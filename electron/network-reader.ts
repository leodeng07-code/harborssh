import type { Varbind } from 'net-snmp';
import type { NetworkQueryData, NetworkQueryKind, NetworkQueryRow } from '../shared/types';
import { IP_OIDS, ipv4, matchingRoutes, parseAddresses, parseArp, parseRoutes, valueNumber, valueText } from './ip-mib';

interface Transport { walk(oid: string): Promise<Varbind[]>; get(oids: string[]): Promise<Varbind[]> }
const IF = { index: '1.3.6.1.2.1.2.2.1.1', name: '1.3.6.1.2.1.31.1.1.1.1', description: '1.3.6.1.2.1.2.2.1.2', admin: '1.3.6.1.2.1.2.2.1.7', oper: '1.3.6.1.2.1.2.2.1.8' };
export async function readIpQuery(reader: Transport, kind: NetworkQueryKind, query: string, signal?: AbortSignal): Promise<NetworkQueryData> {
  const warnings: string[] = [], rows: NetworkQueryRow[] = [];
  // A successful identity request distinguishes an unreachable device from an empty/hidden table.
  await reader.get(['1.3.6.1.2.1.1.3.0']);
  const read = async (oid: string, label: string) => {
    signal?.throwIfAborted();
    try { return await reader.walk(oid); }
    catch (error) { signal?.throwIfAborted(); warnings.push(`${label} 读取失败，结果可能不完整`); return []; }
  };
  let available = false;
  if (kind === 'arp' || kind === 'auto') {
    const [legacy, modern] = await Promise.all([read(IP_OIDS.arp, 'ARP 表'), read(IP_OIDS.neighbor, '邻居表')]);
    const entries = new Map<string, NetworkQueryRow>();
    for (const row of [...parseArp(legacy, false), ...parseArp(modern, true)]) entries.set(`${row.ifIndex}:${row.ip}`, row);
    available ||= !!(legacy.length || modern.length);
    if (!legacy.length && !modern.length) warnings.push('ARP 表未返回数据：可能为空、不支持或 SNMP 视图未开放');
    const isMac = query.includes(':');
    rows.push(...[...entries.values()].filter(row => !query || (isMac ? row.mac === query : row.ip!.includes(query))));
  }
  if (kind === 'ipInterfaces' || kind === 'auto' && ipv4(query) !== undefined) {
    const [legacy, modern, indices, admins, opers] = await Promise.all([
      read(IP_OIDS.address, 'IPv4 地址表'), read(IP_OIDS.modernAddress, 'IP 地址表'),
      read(IF.index, '接口索引'), read(IF.admin, '接口管理状态'), read(IF.oper, '接口链路状态'),
    ]);
    const entries = new Map<string, NetworkQueryRow>();
    for (const row of [...parseAddresses(legacy, false), ...parseAddresses(modern, true)]) {
      const key = `${row.ifIndex}:${row.ip}`, previous = entries.get(key);
      entries.set(key, { ...row, mask: row.mask ?? previous?.mask, prefixLength: row.prefixLength ?? previous?.prefixLength });
    }
    if (!legacy.length && !modern.length) warnings.push('IPv4 地址表未返回数据，不能确定接口是否未配置 IP');
    if (!indices.length) warnings.push('接口索引未返回数据，可能缺少未配置 IP 的接口');
    const addressed = new Set([...entries.values()].map(row => row.ifIndex));
    for (const row of indices) {
      const ifIndex = valueNumber(row); if (ifIndex && !addressed.has(ifIndex)) entries.set(`${ifIndex}:unassigned`, { key: `if:${ifIndex}`, kind: 'ipInterfaces', source: 'IF-MIB', ifIndex, interfaceName: `ifIndex ${ifIndex}` });
    }
    const admin = new Map(admins.map(v => [Number(v.oid.split('.').at(-1)), valueNumber(v)])), oper = new Map(opers.map(v => [Number(v.oid.split('.').at(-1)), valueNumber(v)]));
    for (const row of entries.values()) { row.adminStatus = admin.get(row.ifIndex!); row.operStatus = oper.get(row.ifIndex!); }
    available ||= !!(indices.length || entries.size);
    rows.push(...[...entries.values()].filter(row => !query || (row.ip || '').includes(query)));
  }
  if (kind === 'routes' || kind === 'auto' && ipv4(query) !== undefined) {
    let routes: NetworkQueryRow[] = [];
    for (const table of ['inetCidr', 'cidr', 'routes'] as const) {
      const values = await read(IP_OIDS[table], table === 'routes' ? '旧版路由表' : `${table} 路由表`);
      available ||= !!values.length;
      routes = parseRoutes(values, table, warnings);
      if (routes.length) break;
    }
    if (!routes.length) warnings.push('IPv4 路由表未返回有效条目：可能为空、不支持或 SNMP 视图未开放');
    rows.push(...matchingRoutes(routes, query));
  }
  // Map actual ifIndex values; never treat bridge/VLAN numbers as interface indices.
  if (rows.length) {
    const [names, descriptions] = await Promise.all([read(IF.name, '接口名称'), read(IF.description, '接口描述')]);
    const descMap = new Map(descriptions.map(v => [Number(v.oid.split('.').at(-1)), valueText(v)]));
    const namesByIndex = new Map(names.map(v => [Number(v.oid.split('.').at(-1)), valueText(v)]));
    if (!names.length && !descriptions.length) warnings.push('接口名称未返回，仅显示 ifIndex');
    for (const row of rows) { row.interfaceName = namesByIndex.get(row.ifIndex!) || descMap.get(row.ifIndex!) || row.interfaceName; row.description = descMap.get(row.ifIndex!); }
  }
  signal?.throwIfAborted();
  if (rows.length > 5000) warnings.push('本设备命中超过 5000 条，仅显示前 5000 条，请缩小查询范围');
  return { rows: rows.slice(0, 5000), warnings: [...new Set(warnings)], available, readAt: Date.now() };
}
