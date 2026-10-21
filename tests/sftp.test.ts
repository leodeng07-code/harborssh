import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Manager } from '../electron/manager';
import { localName, remoteName } from '../electron/sftp';
import type { FileTransfer } from '../shared/types';
import { freePort, profile, sshFixture, tempStore, until } from './helpers';

async function setup(options: { writeDelay?: number; deny?: string; singleSession?: boolean } = {}) {
  const temp = await tempStore(); const remote = path.join(temp.directory, 'remote'); const local = path.join(temp.directory, 'local'); const downloaded = path.join(temp.directory, 'downloads');
  for (const dir of [remote, local, downloaded]) await fs.mkdir(dir);
  const channels = { count: 0 }, fixture = await sshFixture({ root: remote, channels, ...options }); const events: FileTransfer[][] = [];
  const manager = new Manager(temp.store, event => { if (event.type === 'transfers') events.push(event.data); }, async () => true);
  const p = profile(fixture.port); await temp.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } }); const id = manager.startSession(p.id);
  await until(() => manager.snapshot().sessions[0].status === 'connected');
  return { ...temp, remote, local, downloaded, channels, fixture, manager, id, events, close: async () => { manager.dispose(); await fixture.close(); await temp.cleanup(); } };
}
async function idle(t: Awaited<ReturnType<typeof setup>>) { await until(() => t.manager.sftp.transfers(t.id).every(j => ['success', 'error', 'cancelled'].includes(j.status)), 15000); }
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('SFTP shares SSH client: UTF-8 directories, metadata, mkdir, rename, empty-directory delete, permission error and live terminal', async () => {
  const t = await setup({ deny: 'forbidden' });
  try {
    await fs.writeFile(path.join(t.remote, '说明.txt'), '远程 UTF-8 内容'); await fs.mkdir(path.join(t.remote, '目录 空格'));
    const root = await t.manager.sftp.list(t.id, '.'); assert.equal(root.path, '/'); assert.equal(root.entries[0].name, '目录 空格'); assert.equal(root.entries[1].size, Buffer.byteLength('远程 UTF-8 内容'));
    await t.manager.sftp.mkdir(t.id, '/', '新文件夹'); await t.manager.sftp.rename(t.id, '/说明.txt', '新名称.txt');
    await assert.rejects(() => t.manager.sftp.list(t.id, '/forbidden'), /权限/);
    const removed = await t.manager.sftp.remove(t.id, ['/新文件夹', '/missing.txt']); assert.equal(removed[0].error, undefined); assert.ok(removed[1].error);
    t.manager.write(t.id, 'sftp-and-shell\r'); await until(() => t.manager.readTerminal(t.id).data.some(c => Buffer.from(c, 'base64').toString().includes('sftp-and-shell')));
    assert.equal(t.manager.snapshot().sessions.length, 1); assert.equal(t.channels.count, 1);
    assert.equal(t.fixture.connectionCount(), 1);
  } finally { await t.close(); }
});

test('SFTP uploads and downloads multiple streamed files, preserving binary hashes, Unicode names and empty files', async () => {
  const t = await setup();
  try {
    const contents = [randomBytes(1024 * 1024 + 17), Buffer.from('文件内容\n含空格'), Buffer.alloc(0)]; const names = ['binary.dat', '中文 名.txt', 'empty.txt'];
    for (let i = 0; i < names.length; i++) await fs.writeFile(path.join(t.local, names[i]), contents[i]);
    await t.manager.sftp.upload(t.id, names.map(n => path.join(t.local, n)), '/', false); await idle(t);
    assert.ok(t.manager.sftp.transfers(t.id).every(j => j.status === 'success'), JSON.stringify(t.manager.sftp.transfers(t.id)));
    for (let i = 0; i < names.length; i++) assert.equal(digest(await fs.readFile(path.join(t.remote, names[i]))), digest(contents[i]));
    await t.manager.sftp.download(t.id, names.map(n => '/' + n), t.downloaded, false); await idle(t);
    assert.ok(t.manager.sftp.transfers(t.id).every(j => j.status === 'success'), JSON.stringify(t.manager.sftp.transfers(t.id)));
    for (let i = 0; i < names.length; i++) assert.equal(digest(await fs.readFile(path.join(t.downloaded, names[i]))), digest(contents[i]));
    assert.ok(t.events.some(items => items.some(j => j.bytes > 0 && j.status === 'running')));
    assert.ok(!(await fs.readdir(t.remote)).some(n => n.endsWith('.part'))); assert.ok(!(await fs.readdir(t.downloaded)).some(n => n.endsWith('.part')));
  } finally { await t.close(); }
});

