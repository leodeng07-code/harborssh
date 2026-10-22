import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MacLookup, MacMatch } from '../../shared/types';
import { PortModeBadge } from './PortModeBadge';

function MatchTable({ matches }: { matches: MacMatch[] }) {
  return <table className="interface-table mac-match-table"><thead><tr><th>学习端口</th><th>端口类型</th><th>接口索引</th><th>VLAN</th><th>FDB / 数据表</th></tr></thead><tbody>{matches.map((match, index) => <tr key={index}><td><strong>{match.interfaceName}</strong><small>桥端口 {match.bridgePort}</small></td><td><PortModeBadge mode={match.portMode} /></td><td>{match.ifIndex ?? '未映射'}</td><td>{match.vlans.join(', ') || '未确定'}</td><td>{match.fdbId === undefined ? '—' : match.fdbId}<small>{match.source} · {{ 1: '其他', 3: '动态学习', 4: '本机', 5: '静态管理' }[match.entryStatus || 0] || '状态未返回'}</small></td></tr>)}</tbody></table>;
}
export function MacLookupResults({ lookup }: { lookup: MacLookup }) {
  const [expanded, setExpanded] = useState(false);
  const trunks = lookup.matches.filter(match => match.portMode?.kind === 'trunk');
  const visible = lookup.matches.filter(match => match.portMode?.kind !== 'trunk').sort((a, b) => Number(b.portMode?.kind === 'access') - Number(a.portMode?.kind === 'access'));
  return <div className="mac-results">
    <p><strong>{lookup.mac}</strong> · {lookup.host} · {new Date(lookup.readAt).toLocaleTimeString()} · {lookup.matches.length} 条命中{trunks.length > 0 ? `（含 ${trunks.length} 条 Trunk）` : ''}</p>
    {visible.length > 0 && <div className="mac-visible-results"><MatchTable matches={visible} /></div>}
    {!visible.length && trunks.length > 0 && <p className="network-empty">本次仅命中 Trunk 学习结果，已默认折叠，可在下方展开查看。</p>}
    {trunks.length > 0 && <section className="mac-trunk-results"><button className="trunk-toggle" aria-expanded={expanded} aria-label="展开或折叠 Trunk 学习结果" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}Trunk 学习结果 · {trunks.length} 条<span>{expanded ? '收起' : '展开查看'}</span></button>{expanded && <div className="mac-trunk-table"><MatchTable matches={trunks} /></div>}</section>}
    {!lookup.matches.length && <p className="network-empty">当前可读取的表中未命中。设备可能尚未学习、条目已老化，或对应 VLAN 表未开放。</p>}
    {lookup.warnings.length > 0 && <details className="network-warnings"><summary>{lookup.warnings.length} 项数据需检查</summary>{lookup.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
  </div>;
}
