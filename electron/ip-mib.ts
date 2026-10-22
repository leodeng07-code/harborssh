import type { Varbind } from 'net-snmp';
import type { NetworkQueryRow } from '../shared/types';

// RFC 1213, RFC 4293 and RFC 4292/2096. Only IPv4 is exposed in this view.
export const IP_OIDS = {
  arp: '1.3.6.1.2.1.4.22.1', neighbor: '1.3.6.1.2.1.4.35.1',
  address: '1.3.6.1.2.1.4.20.1', modernAddress: '1.3.6.1.2.1.4.34.1',
  routes: '1.3.6.1.2.1.4.21.1', cidr: '1.3.6.1.2.1.4.24.4.1', inetCidr: '1.3.6.1.2.1.4.24.7.1',
};
export const valueText = (v?: Varbind) => Buffer.isBuffer(v?.value) ? v.value.toString('utf8').replace(/\0+$/, '') : String(v?.value ?? '');
export const valueNumber = (v?: Varbind) => typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : undefined;
const physical = (v?: Varbind) => Buffer.isBuffer(v?.value) ? [...v.value].map(n => n.toString(16).padStart(2, '0')).join(':').toUpperCase() : '';
export function ipv4(value: string): number | undefined {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return;
  const bytes = value.split('.').map(Number); if (bytes.some(v => v > 255)) return;
  return bytes.reduce((total, byte) => total * 256 + byte, 0);
}
export function prefixFromMask(mask: string): number | undefined {
  const value = ipv4(mask); if (value === undefined) return;
  const bits = value.toString(2).padStart(32, '0'); return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : undefined;
}
export function maskFromPrefix(prefix: number): string {
  const bits = '1'.repeat(prefix).padEnd(32, '0'); return [0, 8, 16, 24].map(start => parseInt(bits.slice(start, start + 8), 2)).join('.');
}
export function tableRows(values: Varbind[], root: string) {
  const rows = new Map<string, Map<number, Varbind>>();
  for (const value of values) {
    if (!value.oid.startsWith(root + '.')) continue;
    const [column, ...index] = value.oid.slice(root.length + 1).split('.').map(Number);
    if (!index.length || ![column, ...index].every(Number.isSafeInteger)) continue;
    const key = index.join('.'); const row = rows.get(key) || new Map<number, Varbind>(); row.set(column, value); rows.set(key, row);
  }
  return rows;
}
const ipIndex = (parts: number[]) => parts.length === 4 && parts.every(v => v >= 0 && v <= 255) ? parts.join('.') : '';
const ifLabel = (index?: number) => index ? `ifIndex ${index}` : '未指定接口';
export function parseArp(values: Varbind[], modern: boolean): NetworkQueryRow[] {
  const root = modern ? IP_OIDS.neighbor : IP_OIDS.arp, result: NetworkQueryRow[] = [];
  for (const [key, columns] of tableRows(values, root)) {
    const index = key.split('.').map(Number), ifIndex = index[0];
    const ip = modern ? index[1] === 1 && index[2] === 4 ? ipIndex(index.slice(3)) : '' : ipIndex(index.slice(1));
    const type = valueNumber(columns.get(modern ? 6 : 4)), state = valueNumber(columns.get(7));
    if (!ip || ifIndex <= 0 || type === 2 || modern && (state === 5 || valueNumber(columns.get(8)) !== undefined && valueNumber(columns.get(8)) !== 1)) continue;
    const mac = physical(columns.get(modern ? 4 : 2));
    result.push({ key: `${root}.${key}`, kind: 'arp', source: modern ? 'ipNetToPhysical' : 'ipNetToMedia', ifIndex, interfaceName: ifLabel(ifIndex), ip, mac,
      type: type === undefined ? '未知' : ({ 1: '其他', 3: '动态', 4: '静态', 5: '本机' }[type] || String(type)),
      state: modern ? ({ 1: '可达', 2: '待确认', 3: '延迟', 4: '探测', 6: '未完成', 7: '未知' }[state || 0] || '未返回') : undefined });
  }
  return result;
}
export function parseAddresses(values: Varbind[], modern: boolean): NetworkQueryRow[] {
  const root = modern ? IP_OIDS.modernAddress : IP_OIDS.address, result: NetworkQueryRow[] = [];
  for (const [key, columns] of tableRows(values, root)) {
    const parts = key.split('.').map(Number), ip = modern ? parts[0] === 1 && parts[1] === 4 ? ipIndex(parts.slice(2)) : '' : ipIndex(parts);
    const ifIndex = valueNumber(columns.get(modern ? 3 : 2));
    if (!ip || !ifIndex || modern && valueNumber(columns.get(10)) !== undefined && valueNumber(columns.get(10)) !== 1) continue;
    let mask = modern ? '' : valueText(columns.get(3)), prefixLength = prefixFromMask(mask);
    if (modern) {
      // ipAddressPrefix references an ipAddressPrefixOrigin row (column 5).
      const pointer = valueText(columns.get(5)), prefixRoot = '1.3.6.1.2.1.4.32.1.5.';
      if (pointer.startsWith(prefixRoot)) {
        const index = pointer.slice(prefixRoot.length).split('.').map(Number);
        if (index.length === 8 && index[0] === ifIndex && index[1] === 1 && index[2] === 4 && ipIndex(index.slice(3, 7)) && index[7] >= 0 && index[7] <= 32) {
          prefixLength = index[7]; mask = maskFromPrefix(prefixLength);
        }
      }
    }
    result.push({ key: `${root}.${key}`, kind: 'ipInterfaces', source: modern ? 'ipAddressTable' : 'ipAddrTable', ifIndex, interfaceName: ifLabel(ifIndex), ip, mask: prefixLength === undefined ? undefined : mask, prefixLength });
  }
  return result;
}
const protocolNames: Record<number, string> = { 1: 'Other', 2: 'Local', 3: 'NetMgmt / Static', 4: 'ICMP', 5: 'EGP', 6: 'GGP', 7: 'HELLO', 8: 'RIP', 9: 'IS-IS', 10: 'ES-IS', 11: 'IGRP', 12: 'BBN-SPF-IGP', 13: 'OSPF', 14: 'BGP', 15: 'IDPR', 16: 'EIGRP', 17: 'DSDV', 18: 'RPL' };
export function parseRoutes(values: Varbind[], table: 'routes' | 'cidr' | 'inetCidr', warnings: string[] = []): NetworkQueryRow[] {
  const root = IP_OIDS[table], result: NetworkQueryRow[] = [];
  for (const [key, columns] of tableRows(values, root)) {
    const index = key.split('.').map(Number); let ip = '', mask = '', nextHop = '', policy = '', prefixLength: number | undefined;
    if (table === 'routes') { ip = ipIndex(index); mask = valueText(columns.get(11)); nextHop = valueText(columns.get(7)); }
    else if (table === 'cidr') { if (index.length !== 13) continue; ip = ipIndex(index.slice(0, 4)); mask = ipIndex(index.slice(4, 8)); policy = `TOS ${index[8]}`; nextHop = ipIndex(index.slice(9)); }
    else {
      // InetAddress and OBJECT IDENTIFIER indices are length-prefixed, never fixed-offset.
      if (index[0] !== 1 || index[1] !== 4) continue;
      ip = ipIndex(index.slice(2, 6)); prefixLength = index[6]; const policyLength = index[7];
      if (!Number.isInteger(policyLength) || policyLength < 2 || policyLength > 100) continue;
      policy = index.slice(8, 8 + policyLength).join('.'); const offset = 8 + policyLength;
      const family = index[offset], length = index[offset + 1];
      if (offset + 2 + length !== index.length) continue;
      if (family === 1 && length === 4) nextHop = ipIndex(index.slice(offset + 2));
      else if (family !== 0 || length !== 0) continue;
      if (prefixLength >= 0 && prefixLength <= 32) mask = maskFromPrefix(prefixLength);
    }
    prefixLength ??= prefixFromMask(mask);
    const old = table === 'routes', inet = table === 'inetCidr';
    const type = valueNumber(columns.get(old ? 8 : inet ? 8 : 6));
    const rowStatus = valueNumber(columns.get(inet ? 17 : 16));
    // Legacy type 2 is invalid; modern type 2 is a valid reject route.
    if (old && type === 2 || !old && rowStatus !== undefined && rowStatus !== 1) continue;
    if (!ip || prefixLength === undefined || ipv4(ip) === undefined || Math.floor(ipv4(ip)! / 2 ** (32 - prefixLength)) * 2 ** (32 - prefixLength) !== ipv4(ip)) { warnings.push('部分路由的目的地址或掩码无效，已跳过'); continue; }
    const ifIndex = valueNumber(columns.get(old ? 2 : inet ? 7 : 5)), proto = valueNumber(columns.get(old ? 9 : inet ? 9 : 7));
    const metric = valueNumber(columns.get(old ? 3 : inet ? 12 : 11));
    result.push({ key: `${root}.${key}`, kind: 'routes', source: inet ? 'inetCidrRouteTable' : old ? 'ipRouteTable' : 'ipCidrRouteTable', ifIndex, interfaceName: ifLabel(ifIndex), ip, mask, prefixLength, nextHop, policy,
      protocol: proto === undefined ? '未知' : protocolNames[proto] || `协议 ${proto}`, metric: metric !== undefined && metric >= 0 ? metric : undefined,
      type: type === undefined ? '未知' : (old ? ({ 1: '其他', 3: '直连', 4: '间接' }[type]) : ({ 1: '其他', 2: '拒绝', 3: '直连', 4: '间接', 5: '黑洞' }[type])) || String(type) });
  }
  return result;
}
export function matchingRoutes(rows: NetworkQueryRow[], query: string) {
  if (!query) return rows.sort((a, b) => ipv4(a.ip!)! - ipv4(b.ip!)! || b.prefixLength! - a.prefixLength!);
  const address = ipv4(query); if (address === undefined) throw new Error('路由查询请输入完整 IPv4 地址');
  const matches = rows.filter(row => Math.floor(address / 2 ** (32 - row.prefixLength!)) === Math.floor(ipv4(row.ip!)! / 2 ** (32 - row.prefixLength!)));
  const longest = matches.reduce((maximum, row) => Math.max(maximum, row.prefixLength!), -1); return matches.filter(row => row.prefixLength === longest);
}
