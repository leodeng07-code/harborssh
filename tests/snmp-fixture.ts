import snmp from 'net-snmp';
import dgram from 'node:dgram';
import type { ParameterDefinition } from '../shared/types';

export const testMappings: ParameterDefinition[] = [
  { field: 'speed', oid: '1.3.6.1.4.1.8072.9999.1.1', index: 'ifIndex', type: 'Integer', choices: [{ label: '自动', value: 0 }, { label: '1000 Mbps', value: 1000 }] },
  { field: 'duplex', oid: '1.3.6.1.4.1.8072.9999.1.2', index: 'ifIndex', type: 'Integer', choices: [{ label: '自动', value: 0 }, { label: '全双工', value: 1 }] },
  { field: 'vlanMode', oid: '1.3.6.1.4.1.8072.9999.1.3', index: 'ifIndex', type: 'Integer', choices: [{ label: 'Access', value: 1 }, { label: 'Trunk', value: 2 }] },
];
export async function snmpFixture() {
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
  scalar('systemName', '1.3.6.1.2.1.1.5', S, '测试交换机'); scalar('systemDescription', '1.3.6.1.2.1.1.1', S, 'Local SNMP integration fixture'); scalar('systemObject', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.8072.3.2.10');
  table('interfaces', '1.3.6.1.2.1.2.2.1', [{ number: 1, name: 'ifIndex', type: I }, { number: 2, name: 'ifDescr', type: S }, { number: 5, name: 'ifSpeed', type: snmp.ObjectType.Gauge }, { number: 6, name: 'ifMac', type: S }, { number: 7, name: 'ifAdmin', type: I, writable: true }, { number: 8, name: 'ifOper', type: I }], ['ifIndex'], [[101, 'GigabitEthernet0/0/7', 1_000_000_000, Buffer.from('001122334455', 'hex'), 1, 1]]);
  table('extended', '1.3.6.1.2.1.31.1.1.1', [{ number: 1, name: 'ifName', type: S }, { number: 15, name: 'ifHighSpeed', type: snmp.ObjectType.Gauge }, { number: 18, name: 'ifAlias', type: S, writable: true }, { number: 99, name: 'xIndex', type: I }], ['xIndex'], [['GE0/0/7', 1000, '办公区', 101]]);
  table('bridge', '1.3.6.1.2.1.17.1.4.1', [{ number: 1, name: 'bridgeIndex', type: I }, { number: 2, name: 'bridgeIf', type: I }], ['bridgeIndex'], [[7, 101]]);
  table('pvid', '1.3.6.1.2.1.17.7.1.4.5.1', [{ number: 1, name: 'portPvid', type: snmp.ObjectType.Gauge, writable: true }, { number: 99, name: 'pvidIndex', type: I }], ['pvidIndex'], [[20, 7]]);
  table('duplex', '1.3.6.1.2.1.10.7.2.1', [{ number: 19, name: 'duplexStatus', type: I }, { number: 99, name: 'duplexIndex', type: I }], ['duplexIndex'], [[3, 101]]);
  table('vendor', '1.3.6.1.4.1.8072.9999.1', [{ number: 1, name: 'vendorSpeed', type: I, writable: true }, { number: 2, name: 'vendorDuplex', type: I, writable: true }, { number: 3, name: 'vendorMode', type: I, writable: true }, { number: 99, name: 'vendorIndex', type: I }], ['vendorIndex'], [[0, 0, 1, 101]]);
  // Deliberately different FDB ID 77, VLAN ID 20, bridge port 7 and ifIndex 101.
  const indexCols = Array.from({ length: 7 }, (_, i) => ({ number: 100 + i, name: `qIndex${i}`, type: I }));
  table('qFdb', '1.3.6.1.2.1.17.7.1.2.2.1', [{ number: 2, name: 'qPort', type: I }, { number: 3, name: 'qStatus', type: I }, ...indexCols], indexCols.map(c => c.name), [[7, 3, 77, 170, 187, 204, 221, 238, 255], [7, 2, 77, 18, 52, 86, 120, 154, 188]]);
  table('vlanMap', '1.3.6.1.2.1.17.7.1.4.2.1', [{ number: 3, name: 'vlanFdb', type: snmp.ObjectType.Gauge }, { number: 100, name: 'timeMark', type: I }, { number: 101, name: 'vlanId', type: I }], ['timeMark', 'vlanId'], [[77, 0, 20]]);
  const bCols = Array.from({ length: 6 }, (_, i) => ({ number: 100 + i, name: `bIndex${i}`, type: I }));
  table('classicFdb', '1.3.6.1.2.1.17.4.3.1', [{ number: 2, name: 'classicPort', type: I }, { number: 3, name: 'classicStatus', type: I }, ...bCols], bCols.map(c => c.name), [[7, 3, 0, 17, 34, 51, 68, 85]]);
  return { port, writes, mib, close: () => new Promise<void>(resolve => agent.close(resolve)) };
}
