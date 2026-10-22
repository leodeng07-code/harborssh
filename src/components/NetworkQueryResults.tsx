import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { NetworkQueryDevice, NetworkQueryRow } from '../../shared/types';
import { PortModeBadge } from './PortModeBadge';

export interface QueryResultItem { device: NetworkQueryDevice; row: NetworkQueryRow }
const labels = { arp: 'ARP 查询', routes: '路由查询', ipInterfaces: 'IP 接口概览', mac: 'MAC 查端口' };
const admin: Record<number, string> = { 1: '启用', 2: '停用', 3: '测试中' }, oper: Record<number, string> = { 1: 'UP', 2: 'DOWN', 3: '测试中', 4: '未知', 5: '休眠', 6: '未安装', 7: '下层断开' };
function details(row: NetworkQueryRow) {
  if (row.kind === 'ipInterfaces') return `${admin[row.adminStatus || 0] || '管理未知'} / ${oper[row.operStatus || 0] || '链路未知'}${row.description ? ` · ${row.description}` : ''}`;
  if (row.kind === 'routes') return [row.protocol, row.type, row.metric === undefined ? '' : `Metric ${row.metric}`, row.policy && row.policy !== '0.0' ? row.policy : ''].filter(Boolean).join(' · ');
  if (row.kind === 'mac') return [row.vlans?.length ? `VLAN ${row.vlans.join(', ')}` : 'VLAN 未确定', row.description].filter(Boolean).join(' · ');
  return [row.type, row.state].filter(Boolean).join(' · ');
}
function ResultTable({ rows, global, onSelect, focusTrunks }: { rows: QueryResultItem[]; global: boolean; onSelect?: (id: string) => void; focusTrunks: boolean }) {
  const [page, setPage] = useState(0), maxPage = Math.max(0, Math.ceil(rows.length / 100) - 1), current = Math.min(page, maxPage);
  const scroll = useRef<HTMLDivElement>(null), firstTrunk = rows.findIndex(item => item.row.kind === 'mac' && item.row.portMode?.kind === 'trunk');
  useEffect(() => { setPage(focusTrunks && firstTrunk >= 0 ? Math.floor(firstTrunk / 100) : 0); }, [focusTrunks, firstTrunk]);
  useEffect(() => {
    const container = scroll.current; if (!container) return;
    const row = focusTrunks ? container.querySelector('tr[data-port-mode="trunk"]') : undefined;
    const header = container.querySelector('thead')?.getBoundingClientRect().height || 0;
    container.scrollTop = row ? Math.max(0, row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - header) : 0;
  }, [focusTrunks, current, firstTrunk]);

  return <div className="network-result-table"><div className="interfaces-scroll" ref={scroll}><table className="interface-table network-query-table"><thead><tr>{global && <th>设备 / 管理 IP</th>}<th>查询结果 / 端口类型</th><th>IPv4 / 前缀</th><th>MAC / 下一跳</th><th>接口 / 类型</th><th>状态 / 说明</th></tr></thead><tbody>{rows.slice(current * 100, (current + 1) * 100).map(({ device, row }) => <tr key={`${device.profileId}:${row.key}`} data-port-mode={row.kind === 'mac' ? row.portMode?.kind || 'unknown' : undefined}>{global && <td><button className="text-button network-device-link" onClick={() => onSelect?.(device.profileId)}>{device.name}</button><small>{device.host} · {device.group}</small><small>{device.data && new Date(device.data.readAt).toLocaleTimeString()}</small></td>}<td><strong>{labels[row.kind]}</strong>{row.kind === 'mac' && <PortModeBadge mode={row.portMode} compact />}<small>{row.source}</small></td><td><code>{row.ip ? `${row.ip}${row.prefixLength === undefined ? '' : `/${row.prefixLength}`}` : row.kind === 'ipInterfaces' ? '未返回 IPv4' : '—'}</code>{row.mask && <small>{row.mask}</small>}</td><td><code>{row.kind === 'routes' ? row.nextHop || '未指定' : row.mac || '—'}</code></td><td><strong>{row.interfaceName}</strong><small>{row.ifIndex === undefined ? '接口未映射' : `ifIndex ${row.ifIndex}`}</small></td><td>{details(row)}</td></tr>)}</tbody></table></div>{rows.length > 100 && <div className="network-query-pagination"><span>每页 100 条 · {current + 1} / {maxPage + 1} 页</span><button className="button small" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><button className="button small" disabled={current === maxPage} onClick={() => setPage(current + 1)}>下一页</button></div>}</div>;
}
export function NetworkQueryResults({ rows, global, onSelect, busy, expanded, onToggle }: { rows: QueryResultItem[]; global: boolean; onSelect?: (id: string) => void; busy: boolean; expanded: boolean; onToggle: () => void }) {
  const trunks = rows.filter(item => item.row.kind === 'mac' && item.row.portMode?.kind === 'trunk');
  const visible = rows.filter(item => item.row.kind !== 'mac' || item.row.portMode?.kind !== 'trunk').sort((a, b) => Number(b.row.portMode?.kind === 'access') - Number(a.row.portMode?.kind === 'access'));
  const displayed = expanded ? [...visible, ...trunks] : visible;
  return <>
    {displayed.length > 0 && <ResultTable rows={displayed} global={global} onSelect={onSelect} focusTrunks={expanded && trunks.length > 0} />}
    {!rows.length && <div className="interfaces-scroll"><p className="network-empty">{busy ? '正在等待设备返回数据…' : '当前可读取的数据中未命中；请同时检查下方设备状态，不能据此判断全网不存在。'}</p></div>}
    {!displayed.length && trunks.length > 0 && <div className="interfaces-scroll"><p className="network-fold-hint">仅命中 Trunk 学习结果，已默认折叠；可展开查看可能的上联结果。</p></div>}
    {trunks.length > 0 && <section className="network-trunk-results"><button className="trunk-toggle" aria-expanded={expanded} aria-label="展开或折叠全网 Trunk 学习结果" onClick={onToggle}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}Trunk 学习结果 · {trunks.length} 条<span>{expanded ? '收起' : '展开查看'}</span></button></section>}
  </>;
}
