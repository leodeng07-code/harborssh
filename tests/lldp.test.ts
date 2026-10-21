import { test } from 'node:test';
import assert from 'node:assert/strict';
import snmp, { type Varbind } from 'net-snmp';
import { SnmpService } from '../electron/snmp';
import { LLDP_OIDS, parseLldp } from '../electron/lldp';
import { profile, tempStore } from './helpers';
import { snmpFixture } from './snmp-fixture';

test('real UDP LLDP: composite indices, multiple neighbors on one port, MAC/network identifiers, BITS and IPv4/IPv6 addresses', async () => {
  const fixture = await snmpFixture(), storage = await tempStore(), service = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p });
    await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
    const result = await service.lldp(p.id);
    assert.equal(result.available, true); assert.equal(result.localName, '本地 LLDP 交换机'); assert.equal(result.neighbors.length, 3);
    const [core, ap, unknown] = result.neighbors;
    assert.equal(core.key, '12345.7.1'); assert.equal(core.localPortNumber, 7); assert.equal(core.localPortId, 'GE0/0/7');
    assert.equal(core.systemName, 'CORE-SW-01'); assert.equal(core.chassisId, 'AA:BB:CC:DD:EE:FF'); assert.equal(core.portId, 'Ten-GigabitEthernet1/0/48');
    assert.deepEqual(core.managementAddresses.sort(), ['192.0.2.10', '2001:db8::10']);
    assert.deepEqual(core.enabledCapabilities, ['网桥/交换机', '路由器']);
    assert.equal(ap.localPortNumber, 7); assert.equal(ap.remoteIndex, 2); assert.equal(ap.chassisId, '192.0.2.25'); assert.equal(ap.portId, '00:11:22:33:44:66');
    assert.deepEqual(ap.managementAddresses, ['192.0.2.25']); assert.deepEqual(ap.enabledCapabilities, ['无线 AP']);
    assert.equal(unknown.localPortId, 'local-port-8'); assert.equal(unknown.systemName, ''); assert.deepEqual(unknown.managementAddresses, []);
    assert.ok(!JSON.stringify(result).includes('192.0.2.99')); assert.ok(!JSON.stringify(result).includes('fixture-read'));
    assert.equal(fixture.writes.length, 0); assert.deepEqual(result.warnings, []);
  } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
});

test('LLDP distinguishes readable empty tables from unavailable MIB data', async () => {
  for (const lldp of ['empty', 'unavailable'] as const) {
    const fixture = await snmpFixture({ lldp }), storage = await tempStore(), service = new SnmpService(storage.store);
    try {
      const p = profile(22); await storage.store.saveProfile({ profile: p });
      await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
      const result = await service.lldp(p.id); assert.equal(result.available, lldp === 'empty'); assert.deepEqual(result.neighbors, []);
    } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
  }
});

test('LLDP keeps unnamed neighbors and rejects malformed indices without assigning an ifIndex', () => {
  const cell = (oid: string, value: Varbind['value']): Varbind => ({ oid, value, type: snmp.ObjectType.OctetString });
  const remote = [cell(`${LLDP_OIDS.remote}.5.42.27.1`, Buffer.from('abcd')), cell(`${LLDP_OIDS.remote}.7.42.27.1`, Buffer.from('uplink')), cell(`${LLDP_OIDS.remote}.7.42.27`, 'bad')];
  const management = [cell(`${LLDP_OIDS.management}.3.42.27.1.1.5.192.0.2.1`, 2)];
  const warnings: string[] = [], result = parseLldp(remote, [], management, warnings);
  assert.equal(result.length, 1); assert.equal(result[0].localPortNumber, 27); assert.equal(result[0].localPortId, '');
  assert.equal(result[0].systemName, ''); assert.equal(result[0].portId, 'uplink'); assert.deepEqual(result[0].managementAddresses, []);
  assert.equal('ifIndex' in result[0], false); assert.ok(warnings.length > 0);
});