test('SFTP recursive folder transfer preserves nested files and empty folders, rejects symlinks and Windows filename collisions', async () => {
  const t = await setup();
  try {
    const source = path.join(t.local, '项目 文件'); await fs.mkdir(path.join(source, '一级', '空目录'), { recursive: true }); await fs.writeFile(path.join(source, '一级', '配置.json'), '{"enabled":true}');
    await t.manager.sftp.upload(t.id, [source], '/', false); await idle(t); assert.equal(t.manager.sftp.transfers(t.id)[0].status, 'success');
    await t.manager.sftp.download(t.id, ['/项目 文件'], t.downloaded, false); await idle(t);
    assert.equal(await fs.readFile(path.join(t.downloaded, '项目 文件', '一级', '配置.json'), 'utf8'), '{"enabled":true}'); assert.ok((await fs.stat(path.join(t.downloaded, '项目 文件', '一级', '空目录'))).isDirectory());
    await fs.mkdir(path.join(t.remote, 'collision')); await fs.writeFile(path.join(t.remote, 'collision', 'A.txt'), 'A'); await fs.writeFile(path.join(t.remote, 'collision', 'a.txt'), 'a');
    await t.manager.sftp.download(t.id, ['/collision'], t.downloaded, false); await idle(t); assert.match(t.manager.sftp.transfers(t.id).at(-1)!.message!, /Windows/);
    await fs.symlink(path.join(t.local, '项目 文件'), path.join(t.local, 'link'));
    await t.manager.sftp.upload(t.id, [path.join(t.local, 'link')], '/', false); await idle(t); assert.match(t.manager.sftp.transfers(t.id).at(-1)!.message!, /符号链接/);
  } finally { await t.close(); }
});

test('SFTP collision handling keeps original data, requires overwrite, and leaves no temporary files on errors', async () => {
  const t = await setup();
  try {
    const name = 'same.txt'; await fs.writeFile(path.join(t.remote, name), 'remote-original'); await fs.writeFile(path.join(t.local, name), 'new-content');
    await t.manager.sftp.upload(t.id, [path.join(t.local, name)], '/', false); await idle(t); assert.match(t.manager.sftp.transfers(t.id).at(-1)!.message!, /已存在/);
    assert.equal(await fs.readFile(path.join(t.remote, name), 'utf8'), 'remote-original');
    await t.manager.sftp.upload(t.id, [path.join(t.local, name)], '/', true); await idle(t); assert.match(t.manager.sftp.transfers(t.id).at(-1)!.message!, /安全覆盖/); assert.equal(await fs.readFile(path.join(t.remote, name), 'utf8'), 'remote-original');
    assert.ok(!(await fs.readdir(t.remote)).some(n => n.endsWith('.part')));
    await fs.writeFile(path.join(t.downloaded, name), 'local-original'); await t.manager.sftp.download(t.id, ['/' + name], t.downloaded, false); await idle(t); assert.equal(await fs.readFile(path.join(t.downloaded, name), 'utf8'), 'local-original');
    await t.manager.sftp.download(t.id, ['/' + name], t.downloaded, true); await idle(t); assert.equal(await fs.readFile(path.join(t.downloaded, name), 'utf8'), 'remote-original');
  } finally { await t.close(); }
});

test('SFTP cancellation stops only its channel, cleans partial upload, allows live terminal IO and cancels queues on disconnect', async () => {
  const t = await setup({ writeDelay: 30 });
  try {
    const source = path.join(t.local, 'large.bin'); await fs.writeFile(source, randomBytes(8 * 1024 * 1024));
    await t.manager.sftp.upload(t.id, [source], '/', false);
    await until(() => t.manager.sftp.transfers(t.id)[0]?.bytes > 0); const transfer = t.manager.sftp.transfers(t.id)[0];
    t.manager.write(t.id, 'during-transfer\r'); await until(() => t.manager.readTerminal(t.id).data.some(c => Buffer.from(c, 'base64').toString().includes('during-transfer')));
    t.manager.sftp.cancel(transfer.id);
    await until(() => t.manager.sftp.transfers(t.id)[0].status === 'cancelled');
    await until(() => t.events.some(items => items.some(j => j.id === transfer.id && j.status === 'cancelled')));
    await until(() => t.manager.snapshot().sessions[0].status === 'connected');
    await until(() => !readdirSync(t.remote).some(n => n.endsWith('.part')), 5000);
    assert.ok((await t.manager.sftp.list(t.id, '/')).entries.every(e => e.name !== 'large.bin'));
    await t.manager.sftp.upload(t.id, [source], '/', false); t.manager.disconnect(t.id);
    assert.equal(t.manager.snapshot().sessions.length, 0); assert.ok(t.manager.sftp.transfers(t.id).every(j => !['running', 'queued', 'preparing'].includes(j.status)));
  } finally { await t.close(); }
});

test('SFTP path/name checks prevent local traversal and unsafe Windows filenames', () => {
  for (const value of ['../escape', '.', '..', '/root', '', 'bad\0name']) assert.throws(() => remoteName(value));
  for (const value of ['CON', 'nul.txt', 'a\\b', 'bad:name', 'tail.', 'tail ', 'x?']) assert.throws(() => localName(value));
  assert.equal(localName('中文 名称.txt'), '中文 名称.txt');
});

