import type { Varbind } from 'net-snmp';
import type { MacMatch, ParameterDefinition, PortModeInfo } from '../shared/types';

// Vendor definitions: H3C HH3C-LswINF-MIB and Huawei HUAWEI-L2IF-MIB.
// VLAN membership, PVID, ifType and interface names are not evidence of link mode.
export const PORT_MODE_OIDS = {
  h3cMode: '1.3.6.1.4.1.25506.8.35.1.1.1.5', h3cBridge: '1.3.6.1.4.1.25506.8.35.1.1.1.10',
  huaweiIfIndex: '1.3.6.1.4.1.2011.5.25.42.1.1.1.3.1.2', huaweiMode: '1.3.6.1.4.1.2011.5.25.42.1.1.1.3.1.3',
  huaweiActiveMode: '1.3.6.1.4.1.2011.5.25.42.1.1.1.3.1.32',
};
interface Transport { get(oids: string[]): Promise<Varbind[]>; walk(oid: string): Promise<Varbind[]> }
const numeric = (value?: Varbind) => typeof value?.value === 'number' && Number.isSafeInteger(value.value) ? value.value : undefined;
const valueText = (value?: Varbind) => Buffer.isBuffer(value?.value) ? value.value.toString('utf8').replace(/\0+$/, '') : String(value?.value ?? '');
export const modeKey = (match: Pick<MacMatch, 'ifIndex' | 'bridgePort'>) => `${match.ifIndex ?? '?'}:${match.bridgePort}`;
const unknown = (reason: string, detail: Partial<PortModeInfo> = {}): PortModeInfo => ({ ...detail, kind: 'unknown', label: '未知', reason });
function vendorMode(value: Varbind | undefined, source: string, huawei = false): PortModeInfo {
  const raw = numeric(value), detail = { source, oid: value?.oid, value: raw };
  const mode = raw === 1 ? 'trunk' : raw === 2 ? 'access' : raw === 3 ? 'hybrid' : undefined;
  if (mode) return { ...detail, kind: mode, label: mode === 'trunk' ? 'Trunk' : mode === 'access' ? 'Access' : 'Hybrid' };
  if (raw === 4 || huawei && raw === 5) return { ...detail, kind: 'other', label: raw === 4 ? 'Fabric' : 'QinQ' };
  return unknown(raw === undefined ? '设备未返回端口模式，可能不支持或无访问权限' : `设备返回未确认模式 ${raw}，保持展开`, detail);
}
export function choiceMode(label: string): PortModeInfo['kind'] {
  const name = label.trim().toLowerCase().replace(/\s+/g, '');
  if (['access', 'access口', 'access模式', '接入', '接入口', '接入模式'].includes(name)) return 'access';
  if (['trunk', 'trunk口', 'trunk模式', '中继', '中继口', '干道', '干道口'].includes(name)) return 'trunk';
  if (['hybrid', 'hybrid口', 'hybrid模式', '混合', '混合口', '混合模式'].includes(name)) return 'hybrid';
  return 'unknown';
}
function column(rows: Varbind[], root: string) {
  return new Map(rows.filter(row => row.oid.startsWith(root + '.') && /^[1-9]\d*$/.test(row.oid.slice(root.length + 1))).map(row => [Number(row.oid.slice(root.length + 1)), row]));
}
export async function readPortModes(reader: Transport, matches: MacMatch[], objectId: string, definition?: ParameterDefinition, signal?: AbortSignal): Promise<Map<string, PortModeInfo>> {
  const result = new Map<string, PortModeInfo>(), unique = [...new Map(matches.map(match => [modeKey(match), match])).values()];
  if (!unique.length) return result;
  const read = async (oid: string) => { signal?.throwIfAborted(); try { return await reader.walk(oid); } catch { signal?.throwIfAborted(); return []; } };
  if (definition) {
    const instances = [...new Set(unique.map(match => definition.index === 'ifIndex' ? match.ifIndex : match.bridgePort).filter((index): index is number => !!index))];
    const values = new Map<string, Varbind>();
    for (let offset = 0; offset < instances.length; offset += 24) {
      signal?.throwIfAborted();
      try { for (const row of await reader.get(instances.slice(offset, offset + 24).map(index => `${definition.oid}.${index}`))) values.set(row.oid, row); }
      catch { signal?.throwIfAborted(); }
    }
    for (const match of unique) {
      const index = definition.index === 'ifIndex' ? match.ifIndex : match.bridgePort, oid = index === undefined ? undefined : `${definition.oid}.${index}`, cell = oid ? values.get(oid) : undefined;
      const value = definition.type === 'Integer' || definition.type === 'Unsigned32' ? numeric(cell) : cell ? valueText(cell) : undefined;
      const choices = definition.choices.filter(choice => choice.value === value), kind = choices.length === 1 ? choiceMode(choices[0].label) : 'unknown';
      result.set(modeKey(match), kind === 'unknown' ? unknown(index === undefined ? '缺少接口索引，无法读取已配置的模式 OID' : !cell ? '模式 OID 未返回数据，保持展开' : '模式枚举未明确标注 Access / Trunk / Hybrid，或存在冲突，保持展开', { source: 'MIB 适配', oid, value }) : { kind, label: kind === 'access' ? 'Access' : kind === 'trunk' ? 'Trunk' : 'Hybrid', source: 'MIB 适配', oid, value });
    }
    return result;
  }
  const identity = objectId.replace(/^\./, '');
  if (identity.startsWith('1.3.6.1.4.1.25506.')) {
    const [modes, bridges] = await Promise.all([read(PORT_MODE_OIDS.h3cMode), read(PORT_MODE_OIDS.h3cBridge)]), modeColumn = column(modes, PORT_MODE_OIDS.h3cMode), bridgeColumn = column(bridges, PORT_MODE_OIDS.h3cBridge);
    for (const match of unique) {
      // Verify the private row against its documented base-port column. Do not
      // substitute a bridge port number or physical port number for ifIndex.
      const indices = [...bridgeColumn].filter(([, value]) => numeric(value) === match.bridgePort).map(([index]) => index);
      result.set(modeKey(match), indices.length === 1 ? vendorMode(modeColumn.get(indices[0]), 'H3C VLAN 模式') : unknown(indices.length ? 'H3C 桥端口映射不唯一，保持展开' : '未取得 H3C 模式表的桥端口映射，保持展开', { source: 'H3C VLAN 模式' }));
    }
  } else if (identity.startsWith('1.3.6.1.4.1.2011.') && !identity.startsWith('1.3.6.1.4.1.2011.10.')) {
    const [mapping, modes, active] = await Promise.all([read(PORT_MODE_OIDS.huaweiIfIndex), read(PORT_MODE_OIDS.huaweiMode), read(PORT_MODE_OIDS.huaweiActiveMode)]);
    const mapColumn = column(mapping, PORT_MODE_OIDS.huaweiIfIndex), modeColumn = column(modes, PORT_MODE_OIDS.huaweiMode), activeColumn = column(active, PORT_MODE_OIDS.huaweiActiveMode);
    for (const match of unique) {
      const indices = match.ifIndex === undefined ? [] : [...mapColumn].filter(([, value]) => numeric(value) === match.ifIndex).map(([index]) => index);
      const index = indices[0], current = activeColumn.get(index);
      result.set(modeKey(match), indices.length === 1 ? vendorMode(current || modeColumn.get(index), current ? '华为生效模式' : '华为 VLAN 模式', true) : unknown('未取得唯一的华为二层端口到 ifIndex 映射，保持展开', { source: '华为 VLAN 模式' }));
    }
  } else for (const match of unique) result.set(modeKey(match), unknown('此设备暂无自动端口模式适配，可在 MIB 适配中配置 VLAN 模式'));
  signal?.throwIfAborted(); return result;
}
