import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Pause, Play, RefreshCw, X } from 'lucide-react';
import type { SessionInfo, SystemSnapshot } from '../../shared/types';
import { api, errorText } from '../api';
import '../system-monitor.css';

export function useSystemStatus(session: SessionInfo, active: boolean, enabled: boolean) {
  const [data, setData] = useState<SystemSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [paused, setPaused] = useState(false), [nonce, setNonce] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const pending = useRef(false), failures = useRef(0), lastAt = useRef(0);
  const [foreground, setForeground] = useState(!document.hidden);
  useEffect(() => { const change = () => setForeground(!document.hidden); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, []);
  useEffect(() => {
    if (!active || !enabled || paused || !foreground || session.status !== 'connected') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (stopped) return;
      if (pending.current) { timer = setTimeout(read, 300); return; }
      pending.current = true; setBusy(true);
      let delay = 5000;
      try {
        const value = await api.readSystem(session.id);
        if (stopped) return;
        setData(value); setError(''); failures.current = 0;
        if (value.readAt !== lastAt.current && value.cpuPercent !== undefined) setHistory(values => [...values, value.cpuPercent!].slice(-40));
        const firstSample = lastAt.current === 0; lastAt.current = value.readAt;
        if (value.platform === 'unsupported') return;
        if (firstSample && value.cpuPercent === undefined) delay = 2200;
      } catch (error) {
        if (stopped) return;
        setError(errorText(error)); failures.current++;
        if (failures.current >= 3) { setPaused(true); return; }
      } finally { pending.current = false; if (!stopped) setBusy(false); }
      if (!stopped) timer = setTimeout(read, delay);
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); setBusy(false); };
  }, [session.id, session.status, active, enabled, paused, nonce, foreground]);
  return { data, error, busy, paused, history, inactive: !active || !enabled || !foreground || session.status !== 'connected', togglePause: () => { failures.current = 0; setPaused(value => !value); }, refresh: () => { failures.current = 0; setPaused(false); setNonce(value => value + 1); } };
}
export const formatBytes = (bytes: number | undefined) => {
  if (bytes === undefined) return '采样中';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit && value < 10 ? 1 : 0)} ${units[unit]}`;
};
const duration = (seconds: number | undefined) => seconds === undefined ? '未返回' : `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
const percent = (value: number | undefined) => value === undefined ? '采样中' : `${value.toFixed(1)}%`;
function Gauge({ value }: { value?: number }) { return <div className="system-gauge" role="meter" aria-label="使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${Math.min(100, value || 0)}%` }} className={(value || 0) >= 90 ? 'high' : ''} /></div>; }
export function SystemMonitorPanel({ monitor, session, onClose }: { monitor: ReturnType<typeof useSystemStatus>; session: SessionInfo; onClose: () => void }) {
  const { data, busy, error, paused, inactive, history } = monitor;
  const linux = data?.platform === 'linux';
  return <aside className="system-panel" aria-label="Linux 运行状态"><header><Activity size={16} /><strong>Linux 运行状态</strong><button className="icon-button" aria-label="收起运行状态" onClick={onClose}><X size={15} /></button></header>
    <div className="system-controls"><span className={inactive || paused || error ? 'muted' : 'system-live'}>{session.status !== 'connected' ? '已断开 · 保留最后数据' : paused ? '已暂停' : inactive ? '暂停采集' : busy ? '正在采集…' : '每 5 秒刷新'}</span><button className="icon-button" aria-label={paused ? '继续状态采集' : '暂停状态采集'} disabled={session.status !== 'connected'} onClick={monitor.togglePause}>{paused ? <Play size={14} /> : <Pause size={14} />}</button><button className="icon-button" aria-label="刷新运行状态" disabled={busy || session.status !== 'connected'} onClick={monitor.refresh}><RefreshCw size={14} className={busy ? 'spinning' : ''} /></button></div>
    <div className="system-content">{error && <p className="system-error" role="alert">{error}{paused ? '；已暂停，请点击刷新重试。' : '；数据未更新。'}</p>}
      {!linux && <div className="system-empty"><Activity size={28} /><p>{data?.reason || (error ? '当前无法读取运行状态，终端仍可使用。' : '正在识别 Linux 系统…')}</p></div>}
      {linux && <><div className="system-identity"><strong>{data.hostname || session.name}</strong><span>{data.release}</span><small>内核 {data.kernel || '未返回'}</small><small>运行 {duration(data.uptime)}</small><small>更新于 {new Date(data.readAt).toLocaleTimeString()}</small></div>
        <section className="system-metric"><h4><Cpu size={15} />CPU <span>{percent(data.cpuPercent)}</span></h4><Gauge value={data.cpuPercent} />{history.length > 1 && <svg className="system-history" viewBox="0 0 280 34" preserveAspectRatio="none" role="img" aria-label="最近 CPU 使用率趋势"><polyline points={history.map((value, index) => `${index * 280 / (history.length - 1)},${33 - value * .32}`).join(' ')} /></svg>}<p>{data.cores ? `${data.cores} 核 · ` : ''}负载 1 / 5 / 15 分钟</p><strong className="mono">{data.load?.map(value => value.toFixed(2)).join(' / ') || '未返回'}</strong></section>
        <section className="system-metric"><h4><MemoryStick size={15} />内存 <span>{data.memory ? percent(data.memory.percent) : '未返回'}</span></h4><Gauge value={data.memory?.percent} /><p>{data.memory ? `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}${data.memory.estimated ? '（估算）' : ''}` : '当前账号未取得内存数据'}</p><small>Swap：{data.swap ? data.swap.total ? `${formatBytes(data.swap.used)} / ${formatBytes(data.swap.total)}` : '未配置' : '未返回'}</small></section>
        <section className="system-metric"><h4><HardDrive size={15} />磁盘<span>{data.disks.length} 个挂载点</span></h4>{data.disks.map((disk, index) => <div className="system-disk" key={`${disk.device}:${disk.mount}:${index}`}><div><strong title={disk.mount}>{disk.mount}</strong><span>{percent(disk.percent)}</span></div><Gauge value={disk.percent} /><p>{formatBytes(disk.used)} / {formatBytes(disk.total)} · 可用 {formatBytes(disk.available)}</p></div>)}</section>
        <section className="system-metric"><h4><Activity size={15} />网络速率</h4><p>逐接口显示，避免虚拟网卡流量重复汇总</p>{data.networks.filter(network => network.name !== 'lo').map(network => <div className="system-network" key={network.name}><strong>{network.name}</strong><span><ArrowDown size={12} />{formatBytes(network.receiveRate)}{network.receiveRate !== undefined ? '/s' : ''}</span><span><ArrowUp size={12} />{formatBytes(network.sendRate)}{network.sendRate !== undefined ? '/s' : ''}</span></div>)}{!data.networks.some(network => network.name !== 'lo') && <small>未返回非回环网卡</small>}</section>
        {data.warnings.length > 0 && <details className="system-warnings"><summary>{data.warnings.length} 项数据提示</summary>{data.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
      </>}
    </div><footer>只读采集 · 无需安装代理</footer></aside>;
}
