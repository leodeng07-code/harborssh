import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import { buildGroupPath, buildGroupTree, groupKey, groupNodeCount, groupPathFromKey, groupSuggestions, inGroup, profileGroupPath } from '../shared/groups';
import { profileSchema } from '../electron/validation';
import { exportProfiles, parseImport } from '../electron/importer';
import { profile, tempStore } from './helpers';

test('hierarchical groups count and filter descendants using complete path segments', () => {
  const profiles = [
    profile(22, { groupPath: ['交换机', '上海', '办公网'] }),
    profile(22, { groupPath: ['交换机', '上海', '生产网'] }),
    profile(22, { groupPath: ['交换机', '北京', '办公网'] }),
    profile(22, { groupPath: ['防火墙', '上海', '办公网'] }),
    profile(22, { groupPath: ['交换机核心', '上海', '办公网'] }),
    profile(22, { group: '未分组', groupPath: [] }),
  ];
  const tree = buildGroupTree(profiles); const switches = tree.find(node => node.name === '交换机')!;
  assert.equal(switches.count, 3); assert.equal(switches.children.find(node => node.name === '上海')!.count, 2);
  assert.equal(switches.children.find(node => node.name === '北京')!.children[0].count, 1);
  assert.equal(profiles.filter(p => inGroup(p, ['交换机'])).length, 3);
  assert.equal(profiles.filter(p => inGroup(p, ['交换机', '上海'])).length, 2);
  assert.equal(profiles.filter(p => inGroup(p, ['交换机', '上海', '办公网'])).length, 1);
  assert.equal(profiles.filter(p => inGroup(p, ['未分组'])).length, 1);
  assert.equal(groupNodeCount(tree), 13);
  assert.deepEqual(groupSuggestions(profiles, ['交换机'], 1), ['北京', '上海'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  assert.deepEqual(groupSuggestions(profiles, ['防火墙', '上海'], 2), ['办公网']);
});
test('group identifiers preserve delimiters in legacy names without merging paths', () => {
  const legacy = profile(22, { group: '交换机 / 上海 / 办公网' });
  assert.deepEqual(profileGroupPath(legacy), ['交换机 / 上海 / 办公网']);
  const path = ['交换机', '上海', '办公网']; assert.deepEqual(groupPathFromKey(groupKey(path)), path);
  assert.notEqual(groupKey(['a / b']), groupKey(['a', 'b']));
  assert.equal(groupPathFromKey('group:bad-json'), null);
  assert.equal(groupPathFromKey('all'), null);
  assert.equal(inGroup(legacy, ['交换机']), false);
});
test('three group levels allow partial depth, reject holes and persist through old-config upgrades', async () => {
  assert.deepEqual(buildGroupPath([' 交换机 ', '上海', '']), ['交换机', '上海']);
  assert.deepEqual(buildGroupPath(['', '', '']), []);
  assert.throws(() => buildGroupPath(['交换机', '', '办公网']), /上一级/);
  assert.throws(() => buildGroupPath(['a', 'b', 'c', 'd']), /三级/);
  assert.equal(profileSchema.safeParse(profile(22, { groupPath: ['a', '', 'b'] })).success, false);
  assert.equal(profileSchema.safeParse(profile(22, { groupPath: ['a', 'b', 'c', 'd'] })).success, false);
  assert.ok(profileSchema.safeParse(profile(22, { groupPath: ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)] })).success);
  const temp = await tempStore();
  try {
    const old = profile(22, { group: '原有/一级分组' });
    await fs.writeFile(path.join(temp.directory, 'config.json'), JSON.stringify({ version: 1, profiles: [old], tunnels: [], credentials: {}, knownHosts: {} }));
    await temp.store.load(); assert.deepEqual(temp.store.config().profiles[0].groupPath, ['原有/一级分组']);
    await temp.store.saveProfile({ profile: { ...temp.store.config().profiles[0], groupPath: ['交换机', '上海', '办公网'] }, secrets: { password: 'kept-in-memory' } });
    await temp.store.saveProfile({ profile: { ...temp.store.config().profiles[0], groupPath: ['交换机', '深圳', '办公网'] } });
    assert.equal((await temp.store.secrets(old.id)).password, 'kept-in-memory');
    await temp.store.load(); const saved = temp.store.config().profiles[0];
    assert.equal(saved.id, old.id); assert.deepEqual(saved.groupPath, ['交换机', '深圳', '办公网']); assert.equal(saved.group, '交换机 / 深圳 / 办公网');
  } finally { await temp.cleanup(); }
});
test('Excel imports three columns or a legacy group path and rejects gaps and conflicts', async () => {
  const temp = await tempStore();
  try {
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('连接列表').addRows([
      ['名称', 'IP', 'user', 'deviceType', '地点', '网络类型', '分组'],
      ['完整层级', '192.0.2.1', 'admin', '交换机', '上海', '办公网', ''],
      ['仅一级', '192.0.2.2', 'admin', '路由器', '', '', ''],
      ['缺少地点', '192.0.2.3', 'admin', '交换机', '', '办公网', ''],
      ['旧路径列', '192.0.2.4', 'admin', '', '', '', ' 防火墙 / 北京 / 生产网 '],
      ['冲突字段', '192.0.2.5', 'admin', '交换机', '上海', '办公网', '交换机/北京/办公网'],
      ['四级', '192.0.2.6', 'admin', '', '', '', 'a/b/c/d'],
      ['一致字段', '192.0.2.7', 'admin', '交换机', '上海', '办公网', '交换机/上海/办公网'],
    ]);
    const filename = path.join(temp.directory, 'grouped.xlsx'); await wb.xlsx.writeFile(filename);
    const draft = await parseImport(filename, { profiles: [], tunnels: [] });
    assert.deepEqual(draft.inputs.get(2)?.profile.groupPath, ['交换机', '上海', '办公网']);
    assert.deepEqual(draft.inputs.get(3)?.profile.groupPath, ['路由器']);
    assert.match(draft.preview.rows[2].error!, /上一级/);
    assert.deepEqual(draft.inputs.get(5)?.profile.groupPath, ['防火墙', '北京', '生产网']);
    assert.match(draft.preview.rows[4].error!, /不一致/); assert.match(draft.preview.rows[5].error!, /三级/);
    assert.equal(draft.preview.rows[0].group, '交换机 / 上海 / 办公网'); assert.ok(draft.inputs.has(8));
  } finally { await temp.cleanup(); }
});
test('Excel exports group levels separately and round-trips old and new profiles without credentials', async () => {
  const temp = await tempStore();
  try {
    const profiles = [profile(22, { host: '192.0.2.10', groupPath: ['交换机', '上海', '办公网'] }), profile(22, { host: '192.0.2.11', group: '原有/一级分组' }), profile(22, { host: '192.0.2.12', group: '未分组', groupPath: [] })];
    const filename = path.join(temp.directory, 'export.xlsx'); await exportProfiles(filename, { profiles, tunnels: [] });
    const draft = await parseImport(filename, { profiles: [], tunnels: [] });
    assert.deepEqual(draft.inputs.get(2)?.profile.groupPath, ['交换机', '上海', '办公网']);
    assert.deepEqual(draft.inputs.get(3)?.profile.groupPath, ['原有/一级分组']);
    assert.deepEqual(draft.inputs.get(4)?.profile.groupPath, []);
    assert.ok(draft.preview.rows.every(row => !row.hasSecret && !row.error));
  } finally { await temp.cleanup(); }
});
