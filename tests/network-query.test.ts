import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Varbind } from 'net-snmp';
import { IP_OIDS, matchingRoutes, parseRoutes, ipv4, prefixFromMask } from '../electron/ip-mib';
import { NetworkQueryService, queryRequest } from '../electron/network-query';
import { SnmpService } from '../electron/snmp';
import { Store } from '../electron/store';
import { profile, tempStore, until } from './helpers';
import { snmpFixture, testMappings } from './snmp-fixture';

const variable = (oid: string, value: unknown): Varbind => ({ oid, type: typeof value === 'number' ? 2 : 4, value } as Varbind);
test('query validation accepts four MAC forms, IPv4 fragments and rejects commands, malformed input and broad scans', () => {
  const p = profile(22);
  for (const query of ['aabb.ccdd.eeff', 'aabb-ccdd-eeff', 'AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff']) assert.equal(queryRequest({ profileIds: [p.id], kind: 'auto', query }).query, 'AA:BB:CC:DD:EE:FF');
  for (const query of ['192.0.2.99', '172.23.', '192']) assert.equal(queryRequest({ profileIds: [p.id], kind: 'arp', query }).query, query);
  for (const query of ['999.1.1.1', '192.0.2.1;display', '2001:db8::1', 'aaaa-bbbb.cccc', '192.0.2.1/24']) assert.throws(() => queryRequest({ profileIds: [p.id], kind: 'auto', query }));
  assert.throws(() => queryRequest({ profileIds: [p.id, randomUUID()], kind: 'routes', query: '' }), /填写/);
  assert.throws(() => queryRequest({ profileIds: [p.id], kind: 'routes', query: '192.0.2.' }), /完整 IPv4/);
  assert.equal(ipv4('255.255.255.255'), 4294967295); assert.equal(ipv4('01.1.1.1'), undefined);
  assert.equal(prefixFromMask('0.0.0.0'), 0); assert.equal(prefixFromMask('255.255.255.255'), 32); assert.equal(prefixFromMask('255.0.255.0'), undefined);
});
test('inetCidr variable-length policy, direct next-hop and reject routes retain identity; longest prefix keeps ECMP', () => {
  const make = (index: number[], type: number) => [variable(`${IP_OIDS.inetCidr}.7.${index.join('.')}`, 101), variable(`${IP_OIDS.inetCidr}.8.${index.join('.')}`, type), variable(`${IP_OIDS.inetCidr}.17.${index.join('.')}`, 1)];
  const a = [1, 4, 192, 0, 2, 0, 24, 2, 0, 0, 1, 4, 192, 0, 2, 254];
  const b = [1, 4, 192, 0, 2, 0, 24, 3, 1, 3, 6, 1, 4, 192, 0, 2, 253];
  const direct = [1, 4, 192, 0, 2, 200, 32, 2, 0, 0, 0, 0];
  const rows = parseRoutes([...make(a, 4), ...make(b, 4), ...make(direct, 2)], 'inetCidr');
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.key)).size, 3);
  assert.equal(matchingRoutes(rows, '192.0.2.99').length, 2);
  const rejected = matchingRoutes(rows, '192.0.2.200'); assert.equal(rejected.length, 1); assert.equal(rejected[0].type, '拒绝'); assert.equal(rejected[0].nextHop, '');
  assert.equal(matchingRoutes(rows, '203.0.113.1').length, 0);
});
for (const mode of ['legacy', 'cidr', 'modern'] as const) test(`real UDP ${mode}: ARP/IP brief/longest-prefix route and auto IP/MAC are read-only`, async () => {
  const fixture = await snmpFixture({ ipTables: mode }), storage = await tempStore(), snmp = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
    const arp = await snmp.query(p.id, 'arp', '192.0.2.99'); assert.equal(arp.available, true); assert.equal(arp.rows.length, 1); assert.equal(arp.rows[0].mac, 'AA:BB:CC:DD:EE:FF'); assert.equal(arp.rows[0].ifIndex, 101); assert.equal(arp.rows[0].interfaceName, 'GE0/0/7');
    const invalidArp = await snmp.query(p.id, 'arp', '192.0.2.77'); assert.equal(invalidArp.rows.length, 0);
    const brief = await snmp.query(p.id, 'ipInterfaces', ''); assert.equal(brief.rows.length, mode === 'modern' ? 1 : 2); assert.equal(brief.rows[0].mask, '255.255.255.0'); assert.equal(brief.rows[0].prefixLength, 24); assert.equal(brief.rows[0].adminStatus, 1); assert.equal(brief.rows[0].operStatus, 1);
    const routes = await snmp.query(p.id, 'routes', '192.0.2.99'); assert.equal(routes.rows.length, mode === 'legacy' ? 1 : 2); assert.ok(routes.rows.every(row => row.prefixLength === 24));
    if (mode !== 'modern') { const fallback = await snmp.query(p.id, 'routes', '1.1.1.1'); assert.equal(fallback.rows.length, 1); assert.equal(fallback.rows[0].prefixLength, 0); }
    else { const reject = await snmp.query(p.id, 'routes', '192.0.2.200'); assert.equal(reject.rows[0].type, '拒绝'); }
    const auto = await snmp.query(p.id, 'auto', '192.0.2.1'); assert.ok(auto.rows.some(row => row.kind === 'ipInterfaces')); assert.ok(auto.rows.some(row => row.kind === 'routes'));
    const mac = await snmp.query(p.id, 'auto', 'AA:BB:CC:DD:EE:FF'); assert.ok(mac.rows.some(row => row.kind === 'arp')); assert.ok(mac.rows.some(row => row.kind === 'mac')); assert.deepEqual(mac.rows.find(row => row.kind === 'mac')!.vlans, [20]);
    assert.equal(fixture.writes.length, 0);
  } finally { snmp.dispose(); await fixture.close(); await storage.cleanup(); }
});
test('unavailable tables are distinguished from readable non-matches and unassigned IPv4 is not asserted', async () => {
  const fixture = await snmpFixture({ ipTables: 'unavailable' }), storage = await tempStore(), snmp = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' });
    for (const kind of ['arp', 'routes'] as const) { const result = await snmp.query(p.id, kind, '192.0.2.99'); assert.equal(result.available, false); assert.equal(result.rows.length, 0); assert.match(result.warnings.join(' '), /为空|权限|未开放/); }
    const brief = await snmp.query(p.id, 'ipInterfaces', ''); assert.equal(brief.rows[0].ip, undefined); assert.ok(brief.warnings.length);
    const controller = new AbortController(); controller.abort(); await assert.rejects(() => snmp.query(p.id, 'arp', '', controller.signal));
  } finally { snmp.dispose(); await fixture.close(); await storage.cleanup(); }
});
test('network jobs bound concurrency, retain errors and partial results, cancel in-flight/queued work and exclude unconfigured devices', async () => {
  const storage = await tempStore(); let active = 0, maximum = 0, started = 0, cancelled = 0;
  const devices = Array.from({ length: 8 }, (_, i) => profile(22, { name: `device-${i}` }));
  let slow = false;
  const fake = { query: async (id: string, _kind: string, _query: string, signal: AbortSignal) => {
    active++; started++; maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(done, slow ? 10000 : 30); function abort() { clearTimeout(timer); cancelled++; reject(new Error('cancelled')); } function done() { signal.removeEventListener('abort', abort); resolve(); } signal.addEventListener('abort', abort, { once: true }); });
      if (id === devices[1].id) throw new Error('设备超时');
      return { rows: [{ key: 'test', kind: 'arp', source: 'fixture', interfaceName: 'GE1', ip: '192.0.2.99' }], warnings: id === devices[2].id ? ['部分表未开放'] : [], available: true, readAt: Date.now() };
    } finally { active--; }
  } } as unknown as SnmpService;
  const service = new NetworkQueryService(storage.store, fake);
  try {
    await storage.store.importProfiles(devices.map(p => ({ profile: p })));
    assert.throws(() => service.start({ profileIds: [devices[0].id], kind: 'arp', query: '' }), /尚未配置/);
    await storage.store.saveSnmpBatch({ profileIds: devices.map(p => p.id), readCommunity: 'uniform-secret' });
    const request = { profileIds: devices.map(p => p.id), kind: 'arp', query: '192.0.2.99' };
    const id = service.start(request); assert.throws(() => service.start(request), /上一轮/);
    await until(() => service.read(id).status === 'done'); const result = service.read(id);
    assert.equal(maximum, 3); assert.equal(result.devices.filter(d => d.status === 'error').length, 1); assert.equal(result.devices.filter(d => d.data?.rows.length).length, 7); assert.ok(!JSON.stringify(result).includes('uniform-secret'));
    slow = true; const before = started, second = service.start(request); await until(() => active === 3); service.cancel(second); await until(() => service.read(second).status === 'cancelled'); assert.equal(started - before, 3); assert.equal(cancelled, 3); assert.equal(service.read(second).devices.filter(d => d.status === 'cancelled').length, 8);
    slow = false; const third = service.start(request); await until(() => service.read(third).status === 'done'); assert.throws(() => service.read(id), /过期/);
    slow = true; const fourth = service.start(request); await until(() => active === 3); service.pause(); await until(() => service.read(fourth).status === 'cancelled'); assert.equal(active, 0);
    service.dispose(); assert.throws(() => service.start(request), /已关闭/);
  } finally { service.dispose(); await storage.cleanup(); }
});
test('uniform community applies atomically, preserves UDP ports and MIB mappings, retains optional write secrets and survives restart encrypted', async () => {
  const storage = await tempStore();
  try {
    const a = profile(22), b = profile(22); await storage.store.importProfiles([{ profile: a }, { profile: b }]);
    await storage.store.saveSnmp({ profileId: a.id, port: 1161, readCommunity: 'old', writeCommunity: 'old-write-secret', parameters: testMappings });
    const original = await fs.readFile(path.join(storage.directory, 'config.json'), 'utf8');
    await assert.rejects(() => storage.store.saveSnmpBatch({ profileIds: [a.id, randomUUID()], readCommunity: 'must-rollback' }), /不存在/);
    assert.equal(await fs.readFile(path.join(storage.directory, 'config.json'), 'utf8'), original);
    await storage.store.saveSnmpBatch({ profileIds: [a.id, b.id, a.id], readCommunity: 'new-uniform-secret' });
    const config = storage.store.config(); assert.equal(config.snmp?.length, 2); assert.equal(config.snmp?.find(t => t.profileId === a.id)?.port, 1161); assert.equal(config.snmp?.find(t => t.profileId === b.id)?.port, 161); assert.deepEqual(config.snmp?.find(t => t.profileId === a.id)?.parameters, testMappings);
    assert.equal((await storage.store.snmpSecrets(a.id)).writeCommunity, 'old-write-secret');
    const disk = await fs.readFile(path.join(storage.directory, 'config.json'), 'utf8'); for (const secret of ['new-uniform-secret', 'old-write-secret']) { assert.ok(!disk.includes(secret)); assert.ok(!JSON.stringify(config).includes(secret)); }
    const restarted = new Store(storage.directory, storage.vault); await restarted.load(); assert.equal((await restarted.snmpSecrets(b.id)).readCommunity, 'new-uniform-secret');
    await restarted.saveSnmpBatch({ profileIds: [a.id, b.id], port: 2161, readCommunity: 'final', clearWrite: true }); assert.equal((await restarted.snmpSecrets(a.id)).writeCommunity, undefined); assert.ok(restarted.config().snmp?.every(t => t.port === 2161));
  } finally { await storage.cleanup(); }
});

test('cancelling a real UDP query closes retry timers and releases SNMP slots immediately', async () => {
  const { default: dgram } = await import('node:dgram');
  const socket = dgram.createSocket('udp4'); await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const storage = await tempStore(), service = new SnmpService(storage.store); let packets = 0; socket.on('message', () => packets++);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: socket.address().port, readCommunity: 'do-not-log-this-community' });
    const controller = new AbortController(), pending = service.query(p.id, 'arp', '', controller.signal);
    await until(() => packets > 0); const start = Date.now(); controller.abort(); await assert.rejects(() => pending); assert.ok(Date.now() - start < 500);
    const before = packets; await new Promise(resolve => setTimeout(resolve, 2000)); assert.equal(packets, before, 'an aborted query must not retry in the background');
    const fixture = await snmpFixture();
    try { await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read' }); assert.equal((await service.query(p.id, 'arp', '192.0.2.99')).rows.length, 1); }
    finally { await fixture.close(); }
  } finally { service.dispose(); await new Promise<void>(resolve => socket.close(resolve)); await storage.cleanup(); }
});
