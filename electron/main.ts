import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { Store } from './store';
import { Vault } from './vault';
import { Manager } from './manager';
import { parseImport, exportProfiles, importSelection, type ImportDraft } from './importer';
import { batchSchema, idSchema, message, profileInputSchema, tunnelSchema, snmpConfigSchema, interfaceChangeSchema } from './validation';
import { SnmpService } from './snmp';
import type { AppEvent, Profile } from '../shared/types';

let win: BrowserWindow;
let store: Store;
let vault: Vault;
let manager: Manager;
let snmp: SnmpService;
let exiting = false;
let confirmingClose = false;
const drafts = new Map<string, ImportDraft>();
const verifications = new Map<string, Promise<boolean>>();
const devURL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
const rendererPath = path.join(__dirname, '../dist/index.html');

function assertSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的请求来源');
  const url = event.senderFrame?.url;
  if (devURL ? new URL(url || 'about:blank').origin !== new URL(devURL).origin : url !== pathToFileURL(rendererPath).href) throw new Error('无效的页面来源');
}
function handle(channel: string, fn: (...args: any[]) => unknown, requiresUnlock = true) {
  ipcMain.handle(channel, async (event, ...args) => { assertSender(event); try { if (requiresUnlock && !vault.available()) throw new Error('请先输入软件密码解锁'); return await fn(...args); } catch (err) { throw new Error(message(err)); } });
}
function emit(event: AppEvent) { if (win && !win.isDestroyed()) win.webContents.send('harbor:event', event); }
async function clipboardResult<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('访问系统剪贴板超时，请重试')), 7000); })]); }
  finally { clearTimeout(timer); }
}
async function verifyHost(profile: Profile, fingerprint: string): Promise<boolean> {
  const host = `[${profile.host.toLowerCase()}]:${profile.port}`;
  const known = store.knownHost(host);
  if (known === fingerprint) return true;
  const key = `${host}:${fingerprint}`;
  if (verifications.has(key)) return verifications.get(key)!;
  const operation = (async () => {
    if (known) {
      await dialog.showMessageBox(win, { type: 'error', title: '服务器指纹已改变', message: `${profile.host}:${profile.port} 的身份与已保存记录不一致，连接已阻止。`, detail: `已保存：${known}\n当前：${fingerprint}\n\n请向服务器管理员核对。确认服务器更换密钥后，可在编辑连接中重置信任指纹。`, buttons: ['关闭'] });
      return false;
    }
    const response = await dialog.showMessageBox(win, { type: 'question', title: '首次连接：核对服务器身份', message: `信任 ${profile.host}:${profile.port} 的主机密钥？`, detail: `SHA256 指纹：\n${fingerprint}\n\n请与服务器管理员提供的指纹核对。信任后将保存指纹，用于检查后续连接。`, buttons: ['取消', '信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
    if (response.response !== 1) return false;
    // Another concurrent connection must not replace an already pinned different key.
    const current = store.knownHost(host); if (current && current !== fingerprint) return false;
    await store.trustHost(host, fingerprint); return true;
  })();
  verifications.set(key, operation);
  try { return await operation; } finally { verifications.delete(key); }
}
function registerIPC() {
  const password = z.string().max(256);
  handle('harbor:lock-status', () => vault.status(), false);
  handle('harbor:password-setup', async raw => { await vault.setup(password.parse(raw)); await store.migrateCredentials(); }, false);
  handle('harbor:unlock', async raw => { await vault.unlock(password.parse(raw)); await store.migrateCredentials(); }, false);
  handle('harbor:password-change', (current, next) => vault.changePassword(password.parse(current), password.parse(next)));
  handle('harbor:initial', () => ({ config: store.config(), runtime: manager.snapshot(), version: app.getVersion(), secureStorage: vault.available(), platform: process.platform }));
  handle('harbor:profile-save', input => store.saveProfile(profileInputSchema.parse(input)));
  handle('harbor:profile-delete', async raw => { const id = idSchema.parse(raw); await manager.closeProfile(id); return store.deleteProfile(id); });
  handle('harbor:profiles-delete', async raw => {
    const ids = [...new Set(z.array(idSchema).min(1).max(2000).parse(raw))];
    ids.forEach(id => store.profile(id));
    manager.assertProfilesDeletable(ids);
    for (const id of ids) await manager.closeProfile(id);
    return store.deleteProfiles(ids);
  });
  handle('harbor:tunnel-save', raw => { const t = tunnelSchema.parse(raw); if (manager.tunnelActive(t.id)) throw new Error('请先停止隧道再编辑'); return store.saveTunnel(t); });
  handle('harbor:tunnel-delete', async raw => { const id = idSchema.parse(raw); await manager.removeTunnel(id); return store.deleteTunnel(id); });
  handle('harbor:connect', id => manager.startSession(idSchema.parse(id)));
  handle('harbor:disconnect', async raw => {
    const id = idSchema.parse(raw), count = manager.sftp.transfers(id).filter(t => ['queued', 'preparing', 'running'].includes(t.status)).length;
    if (count) {
      const result = await dialog.showMessageBox(win, { type: 'question', title: '关闭 SSH 会话', message: `此会话有 ${count} 项文件传输尚未完成，关闭将取消这些传输。`, buttons: ['继续传输', '取消传输并关闭'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    manager.disconnect(id);
  });
  handle('harbor:terminal-read', id => manager.readTerminal(idSchema.parse(id)));
  handle('harbor:log-directory-choose', async () => {
    const result = await dialog.showOpenDialog(win, { title: '选择终端日志保存目录', defaultPath: store.config().terminalLogDirectory, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = result.filePaths[0]; await fs.mkdir(directory, { recursive: true });
    const probe = path.join(directory, `.harborssh-write-test-${crypto.randomUUID()}`);
    const handle = await fs.open(probe, 'wx', 0o600); await handle.close(); await fs.unlink(probe);
    return store.saveLogDirectory(directory);
  });
  handle('harbor:log-directory-open', async () => {
    const directory = store.config().terminalLogDirectory!; await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(directory); if (error) throw new Error(error);
  });
  const remote = z.string().max(4096).refine(value => !value.includes('\0'), '路径不能包含空字符');
  const remotePaths = z.array(remote.min(1)).min(1).max(100);
  handle('harbor:sftp-list', (id, directory) => manager.sftp.list(idSchema.parse(id), remote.parse(directory)));
  handle('harbor:sftp-transfers', id => manager.sftp.transfers(idSchema.parse(id)));
  handle('harbor:sftp-cancel', id => manager.sftp.cancel(idSchema.parse(id)));
  handle('harbor:sftp-mkdir', (id, directory, name) => manager.sftp.mkdir(idSchema.parse(id), remote.parse(directory), z.string().min(1).max(255).parse(name)));
  handle('harbor:sftp-rename', (id, filename, name) => manager.sftp.rename(idSchema.parse(id), remote.min(1).parse(filename), z.string().min(1).max(255).parse(name)));
  handle('harbor:sftp-delete', (id, filenames) => manager.sftp.remove(idSchema.parse(id), remotePaths.parse(filenames)));
  handle('harbor:sftp-upload', async (rawId, rawDirectory, rawFolder, rawOverwrite) => {
    const id = idSchema.parse(rawId), directory = remote.parse(rawDirectory), folder = z.boolean().parse(rawFolder), overwrite = z.boolean().parse(rawOverwrite);
    const result = await dialog.showOpenDialog(win, { title: folder ? '选择上传到远程的文件夹' : '选择上传到远程的文件', properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'] });
    if (!result.canceled && result.filePaths.length) await manager.sftp.upload(id, result.filePaths, directory, overwrite);
  });
  handle('harbor:sftp-download', async (rawId, rawPaths, rawOverwrite) => {
    const id = idSchema.parse(rawId), filenames = remotePaths.parse(rawPaths), overwrite = z.boolean().parse(rawOverwrite);
    const result = await dialog.showOpenDialog(win, { title: '选择文件下载保存目录', properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths[0]) await manager.sftp.download(id, filenames, result.filePaths[0], overwrite);
  });
  handle('harbor:tunnel-start', id => manager.startTunnel(idSchema.parse(id)));
  handle('harbor:tunnel-stop', id => manager.stopTunnel(idSchema.parse(id)));
  handle('harbor:batch-run', request => manager.runBatch(batchSchema.parse(request)));
  handle('harbor:batch-cancel', id => manager.cancelBatch(idSchema.parse(id)));
  handle('harbor:snmp-configure', input => store.saveSnmp(snmpConfigSchema.parse(input)));
  handle('harbor:snmp-interfaces', id => snmp.interfaces(idSchema.parse(id)));
  handle('harbor:snmp-mac', (id, mac) => snmp.mac(idSchema.parse(id), z.string().max(64).parse(mac)));
  handle('harbor:snmp-lldp', id => snmp.lldp(idSchema.parse(id)));
  handle('harbor:snmp-change', async raw => {
    const input = interfaceChangeSchema.parse(raw), p = store.profile(input.profileId);
    const display = (value: number | string) => input.field === 'adminStatus' ? value === 1 ? '启用' : value === 2 ? '停用' : String(value) : String(value) || '（空）';
    const labels = { adminStatus: '接口管理状态', alias: '接口描述', pvid: 'PVID', vlanMode: 'VLAN 模式', speed: '速率配置', duplex: '双工配置' };
    const result = await dialog.showMessageBox(win, { type: 'warning', title: '确认修改接口', message: `${p.name}（${p.host}） · ifIndex ${input.index}`, detail: `${labels[input.field]}：${display(input.expected)} → ${display(input.value)}\n\n接口参数变更可能断开业务及设备管理连接。\n修改通过 SNMP SET 下发，软件将回读验证。`, buttons: ['取消', '确认下发'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return { verified: false, message: '已取消，未下发修改' };
    return snmp.change(input);
  });
  handle('harbor:pick-key', async () => {
    const result = await dialog.showOpenDialog(win, { title: '选择 SSH 私钥', properties: ['openFile'], filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', '*'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('harbor:import-preview', async () => {
    const result = await dialog.showOpenDialog(win, { title: '从 Excel 导入 SSH 连接', properties: ['openFile'], filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv'] }] });
    if (result.canceled) return null;
    const draft = await parseImport(result.filePaths[0], store.config());
    drafts.clear(); drafts.set(draft.preview.token, draft); return draft.preview;
  });
  handle('harbor:import-cancel', token => { drafts.delete(idSchema.parse(token)); });
  handle('harbor:import-commit', async (rawToken, rawRows, rawRemember, rawFillMissing = false) => {
    const token = idSchema.parse(rawToken), rows = z.array(z.number().int().positive()).max(2000).parse(rawRows), remember = z.boolean().parse(rawRemember);
    const fillMissing = z.boolean().parse(rawFillMissing);
    const draft = drafts.get(token);
    if (!draft || Date.now() - draft.createdAt > 30 * 60 * 1000) { drafts.delete(token); throw new Error('导入预览已过期，请重新选择文件'); }
    if (!rows.length) throw new Error('请选择有效的连接行');
    const config = await store.importProfiles(config => importSelection(draft, rows, config, remember, fillMissing)); drafts.delete(token); return config;
  });
  handle('harbor:template-save', async () => {
    const result = await dialog.showSaveDialog(win, { title: '保存 Excel 导入模板', defaultPath: 'HarborSSH-导入模板.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return false;
    await fs.copyFile(path.join(__dirname, '../assets/SSH导入模板.xlsx'), result.filePath); return true;
  });
  handle('harbor:export', async () => {
    const result = await dialog.showSaveDialog(win, { title: '导出连接（不包含密码和私钥口令）', defaultPath: 'HarborSSH-连接列表.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return false;
    await exportProfiles(result.filePath, store.config()); return true;
  });
  handle('harbor:reset-trust', async raw => {
    const p = store.profile(idSchema.parse(raw)); const host = `[${p.host.toLowerCase()}]:${p.port}`;
    const result = await dialog.showMessageBox(win, { type: 'warning', title: '重置信任指纹', message: `移除 ${p.host}:${p.port} 的已信任指纹？`, detail: '下一次连接时会重新要求核对主机身份。请先确认服务器更换密钥的原因。', buttons: ['取消', '移除指纹'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return false;
    await store.forgetHost(host); return true;
  });
  handle('harbor:copy', value => clipboardResult(clipboard.writeText(z.string().max(1024 * 1024).parse(value))));
  handle('harbor:paste', async () => (await clipboardResult(clipboard.readText())).slice(0, 1024 * 1024));
  ipcMain.on('harbor:write', (event, rawId, data) => { try { assertSender(event); if (vault.available()) manager.write(idSchema.parse(rawId), z.string().max(1024 * 1024).parse(data)); } catch {} });
  ipcMain.on('harbor:resize', (event, rawId, cols, rows) => { try { assertSender(event); if (vault.available()) manager.resize(idSchema.parse(rawId), cols, rows); } catch {} });
  ipcMain.on('harbor:window', (event, action) => {
    try { assertSender(event); if (action === 'minimize') win.minimize(); if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); if (action === 'close') win.close(); } catch {}
  });
}

async function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1040, minHeight: 700, frame: false, backgroundColor: '#0c1117', show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    if (confirmingClose) return;
    confirmingClose = true;
    const finishClose = async () => { manager.dispose(); await manager.flushLogs(); exiting = true; win.close(); };
    if (!manager.activeCount()) { void finishClose(); return; }
    void dialog.showMessageBox(win, { type: 'question', title: '退出 Harbor SSH', message: '退出将断开所有 SSH 会话、隧道、文件传输和批量任务。', buttons: ['取消', '断开并退出'], defaultId: 0, cancelId: 0 }).then(result => {
      confirmingClose = false;
      if (result.response === 1) { confirmingClose = true; void finishClose(); }
    });
  });
  if (devURL) await win.loadURL(devURL); else await win.loadFile(rendererPath);
}
if (process.env.HARBOR_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.HARBOR_TEST_DATA);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  void app.whenReady().then(async () => {
    vault = new Vault(app.getPath('userData'), async value => (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result);
    await vault.load(); store = new Store(app.getPath('userData'), vault);
    await store.load(); manager = new Manager(store, emit, verifyHost); snmp = new SnmpService(store); registerIPC(); await createWindow();
  }).catch(error => { dialog.showErrorBox('Harbor SSH 启动失败', message(error)); app.exit(1); });
  app.on('window-all-closed', () => { manager?.dispose(); app.quit(); });
  app.on('before-quit', event => {
    if (exiting || !manager) return;
    event.preventDefault(); manager.dispose();
    void manager.flushLogs().then(() => { exiting = true; app.quit(); });
  });
  app.on('will-quit', () => { manager?.dispose(); snmp?.dispose(); vault?.lock(); });
}
