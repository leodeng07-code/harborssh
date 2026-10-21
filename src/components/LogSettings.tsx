import { useState } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import type { Config } from '../../shared/types';
import { api, errorText } from '../api';

export function LogSettings({ config, onConfig, notify }: { config: Config; onConfig: (config: Config) => void; notify: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return <section className="settings-section"><div className="settings-icon"><Folder size={20} /></div><div><h3>终端日志自动保存</h3><p>每个 SSH 会话持续记录远端输出，断开后按“连接名称＋断开时间”保存。正常退出软件时会完成日志写入。</p><label className="log-directory-label">保存目录<output aria-label="终端日志保存目录" className="log-directory mono">{config.terminalLogDirectory || '桌面版自动使用本机日志目录'}</output></label><div className="settings-actions"><button className="button" disabled={busy} onClick={async () => { setBusy(true); try { const next = await api.chooseLogDirectory(); if (next) { onConfig(next); notify('日志保存目录已更新，新会话将使用此目录'); } } catch (error) { notify(errorText(error), true); } finally { setBusy(false); } }}><Folder size={15} />{busy ? '正在选择…' : '选择保存目录'}</button><button className="button" onClick={async () => { try { await api.openLogDirectory(); } catch (error) { notify(errorText(error), true); } }}><FolderOpen size={15} />打开日志目录</button></div><p className="log-settings-note">目录修改从新会话起生效。连接期间为 .recording.log，持续写入；异常退出时该文件仍会保留。日志是明文文件，包含远端显示的内容，不额外记录键盘输入。</p></div></section>;
}
