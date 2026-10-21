import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'ssh2';
import { SystemMonitor, SYSTEM_PROBE, SYSTEM_SAMPLE, parseSystemSample } from '../electron/system-monitor';
import { Manager } from '../electron/manager';
import { delay, profile, sshFixture, tempStore, until } from './helpers';
import { systemSample as sample } from './system-fixture';

test('Linux metrics use counter deltas without counting guest twice; available memory, swap, load and disk mounts', () => {
  const first = parseSystemSample('session', sample()), next = parseSystemSample('session', sample(1), first);
  assert.equal(first.snapshot.cpuPercent, undefined); assert.equal(first.snapshot.networks[0].receiveRate, undefined);
  assert.equal(next.snapshot.cpuPercent, 30); assert.equal(next.snapshot.networks[0].receiveRate, 1024); assert.equal(next.snapshot.networks[0].sendRate, 2048);
  assert.equal(next.snapshot.memory?.percent, 37.5); assert.equal(next.snapshot.memory?.total, 8 * 1024 ** 3); assert.equal(next.snapshot.swap?.percent, 50);
  assert.equal(next.snapshot.disks[1].mount, '/data store'); assert.equal(next.snapshot.disks[0].percent, 53);
  assert.deepEqual(next.snapshot.load, [.5, .2, .1]); assert.equal(next.snapshot.cores, 4); assert.deepEqual(next.snapshot.warnings, []);
});
test('reboots, network counter resets, unavailable metrics and old-kernel memory fallback remain explicit', () => {
  const before = parseSystemSample('session', sample(1)), reboot = parseSystemSample('session', sample(), before);
  assert.equal(reboot.snapshot.cpuPercent, undefined); assert.equal(reboot.snapshot.networks[0].receiveRate, undefined);
  const reset = parseSystemSample('session', sample(2).replace('20240 1', '1 1'), before);
  assert.equal(reset.snapshot.networks[0].receiveRate, undefined);
  const old = parseSystemSample('session', sample().replace('MemAvailable: 5242880 kB', 'SReclaimable: 20 kB\nShmem: 10 kB'));
  assert.equal(old.snapshot.memory?.estimated, true); assert.equal(old.snapshot.memory?.available, (1048576 + 100 + 200 + 20 - 10) * 1024);
  const missing = parseSystemSample('session', '__HARBOR_SYS_V1__\n[end]\n').snapshot;
  assert.equal(missing.memory, undefined); assert.ok(missing.warnings.length >= 4);
  assert.throws(() => parseSystemSample('session', 'garbage'), /完整/);
});
test('fixed Linux collector runs on a real local Linux shell and produces parseable metrics', async () => {
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', SYSTEM_SAMPLE], { timeout: 8000, maxBuffer: 256 * 1024 });
  const result = parseSystemSample('real-linux', stdout).snapshot;
  assert.ok(result.memory!.total > 0); assert.ok(result.uptime! > 0); assert.ok(result.disks.length > 0); assert.ok(result.networks.length > 0); assert.ok(result.hostname);
});
test('real SSH monitoring reuses the session, coalesces reads and does not send sampling output to the terminal/log', async () => {
  let step = 0;
  const fixture = await sshFixture(undefined, (command, stream) => { if (![SYSTEM_PROBE, SYSTEM_SAMPLE].includes(command)) return false; stream.write(command === SYSTEM_PROBE ? 'Linux\n' : sample(step++)); stream.exit(0); stream.end(); return true; });
  const storage = await tempStore(), events: string[] = [], manager = new Manager(storage.store, event => { if (event.type === 'terminal') events.push(Buffer.from(event.data, 'base64').toString()); }, async () => true);
  try {
    const p = profile(fixture.port); await storage.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const id = manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'connected');
    const [a, b] = await Promise.all([manager.system.read(id), manager.system.read(id)]); assert.deepEqual(a, b);
    assert.deepEqual(fixture.execCommands, [SYSTEM_PROBE, SYSTEM_SAMPLE]); assert.equal(fixture.connectionCount(), 1);
    await delay(2100); const next = await manager.system.read(id); assert.equal(next.cpuPercent, 30); assert.equal(next.networks[0].receiveRate, 1024);
    assert.equal(fixture.execCommands.filter(command => command === SYSTEM_PROBE).length, 1); assert.equal(fixture.received.length, 0); assert.ok(!events.join('').includes('__HARBOR_SYS'));
    manager.disconnect(id); assert.throws(() => manager.system.read(id), /连接/);
    await manager.flushLogs(); const fs = await import('node:fs/promises'); const path = await import('node:path');
    const files = await fs.readdir(storage.store.config().terminalLogDirectory!); assert.equal(files.length, 1);
    assert.ok(!(await fs.readFile(path.join(storage.store.config().terminalLogDirectory!, files[0]), 'utf8')).includes('__HARBOR_SYS'));
  } finally { manager.dispose(); await manager.flushLogs(); await fixture.close(); await storage.cleanup(); }
});
test('unsupported devices are probed once, and monitoring timeout/cancellation do not close the SSH shell', async () => {
  let hang = false;
  const fixture = await sshFixture(undefined, (command, stream) => { if (command !== SYSTEM_PROBE) return false; if (!hang) { stream.write('Huawei VRP\n'); stream.exit(0); stream.end(); } return true; });
  const client = new Client(); client.on('error', () => {});
  await new Promise<void>((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port: fixture.port, username: 'tester', password: 'test-secret' }); });
  const monitor = new SystemMonitor(() => client, 800);
  try {
    assert.equal((await monitor.read('unsupported')).platform, 'unsupported'); await monitor.read('unsupported'); assert.equal(fixture.execCommands.length, 1);
    hang = true; await assert.rejects(monitor.read('timeout'), /超时/); assert.equal(fixture.connectionCount(), 1);
    const pending = monitor.read('cancel'); monitor.closeSession('cancel'); await assert.rejects(pending, /断开/);
    const result = await new Promise<string>((resolve, reject) => client.exec('echo alive', (error, stream) => { if (error) return reject(error); let output = ''; stream.on('data', (data: Buffer) => output += data); stream.on('close', () => resolve(output)); }));
    assert.match(result, /echo alive/);
  } finally { monitor.dispose(); client.end(); await fixture.close(); }
});
