import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck, Terminal } from 'lucide-react';
import { api, errorText } from '../api';

export function PasswordGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ configured: boolean; unlocked: boolean }>();
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void api.lockStatus().then(setStatus).catch(error => setError(errorText(error))); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !status) return;
    if (!status.configured && password !== confirmation) { setError('两次输入的软件密码不一致'); return; }
    setBusy(true); setError('');
    try { if (status.configured) await api.unlock(password); else await api.setupPassword(password); setPassword(''); setConfirmation(''); setStatus(await api.lockStatus()); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  if (status?.unlocked) return children;
  return <div className="lock-screen"><header className="lock-titlebar"><span><Terminal size={18} />Harbor SSH</span><button className="icon-button" aria-label="退出应用" onClick={() => api.window('close')}>×</button></header><form className="lock-card" onSubmit={submit}>
    <div className="lock-emblem"><LockKeyhole size={30} /></div><span className="eyebrow">YOUR LOCAL, PRIVATE WORKSPACE</span><h1>{status ? status.configured ? '欢迎回来' : '设置软件密码' : '正在加载…'}</h1>
    <p>{status?.configured ? '输入软件密码，解锁你的连接与凭据。' : '设置一个软件密码，保护保存在本机的 SSH 凭据。'}</p>
    {status && <><label>软件密码<input autoFocus type="password" required minLength={status.configured ? undefined : 8} maxLength={256} autoComplete={status.configured ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder={status.configured ? '输入软件密码' : '至少 8 个字符'} /></label>
      {!status.configured && <><label>确认软件密码<input type="password" required maxLength={256} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="再次输入软件密码" /></label><div className="notice">请牢记软件密码，忘记后无法恢复已加密的凭据。备份时请保留整个配置目录，包括 vault.json。</div></>}
      <button className="button primary lock-submit" disabled={busy}>{busy ? '正在解锁…' : status.configured ? '解锁工作空间' : '设置密码并进入'}<ArrowRight size={16} /></button></>}
    {error && <div className="form-error" role="alert">{error}</div>}<div className="lock-note"><ShieldCheck size={14} />SSH 凭据加密保存 · 退出后保留</div>
  </form></div>;
}

export function PasswordSettings({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (next !== confirm) { notify('两次输入的新密码不一致', true); return; }
    setBusy(true);
    try { await api.changePassword(current, next); setOpened(false); setCurrent(''); setNext(''); setConfirm(''); notify('软件密码已修改，SSH 凭据已保留'); }
    catch (error) { notify(errorText(error), true); } finally { setBusy(false); }
  }
  return <div className="password-settings">{!opened ? <button className="button" onClick={() => setOpened(true)}><LockKeyhole size={14} />修改软件密码</button> : <form className="password-change-form" onSubmit={submit}><label>当前软件密码<input required type="password" maxLength={256} autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label><label>新软件密码<input required type="password" minLength={8} maxLength={256} autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label><label>确认新软件密码<input required type="password" maxLength={256} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label><div className="settings-actions"><button className="button" type="button" disabled={busy} onClick={() => { setOpened(false); setCurrent(''); setNext(''); setConfirm(''); }}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在修改…' : '保存软件密码'}</button></div></form>}</div>;
}
