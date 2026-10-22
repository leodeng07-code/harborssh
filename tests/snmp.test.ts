import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { Store } from '../electron/store';
import { normalizeMac, SnmpService } from '../electron/snmp';
import { interfaceChangeSchema, snmpConfigSchema } from '../electron/validation';
import { profile, tempStore } from './helpers';
import { snmpFixture, testMappings } from './snmp-fixture';

test('MAC inputs and unsafe mappings are validated', () => {
  for (const input of ['aabbccddeeff', 'aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'aabb.ccdd.eeff', 'aabb-ccdd-eeff']) assert.equal(normalizeMac(input), 'AA:BB:CC:DD:EE:FF');
  for (const input of ['AA:BB:CC', 'aa-bb:cc-dd-ee-ff', 'prefixaabbccddeeff', 'GG:BB:CC:DD:EE:FF']) assert.throws(() => normalizeMac(input));
  const p = profile(22);
  assert.equal(interfaceChangeSchema.safeParse({ profileId: p.id, index: 1, field: 'adminStatus', value: 7, expected: 1 }).success, false);
  assert.equal(interfaceChangeSchema.safeParse({ profileId: p.id, index: 1, field: 'alias', value: '中'.repeat(22), expected: '' }).success, false);
  assert.equal(snmpConfigSchema.safeParse({ profileId: p.id, port: 161, parameters: [{ ...testMappings[0], choices: [{ label: 'invalid', value: '1000' }] }] }).success, false);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 10001 }, { retries: 3 }, { maxRepetitions: 0 }]) assert.equal(snmpConfigSchema.safeParse({ profileId: p.id, port: 161, ...options }).success, false);
});

test('SNMP timeout identifies transport/GET without disclosing community, and per-device tuning supports slow responses and survives shared setup/restart', async () => {
  const fixture = await snmpFixture(), storage = await tempStore(), service = new SnmpService(storage.store), relay = dgram.createSocket('udp4');
  const { Ber } = createRequire(import.meta.url)('asn1-ber'); let requester: dgram.RemoteInfo | undefined; const repetitions: number[] = [], timers = new Set<NodeJS.Timeout>();
  relay.on('message', (packet, remote) => {
    if (remote.port === fixture.port) { if (!requester) return; const target = requester; const timer = setTimeout(() => { timers.delete(timer); relay.send(packet, target.port, target.address); }, 700); timers.add(timer); return; }
    requester = remote;
    const reader = new Ber.Reader(packet); reader.readSequence(); reader.readInt(); reader.readString();
    if (reader.peek() === 165) { reader.readSequence(165); reader.readInt(); reader.readInt(); repetitions.push(reader.readInt()); }
    relay.send(packet, fixture.port, '127.0.0.1');
  });
  await new Promise<void>(resolve => relay.bind(0, '127.0.0.1', resolve)); const port = (relay.address() as { port: number }).port;
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p });
    await storage.store.saveSnmp({ profileId: p.id, port, readCommunity: 'fixture-read', timeoutMs: 500, retries: 0 });
    await assert.rejects(service.interfaces(p.id), error => { const message = (error as Error).message; assert.match(message, /未收到设备响应.*UDP.*GET/); assert.ok(!message.includes('fixture-read')); return true; });
    await storage.store.saveSnmp({ profileId: p.id, port, timeoutMs: 1500, retries: 1, maxRepetitions: 5 });
    const data = await service.interfaces(p.id); assert.equal(data.interfaces[0].index, 101); assert.ok(repetitions.length > 0 && repetitions.every(n => n === 5));
    await storage.store.saveSnmpBatch({ profileIds: [p.id], readCommunity: 'fixture-read' });
    const restarted = new Store(storage.directory, storage.vault); await restarted.load(); const target = restarted.config().snmp![0];
    assert.equal(target.timeoutMs, 1500); assert.equal(target.retries, 1); assert.equal(target.maxRepetitions, 5); assert.equal(target.port, port); assert.equal(fixture.writes.length, 0);
  } finally { service.dispose(); for (const timer of timers) clearTimeout(timer); await new Promise<void>(resolve => relay.close(resolve)); await fixture.close(); await storage.cleanup(); }
});
test('SNMP communities survive restart encrypted, are never exposed in config and delete with profile', async () => {
  const storage = await tempStore();
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p, secrets: { password: 'ssh-secret' } });
    await storage.store.saveSnmp({ profileId: p.id, port: 161, readCommunity: 'private-read-secret', writeCommunity: 'private-write-secret', parameters: testMappings });
    await storage.store.saveSnmp({ profileId: p.id, port: 1161 });
    await storage.store.saveProfile({ profile: { ...p, name: 'renamed' } });
    const saved = await fs.readFile(path.join(storage.directory, 'config.json'), 'utf8'); assert.ok(!saved.includes('private-read-secret') && !saved.includes('private-write-secret') && !saved.includes('ssh-secret'));
    assert.ok(!JSON.stringify(storage.store.config()).includes('private-read-secret'));
    const restarted = new Store(storage.directory, storage.vault); await restarted.load();
    assert.deepEqual(await restarted.snmpSecrets(p.id), { readCommunity: 'private-read-secret', writeCommunity: 'private-write-secret' });
    assert.equal((await restarted.secrets(p.id)).password, 'ssh-secret');
    await restarted.saveSnmp({ profileId: p.id, port: 161, clearWrite: true });
    assert.equal((await restarted.snmpSecrets(p.id)).writeCommunity, undefined);
    await restarted.deleteProfiles([p.id]); assert.deepEqual(restarted.config().snmp, []);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(storage.directory, 'config.json'), 'utf8')).snmpCredentials).length, 0);
  } finally { await storage.cleanup(); }
});

