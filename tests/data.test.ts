import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Store } from '../electron/store';
import { parseImport, exportProfiles, readExcel } from '../electron/importer';
import { batchSchema, profileSchema, tunnelSchema } from '../electron/validation';
import { profile, tempStore } from './helpers';

test('credentials: encrypted disk persistence ignores legacy temporary flag, preserves empty edits, clearing and concurrent writes', async () => {
  const temp = await tempStore(); const key = randomBytes(32);
  const cipher = {
    available: () => true,
    encrypt: async (value: string) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString('base64'); },
    decrypt: async (value: string) => { const b = Buffer.from(value, 'base64'), c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(); },
  };
  try {
    const store = new Store(temp.directory, cipher); await store.load(); const p = profile(22, { rememberSecret: true });
    await store.saveProfile({ profile: p, secrets: { password: 'sensitive password 001 ' } });
    assert.ok(!(await fs.readFile(path.join(temp.directory, 'config.json'), 'utf8')).includes('sensitive password'));
    assert.equal(store.config().profiles[0].hasSecret, true);
    const reloaded = new Store(temp.directory, cipher); await reloaded.load(); assert.equal((await reloaded.secrets(p.id)).password, 'sensitive password 001 ');
    await reloaded.saveProfile({ profile: { ...p, rememberSecret: false } }); assert.equal((await reloaded.secrets(p.id)).password, 'sensitive password 001 ');
    const afterExit = new Store(temp.directory, cipher); await afterExit.load(); assert.equal((await afterExit.secrets(p.id)).password, 'sensitive password 001 ');
    await reloaded.saveProfile({ profile: p, clearSecret: true }); assert.equal(reloaded.config().profiles[0].hasSecret, false);
    await Promise.all(Array.from({ length: 15 }, (_, i) => reloaded.saveProfile({ profile: profile(22, { name: `host-${i}` }) })));
    assert.equal(reloaded.config().profiles.length, 16);
  } finally { await temp.cleanup(); }
});
test('Excel: bilingual columns, exact passwords, duplicates, invalid rows and formula rejection', async () => {
  const temp = await tempStore();
  try {
    const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('连接列表');
    sheet.addRows([
      ['name', 'host', 'port', 'username', '认证方式', 'password', '分组', '私钥路径'],
      ['A', '192.0.2.10', 22, 'admin', '密码', ' 0001 ', '生产', ''],
      ['B', '192.0.2.10', 22, 'admin', 'password', 'other', '生产', ''],
      ['Bad port', '192.0.2.20', 70000, 'root', 'password', '', '', ''],
      ['Key', 'server.example', 2222, 'ubuntu', '私钥', '', '数据库', 'C:\\Users\\you\\.ssh\\id_ed25519'],
      ['Formula', '192.0.2.30', 22, 'admin', 'password', { formula: '"abc"', result: 'abc' }, '', ''],
      ['Missing user', '192.0.2.40', 22, '', 'password', '', '', ''],
    ]);
    const filename = path.join(temp.directory, 'import.xlsx'); await wb.xlsx.writeFile(filename);
    const draft = await parseImport(filename, { profiles: [], tunnels: [] });
    assert.equal(draft.preview.rows.length, 6); assert.equal(draft.inputs.get(2)?.secrets?.password, ' 0001 '); assert.equal(draft.preview.rows[1].duplicate, true);
    assert.ok(draft.preview.rows[2].error); assert.equal(draft.inputs.get(5)?.profile.authType, 'key'); assert.match(draft.preview.rows[4].error!, /公式/); assert.ok(draft.preview.rows[5].error);
    assert.ok(!JSON.stringify(draft.preview).includes('0001')); assert.ok(!JSON.stringify(draft.preview).includes('other'));
  } finally { await temp.cleanup(); }
});
test('CSV and Excel export: round trip metadata, no secrets exported', async () => {
  const temp = await tempStore();
  try {
    const csv = path.join(temp.directory, 'hosts.csv'); await fs.writeFile(csv, '\uFEFF连接名称,主机地址,端口,用户名,密码\n"上海,主机",192.0.2.5,22,admin," 0010 "\n');
    const draft = await parseImport(csv, { profiles: [], tunnels: [] }); assert.equal(draft.inputs.get(2)?.profile.name, '上海,主机'); assert.equal(draft.inputs.get(2)?.secrets?.password, ' 0010 ');
    const p = draft.inputs.get(2)!; await temp.store.importProfiles([p]);
    const target = path.join(temp.directory, 'export.xlsx'); await exportProfiles(target, temp.store.config());
    const imported = await parseImport(target, { profiles: [], tunnels: [] }); assert.equal(imported.preview.rows[0].host, '192.0.2.5'); assert.equal(imported.preview.rows[0].hasSecret, false);
  } finally { await temp.cleanup(); }
});
test('Excel embedded template: correct headers, dropdowns, blank import sheet and instructions', async () => {
  const wb = await readExcel(path.resolve('assets/SSH导入模板.xlsx'));
  assert.equal(wb.worksheets.length, 2); const sheet = wb.getWorksheet('连接列表')!;
  assert.equal(sheet.getCell('B1').value, '主机地址'); assert.equal(sheet.getCell('D1').value, '用户名'); assert.equal(sheet.getCell('F2').value, null);
  assert.deepEqual([sheet.getCell('I1').value, sheet.getCell('J1').value, sheet.getCell('K1').value], ['设备类型', '地点', '网络类型']);
  assert.equal(sheet.getCell('E2').dataValidation.type, 'list');
  assert.match(wb.getWorksheet('填写说明')!.getCell('A23').text, /明文/);
  await assert.rejects(parseImport(path.resolve('assets/SSH导入模板.xlsx'), { profiles: [], tunnels: [] }), /没有连接记录/);
});
test('validation rejects malformed addresses, invalid ports and unbounded batch settings', () => {
  assert.equal(profileSchema.safeParse(profile(22, { host: 'bad host' })).success, false);
  assert.equal(profileSchema.safeParse(profile(0)).success, false);
  assert.equal(batchSchema.safeParse({ profileIds: [], command: 'ls', timeout: 0, concurrency: 100 }).success, false);
  assert.equal(tunnelSchema.safeParse({ id: crypto.randomUUID(), profileId: crypto.randomUUID(), name: 'x', type: 'local', bindHost: '127.0.0.1', bindPort: 80, targetHost: '', targetPort: 80 }).success, false);
});
