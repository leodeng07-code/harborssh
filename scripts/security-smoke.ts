import { _electron as electron } from 'playwright';
import { poll } from './poll.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { freePort, profile, sshFixture } from '../tests/helpers';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-security-'));
const fixture = await sshFixture(); const fixture2 = await sshFixture();
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
const errors: string[] = [];
async function launch() {
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); return page;
}
try {
  await fs.mkdir('test-results', { recursive: true }); let page = await launch();
  await page.getByRole('heading', { name: '设置软件密码', exact: true }).waitFor();
  const locked = await page.evaluate(async () => { try { await window.harbor!.initial(); return false; } catch { return true; } }); assert.equal(locked, true);
  await page.getByLabel('软件密码', { exact: true }).fill('test-app-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('test-app-password');
  await page.screenshot({ path: 'test-results/14-password-setup.png' });
  await page.getByRole('button', { name: '设置密码并进入', exact: true }).click(); await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  const csv = path.join(directory, 'import.csv'); await fs.writeFile(csv, `连接名称,主机地址,端口,用户名,密码,设备类型,地点,网络类型\n上海办公交换机,127.0.0.1,${fixture.port},tester,test-secret,交换机,上海,办公网\n北京生产交换机,127.0.0.1,${fixture2.port},tester,test-secret,交换机,北京,生产网\n`);
  await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, csv);
  await page.getByRole('button', { name: '导入 Excel', exact: true }).last().click(); await page.getByRole('button', { name: '导入 2 条连接', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择所有显示的连接', exact: true }).check(); await page.getByRole('button', { name: '批量连接', exact: true }).click();
  await poll(page, async () => { const s = (await window.harbor!.initial()).runtime.sessions; return s.length === 2 && s.every(s => s.status === 'connected'); });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  for (const [name, id] of [['深海绿', 'harbor'], ['极夜蓝', 'ocean'], ['暮色紫', 'violet'], ['石墨灰', 'graphite'], ['暖沙棕', 'ember'], ['晴空白', 'daylight']]) {
    await page.locator('.theme-option').filter({ hasText: name }).click(); assert.equal(await page.locator('html').getAttribute('data-theme'), id);
  }
  await page.screenshot({ path: 'test-results/15-themes-light.png' });
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.screenshot({ path: 'test-results/16-terminal-light.png' });
  const terminalBg = await page.locator('.terminal-pane.visible .xterm-scrollable-element').evaluate(el => getComputedStyle(el).backgroundColor); assert.equal(terminalBg, 'rgb(255, 255, 255)');
  await page.screenshot({ path: 'test-results/16-terminal-light.png' });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('button', { name: '布布一二', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'bubu-yier');
  const strength = page.getByRole('slider', { name: /背景显示强度/ });
  assert.equal(await strength.inputValue(), '14');
  await strength.focus(); await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper-opacity').trim()), '0');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await strength.inputValue(), '14');
  await strength.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await strength.inputValue(), '15');
  const wallpaper = await page.locator('.main-content').evaluate(el => {
    const style = getComputedStyle(el, '::before'); return { image: style.backgroundImage, opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
  assert.ok(wallpaper.image.includes('bubu-yier-cafe')); assert.equal(wallpaper.opacity, '0.15'); assert.equal(wallpaper.pointerEvents, 'none');
  const offlineAsset = await page.evaluate(async () => {
    const url = getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper').trim().match(/^url\("(.*)"\)$/)?.[1];
    if (!url) return false;
    return new Promise<boolean>(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth === 3840 && img.naturalHeight === 2160); img.onerror = () => resolve(false); img.src = url; });
  }); assert.equal(offlineAsset, true);
  await page.screenshot({ path: 'test-results/20-bubu-theme-settings.png' });
  await page.getByRole('button', { name: '终端', exact: true }).click();
  assert.match(await page.locator('.terminal-pane.visible .xterm-scrollable-element').evaluate(el => getComputedStyle(el).backgroundColor), /, 0\)$/);
  assert.equal(await page.locator('.terminal-pane.visible .xterm-viewport').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.locator('.terminal-pane.visible .terminal-container').click(); await page.keyboard.insertText('bubu-theme-live-check'); await page.keyboard.press('Enter');
  await poll(page, async () => { const state = await window.harbor!.initial(); const buffers = await Promise.all(state.runtime.sessions.map(session => window.harbor!.readTerminal(session.id))); return buffers.some(buffer => buffer.data.some(value => atob(value).includes('bubu-theme-live-check'))); });
  await page.screenshot({ path: 'test-results/21-bubu-theme-terminal.png' });
  const before = await page.evaluate(() => window.harbor!.initial());
  await app!.close(); app = undefined; page = await launch();
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'bubu-yier');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper-opacity').trim()), '0.15');
  await page.screenshot({ path: 'test-results/22-bubu-theme-unlock.png' });
  await page.getByLabel('软件密码', { exact: true }).fill('wrong-password'); await page.getByRole('button', { name: '解锁工作空间', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '软件密码不正确' }).waitFor();
  // The error retry delay protects the KDF from rapid repeated requests.
  await page.getByLabel('软件密码', { exact: true }).fill('test-app-password'); await page.waitForTimeout(600); await page.getByRole('button', { name: '解锁工作空间', exact: true }).click();
  await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  const reloaded = await page.evaluate(() => window.harbor!.initial()); assert.deepEqual(reloaded.config.profiles.map(p => p.id), before.config.profiles.map(p => p.id)); assert.ok(reloaded.config.profiles.every(p => p.hasSecret));
  await page.getByRole('checkbox', { name: '选择所有显示的连接', exact: true }).check(); await page.getByRole('button', { name: '批量连接', exact: true }).click();
  await poll(page, async () => { const s = (await window.harbor!.initial()).runtime.sessions; return s.length === 2 && s.every(s => s.status === 'connected'); });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click(); await page.locator('.theme-option').filter({ hasText: '暮色紫' }).click();
  await page.screenshot({ path: 'test-results/17-themes-violet.png' });
  await page.getByRole('button', { name: '修改软件密码', exact: true }).click(); await page.getByLabel('当前软件密码', { exact: true }).fill('test-app-password'); await page.getByLabel('新软件密码', { exact: true }).fill('changed-app-password'); await page.getByLabel('确认新软件密码', { exact: true }).fill('changed-app-password'); await page.getByRole('button', { name: '保存软件密码', exact: true }).click(); await page.getByText('软件密码已修改，SSH 凭据已保留', { exact: true }).waitFor();
  const missing = profile(22, { name: '旧版缺失密码', host: '192.0.2.89', groupPath: ['防火墙', '深圳', '管理网'] });
  await page.evaluate(p => window.harbor!.saveProfile({ profile: p }), missing);
  const recovery = path.join(directory, 'recover.csv'); await fs.writeFile(recovery, '连接名称,主机地址,端口,用户名,密码\n覆盖名称不会生效,192.0.2.89,22,tester,recovered-secret\n');
  await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, recovery);
  await page.getByRole('button', { name: '连接管理', exact: true }).click(); await page.getByRole('button', { name: '导入 Excel', exact: true }).last().click();
  await page.getByRole('checkbox', { name: '为 1 条重复连接补充缺失凭据', exact: true }).check(); await page.screenshot({ path: 'test-results/18-recover-import.png' });
  await page.getByRole('button', { name: '导入 1 条连接', exact: true }).click();
  const recovered = await page.evaluate(() => window.harbor!.initial()); assert.equal(recovered.config.profiles.find(p => p.id === missing.id)!.hasSecret, true); assert.equal(recovered.config.profiles.find(p => p.id === missing.id)!.name, missing.name);
  const port = await freePort(); await page.evaluate(async ({ p, port }) => { await window.harbor!.saveTunnel({ id: crypto.randomUUID(), name: '关联 SOCKS5', profileId: p.id, type: 'dynamic', bindHost: '127.0.0.1', bindPort: port, targetHost: '', targetPort: 80 }); }, { p: reloaded.config.profiles[0], port });
  await page.reload(); await page.getByRole('button', { name: 'SSH 隧道', exact: true }).click(); await page.getByRole('button', { name: '启动', exact: true }).click(); await page.getByText('运行中', { exact: true }).waitFor();
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  for (const p of reloaded.config.profiles) await page.getByRole('checkbox', { name: `选择 ${p.name}`, exact: true }).check();
  await page.getByRole('button', { name: '批量删除', exact: true }).click(); await page.getByRole('dialog').getByText(/2 个会话、删除 1 条关联隧道/).waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.harbor!.initial())).config.profiles.length, 3);
  await page.getByRole('button', { name: '批量删除', exact: true }).click(); await page.screenshot({ path: 'test-results/19-bulk-delete.png' }); await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await poll(page, async () => (await window.harbor!.initial()).config.profiles.length === 1);
  const end = await page.evaluate(() => window.harbor!.initial()); assert.equal(end.runtime.sessions.length, 0); assert.equal(end.config.tunnels.length, 0); assert.equal(end.runtime.tunnels.length, 0); assert.equal(end.config.profiles[0].id, missing.id);
  await page.setViewportSize({ width: 1040, height: 700 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await app!.close(); app = undefined; page = await launch();
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
  await page.getByLabel('软件密码', { exact: true }).fill('changed-app-password'); await page.getByRole('button', { name: '解锁工作空间', exact: true }).click();
  await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.harbor!.initial())).config.profiles[0].hasSecret, true);
  assert.deepEqual(errors, []);
  console.log('Security UI passed: lock, password recovery, classic and original Bubu themes, offline official wallpaper, adjustable opacity and restart persistence, transparent live terminal, password change, credential recovery and confirmed bulk deletion.');
} catch (error) {
  console.error('Renderer errors:', errors);
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: 'test-results/security-failure.png' }); console.error((await page.locator('body').innerText()).slice(0, 4000)); }
  throw error;
} finally { if (app) await app.close(); await fixture.close(); await fixture2.close(); await fs.rm(directory, { recursive: true, force: true }); }
