import { useState, type FormEvent } from 'react';
import { FolderOpen, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { Config, Profile } from '../../shared/types';
import { api, errorText } from '../api';
import { Modal } from './Modal';
import { GroupFields } from './GroupFields';
import { buildGroupPath, groupLabel, profileGroupPath, UNGROUPED } from '../../shared/groups';

export function newProfile(path: string[] = []): Profile { const groupPath = path.length === 1 && path[0] === UNGROUPED ? [] : path; return { id: crypto.randomUUID(), name: '', host: '', port: 22, username: 'root', group: groupLabel(groupPath), groupPath, authType: 'password', privateKeyPath: '', agentPath: '', favorite: false, color: 'teal', hasSecret: false, rememberSecret: true }; }
export function ProfileForm({ profile, profiles, secure, existing, onSaved, onClose }: { profile: Profile; profiles: Profile[]; secure: boolean; existing: boolean; onSaved: (config: Config) => void; onClose: () => void }) {
  const [p, setP] = useState({ ...profile, rememberSecret: true }); const [password, setPassword] = useState(''); const [passphrase, setPassphrase] = useState(''); const [clearSecret, setClearSecret] = useState(false);
  const [levels, setLevels] = useState(() => profileGroupPath(profile));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const update = <K extends keyof Profile>(key: K, value: Profile[K]) => setP(p => ({ ...p, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const groupPath = buildGroupPath(levels); onSaved(await api.saveProfile({ profile: { ...p, groupPath, group: groupLabel(groupPath) }, secrets: { password, passphrase }, clearSecret })); onClose(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <Modal title={existing ? '编辑 SSH 连接' : '新建 SSH 连接'} subtitle="配置主机信息，随时开启远程会话。" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="form-body"><label>连接名称<input required maxLength={100} autoFocus placeholder="例如：生产环境 · Web 01" value={p.name} onChange={e => update('name', e.target.value)} /></label>
        <div className="form-row host-port"><label>主机地址<input required placeholder="IP 地址或域名" value={p.host} onChange={e => update('host', e.target.value)} /></label><label>端口<input required type="number" min={1} max={65535} value={p.port} onChange={e => update('port', Number(e.target.value))} /></label></div>
        <label>用户名<input required value={p.username} onChange={e => update('username', e.target.value)} /></label>
        <GroupFields levels={levels} onChange={setLevels} profiles={profiles} />
        <div className="field-label">认证方式</div><div className="segmented auth"><button type="button" className={p.authType === 'password' ? 'active' : ''} onClick={() => update('authType', 'password')}><LockKeyhole size={15} />密码</button><button type="button" className={p.authType === 'key' ? 'active' : ''} onClick={() => update('authType', 'key')}><KeyRound size={15} />私钥</button><button type="button" className={p.authType === 'agent' ? 'active' : ''} onClick={() => update('authType', 'agent')}><ShieldCheck size={15} />SSH Agent</button></div>
        {p.authType === 'password' && <label>密码<input type="password" autoComplete="new-password" placeholder={p.hasSecret ? '已保存凭据，留空保留原密码' : '输入 SSH 登录密码'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
        {p.authType === 'key' && <><label>私钥文件<div className="input-with-button"><input required placeholder="C:\Users\you\.ssh\id_ed25519" value={p.privateKeyPath} onChange={e => update('privateKeyPath', e.target.value)} /><button type="button" className="button" onClick={async () => { try { const file = await api.pickKey(); if (file) update('privateKeyPath', file); } catch (err) { setError(errorText(err)); } }}><FolderOpen size={16} />浏览</button></div></label><label>私钥口令（可选）<input type="password" autoComplete="new-password" placeholder={p.hasSecret ? '留空保留原口令' : '未加密私钥可留空'} value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label><p className="field-hint">支持 OpenSSH / PEM 私钥；PuTTY .ppk 请先转换为 OpenSSH 格式。</p></>}
        {p.authType === 'agent' && <label>Agent 路径（可选）<input placeholder="留空使用系统 SSH Agent" value={p.agentPath} onChange={e => update('agentPath', e.target.value)} /><span className="field-hint">Windows 默认使用 OpenSSH Authentication Agent 服务。</span></label>}
        {p.authType !== 'agent' && <div className="secret-options"><span className="credential-info"><ShieldCheck size={15} />{p.hasSecret ? '已有凭据 · 留空保留' : '尚未保存凭据'}</span><p className="field-hint">凭据由软件密码保护并加密保存，退出后仍保留。私钥文件只保存路径。</p>{existing && p.hasSecret && <label className="checkbox-label"><input type="checkbox" checked={clearSecret} onChange={e => setClearSecret(e.target.checked)} />清除原有凭据</label>}</div>}
        <div className="form-row align-center"><div><span className="field-label">标记颜色</span><div className="color-picker">{['teal', 'blue', 'violet', 'amber', 'rose'].map(color => <button key={color} type="button" title={color} className={`color-dot ${color} ${p.color === color ? 'selected' : ''}`} onClick={() => update('color', color)} />)}</div></div><label className="checkbox-label"><input type="checkbox" checked={p.favorite} onChange={e => update('favorite', e.target.checked)} />加入收藏</label></div>
        {existing && <button type="button" className="text-button muted" onClick={async () => { try { if (await api.resetTrust(p.id)) setError('已重置，下次连接将重新核对主机指纹。'); } catch (err) { setError(errorText(err)); } }}>重置信任指纹</button>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div><footer className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存连接'}</button></footer>
    </form>
  </Modal>;
}
