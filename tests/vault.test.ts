import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Vault } from '../electron/vault';
import { Store } from '../electron/store';
import { Manager } from '../electron/manager';
import { importSelection, parseImport } from '../electron/importer';
import { freePort, profile, sshFixture, tempStore, until } from './helpers';

test('software password: restart requires unlock, wrong passwords fail, password change retains data key', async () => {
  const temp = await tempStore();
  try {
    const p = profile(22, { rememberSecret: false }); await temp.store.saveProfile({ profile: p, secrets: { password: 'persistent-secret-001 ' } });
    const diskBefore = await fs.readFile(path.join(temp.directory, 'config.json'), 'utf8');
    assert.ok(!diskBefore.includes('persistent-secret')); assert.ok(!JSON.stringify(temp.store.config()).includes('persistent-secret'));
    temp.vault.lock(); await assert.rejects(() => temp.store.secrets(p.id), /解密/);
    const vault = new Vault(temp.directory); await vault.load(); assert.deepEqual(vault.status(), { configured: true, unlocked: false });
    await assert.rejects(() => vault.unlock('wrong-password'), /不正确/);
    const good = new Vault(temp.directory); await good.load(); await good.unlock('fixture-master-password');
    const store = new Store(temp.directory, good); await store.load(); assert.equal((await store.secrets(p.id)).password, 'persistent-secret-001 ');
    await assert.rejects(() => good.changePassword('incorrect', 'replacement-master-password'), /不正确/);
    const change = new Vault(temp.directory); await change.load(); await change.unlock('fixture-master-password'); await change.changePassword('fixture-master-password', 'replacement-master-password'); change.lock();
    assert.equal(await fs.readFile(path.join(temp.directory, 'config.json'), 'utf8'), diskBefore);
    const oldPassword = new Vault(temp.directory); await oldPassword.load(); await assert.rejects(() => oldPassword.unlock('fixture-master-password'), /不正确/);
    const updated = new Vault(temp.directory); await updated.load(); await updated.unlock('replacement-master-password');
    const final = new Store(temp.directory, updated); await final.load(); assert.equal((await final.secrets(p.id)).password, 'persistent-secret-001 ');
    const encrypted = await updated.encrypt('tamper-check'); const bytes = Buffer.from(encrypted.slice(9), 'base64'); bytes[bytes.length - 1] ^= 1;
    await assert.rejects(() => updated.decrypt(`vault:v1:${bytes.toString('base64')}`));
    updated.lock(); good.lock();
  } finally { await temp.cleanup(); }
});

test('Excel recovery only fills missing credentials, preserves profile ID and groups, rejects stale overwrite', async () => {
  const temp = await tempStore();
  try {
    const missing = profile(22, { groupPath: ['交换机', '上海', '办公网'], name: '保留此名称' });
    const present = profile(23, { name: '已有密码' });
    await temp.store.saveProfile({ profile: missing }); await temp.store.saveProfile({ profile: present, secrets: { password: 'existing-secret' } });
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('连接列表').addRows([
      ['连接名称', '主机地址', '端口', '用户名', '密码'],
      ['覆盖名称不可发生', '127.0.0.1', 22, 'tester', 'restore-secret'],
      ['覆盖已有密码不可发生', '127.0.0.1', 23, 'tester', 'wrong-secret'],
      ['文件内重复', '127.0.0.1', 22, 'tester', 'other-secret'],
    ]);
    const filename = path.join(temp.directory, 'recover.xlsx'); await wb.xlsx.writeFile(filename);
    const draft = await parseImport(filename, temp.store.config());
    assert.equal(draft.preview.rows[0].canFillSecret, true); assert.equal(draft.preview.rows[1].canFillSecret, false); assert.equal(draft.preview.rows[2].canFillSecret, false);
    assert.throws(() => importSelection(draft, [2], temp.store.config(), true, false), /重复/);
    assert.throws(() => importSelection(draft, [3], temp.store.config(), true, true), /已有凭据/);
    await temp.store.importProfiles(c => importSelection(draft, [2], c, true, true));
    const restored = temp.store.profile(missing.id); assert.equal(restored.name, missing.name); assert.deepEqual(restored.groupPath, missing.groupPath);
    assert.equal((await temp.store.secrets(missing.id)).password, 'restore-secret'); assert.equal((await temp.store.secrets(present.id)).password, 'existing-secret');
    await assert.rejects(() => temp.store.importProfiles(c => importSelection(draft, [2], c, true, true)), /已有凭据/);
  } finally { await temp.cleanup(); }
});

