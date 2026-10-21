import { useState, type FormEvent } from 'react';
import { ArrowLeftRight, Globe2, Laptop, Server } from 'lucide-react';
import type { Config, Profile, Tunnel } from '../../shared/types';
import { api, errorText } from '../api';
import { Modal } from './Modal';

export function TunnelForm({ tunnel, profiles, onSaved, onClose }: { tunnel?: Tunnel; profiles: Profile[]; onSaved: (c: Config) => void; onClose: () => void }) {
  const [t, setT] = useState<Tunnel>(tunnel || { id: crypto.randomUUID(), name: '', profileId: profiles[0]?.id || '', type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 80 });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const update = <K extends keyof Tunnel>(key: K, value: Tunnel[K]) => setT(t => ({ ...t, [key]: value }));
  async function submit(e: FormEvent) { e.preventDefault(); if (busy) return; setBusy(true); try { onSaved(await api.saveTunnel(t)); onClose(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  const descriptions = { local: '通过本机端口，访问 SSH 服务器侧的服务。例如连接远程数据库。', remote: '通过服务器端口，访问本机侧的服务。远程监听地址受服务器 GatewayPorts 配置限制。', dynamic: '在本机启动 SOCKS5 代理，由 SSH 服务器连接目标地址。支持 TCP 和远程 DNS。' };
  return <Modal title={tunnel ? '编辑 SSH 隧道' : '新建 SSH 隧道'} subtitle="为远程服务建立一条加密通道。" onClose={onClose}><form onSubmit={submit}><div className="form-body">
    <label>隧道名称<input required autoFocus maxLength={100} placeholder="例如：生产数据库" value={t.name} onChange={e => update('name', e.target.value)} /></label>
    <label>SSH 连接<select required value={t.profileId} onChange={e => update('profileId', e.target.value)}><option value="" disabled>选择 SSH 连接</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.username}@{p.host}</option>)}</select></label>
    <div className="field-label">转发模式</div><div className="segmented auth">{([{ type: 'local', label: '本地转发', icon: Laptop }, { type: 'remote', label: '远程转发', icon: Server }, { type: 'dynamic', label: '动态 SOCKS5', icon: Globe2 }] as const).map(({ type, label, icon: Icon }) => <button type="button" key={type} className={t.type === type ? 'active' : ''} onClick={() => setT(t => ({ ...t, type, bindHost: '127.0.0.1', bindPort: type === 'dynamic' ? 1080 : 8080 }))}><Icon size={15} />{label}</button>)}</div>
    <p className="mode-description">{descriptions[t.type]}</p>
    <div className="tunnel-diagram"><span>{t.type === 'remote' ? 'SSH 服务器' : '本机'}<small>{t.bindHost}:{t.bindPort || '端口'}</small></span><ArrowLeftRight size={21} /><span>{t.type === 'dynamic' ? '互联网' : t.type === 'remote' ? '本机侧目标' : '服务器侧目标'}<small>{t.type === 'dynamic' ? 'SOCKS5 · TCP' : `${t.targetHost}:${t.targetPort || '端口'}`}</small></span></div>
    <div className="form-row host-port"><label>{t.type === 'remote' ? '远程监听地址' : '本地监听地址'}<input required value={t.bindHost} onChange={e => update('bindHost', e.target.value)} /></label><label>监听端口<input type="number" required min={1} max={65535} value={t.bindPort} onChange={e => update('bindPort', Number(e.target.value))} /></label></div>
    {t.type !== 'dynamic' && <div className="form-row host-port"><label>目标地址<input required value={t.targetHost} onChange={e => update('targetHost', e.target.value)} /></label><label>目标端口<input type="number" required min={1} max={65535} value={t.targetPort} onChange={e => update('targetPort', Number(e.target.value))} /></label></div>}
    {t.bindHost !== '127.0.0.1' && t.bindHost !== 'localhost' && t.bindHost !== '::1' && <div className="notice amber">此监听地址可能允许其他设备访问。SOCKS5 不提供用户名密码认证，建议仅监听本机。</div>}
    <p className="field-hint">隧道拥有独立的 SSH 连接，关闭终端标签不会停止隧道。退出程序会停止所有隧道。</p>{error && <div className="form-error" role="alert">{error}</div>}
  </div><footer className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !profiles.length}>{busy ? '保存中…' : '保存隧道'}</button></footer></form></Modal>;
}
