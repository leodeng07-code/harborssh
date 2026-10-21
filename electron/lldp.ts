import type { Varbind } from 'net-snmp';
import type { LldpNeighbor } from '../shared/types';

export const LLDP_OIDS = {
  localChassisSubtype: '1.0.8802.1.1.2.1.3.1.0', localName: '1.0.8802.1.1.2.1.3.3.0',
  localPorts: '1.0.8802.1.1.2.1.3.7.1', remote: '1.0.8802.1.1.2.1.4.1.1', management: '1.0.8802.1.1.2.1.4.2.1',
};
const string = (value: unknown) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')).replace(/\0+$/, '').slice(0, 4096);
function networkAddress(family: number, bytes: number[]) {
  if (!bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return '';
  if (family === 1 && bytes.length === 4) return bytes.join('.');
  if (family === 2 && bytes.length === 16) {
    const ip = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(':');
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  }
  return '';
}
function identifier(value: unknown, subtype: unknown, chassis = false) {
  if (!Buffer.isBuffer(value)) return string(value);
  if (subtype === (chassis ? 4 : 3) && value.length === 6) return [...value].map(byte => byte.toString(16).padStart(2, '0')).join(':').toUpperCase();
  if (subtype === (chassis ? 5 : 4)) return networkAddress(value[0], [...value.subarray(1)]) || `0x${value.toString('hex')}`;
  const result = string(value);
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(result) ? `0x${value.toString('hex').slice(0, 4096)}` : result;
}
function capabilities(value: unknown) {
  if (!Buffer.isBuffer(value)) return [];
  const labels = ['其他', '中继器', '网桥/交换机', '无线 AP', '路由器', '电话', 'DOCSIS', '终端', 'C-VLAN', 'S-VLAN', 'TPMR'];
  const result: string[] = [];
  for (let bit = 0; bit < value.length * 8; bit++) if (value[bit >> 3] & (0x80 >> (bit % 8))) result.push(labels[bit] || `能力位 ${bit}`);
  return result;
}
export function parseLldp(remote: Varbind[], local: Varbind[], management: Varbind[], warnings: string[]): LldpNeighbor[] {
  const rows = new Map<string, Map<number, unknown>>(), ports = new Map<number, Map<number, unknown>>(), addresses = new Map<string, Set<string>>();
  let malformed = false;
  for (const entry of remote) {
    const parts = entry.oid.slice(LLDP_OIDS.remote.length + 1).split('.').map(Number), [column, time, port, index] = parts;
    if (!entry.oid.startsWith(LLDP_OIDS.remote + '.') || parts.length !== 4 || !parts.every(Number.isInteger) || time < 0 || port <= 0 || index <= 0) { malformed = true; continue; }
    if (column < 4 || column > 12) continue;
    const key = `${time}.${port}.${index}`;
    if (!rows.has(key)) rows.set(key, new Map()); rows.get(key)!.set(column, entry.value);
  }
  for (const entry of local) {
    const parts = entry.oid.slice(LLDP_OIDS.localPorts.length + 1).split('.').map(Number), [column, port] = parts;
    if (!entry.oid.startsWith(LLDP_OIDS.localPorts + '.') || parts.length !== 2 || !parts.every(Number.isInteger) || port <= 0) continue;
    if (!ports.has(port)) ports.set(port, new Map()); ports.get(port)!.set(column, entry.value);
  }
  for (const entry of management) {
    const parts = entry.oid.slice(LLDP_OIDS.management.length + 1).split('.').map(Number);
    const [column, time, port, index, family, length, ...bytes] = parts;
    if (column < 3 || column > 5) continue;
    if (!entry.oid.startsWith(LLDP_OIDS.management + '.') || !parts.every(Number.isInteger) || column < 3 || column > 5 || length !== bytes.length || !bytes.every(byte => byte >= 0 && byte <= 255)) { malformed = true; continue; }
    const address = networkAddress(family, bytes) || `地址族 ${family}: ${Buffer.from(bytes).toString('hex')}`;
    const key = `${time}.${port}.${index}`;
    if (!addresses.has(key)) addresses.set(key, new Set()); addresses.get(key)!.add(address);
  }
  if (malformed) warnings.push('部分 LLDP 表索引无效，已跳过，结果可能不完整');
  return [...rows].map(([key, row]) => {
    const [timeMark, localPortNumber, remoteIndex] = key.split('.').map(Number), port = ports.get(localPortNumber);
    return {
      key, timeMark, localPortNumber, remoteIndex,
      localPortId: identifier(port?.get(3), port?.get(2)), localPortDescription: string(port?.get(4)),
      chassisId: identifier(row.get(5), row.get(4), true), portId: identifier(row.get(7), row.get(6)), portDescription: string(row.get(8)),
      systemName: string(row.get(9)), systemDescription: string(row.get(10)), managementAddresses: [...(addresses.get(key) || [])],
      supportedCapabilities: capabilities(row.get(11)), enabledCapabilities: capabilities(row.get(12)),
    };
  }).sort((a, b) => a.localPortNumber - b.localPortNumber || a.remoteIndex - b.remoteIndex || a.timeMark - b.timeMark);
}