test('SNMP GETBULK timeout retries a complete column at five rows and uses the smaller batch for subsequent columns', async () => {
  const fixture = await snmpFixture(), storage = await tempStore(), service = new SnmpService(storage.store), relay = dgram.createSocket('udp4');
  const { Ber } = createRequire(import.meta.url)('asn1-ber'); let requester: dgram.RemoteInfo | undefined; const batches: number[] = [];
  relay.on('message', (packet, remote) => {
    if (remote.port === fixture.port) { if (requester) relay.send(packet, requester.port, requester.address); return; }
    requester = remote; const reader = new Ber.Reader(packet); reader.readSequence(); reader.readInt(); reader.readString();
    if (reader.peek() === 165) { reader.readSequence(165); reader.readInt(); reader.readInt(); const batch = reader.readInt(); batches.push(batch); if (batch > 5) return; }
    relay.send(packet, fixture.port, '127.0.0.1');
  });
  await new Promise<void>(resolve => relay.bind(0, '127.0.0.1', resolve));
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p }); await storage.store.saveSnmp({ profileId: p.id, port: (relay.address() as { port: number }).port, readCommunity: 'fixture-read', timeoutMs: 500, retries: 0 });
    const data = await service.interfaces(p.id); assert.equal(data.interfaces.length, 1); assert.equal(data.interfaces[0].name, 'GE0/0/7');
    assert.equal(batches[0], 30); assert.ok(batches.length > 2 && batches.slice(1).every(batch => batch === 5)); assert.equal(fixture.writes.length, 0);
  } finally { service.dispose(); await new Promise<void>(resolve => relay.close(resolve)); await fixture.close(); await storage.cleanup(); }
});
test('real UDP SNMP v2c: interface reads, PVID bridge mapping, vendor settings, readback and MAC VLAN/port mapping', async () => {
  const fixture = await snmpFixture(), storage = await tempStore(), service = new SnmpService(storage.store);
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p });
    await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read', parameters: testMappings });
    const snapshot = await service.interfaces(p.id), iface = snapshot.interfaces[0];
    assert.equal(snapshot.name, '测试交换机'); assert.equal(iface.index, 101); assert.equal(iface.name, 'GE0/0/7'); assert.equal(iface.bridgePort, 7); assert.equal(iface.parameters.pvid, 20); assert.equal(iface.speedMbps, 1000); assert.equal(iface.duplexStatus, 3);
    await assert.rejects(() => service.change({ profileId: p.id, index: 101, field: 'adminStatus', expected: 1, value: 2 }), /读写/); assert.equal(fixture.writes.length, 0);
    await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, writeCommunity: 'fixture-write' });
    for (const [field, expected, value] of [['adminStatus', 1, 2], ['alias', '办公区', '新的描述'], ['pvid', 20, 30], ['speed', 0, 1000], ['duplex', 0, 1], ['vlanMode', 1, 2]] as const) {
      const result = await service.change({ profileId: p.id, index: 101, field, expected, value }); assert.equal(result.verified, true, result.message);
    }
    await assert.rejects(() => service.change({ profileId: p.id, index: 101, field: 'adminStatus', expected: 1, value: 2 }), /已变化/);
    await assert.rejects(() => service.change({ profileId: p.id, index: 101, field: 'speed', expected: 1000, value: 4000 }), /枚举/);
    const q = await service.mac(p.id, 'aabb.ccdd.eeff'); assert.equal(q.matches.length, 1); assert.equal(q.matches[0].ifIndex, 101); assert.equal(q.matches[0].bridgePort, 7); assert.equal(q.matches[0].fdbId, 77); assert.deepEqual(q.matches[0].vlans, [20]); assert.equal(q.matches[0].interfaceName, 'GE0/0/7');
    const classic = await service.mac(p.id, '00-11-22-33-44-55'); assert.equal(classic.matches[0].source, 'BRIDGE'); assert.equal(classic.matches[0].ifIndex, 101);
    assert.deepEqual((await service.mac(p.id, '1234.5678.9abc')).matches, []);
  } finally { service.dispose(); await fixture.close(); await storage.cleanup(); }
});

