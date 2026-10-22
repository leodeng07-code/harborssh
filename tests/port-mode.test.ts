import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Varbind } from 'net-snmp';
import type { MacMatch } from '../shared/types';
import { choiceMode, modeKey, PORT_MODE_OIDS, readPortModes } from '../electron/port-mode';
import { SnmpService } from '../electron/snmp';
import { profile, tempStore } from './helpers';
import { snmpFixture, testMappings } from './snmp-fixture';
const match: MacMatch = { bridgePort: 7, ifIndex: 101, interfaceName: 'GE0/0/7', source: 'Q-BRIDGE', vlans: [20] };
const value = (oid: string, v: number): Varbind => ({ oid, type: 2, value: v });

test('mode labels are explicit; access is never inferred from VLAN count/PVID or a negated Trunk label', () => {
  for (const name of ['Access', '接入口', 'ACCESS 模式']) assert.equal(choiceMode(name), 'access');
  for (const name of ['Trunk', '中继口', '干道']) assert.equal(choiceMode(name), 'trunk');
  assert.equal(choiceMode('Hybrid'), 'hybrid');
  for (const name of ['非Trunk', 'Not Trunk', 'auto', 'uplink', '1', 'Unknown', 'Access/Trunk']) assert.equal(choiceMode(name), 'unknown');
});
for (const vendor of ['h3c', 'huawei'] as const) for (const [modeValue, expected] of [[1, 'trunk'], [2, 'access'], [3, 'hybrid'], [99, 'unknown']] as const) test(`real UDP ${vendor}: mode ${modeValue} is ${expected}, vendor row indices are mapped rather than guessed`, async () => {
  const fixture = await snmpFixture({ portMode: vendor, modeValue }), storage = await tempStore(), service = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
    const result = await service.mac(p.id, 'aabb-ccdd-eeff'); assert.equal(result.matches.length, 1); assert.equal(result.matches[0].portMode?.kind, expected); assert.equal(result.matches[0].portMode?.value, modeValue);
    assert.ok(result.matches[0].portMode?.oid?.endsWith(vendor === 'h3c' ? '.909' : '.55'));
    assert.equal(result.matches[0].ifIndex, 101); assert.deepEqual(result.matches[0].vlans, [20]); assert.equal(fixture.writes.length, 0);
    const network = await service.query(p.id, 'mac', 'AA:BB:CC:DD:EE:FF'); assert.equal(network.rows[0].portMode?.kind, expected);
    if (expected === 'unknown') assert.match(result.warnings.join(' '), /保持展开/);
  } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
});
test('Huawei active mode overrides configured mode; invalid active mode never falls back to configured Trunk', async () => {
  for (const activeMode of [2, 0]) {
    const fixture = await snmpFixture({ portMode: 'huawei', modeValue: 1, activeMode }), storage = await tempStore(), service = new SnmpService(storage.store);
    try {
      const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
      const result = await service.mac(p.id, 'aabb.ccdd.eeff'); assert.equal(result.matches[0].portMode?.kind, activeMode === 2 ? 'access' : 'unknown'); assert.equal(result.matches[0].portMode?.source, '华为生效模式'); assert.equal(fixture.writes.length, 0);
    } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
  }
});
test('explicit MIB enum mapping is authoritative and does not reuse vendor numeric meanings', async () => {
  const fixture = await snmpFixture({ portMode: 'h3c', modeValue: 1 }), storage = await tempStore(), service = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read', parameters: testMappings });
    const result = await service.mac(p.id, 'aabb.ccdd.eeff'); assert.equal(result.matches[0].portMode?.kind, 'access'); assert.equal(result.matches[0].portMode?.source, 'MIB 适配');
    fixture.mib.setTableSingleCell('vendor', 3, [101], 2); assert.equal((await service.mac(p.id, 'aabb.ccdd.eeff')).matches[0].portMode?.kind, 'trunk');
    fixture.mib.setTableSingleCell('vendor', 3, [101], 99); assert.equal((await service.mac(p.id, 'aabb.ccdd.eeff')).matches[0].portMode?.kind, 'unknown'); assert.equal(fixture.writes.length, 0);
  } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
});
test('optional table failures, ambiguous mappings and unknown vendors preserve visible FDB hits; empty results cause no mode requests', async () => {
  const reader = { walk: async (oid: string) => oid === PORT_MODE_OIDS.h3cBridge ? [value(`${oid}.909`, 7), value(`${oid}.910`, 7)] : [value(`${oid}.909`, 1)], get: async (_oids: string[]) => [] as Varbind[] };
  const ambiguous = await readPortModes(reader, [match], '1.3.6.1.4.1.25506.11.1'); assert.equal(ambiguous.get(modeKey(match))?.kind, 'unknown');
  const failed = { ...reader, walk: async () => { throw new Error('No access'); } };
  const missing = await readPortModes(failed, [match], '1.3.6.1.4.1.25506.11.1'); assert.equal(missing.get(modeKey(match))?.kind, 'unknown');
  let requested = 0; const counter = { walk: async () => { requested++; return []; }, get: async () => { requested++; return []; } };
  const unknownVendor = await readPortModes(counter, [match], '1.3.6.1.4.1.8072.3.2.10'); assert.equal(unknownVendor.get(modeKey(match))?.kind, 'unknown'); assert.equal(requested, 0);
  assert.equal((await readPortModes(counter, [], '1.3.6.1.4.1.25506.11.1')).size, 0); assert.equal(requested, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => readPortModes(counter, [match], '1.3.6.1.4.1.25506.11.1', undefined, controller.signal));
});
test('custom bridge-port mapping is read by bridge index and repeated VLAN matches share one mode read', async () => {
  let gets = 0;
  const definition = { ...testMappings[2], index: 'bridgePort' as const };
  const reader = { walk: async () => [] as Varbind[], get: async (oids: string[]) => { gets++; assert.deepEqual(oids, [`${definition.oid}.7`]); return [value(oids[0], 2)]; } };
  const result = await readPortModes(reader, [match, { ...match, vlans: [30] }], '', definition); assert.equal(gets, 1); assert.equal(result.get(modeKey(match))?.kind, 'trunk');
  const unmapped = await readPortModes(reader, [{ ...match, ifIndex: undefined }], '', testMappings[2]); assert.equal(unmapped.get(modeKey({ ...match, ifIndex: undefined }))?.kind, 'unknown'); assert.equal(gets, 1);
});

test('vendor-only enum values are not reused across H3C and Huawei', async () => {
  const h3c = { get: async () => [] as Varbind[], walk: async (oid: string) => [value(`${oid}.909`, oid === PORT_MODE_OIDS.h3cBridge ? 7 : 5)] };
  assert.equal((await readPortModes(h3c, [match], '1.3.6.1.4.1.25506.11.1')).get(modeKey(match))?.kind, 'unknown');
  const huawei = { get: async () => [] as Varbind[], walk: async (oid: string) => oid === PORT_MODE_OIDS.huaweiActiveMode ? [] : [value(`${oid}.55`, oid === PORT_MODE_OIDS.huaweiIfIndex ? 101 : 5)] };
  const actual = (await readPortModes(huawei, [match], '1.3.6.1.4.1.2011.2.23.1')).get(modeKey(match)); assert.equal(actual?.kind, 'other'); assert.equal(actual?.label, 'QinQ');
});