test('servers without an SFTP subsystem report a file-panel error while the SSH terminal remains usable', async () => {
  const temp = await tempStore(), fixture = await sshFixture(); const manager = new Manager(temp.store, () => {}, async () => true);
  try {
    const p = profile(fixture.port); await temp.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } }); const id = manager.startSession(p.id);
    await until(() => manager.snapshot().sessions[0].status === 'connected'); await assert.rejects(() => manager.sftp.list(id, '.'), /SFTP/);
    assert.equal(manager.snapshot().sessions[0].status, 'connected'); manager.write(id, 'sftp-unavailable-shell-ok\r');
    await until(() => manager.readTerminal(id).data.some(c => Buffer.from(c, 'base64').toString().includes('sftp-unavailable-shell-ok')));
  } finally { manager.dispose(); await fixture.close(); await temp.cleanup(); }
});

test('single-channel SSH devices use a verified separate SFTP transport, transfer binary files and close both connections', async () => {
  const t = await setup({ singleSession: true });
  try {
    const profileId = t.manager.snapshot().sessions[0].profileId;
    await t.store.saveProfile({ profile: { ...t.store.profile(profileId), port: await freePort() } });
    const content = randomBytes(128 * 1024 + 37), source = path.join(t.local, '交换机兼容.bin'); await fs.writeFile(source, content);
    const [a, b] = await Promise.all([t.manager.sftp.list(t.id, '.'), t.manager.sftp.list(t.id, '.')]); assert.deepEqual(a, b);
    assert.equal(t.fixture.connectionCount(), 2); assert.equal(t.channels.count, 1);
    await t.manager.sftp.upload(t.id, [source], '/', false); await idle(t); assert.equal(t.manager.sftp.transfers(t.id)[0].status, 'success');
    await t.manager.sftp.download(t.id, ['/交换机兼容.bin'], t.downloaded, false); await idle(t);
    assert.equal(digest(await fs.readFile(path.join(t.downloaded, '交换机兼容.bin'))), digest(content));
    t.manager.write(t.id, 'separate-sftp-shell-still-active\r'); await until(() => t.manager.readTerminal(t.id).data.some(c => Buffer.from(c, 'base64').toString().includes('separate-sftp-shell-still-active')));
    assert.equal(t.manager.snapshot().sessions[0].status, 'connected');
    t.manager.disconnect(t.id); await until(() => t.fixture.connectionCount() === 0);
  } finally { await t.close(); }
});

test('dedicated SFTP fallback verifies host identity and rejects it without closing the terminal', async () => {
  const temp = await tempStore(), remote = path.join(temp.directory, 'remote'); await fs.mkdir(remote);
  const fixture = await sshFixture({ root: remote, singleSession: true }); let verifications = 0;
  const manager = new Manager(temp.store, () => {}, async () => ++verifications === 1);
  try {
    const p = profile(fixture.port); await temp.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const id = manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'connected');
    await assert.rejects(manager.sftp.list(id, '.'), /独立 SFTP/); assert.equal(verifications, 2);
    await until(() => fixture.connectionCount() === 1); assert.equal(manager.snapshot().sessions[0].status, 'connected');
    manager.write(id, 'terminal-after-rejected-fingerprint\r'); await until(() => manager.readTerminal(id).data.some(chunk => Buffer.from(chunk, 'base64').toString().includes('terminal-after-rejected-fingerprint')));
  } finally { manager.dispose(); await fixture.close(); await temp.cleanup(); }
});

test('single-channel compatibility keeps concurrent transfers independent when one is cancelled', async () => {
  const t = await setup({ singleSession: true, writeDelay: 45 });
  try {
    const a = path.join(t.local, 'cancel.bin'), b = path.join(t.local, 'keep.bin'), content = randomBytes(256 * 1024 + 1);
    await fs.writeFile(a, randomBytes(1024 * 1024)); await fs.writeFile(b, content);
    await t.manager.sftp.upload(t.id, [a, b], '/', false);
    await until(() => t.manager.sftp.transfers(t.id).some(job => job.name === 'cancel.bin' && job.bytes > 0));
    const cancelled = t.manager.sftp.transfers(t.id).find(job => job.name === 'cancel.bin')!; t.manager.sftp.cancel(cancelled.id); await idle(t);
    assert.equal(t.manager.sftp.transfers(t.id).find(job => job.name === 'cancel.bin')!.status, 'cancelled');
    assert.equal(t.manager.sftp.transfers(t.id).find(job => job.name === 'keep.bin')!.status, 'success');
    assert.equal(digest(await fs.readFile(path.join(t.remote, 'keep.bin'))), digest(content));
    await until(() => !readdirSync(t.remote).some(name => name.endsWith('.part')));
    assert.equal(t.fixture.connectionCount(), 2); assert.equal(t.manager.snapshot().sessions[0].status, 'connected');
  } finally { await t.close(); }
});
