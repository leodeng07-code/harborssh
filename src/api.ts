import type { DesktopAPI, Config } from '../shared/types';

export const isDesktop = !!window.harbor;
const unavailable = async (): Promise<never> => { throw new Error('浏览器仅提供界面预览，请运行 Windows 桌面版使用 SSH、隧道和 Excel 文件操作。'); };
let previewConfig: Config = { profiles: [], tunnels: [] };
try { previewConfig = JSON.parse(localStorage.getItem('harbor-preview') || '{"profiles":[],"tunnels":[]}'); } catch {}
function savePreview() { localStorage.setItem('harbor-preview', JSON.stringify(previewConfig)); return structuredClone(previewConfig); }
const browser: DesktopAPI = {
  lockStatus: async () => ({ configured: true, unlocked: true }), setupPassword: unavailable, unlock: unavailable, changePassword: unavailable,
  initial: async () => ({ config: structuredClone(previewConfig), runtime: { sessions: [], tunnels: [], jobs: [] }, version: '0.6.1', secureStorage: false, platform: 'browser' }),
  saveProfile: async input => { const p = { ...input.profile, hasSecret: false, rememberSecret: false }; previewConfig.profiles = [...previewConfig.profiles.filter(x => x.id !== p.id), p]; return savePreview(); },
  deleteProfile: async id => { previewConfig.profiles = previewConfig.profiles.filter(p => p.id !== id); previewConfig.tunnels = previewConfig.tunnels.filter(t => t.profileId !== id); return savePreview(); },
  deleteProfiles: async ids => { const selected = new Set(ids); previewConfig.profiles = previewConfig.profiles.filter(p => !selected.has(p.id)); previewConfig.tunnels = previewConfig.tunnels.filter(t => !selected.has(t.profileId)); return savePreview(); },
  saveTunnel: async tunnel => { previewConfig.tunnels = [...previewConfig.tunnels.filter(t => t.id !== tunnel.id), tunnel]; return savePreview(); },
  deleteTunnel: async id => { previewConfig.tunnels = previewConfig.tunnels.filter(t => t.id !== id); return savePreview(); },
  connect: unavailable, disconnect: unavailable, write: () => {}, resize: () => {}, readTerminal: unavailable,
  readSystem: unavailable,
  chooseLogDirectory: unavailable, openLogDirectory: unavailable,
  sftpList: unavailable, sftpUpload: unavailable, sftpDownload: unavailable, sftpMkdir: unavailable, sftpRename: unavailable, sftpDelete: unavailable, sftpTransfers: unavailable, sftpCancel: unavailable,
  startTunnel: unavailable, stopTunnel: unavailable, runBatch: unavailable, cancelBatch: unavailable,
  snmpConfigure: unavailable, snmpInterfaces: unavailable, snmpChange: unavailable, snmpMac: unavailable, snmpLldp: unavailable,
  networkQuery: unavailable, networkQueryRead: unavailable, networkQueryCancel: unavailable,
  windowVisible: async () => !document.hidden,
  snmpConfigureBatch: unavailable,
  pickKey: unavailable, importPreview: unavailable, importCommit: unavailable, importCancel: async () => {}, saveTemplate: unavailable, exportConfig: unavailable, resetTrust: unavailable,
  copy: text => navigator.clipboard.writeText(text), paste: () => navigator.clipboard.readText(), window: () => {}, onEvent: () => () => {},
};
export const api = window.harbor || browser;
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
