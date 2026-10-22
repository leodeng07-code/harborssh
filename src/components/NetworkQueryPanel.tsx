import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Square, RefreshCw } from 'lucide-react';
import type { Config, NetworkQueryJob, NetworkQueryKind, Profile } from '../../shared/types';
import { buildGroupTree, groupLabel, inGroup, type GroupNode } from '../../shared/groups';
import { api, errorText } from '../api';
import { NetworkQueryResults } from './NetworkQueryResults';

export function groupOptions(profiles: Profile[]) {
  const flatten = (nodes: GroupNode[]): GroupNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
  return flatten(buildGroupTree(profiles));
}
export function ScopePicker({ profiles, value, onChange, disabled }: { profiles: Profile[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="network-scope">设备范围<select aria-label="网络查询设备范围" disabled={disabled} value={value} onChange={event => onChange(event.target.value)}><option value="">全部分组（{profiles.length} 台）</option>{groupOptions(profiles).map(node => <option key={node.key} value={JSON.stringify(node.path)}>{groupLabel(node.path)}（{node.count} 台）</option>)}</select></label>;
}
const labels = { auto: '智能查询', arp: 'ARP 查询', routes: '路由查询', ipInterfaces: 'IP 接口概览', mac: 'MAC 查端口' };
const hint = (kind: NetworkQueryKind) => kind === 'auto' ? '输入完整 IPv4：查询 ARP、接口地址和最佳路由；输入 MAC：查询 ARP 和学习端口。' : kind === 'routes' ? '输入目的 IPv4，按最长前缀匹配最佳路由，保留多下一跳。' : kind === 'ipInterfaces' ? '显示接口 IPv4 / 掩码、管理状态和链路状态；可按 IPv4 地址片段筛选。' : kind === 'arp' ? '按 IPv4 地址或片段筛选 IP、MAC、出接口及动态 / 静态类型。' : '支持 xxxx.xxxx.xxxx、xxxx-xxxx-xxxx、xx:xx:xx:xx:xx:xx、xx-xx-xx-xx-xx-xx。';
export function NetworkQueryPanel({ config, kind: fixedKind, global = false, onSelect }: { config: Config; kind?: NetworkQueryKind; global?: boolean; onSelect?: (id: string) => void }) {
  const [kind, setKind] = useState<NetworkQueryKind>(fixedKind || 'auto');
  const [query, setQuery] = useState(''), [scope, setScope] = useState('');
  const [interval, setIntervalValue] = useState(() => { const saved = Number(localStorage.getItem('harbor-network-refresh') ?? 30); return [0, 30, 60].includes(saved) ? saved : 30; });
  const [job, setJob] = useState<NetworkQueryJob>(), [busy, setBusy] = useState(false), [armed, setArmed] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [visible, setVisible] = useState(!document.hidden), [showTrunks, setShowTrunks] = useState(false);
  const generation = useRef(0), active = useRef<string | undefined>(undefined), working = useRef(false), runRef = useRef<() => Promise<void>>(async () => {});
  const allConfigured = useMemo(() => config.profiles.filter(profile => config.snmp?.some(target => target.profileId === profile.id && target.hasReadCommunity)), [config]);
  const profiles = allConfigured.filter(profile => !scope || inGroup(profile, JSON.parse(scope)));
  const idsKey = profiles.map(profile => profile.id).join(',');
  const cancel = () => { generation.current++; working.current = false; if (active.current) void api.networkQueryCancel(active.current).catch(() => {}); active.current = undefined; };
  const stop = () => { cancel(); setBusy(false); setArmed(false); setNotice('已停止查询，自动刷新已暂停'); setJob(previous => previous?.status === 'running' ? { ...previous, status: 'cancelled', devices: previous.devices.map(device => ['queued', 'running'].includes(device.status) ? { ...device, status: 'cancelled' } : device) } : previous); };
  useEffect(() => {
    cancel(); setBusy(false); setArmed(false); setJob(undefined); setError(''); setNotice(''); setShowTrunks(false);
    return cancel;
  }, [idsKey, kind]);
  useEffect(() => { if (fixedKind) setKind(fixedKind); }, [fixedKind]);
  useEffect(() => {
    let mounted = true, nativeVisible = true, revision = 0;
    const change = () => {
      const shown = nativeVisible && !document.hidden; setVisible(shown);
      if (!shown) { cancel(); setBusy(false); setJob(previous => previous?.status === 'running' ? { ...previous, status: 'cancelled', devices: previous.devices.map(device => ['queued', 'running'].includes(device.status) ? { ...device, status: 'cancelled' } : device) } : previous); }
    };
    const unsubscribe = api.onEvent(event => { if (event.type === 'windowVisibility') { revision++; nativeVisible = event.visible; change(); } });
    const initialRevision = revision;
    void api.windowVisible().then(value => { if (mounted && initialRevision === revision) { nativeVisible = value; change(); } }).catch(() => {});
    document.addEventListener('visibilitychange', change);
    return () => { mounted = false; unsubscribe(); document.removeEventListener('visibilitychange', change); };
  }, []);
  const run = async () => {
    if (working.current || !visible || document.hidden) return;
    const token = ++generation.current; working.current = true; setBusy(true); setError(''); setNotice(''); setJob(undefined);
    try {
      const id = await api.networkQuery({ profileIds: profiles.map(profile => profile.id), kind, query });
      if (generation.current !== token) { await api.networkQueryCancel(id); return; }
      active.current = id; setArmed(true);
      do {
        const snapshot = await api.networkQueryRead(id);
        if (generation.current !== token) return;
        setJob(snapshot);
        if (snapshot.status !== 'running') break;
        await new Promise(resolve => window.setTimeout(resolve, 750));
      } while (generation.current === token);
    } catch (e) { if (generation.current === token) { setError(errorText(e)); setArmed(false); } }
    finally { if (generation.current === token) { active.current = undefined; working.current = false; setBusy(false); } }
  };
  runRef.current = run;
  useEffect(() => {
    if (!armed || !interval || busy || !visible) return;
    const timer = window.setTimeout(() => { void runRef.current(); }, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [armed, interval, busy, visible, job?.finishedAt]);
  const completed = job?.devices.filter(device => device.status !== 'queued' && device.status !== 'running').length || 0;
  const hits = job?.devices.filter(device => device.data?.rows.length).length || 0;
  const rows = job?.devices.flatMap(device => (device.data?.rows || []).map(row => ({ device, row }))) || [];
  const issueCount = job?.devices.filter(device => device.status === 'error' || device.data?.warnings.length || device.data && !device.data.available).length || 0;
  return <section className="network-card network-query-panel" aria-label={global ? '全网查询' : labels[kind]}>
    {global && <div className="network-global-options"><ScopePicker profiles={config.profiles} value={scope} onChange={value => { setScope(value); setArmed(false); }} disabled={busy} /><label>查询类型<select aria-label="全网查询类型" disabled={busy} value={kind} onChange={event => { setKind(event.target.value as NetworkQueryKind); setArmed(false); }}><option value="auto">智能 IP / MAC 查询</option><option value="arp">ARP 查询</option><option value="routes">路由查询</option><option value="ipInterfaces">IP 接口查询</option><option value="mac">MAC 学习端口</option></select></label></div>}
    <div className="network-query-heading"><strong>{global ? '全网查询' : labels[kind]}</strong>{global && <span>{profiles.length} 台可查询 · {config.profiles.filter(profile => !scope || inGroup(profile, JSON.parse(scope))).length - profiles.length} 台未配置</span>}<details className="network-query-help"><summary>查询说明</summary><div><p>{hint(kind)}</p><p>IPv4 标准表查询，结果受设备支持和 SNMP 视图权限限制；链路状态不等同于厂商协议状态。每轮最多并行查询 3 台，完成后计时刷新，离开或隐藏页面会停止。MAC 学习端口可能是上联口，需结合 LLDP 继续定位。</p></div></details></div>
    <form className="network-query-form" onSubmit={event => { event.preventDefault(); void run(); }}>
      <label className="network-query-input"><Search size={16} /><input id={global ? 'network-global-search' : undefined} aria-label={global ? '全网查询 IP 或 MAC' : `${labels[kind]}地址`} placeholder={kind === 'auto' ? '输入终端 IPv4 或 MAC，按 Enter 全网查询' : kind === 'mac' ? '输入任意支持格式的 MAC' : kind === 'routes' ? global ? '输入完整目的 IPv4 地址' : '输入完整目的 IPv4；留空读取全部' : global ? '输入 IPv4 地址或片段' : '输入 IPv4 地址；留空读取全部'} value={query} disabled={busy} maxLength={64} onChange={event => { setQuery(event.target.value); setArmed(false); setShowTrunks(false); }} /></label>
      <button className="button primary" disabled={busy || !profiles.length || (global || kind === 'auto' || kind === 'mac') && !query.trim()}><Search size={14} />{busy ? '正在查询…' : global ? '查询全网' : '查询当前设备'}</button>
      {busy ? <button type="button" className="button" onClick={stop}><Square size={13} />停止</button> : armed && interval > 0 ? <button type="button" className="button" onClick={stop}>暂停刷新</button> : null}
      <label className="network-refresh"><RefreshCw size={14} /><select aria-label="网络查询自动刷新" value={interval} onChange={event => { const value = Number(event.target.value); setIntervalValue(value); localStorage.setItem('harbor-network-refresh', String(value)); }}><option value="30">每 30 秒刷新</option><option value="60">每 60 秒刷新</option><option value="0">仅手动查询</option></select></label>
    </form>
    {notice && !job && <p className="network-query-notice" role="status">{notice}</p>}
    {error && <p className="error-text network-query-error" role="alert">{error}</p>}
    {job ? <><div className="network-query-progress" role="status"><strong>{job.status === 'running' ? '查询中' : job.status === 'cancelled' ? '已停止' : '本轮完成'} · {completed} / {job.devices.length} 台 · {hits} 台命中 · {rows.length} 条</strong><span>{job.query || '全部条目'} · {new Date(job.startedAt).toLocaleTimeString()} 开始{armed && interval > 0 && !busy ? ` · 完成后 ${interval} 秒刷新` : ''}</span><progress max={job.devices.length} value={completed} aria-label="网络查询进度" /></div>
      <div className="network-query-results"><NetworkQueryResults rows={rows} global={global} onSelect={onSelect} busy={busy} expanded={showTrunks} onToggle={() => setShowTrunks(value => !value)} />
      <details className="network-query-coverage"><summary>设备查询状态 · {issueCount} 台需检查（含表为空或访问受限）</summary><div>{job.devices.map(device => <article key={device.profileId}><strong>{device.name}</strong><code>{device.host}</code><span>{device.status === 'done' ? device.data?.rows.length ? `${device.data.rows.length} 条命中` : device.data?.available ? '可读取的数据中未命中' : '表为空或不可读取' : { queued: '等待中', running: '查询中', error: '查询失败', cancelled: '已取消' }[device.status]}</span>{device.data && <time>{new Date(device.data.readAt).toLocaleTimeString()}</time>}{device.error && <p className="error-text">{device.error}</p>}{device.data?.warnings.map(warning => <p key={warning} className="warning-text">{warning}</p>)}</article>)}</div></details></div>
    </> : <div className="network-placeholder"><Search size={26} /><p>{global ? '只查询连接库中已配置 SNMP 的设备，可按三级分组缩小范围。' : '通过 SNMP 只读查询，无需连接 SSH。'}</p></div>}

  </section>;
}
