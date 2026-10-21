import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Manager } from '../electron/manager';
import { SessionLogs, logName } from '../electron/session-logs';
import { Store } from '../electron/store';
import { profile, sshFixture, tempStore, until } from './helpers';
import type { TerminalLogInfo } from '../shared/types';

test('terminal logs persist live SSH output beyond scrollback, finalize on disconnect, retain directory after restart', async () => {
  const state = await tempStore(), fixture = await sshFixture();
  const notices: string[] = [];
  const manager = new Manager(state.store, event => { if (event.type === 'notice') notices.push(event.message); }, async () => true);
  try {
    const directory = path.join(state.directory, 'chosen-logs');
    await state.store.saveLogDirectory(directory);
    const p = profile(fixture.port, { name: '10车间:交换机/接入?*' });
    await state.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const id = manager.startSession(p.id);
    await until(() => manager.snapshot().sessions[0]?.status === 'connected');
    const token = '持续输出_中文_UTF8_'; const payload = token.repeat(100000);
    fixture.sendToTerminals(payload);
    let current = '';
    await until(() => { current = manager.readTerminal(id).data.map(data => Buffer.from(data, 'base64').toString()).join(''); return current.includes(token); });
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = async () => {
        try { const live = (await fs.readdir(directory)).find(name => name.endsWith('.recording.log')); if (live && (await fs.stat(path.join(directory, live))).size > Buffer.byteLength(payload)) { resolve(); return; } }
        catch (error) { reject(error); return; }
        if (Date.now() - started > 15000) reject(new Error('live terminal log did not reach disk')); else setTimeout(() => { void check(); }, 30);
      }; void check();
    });
    const stoppedAt = new Date(); manager.disconnect(id); await manager.flushLogs();
    const names = await fs.readdir(directory); assert.equal(names.length, 1);
    assert.match(names[0], /^10车间_交换机_接入__\_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}_/);
    assert.ok(!names[0].endsWith('.recording.log')); assert.ok(names[0].endsWith(`_${id}.log`));
    const content = await fs.readFile(path.join(directory, names[0]), 'utf8');
    assert.ok(content.includes(payload)); assert.ok(content.includes('原因：手动断开')); assert.ok(!content.includes('test-secret'));
    const finalAt = content.match(/断开时间：([^\r\n]+)/)?.[1]; assert.ok(finalAt); assert.ok(Math.abs(Date.parse(finalAt) - stoppedAt.getTime()) < 2000);
    const restored = new Store(state.directory, state.vault); await restored.load(); assert.equal(restored.config().terminalLogDirectory, directory);
    assert.deepEqual(notices, []);
  } finally { manager.dispose(); await manager.flushLogs(); await fixture.close(); await state.cleanup(); }
});

test('terminal logs keep concurrent names separate, preserve split UTF-8 bytes, finish once and sanitize Windows names', async () => {
  const state = await tempStore(); const updates = new Map<string, TerminalLogInfo>();
  const logs = new SessionLogs((id, info) => updates.set(id, info));
  const directory = path.join(state.directory, 'logs');
  try {
    const p = profile(22, { name: 'CON./办公室:交换机*?<>|"' });
    const first = randomUUID(), second = randomUUID(), end = new Date('2026-10-21T01:02:03.456Z');
    logs.start(first, p, directory); logs.start(second, p, directory);
    const utf8 = Buffer.from('\x1b[32m中文日志\x1b[0m\r\n');
    logs.append(first, utf8.subarray(0, 6)); logs.append(first, utf8.subarray(6)); logs.append(second, Buffer.from('second-session'));
    logs.finish(first, '远程断开', end); logs.finish(first, '重复结束', end); logs.finish(second, '软件退出', end); await logs.closeAll();
    const files = await fs.readdir(directory); assert.equal(files.length, 2); assert.ok(files.every(name => !/[<>:"/\\|?*]/.test(name)));
    assert.equal(updates.get(first)?.status, 'saved'); assert.equal(updates.get(second)?.status, 'saved');
    const content = await fs.readFile(updates.get(first)!.path, 'utf8'); assert.ok(content.includes(utf8.toString())); assert.ok(!content.includes('\ufffd'));
    assert.equal(content.match(/--- 会话结束 ---/g)?.length, 1);
    assert.ok(Buffer.byteLength(logName('中文'.repeat(200))) <= 140); assert.equal(logName('NUL'), '_NUL'); assert.equal(logName('.. '), 'SSH');
  } finally { await logs.closeAll(); await state.cleanup(); }
});

test('terminal log failures report errors and preserve existing files instead of overwriting them', async () => {
  const state = await tempStore(); const updates: TerminalLogInfo[] = []; const logs = new SessionLogs((_id, info) => updates.push(info));
  try {
    const badDirectory = path.join(state.directory, 'not-a-directory'); await fs.writeFile(badDirectory, 'original');
    const id = randomUUID(); logs.start(id, profile(22), badDirectory); logs.append(id, Buffer.from('output')); logs.finish(id, '结束'); await logs.closeAll();
    assert.equal(updates.filter(update => update.status === 'error').length, 1); assert.equal(updates.at(-1)!.status, 'error');
    assert.equal(await fs.readFile(badDirectory, 'utf8'), 'original');
    assert.ok(!updates.some(update => update.status === 'saved'));
    const directory = path.join(state.directory, 'collision'); await fs.mkdir(directory);
    const next = randomUUID(), p = profile(22, { name: 'same-name' });
    const existing = path.join(directory, `same-name_2026-10-21_01-02-03-456_${next}.log`);
    await fs.writeFile(existing, 'must-not-be-overwritten');
    logs.start(next, p, directory); logs.append(next, Buffer.from('new-output'));
    logs.finish(next, '结束', new Date(2026, 9, 21, 1, 2, 3, 456)); await logs.closeAll();
    assert.equal(await fs.readFile(existing, 'utf8'), 'must-not-be-overwritten');
    assert.equal(updates.at(-1)!.status, 'error'); assert.ok(updates.at(-1)!.path.endsWith('.recording.log'));
    assert.ok((await fs.readFile(updates.at(-1)!.path, 'utf8')).includes('new-output'));
  } finally { await logs.closeAll(); await state.cleanup(); }
});
