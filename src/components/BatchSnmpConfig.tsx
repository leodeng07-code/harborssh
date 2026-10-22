import { useState } from 'react';
import { Save } from 'lucide-react';
import type { Config } from '../../shared/types';
import { inGroup } from '../../shared/groups';
import { api, errorText } from '../api';
import { Modal } from './Modal';
import { ScopePicker } from './NetworkQueryPanel';

export function BatchSnmpConfig({ config, onClose, onSaved }: { config: Config; onClose: () => void; onSaved: (config: Config) => void }) {
  const [scope, setScope] = useState(''), [read, setRead] = useState(''), [write, setWrite] = useState('');
  const [includeConfigured, setIncludeConfigured] = useState(false), [clearWrite, setClearWrite] = useState(false), [overridePort, setOverridePort] = useState(false), [port, setPort] = useState(161);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const profiles = config.profiles.filter(profile => (!scope || inGroup(profile, JSON.parse(scope))) && (includeConfigured || !config.snmp?.some(target => target.profileId === profile.id && target.hasReadCommunity)));
  return <Modal title="批量 SNMP 配置" subtitle="统一团体名，加密保存到所选设备" onClose={() => { if (!busy) onClose(); }}><form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { const saved = await api.snmpConfigureBatch({ profileIds: profiles.map(profile => profile.id), readCommunity: read, writeCommunity: write || undefined, clearWrite, port: overridePort ? port : undefined }); setRead(''); setWrite(''); onSaved(saved); onClose(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }}><div className="network-form"><ScopePicker profiles={config.profiles} value={scope} onChange={setScope} disabled={busy} />
    <label className="checkbox-label"><input type="checkbox" checked={includeConfigured} disabled={busy} onChange={event => setIncludeConfigured(event.target.checked)} />同时替换已配置设备的团体名</label>
    <details className="batch-snmp-preview"><summary>本次将应用到 {profiles.length} 台设备（展开核对名单）</summary><ul>{profiles.map(profile => <li key={profile.id}><strong>{profile.name}</strong><code>{profile.host}</code></li>)}</ul></details>
    <label>统一只读团体名（Community）<input aria-label="统一只读团体名" type="password" autoComplete="new-password" required maxLength={256} value={read} disabled={busy} onChange={event => setRead(event.target.value)} /></label>
    <label>统一读写团体名（可选）<input aria-label="统一读写团体名" type="password" autoComplete="new-password" maxLength={256} value={write} disabled={busy || clearWrite} onChange={event => setWrite(event.target.value)} placeholder="留空保留每台设备原有的读写凭据" /></label>
    <label className="checkbox-label"><input type="checkbox" checked={clearWrite} disabled={busy} onChange={event => setClearWrite(event.target.checked)} />移除所选设备的读写团体名</label>
    <label className="checkbox-label"><input type="checkbox" checked={overridePort} disabled={busy} onChange={event => setOverridePort(event.target.checked)} />统一 UDP 端口</label>
    {overridePort && <label>UDP 端口<input aria-label="统一 SNMP UDP 端口" type="number" min={1} max={65535} required value={port} disabled={busy} onChange={event => setPort(Number(event.target.value))} /></label>}
    <p className="field-hint">仅保存软件的查询配置，不会修改交换机配置。未勾选统一端口时保留各设备端口，新设备默认 161；保留原有 MIB 参数适配。团体名由软件密码加密保存，不回显。</p>
    {error && <p className="error-text" role="alert">{error}</p>}
  </div><footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !profiles.length}><Save size={14} />{busy ? '正在保存…' : `应用到 ${profiles.length} 台设备`}</button></footer></form></Modal>;
}