test('Excel credentials survive repeated bulk SSH connections, batch execution and a full vault/store restart', async () => {
  const a = await sshFixture(), b = await sshFixture(), temp = await tempStore();
  let manager = new Manager(temp.store, () => {}, async () => true);
  try {
    const file = path.join(temp.directory, 'hosts.csv'); await fs.writeFile(file, `连接名称,主机地址,端口,用户名,密码\nA,127.0.0.1,${a.port},tester,test-secret\nB,127.0.0.1,${b.port},tester,test-secret\n`);
    const draft = await parseImport(file, temp.store.config()); await temp.store.importProfiles([...draft.inputs.values()]);
    const ids = temp.store.config().profiles.map(p => p.id);
    for (let round = 0; round < 2; round++) {
      const sessions = ids.map(id => manager.startSession(id)); await until(() => manager.snapshot().sessions.every(s => s.status === 'connected'));
      sessions.forEach(id => manager.disconnect(id));
    }
    const job = manager.runBatch({ profileIds: ids, command: 'hostname', concurrency: 2, timeout: 5 });
    await until(() => manager.snapshot().jobs.find(j => j.id === job)?.status === 'done'); assert.ok(manager.snapshot().jobs[0].results.every(r => r.status === 'success'));
    manager.dispose(); temp.vault.lock();
    const vault = new Vault(temp.directory); await vault.load(); await vault.unlock('fixture-master-password');
    const reopened = new Store(temp.directory, vault); await reopened.load(); manager = new Manager(reopened, () => {}, async () => true);
    ids.forEach(id => manager.startSession(id)); await until(() => manager.snapshot().sessions.every(s => s.status === 'connected'));
    for (const id of ids) assert.equal((await reopened.secrets(id)).password, 'test-secret');
    assert.ok(reopened.config().profiles.every(p => p.hasSecret && p.rememberSecret));
  } finally { manager.dispose(); await a.close(); await b.close(); await temp.cleanup(); }
});

test('bulk deletion preflights running jobs, closes sessions/tunnels and removes only selected profiles and credentials', async () => {
  const fixture = await sshFixture(), temp = await tempStore(); const manager = new Manager(temp.store, () => {}, async () => true);
  try {
    const selected = [profile(fixture.port), profile(fixture.port)], keep = profile(22, { name: '保留主机' });
    for (const p of [...selected, keep]) await temp.store.saveProfile({ profile: p, secrets: { password: 'test-secret' } });
    const tunnel = { id: crypto.randomUUID(), name: '待删除隧道', profileId: selected[0].id, type: 'dynamic' as const, bindHost: '127.0.0.1', bindPort: await freePort(), targetHost: '', targetPort: 80 };
    await temp.store.saveTunnel(tunnel); await manager.startTunnel(tunnel.id);
    const sessions = selected.map(p => manager.startSession(p.id)); await until(() => manager.snapshot().sessions.every(s => s.status === 'connected'));
    const job = manager.runBatch({ profileIds: [selected[1].id], command: 'hang', concurrency: 1, timeout: 5 });
    assert.throws(() => manager.assertProfilesDeletable(selected.map(p => p.id)), /停止任务/);
    assert.equal(manager.snapshot().sessions.length, 2); assert.equal(manager.snapshot().tunnels[0].status, 'running');
    manager.cancelBatch(job); await until(() => manager.snapshot().jobs[0].status !== 'running');
    manager.assertProfilesDeletable(selected.map(p => p.id)); for (const p of selected) await manager.closeProfile(p.id);
    await temp.store.deleteProfiles(selected.map(p => p.id));
    assert.equal(manager.snapshot().sessions.length, 0); assert.equal(manager.snapshot().tunnels.length, 0);
    assert.deepEqual(temp.store.config().profiles.map(p => p.id), [keep.id]); assert.equal(temp.store.config().tunnels.length, 0);
    for (const p of selected) assert.deepEqual(await temp.store.secrets(p.id), {});
    assert.equal((await temp.store.secrets(keep.id)).password, 'test-secret'); assert.equal(sessions.length, 2);
  } finally { manager.dispose(); await fixture.close(); await temp.cleanup(); }
});

test('legacy credentials migrate after password unlock; unreadable ciphertext remains available for recovery', async () => {
  const temp = await tempStore();
  try {
    const readable = profile(22), unreadable = profile(23);
    const legacy = Buffer.from(JSON.stringify({ password: 'legacy-secret-value' })).toString('base64');
    await fs.writeFile(path.join(temp.directory, 'config.json'), JSON.stringify({ version: 1, profiles: [readable, unreadable], tunnels: [], knownHosts: {}, credentials: { [readable.id]: legacy, [unreadable.id]: 'unreadable-ciphertext' } }));
    const vault = new Vault(temp.directory, async value => { if (value !== legacy) throw new Error('Unavailable'); return Buffer.from(value, 'base64').toString(); });
    await vault.load(); await vault.unlock('fixture-master-password');
    const store = new Store(temp.directory, vault); await store.load(); await store.migrateCredentials();
    const disk = JSON.parse(await fs.readFile(path.join(temp.directory, 'config.json'), 'utf8'));
    assert.ok(disk.credentials[readable.id].startsWith('vault:v1:')); assert.equal(disk.credentials[unreadable.id], 'unreadable-ciphertext');
    assert.equal((await store.secrets(readable.id)).password, 'legacy-secret-value'); await assert.rejects(() => store.secrets(unreadable.id), /无法解密/);
    await store.saveProfile({ profile: unreadable, secrets: { password: 'replacement-secret' } }); assert.equal((await store.secrets(unreadable.id)).password, 'replacement-secret'); vault.lock();
  } finally { await temp.cleanup(); }
});
