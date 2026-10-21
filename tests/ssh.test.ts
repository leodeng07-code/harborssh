import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { freePort, profile, socketReader, sshFixture, tempStore, until } from './helpers';
import { batchCompletion } from '../electron/batch-result';

test('batch completion distinguishes command status from transport failure', () => {
  assert.equal(batchCompletion(0, undefined, true, 'read ECONNRESET').status, 'success');
  assert.match(batchCompletion(0, undefined, true, 'read ECONNRESET').warning!, /退出码 0/);
  assert.equal(batchCompletion(7, undefined, true, 'read ECONNRESET').status, 'error');
  assert.equal(batchCompletion(undefined, 'TERM', true).status, 'error');
  assert.equal(batchCompletion(undefined, undefined, true, 'read ECONNRESET').status, 'unconfirmed');
  assert.equal(batchCompletion(undefined, undefined, false, 'read ECONNRESET').status, 'error');
  assert.equal(batchCompletion(undefined, undefined, false).status, 'unconfirmed');
});
test('real SSH: missing exit status and disconnect after exit are not false command failures', async () => {
  const fixture = await sshFixture(), storage = await tempStore();
  const manager = new Manager(storage.store, () => {}, async () => true);
  try {
    const p = profile(fixture.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    for (const [command, status] of [['no-exit', 'unconfirmed'], ['exit-then-disconnect', 'success'], ['disconnect-with-output', 'unconfirmed']]) {
      manager.runBatch({ profileIds: [p.id], command, timeout: 5, concurrency: 1 });
      await until(() => manager.snapshot().jobs[0].status === 'done');
      const result = manager.snapshot().jobs[0].results[0];
      assert.equal(result.status, status, JSON.stringify(result)); assert.ok(result.output);
      if (status === 'unconfirmed') { assert.ok(result.warning); assert.equal(result.error, undefined); }
    }
  } finally { manager.dispose(); await fixture.close(); await storage.cleanup(); }
});

test('real SSH: terminal IO, UTF-8, resizing and cleanup', async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true);
  try {
    const p = profile(f.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const id = manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'connected');
    manager.write(id, 'hello\r'); manager.resize(id, 120, 42);
    await until(() => manager.readTerminal(id).data.map(c => Buffer.from(c, 'base64').toString()).join('').includes('hello'));
    const output = Buffer.concat(manager.readTerminal(id).data.map(c => Buffer.from(c, 'base64'))).toString('utf8');
    assert.match(output, /欢迎使用 SSH 测试终端/); assert.match(output, /echo:hello/);
    await until(() => f.sizes.some(s => s.cols === 120 && s.rows === 42)); manager.disconnect(id); assert.equal(manager.snapshot().sessions.length, 0);
  } finally { manager.dispose(); await f.close(); await storage.cleanup(); }
});
test('real SSH: password failure and rejected host key surface errors', async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true);
  const rejecting = new Manager(storage.store, () => {}, async () => false);
  try {
    const p = profile(f.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'wrong' } });
    manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'error'); assert.match(manager.snapshot().sessions[0].message!, /authentication/i);
    await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    rejecting.startSession(p.id); await until(() => rejecting.snapshot().sessions[0]?.status === 'error'); assert.match(rejecting.snapshot().sessions[0].message!, /verification/i);
  } finally { manager.dispose(); rejecting.dispose(); await f.close(); await storage.cleanup(); }
});
test('real SSH: encrypted PEM private key login', async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true);
  try {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase: 'key-secret' }, publicKeyEncoding: { format: 'pem', type: 'pkcs1' } }).privateKey;
    const filename = path.join(storage.directory, 'id_rsa'); await fs.writeFile(filename, key);
    const p = profile(f.port, { authType: 'key', privateKeyPath: filename }); await storage.store.saveProfile({ profile: p, secrets: { passphrase: 'key-secret' } });
    manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'connected');
  } finally { manager.dispose(); await f.close(); await storage.cleanup(); }
});
test('real SSH: concurrent batch results, nonzero exit, cancellation and timeout', async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true);
  try {
    const a = profile(f.port), b = profile(f.port, { name: '第二台主机' });
    for (const p of [a, b]) await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const request = { profileIds: [a.id, b.id], command: 'hostname', concurrency: 2, timeout: 5 };
    manager.runBatch(request); await until(() => manager.snapshot().jobs[0].status === 'done');
    assert.ok(manager.snapshot().jobs[0].results.every(r => r.status === 'success' && r.output.includes('主机结果: hostname') && r.exitCode === 0));
    manager.runBatch({ ...request, command: 'fail' }); await until(() => manager.snapshot().jobs[0].status === 'done');
    assert.ok(manager.snapshot().jobs[0].results.every(r => r.status === 'error' && r.output.includes('failure detail') && r.exitCode === 7));
    const id = manager.runBatch({ ...request, command: 'hang', concurrency: 1 }); await until(() => manager.snapshot().jobs[0].results[0].status === 'running'); manager.cancelBatch(id);
    await until(() => manager.snapshot().jobs[0].status === 'cancelled'); assert.ok(manager.snapshot().jobs[0].results.every(r => r.status === 'cancelled'));
    manager.runBatch({ ...request, profileIds: [a.id], command: 'hang', timeout: 1 }); await until(() => manager.snapshot().jobs[0].status === 'done');
    assert.match(manager.snapshot().jobs[0].results[0].error!, /超时/);
  } finally { manager.dispose(); await f.close(); await storage.cleanup(); }
});
for (const type of ['local', 'remote', 'dynamic'] as const) test(`real SSH: ${type} tunnel transfers bytes and releases port on stop`, async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true); let socket: net.Socket | undefined;
  try {
    const p = profile(f.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const bindPort = await freePort(); const t = { id: crypto.randomUUID(), name: '转发测试', profileId: p.id, type, bindHost: '127.0.0.1', bindPort, targetHost: '127.0.0.1', targetPort: f.echoPort };
    await storage.store.saveTunnel(t); await manager.startTunnel(t.id); assert.equal(manager.snapshot().tunnels[0].status, 'running', manager.snapshot().tunnels[0].message || 'Tunnel should be running');
    socket = net.connect({ port: bindPort, host: '127.0.0.1' }); const read = socketReader(socket);
    await new Promise<void>(resolve => socket!.once('connect', resolve));
    if (type === 'dynamic') {
      // Fragment the greeting, then pipeline the domain request and initial application bytes.
      socket.write(Buffer.from([5]));
      const port = Buffer.alloc(2); port.writeUInt16BE(f.echoPort);
      socket.write(Buffer.concat([Buffer.from([1, 0, 5, 1, 0, 3, 9]), Buffer.from('localhost'), port, Buffer.from('ping')]));
      assert.deepEqual([...await read(2)], [5, 0]); assert.equal((await read(10))[1], 0);
    } else socket.write('ping');
    assert.equal((await read(4)).toString(), 'ping'); assert.equal(manager.snapshot().tunnels[0].connections, 1);
    socket.destroy(); await manager.stopTunnel(t.id); assert.equal(manager.snapshot().tunnels[0].status, 'stopped');
    const server = net.createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(bindPort, '127.0.0.1', resolve); }); await new Promise<void>(resolve => server.close(() => resolve()));
  } finally { socket?.destroy(); manager.dispose(); await f.close(); await storage.cleanup(); }
});
test('tunnel bind conflicts report an error without a leaked SSH connection', async () => {
  const f = await sshFixture(), storage = await tempStore(); const manager = new Manager(storage.store, () => {}, async () => true);
  try {
    const p = profile(f.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const t = { id: crypto.randomUUID(), name: '端口冲突', profileId: p.id, type: 'local' as const, bindHost: '127.0.0.1', bindPort: f.echoPort, targetHost: '127.0.0.1', targetPort: 80 };
    await storage.store.saveTunnel(t); await manager.startTunnel(t.id); assert.equal(manager.snapshot().tunnels[0].status, 'error'); assert.match(manager.snapshot().tunnels[0].message!, /EADDRINUSE/);
  } finally { manager.dispose(); await f.close(); await storage.cleanup(); }
});
