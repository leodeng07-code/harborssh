import snmp from 'net-snmp';
import dgram from 'node:dgram';
import type { ParameterDefinition } from '../shared/types';

export const testMappings: ParameterDefinition[] = [
  { field: 'speed', oid: '1.3.6.1.4.1.8072.9999.1.1', index: 'ifIndex', type: 'Integer', choices: [{ label: '自动', value: 0 }, { label: '1000 Mbps', value: 1000 }] },
  { field: 'duplex', oid: '1.3.6.1.4.1.8072.9999.1.2', index: 'ifIndex', type: 'Integer', choices: [{ label: '自动', value: 0 }, { label: '全双工', value: 1 }] },
  { field: 'vlanMode', oid: '1.3.6.1.4.1.8072.9999.1.3', index: 'ifIndex', type: 'Integer', choices: [{ label: 'Access', value: 1 }, { label: 'Trunk', value: 2 }] },
];
export async function snmpFixture(options: { lldp?: 'neighbors' | 'empty' | 'unavailable'; ipTables?: 'legacy' | 'cidr' | 'modern' | 'empty' | 'unavailable'; portMode?: 'h3c' | 'huawei'; modeValue?: number; activeMode?: number; portModeIndex?: number } = {}) {
  const socket = dgram.createSocket('udp4'); await new Promise<void>(r => socket.bind(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise<void>(r => socket.close(r));
  const agent = snmp.createAgent({ port, address: '127.0.0.1', accessControlModelType: snmp.AccessControlModelType.Simple }, () => {});
  const authorizer = agent.getAuthorizer(); authorizer.addCommunity('fixture-read'); authorizer.addCommunity('fixture-write');
  authorizer.getAccessControlModel().setCommunityAccess('fixture-write', snmp.AccessLevel.ReadWrite);
  const mib = agent.getMib(), writes: string[] = [];
  const scalar = (name: string, oid: string, type: number, value: unknown) => { mib.registerProvider({ name, oid, type: snmp.MibProviderType.Scalar, scalarType: type, maxAccess: snmp.MaxAccess['read-only'] }); mib.setScalarValue(name, value); };
  const table = (name: string, oid: string, columns: { number: number; name: string; type: number; writable?: boolean }[], indices: string[], rows: unknown[][]) => {
    mib.registerProvider({ name, oid, type: snmp.MibProviderType.Table, maxAccess: snmp.MaxAccess['not-accessible'], tableColumns: columns.map(c => ({ ...c, maxAccess: c.writable ? snmp.MaxAccess['read-write'] : snmp.MaxAccess['read-only'] })), tableIndex: indices.map(columnName => ({ columnName })), handler: (request: any) => { if (request.operation === snmp.PduType.SetRequest) writes.push(request.oid); request.done(); } });
    for (const row of rows) mib.addTableRow(name, row);
  };
  const I = snmp.ObjectType.Integer, S = snmp.ObjectType.OctetString;
  scalar('systemName', '1.3.6.1.2.1.1.5', S, '测试交换机'); scalar('systemDescription', '1.3.6.1.2.1.1.1', S, 'Local SNMP integration fixture'); scalar('systemObject', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, options.portMode === 'h3c' ? '1.3.6.1.4.1.25506.11.1.1' : options.portMode === 'huawei' ? '1.3.6.1.4.1.2011.2.23.1' : '1.3.6.1.4.1.8072.3.2.10');
  table('interfaces', '1.3.6.1.2.1.2.2.1', [{ number: 1, name: 'ifIndex', type: I }, { number: 2, name: 'ifDescr', type: S }, { number: 5, name: 'ifSpeed', type: snmp.ObjectType.Gauge }, { number: 6, name: 'ifMac', type: S }, { number: 7, name: 'ifAdmin', type: I, writable: true }, { number: 8, name: 'ifOper', type: I }], ['ifIndex'], [[101, 'GigabitEthernet0/0/7', 1_000_000_000, Buffer.from('001122334455', 'hex'), 1, 1]]);
  table('extended', '1.3.6.1.2.1.31.1.1.1', [{ number: 1, name: 'ifName', type: S }, { number: 15, name: 'ifHighSpeed', type: snmp.ObjectType.Gauge }, { number: 18, name: 'ifAlias', type: S, writable: true }, { number: 99, name: 'xIndex', type: I }], ['xIndex'], [['GE0/0/7', 1000, '办公区', 101]]);
  table('bridge', '1.3.6.1.2.1.17.1.4.1', [{ number: 1, name: 'bridgeIndex', type: I }, { number: 2, name: 'bridgeIf', type: I }], ['bridgeIndex'], [[7, 101]]);
  table('pvid', '1.3.6.1.2.1.17.7.1.4.5.1', [{ number: 1, name: 'portPvid', type: snmp.ObjectType.Gauge, writable: true }, { number: 99, name: 'pvidIndex', type: I }], ['pvidIndex'], [[20, 7]]);
  table('duplex', '1.3.6.1.2.1.10.7.2.1', [{ number: 19, name: 'duplexStatus', type: I }, { number: 99, name: 'duplexIndex', type: I }], ['duplexIndex'], [[3, 101]]);
  table('vendor', '1.3.6.1.4.1.8072.9999.1', [{ number: 1, name: 'vendorSpeed', type: I, writable: true }, { number: 2, name: 'vendorDuplex', type: I, writable: true }, { number: 3, name: 'vendorMode', type: I, writable: true }, { number: 99, name: 'vendorIndex', type: I }], ['vendorIndex'], [[0, 0, 1, 101]]);
  if (options.portMode === 'h3c') table('h3cPortMode', '1.3.6.1.4.1.25506.8.35.1.1.1', [{ number: 5, name: 'h3cVlanType', type: I }, { number: 10, name: 'h3cBasePort', type: I }, { number: 99, name: 'h3cModeIndex', type: I }], ['h3cModeIndex'], [[options.modeValue ?? 1, 7, options.portModeIndex ?? 909]]);
  if (options.portMode === 'huawei') table('huaweiPortMode', '1.3.6.1.4.1.2011.5.25.42.1.1.1.3.1', [{ number: 2, name: 'hwModeIfIndex', type: I }, { number: 3, name: 'hwConfiguredMode', type: I }, ...(options.activeMode === undefined ? [] : [{ number: 32, name: 'hwActiveMode', type: I }]), { number: 99, name: 'hwModeIndex', type: I }], ['hwModeIndex'], [[101, options.modeValue ?? 1, ...(options.activeMode === undefined ? [] : [options.activeMode]), options.portModeIndex ?? 55]]);
  // Deliberately different FDB ID 77, VLAN ID 20, bridge port 7 and ifIndex 101.
  const indexCols = Array.from({ length: 7 }, (_, i) => ({ number: 100 + i, name: `qIndex${i}`, type: I }));
  table('qFdb', '1.3.6.1.2.1.17.7.1.2.2.1', [{ number: 2, name: 'qPort', type: I }, { number: 3, name: 'qStatus', type: I }, ...indexCols], indexCols.map(c => c.name), [[7, 3, 77, 170, 187, 204, 221, 238, 255], [7, 2, 77, 18, 52, 86, 120, 154, 188]]);
  table('vlanMap', '1.3.6.1.2.1.17.7.1.4.2.1', [{ number: 3, name: 'vlanFdb', type: snmp.ObjectType.Gauge }, { number: 100, name: 'timeMark', type: I }, { number: 101, name: 'vlanId', type: I }], ['timeMark', 'vlanId'], [[77, 0, 20]]);
  const bCols = Array.from({ length: 6 }, (_, i) => ({ number: 100 + i, name: `bIndex${i}`, type: I }));
  table('classicFdb', '1.3.6.1.2.1.17.4.3.1', [{ number: 2, name: 'classicPort', type: I }, { number: 3, name: 'classicStatus', type: I }, ...bCols], bCols.map(c => c.name), [[7, 3, 0, 17, 34, 51, 68, 85]]);
  scalar('uptime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 123456);
  const ipMode = options.ipTables || 'cidr';
  const ipTable = (name: string, oid: string, columns: { number: number; name: string; type: number }[], indexLength: number, rows: unknown[][]) => {
    const indices = Array.from({ length: indexLength }, (_, i) => ({ number: 100 + i, name: `${name}Index${i}`, type: I }));
    table(name, oid, [...columns, ...indices], indices.map(column => column.name), rows);
  };
  const A = snmp.ObjectType.IpAddress;
  if (ipMode !== 'unavailable') {
    ipTable('arpTable', '1.3.6.1.2.1.4.22.1', [{ number: 2, name: 'arpMac', type: S }, { number: 3, name: 'arpIp', type: A }, { number: 4, name: 'arpType', type: I }], 5, ipMode === 'empty' || ipMode === 'modern' ? [] : [
      [Buffer.from('aabbccddeeff', 'hex'), '192.0.2.99', 3, 101, 192, 0, 2, 99],
      [Buffer.from('001122334455', 'hex'), '192.0.2.88', 4, 101, 192, 0, 2, 88],
      [Buffer.from('112233445566', 'hex'), '192.0.2.77', 2, 101, 192, 0, 2, 77],
    ]);
    ipTable('addressTable', '1.3.6.1.2.1.4.20.1', [{ number: 1, name: 'addrIp', type: A }, { number: 2, name: 'addrIf', type: I }, { number: 3, name: 'addrMask', type: A }], 4, ipMode === 'empty' || ipMode === 'modern' ? [] : [
      ['192.0.2.1', 101, '255.255.255.0', 192, 0, 2, 1], ['192.0.2.2', 101, '255.255.255.0', 192, 0, 2, 2],
    ]);
  }
  if (ipMode === 'modern') {
    ipTable('neighborTable', '1.3.6.1.2.1.4.35.1', [{ number: 4, name: 'neighborMac', type: S }, { number: 6, name: 'neighborType', type: I }, { number: 7, name: 'neighborState', type: I }, { number: 8, name: 'neighborStatus', type: I }], 7, [
      [Buffer.from('aabbccddeeff', 'hex'), 3, 1, 1, 101, 1, 4, 192, 0, 2, 99],
      [Buffer.from('112233445566', 'hex'), 2, 1, 1, 101, 1, 4, 192, 0, 2, 77],
    ]);
    ipTable('modernAddressTable', '1.3.6.1.2.1.4.34.1', [{ number: 3, name: 'modernAddrIf', type: I }, { number: 5, name: 'modernAddrPrefix', type: snmp.ObjectType.OID }, { number: 10, name: 'modernAddrStatus', type: I }], 6, [
      [101, '1.3.6.1.2.1.4.32.1.5.101.1.4.192.0.2.0.24', 1, 1, 4, 192, 0, 2, 1],
    ]);
    // Variable policy OID lengths and a zero-length direct-route next-hop.
    const inetColumns = [{ number: 7, name: 'inetIf', type: I }, { number: 8, name: 'inetType', type: I }, { number: 9, name: 'inetProto', type: I }, { number: 12, name: 'inetMetric', type: I }, { number: 17, name: 'inetStatus', type: I }];
    // One table provider requires fixed synthetic index width. Different lengths are covered by parser tests.
    ipTable('inetRouteTable', '1.3.6.1.2.1.4.24.7.1', inetColumns, 16, [
      [101, 4, 13, 10, 1, 1, 4, 192, 0, 2, 0, 24, 2, 0, 0, 1, 4, 192, 0, 2, 254],
      [101, 4, 13, 10, 1, 1, 4, 192, 0, 2, 0, 24, 2, 0, 0, 1, 4, 192, 0, 2, 253],
      [101, 2, 3, -1, 1, 1, 4, 192, 0, 2, 200, 32, 2, 0, 0, 1, 4, 0, 0, 0, 0],
    ]);
  }
  if (ipMode === 'cidr') ipTable('cidrRouteTable', '1.3.6.1.2.1.4.24.4.1', [{ number: 5, name: 'cidrIf', type: I }, { number: 6, name: 'cidrType', type: I }, { number: 7, name: 'cidrProto', type: I }, { number: 11, name: 'cidrMetric', type: I }, { number: 16, name: 'cidrStatus', type: I }], 13, [
    [101, 4, 3, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 192, 0, 2, 254],
    [101, 4, 13, 20, 1, 192, 0, 0, 0, 255, 255, 0, 0, 0, 192, 0, 2, 254],
    [101, 4, 13, 10, 1, 192, 0, 2, 0, 255, 255, 255, 0, 0, 192, 0, 2, 254],
    [101, 4, 13, 10, 1, 192, 0, 2, 0, 255, 255, 255, 0, 0, 192, 0, 2, 253],
    [101, 4, 13, 1, 2, 192, 0, 2, 99, 255, 255, 255, 255, 0, 192, 0, 2, 252],
  ]);
  if (ipMode === 'legacy') ipTable('legacyRouteTable', '1.3.6.1.2.1.4.21.1', [{ number: 1, name: 'routeDest', type: A }, { number: 2, name: 'routeIf', type: I }, { number: 3, name: 'routeMetric', type: I }, { number: 7, name: 'routeNext', type: A }, { number: 8, name: 'routeType', type: I }, { number: 9, name: 'routeProto', type: I }, { number: 11, name: 'routeMask', type: A }], 4, [
    ['0.0.0.0', 101, 1, '192.0.2.254', 4, 3, '0.0.0.0', 0, 0, 0, 0],
    ['192.0.2.0', 101, 10, '0.0.0.0', 3, 2, '255.255.255.0', 192, 0, 2, 0],
    ['192.0.2.99', 101, 1, '192.0.2.252', 2, 3, '255.255.255.255', 192, 0, 2, 99],
  ]);
  if (options.lldp !== 'unavailable') {
    scalar('lldpLocalSubtype', '1.0.8802.1.1.2.1.3.1', I, 4); scalar('lldpLocalName', '1.0.8802.1.1.2.1.3.3', S, '本地 LLDP 交换机');
    table('lldpLocalPorts', '1.0.8802.1.1.2.1.3.7.1', [{ number: 2, name: 'lldpPortType', type: I }, { number: 3, name: 'lldpPortId', type: S }, { number: 4, name: 'lldpPortDesc', type: S }, { number: 100, name: 'lldpPortNumber', type: I }], ['lldpPortNumber'], [[5, 'GE0/0/7', '核心上联', 7], [7, 'local-port-8', '测试端口', 8]]);
    const remIndices = [{ number: 100, name: 'remTime', type: I }, { number: 101, name: 'remLocalPort', type: I }, { number: 102, name: 'remIndex', type: I }];
    table('lldpRemote', '1.0.8802.1.1.2.1.4.1.1', [
      { number: 4, name: 'remChassisType', type: I }, { number: 5, name: 'remChassis', type: S }, { number: 6, name: 'remPortType', type: I }, { number: 7, name: 'remPort', type: S }, { number: 8, name: 'remPortDesc', type: S }, { number: 9, name: 'remName', type: S }, { number: 10, name: 'remDescription', type: S }, { number: 11, name: 'remSupported', type: S }, { number: 12, name: 'remEnabled', type: S }, ...remIndices,
    ], remIndices.map(column => column.name), options.lldp === 'empty' ? [] : [
      [4, Buffer.from('aabbccddeeff', 'hex'), 5, 'Ten-GigabitEthernet1/0/48', '上联核心端口', 'CORE-SW-01', '核心交换机 LLDP 测试邻居', Buffer.from([0x28, 0]), Buffer.from([0x28, 0]), 12345, 7, 1],
      [5, Buffer.from([1, 192, 0, 2, 25]), 3, Buffer.from('001122334466', 'hex'), '无线 AP 上联', 'AP-01', '无线接入点', Buffer.from([0x14, 0]), Buffer.from([0x10, 0]), 12346, 7, 2],
      [7, 'remote-chassis-8', 7, 'remote-port-8', '', '', '', Buffer.from([0, 0]), Buffer.from([0, 0]), 23456, 8, 1],
    ]);
    const manIndices = [{ number: 100, name: 'manTime', type: I }, { number: 101, name: 'manLocal', type: I }, { number: 102, name: 'manRemote', type: I }, { number: 103, name: 'manFamily', type: I }, { number: 104, name: 'manAddress', type: S }];
    table('lldpManagement', '1.0.8802.1.1.2.1.4.2.1', [{ number: 3, name: 'manIfSubtype', type: I }, { number: 4, name: 'manIfId', type: I }, ...manIndices], manIndices.map(column => column.name), options.lldp === 'empty' ? [] : [
      [2, 101, 12345, 7, 1, 1, Buffer.from([192, 0, 2, 10])],
      [2, 101, 12345, 7, 1, 2, Buffer.from('20010db8000000000000000000000010', 'hex')],
      [2, 101, 12346, 7, 2, 1, Buffer.from([192, 0, 2, 25])],
      [2, 101, 99999, 7, 1, 1, Buffer.from([192, 0, 2, 99])],
    ]);
  }
  return { port, writes, mib, close: () => new Promise<void>(resolve => agent.close(resolve)) };
}