test('SNMP rejected and lost SET responses never report verified success or retry the write', async () => {
  const fixture = await snmpFixture(), storage = await tempStore(), service = new SnmpService(storage.store);
  const proxy = dgram.createSocket('udp4');
  let requester: dgram.RemoteInfo | undefined, dropResponse = false, writes = 0;
  const { Ber } = createRequire(import.meta.url)('asn1-ber');
  proxy.on('message', (packet, remote) => {
    if (remote.port === fixture.port) { if (dropResponse) { dropResponse = false; return; } if (requester) proxy.send(packet, requester.port, requester.address); return; }
    requester = remote;
    const reader = new Ber.Reader(packet); reader.readSequence(); reader.readInt(); reader.readString();
    if (reader.peek() === 163) { dropResponse = true; writes++; }
    proxy.send(packet, fixture.port, '127.0.0.1');
  });
  await new Promise<void>(r => proxy.bind(0, '127.0.0.1', r));
  try {
    const p = profile(22); await storage.store.saveProfile({ profile: p });
    await storage.store.saveSnmp({ profileId: p.id, port: fixture.port, readCommunity: 'fixture-read', writeCommunity: 'fixture-read' });
    const denied = await service.change({ profileId: p.id, index: 101, field: 'adminStatus', expected: 1, value: 2 });
    assert.equal(denied.verified, false); assert.equal(fixture.writes.length, 0); assert.equal(fixture.mib.getTableSingleCell('interfaces', 7, [101]), 1);
    await storage.store.saveSnmp({ profileId: p.id, port: proxy.address().port, writeCommunity: 'fixture-write' });
    const lost = await service.change({ profileId: p.id, index: 101, field: 'adminStatus', expected: 1, value: 2 });
    assert.equal(lost.verified, false); assert.match(lost.message, /可能已执行/); assert.equal(writes, 1);
    assert.equal(fixture.mib.getTableSingleCell('interfaces', 7, [101]), 2);
    assert.equal((await service.interfaces(p.id)).interfaces[0].adminStatus, 2);
  } finally { service.dispose(); await new Promise<void>(r => proxy.close(r)); await fixture.close(); await storage.cleanup(); }
});
