import { _electron as electron, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { profile, sshFixture } from '../tests/helpers';
import { poll } from './poll.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-clipboard-'));
const fixture = await sshFixture(), second = await sshFixture();
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let savedClipboard: string | undefined;
const errors: string[] = [];
const longName = 'WH_S5130S-P_ACC_A92_10CJ_1FNAN十车间南侧一楼办公网络接入交换机_完整名称验证';
const p = profile(fixture.port, { name: longName, groupPath: ['交换机', '10车间', '安防网'] });
const p2 = profile(second.port, { name: '第二台会话_中文粘贴验证', groupPath: ['交换机', '11车间', '生产网'] });
async function launch() {
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), directory);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); return page;
}
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > 10000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 40)); }
}
async function clipboardIs(value: string) { await until(async () => await app!.evaluate(({ clipboard }) => clipboard.readText()) === value, 'native clipboard value'); }
async function checkNames(page: Page) {
  const metrics = await page.locator('.profile-identity h3').evaluateAll(nodes => nodes.map(el => {
    const style = getComputedStyle(el), card = el.closest('.profile-card')!.getBoundingClientRect(), box = el.getBoundingClientRect();
    return { text: el.textContent, whiteSpace: style.whiteSpace, fontSize: Number.parseFloat(style.fontSize), clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1, inside: box.right <= card.right && box.left >= card.left };
  }));
  assert.equal(metrics.length, 2); assert.equal(metrics[0].text, longName);
  assert.ok(metrics.every(m => m.whiteSpace === 'normal' && m.fontSize >= 14 && !m.clipped && m.inside), JSON.stringify(metrics));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.hosts-page').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
}
try {
  await fs.mkdir('test-results', { recursive: true }); let page = await launch();
  savedClipboard = await app!.evaluate(async ({ clipboard }) => Promise.race([clipboard.readText(), new Promise<undefined>(resolve => setTimeout(resolve, 2000))]));
  await page.getByLabel('软件密码', { exact: true }).fill('clipboard-ui-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('clipboard-ui-password');
  await page.getByRole('button', { name: '设置密码并进入' }).click(); await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  await page.evaluate(async profiles => { for (const profile of profiles) await window.harbor!.saveProfile({ profile, secrets: { password: 'test-secret' } }); }, [p, p2]);
  await page.reload(); await page.getByRole('heading', { name: longName, exact: true }).waitFor();
  await page.setViewportSize({ width: 1366, height: 900 }); await checkNames(page);
  assert.equal(await page.locator('.profile-identity h3').first().evaluate(el => getComputedStyle(el).fontSize), '15px');
  assert.ok(Number.parseFloat(await page.locator('.profile-identity .mono').first().evaluate(el => getComputedStyle(el).fontSize)) >= 13);
  await page.screenshot({ path: 'test-results/23-readable-device-names.png' });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '终端字号', exact: true }).inputValue(), '16');
  await page.getByRole('combobox', { name: '界面字号', exact: true }).selectOption('18');
  await page.getByRole('button', { name: '布布一二', exact: true }).click();
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  await page.setViewportSize({ width: 1040, height: 700 }); await checkNames(page);
  await page.getByRole('button', { name: '列表视图', exact: true }).click(); await checkNames(page);
  await page.screenshot({ path: 'test-results/24-readable-list-18px.png' });
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('combobox', { name: '界面字号', exact: true }).selectOption('16');
  const logDirectory = path.join(directory, 'chosen-logs'); await fs.mkdir(logDirectory);
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, logDirectory);
  await page.getByRole('button', { name: '选择保存目录', exact: true }).click();
  await page.getByRole('status', { name: '终端日志保存目录', exact: true }).filter({ hasText: logDirectory }).waitFor();
  await page.getByRole('heading', { name: '终端日志自动保存', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/27-auto-log-settings.png' });
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  await page.screenshot({ path: 'test-results/25-readable-bubu-devices.png' });
  await page.locator('.profile-card').filter({ has: page.getByRole('heading', { name: longName, exact: true }) }).getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).last().waitFor();
  const tabsBox = (await page.locator('.terminal-tabs').boundingBox())!;
  assert.ok(tabsBox.y < 130, JSON.stringify(tabsBox));
  assert.equal(await page.locator('.view-terminal>.page-heading').count(), 0);
  assert.ok((await page.locator('.terminal-pane.visible .terminal-split').boundingBox())!.height > 600);
  await page.screenshot({ path: 'test-results/29-compact-ssh-terminal.png' });
  const token = 'mouse_copy_token'; fixture.sendToTerminals(`\r\n${token}\r\n终端中文显示与剪贴板验证\r\n`);
  const row = page.locator('.terminal-pane.visible .xterm-rows>div').filter({ hasText: token }).first(); await row.waitFor();
  const box = (await row.boundingBox())!; const cell = box.width / fixture.sizes.at(-1)!.cols;
  await app!.evaluate(({ clipboard }) => clipboard.writeText('keep-until-selection-ends'));
  await page.mouse.move(box.x + cell * 0.1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + cell * (token.length + 0.1), box.y + box.height / 2, { steps: 12 });
  assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), 'keep-until-selection-ends');
  await page.mouse.up(); await clipboardIs(token);
  await app!.evaluate(({ clipboard }) => clipboard.writeText('keyboard-copy-test'));
  const beforeCopyInput = Buffer.concat(fixture.received).toString();
  const selected = page.locator('.terminal-pane.visible .xterm-selection>div');
  const selectionColor = await selected.first().evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(selectionColor, /^rgba\(/);
  assert.ok(Number(selectionColor.match(/, ([0-9.]+)\)$/)?.[1]) <= 0.3, selectionColor);
  const selectedTextStyle = await row.locator('span').filter({ hasText: token }).first().evaluate(el => { const style = getComputedStyle(el); return { foreground: style.color, background: style.backgroundColor }; });
  const luminance = (value: string) => { const rgb = value.match(/[0-9.]+/g)!.slice(0, 3).map(Number).map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]; };
  const fg = luminance(selectedTextStyle.foreground), bg = luminance(selectedTextStyle.background);
  assert.ok(bg > .5 && (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5, JSON.stringify(selectedTextStyle));
  await page.screenshot({ path: 'test-results/30-readable-terminal-selection.png' });
  await page.keyboard.press('Control+C'); await clipboardIs(token);
  await until(async () => await selected.count() === 0, 'classic copy clears selection');
  assert.equal(Buffer.concat(fixture.received).toString(), beforeCopyInput);
  await page.mouse.dblclick(box.x + cell * 4, box.y + box.height / 2); await clipboardIs(token);
  await page.keyboard.press('Control+Shift+C');
  await until(async () => await selected.count() === 0, 'legacy copy clears selection');
  await page.mouse.click(box.x + cell * 3, box.y + box.height / 2);
  await app!.evaluate(({ clipboard }) => clipboard.writeText('single-click-must-keep'));
  await page.mouse.click(box.x + cell * 3, box.y + box.height / 2);
  await page.getByRole('button', { name: '复制终端选中内容', exact: true }).click();
  await clipboardIs('single-click-must-keep');
  await page.mouse.dblclick(box.x + cell * 4, box.y + box.height / 2); await clipboardIs(token);
  // Enable both remote mouse reporting and bracketed paste: right clicks must
  // still paste once, with no SGR mouse escape sequences sent to the SSH server.
  fixture.sendToTerminals('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
  await poll(page, async () => { const state = await window.harbor!.initial(); const b = await window.harbor!.readTerminal(state.runtime.sessions[0].id); return b.data.some(s => atob(s).includes('[?2004h')); });
  const filesDuring = await fs.readdir(logDirectory); assert.equal(filesDuring.filter(name => name.endsWith('.recording.log')).length, 1);
  const liveLog = await fs.readFile(path.join(logDirectory, filesDuring[0]), 'utf8'); assert.ok(liveLog.includes(token));
  const beforePaste = Buffer.concat(fixture.received).toString();
  const text = 'echo 第一行\r\necho 第二行\n';
  await app!.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
  await page.mouse.click(box.x + cell * 4, box.y + box.height / 2, { button: 'right' });
  const expected = '\x1b[200~echo 第一行\recho 第二行\r\x1b[201~';
  await until(() => Buffer.concat(fixture.received).toString().slice(beforePaste.length) === expected, 'single bracketed right-click paste');
  await until(async () => await selected.count() === 0, 'right-click paste clears old selection');
  await page.keyboard.press('Control+V');
  await until(() => Buffer.concat(fixture.received).toString().slice(beforePaste.length) === expected + expected, 'classic Ctrl+V bracketed paste');
  await page.keyboard.press('Control+Shift+V');
  await until(() => Buffer.concat(fixture.received).toString().slice(beforePaste.length) === expected.repeat(3), 'legacy keyboard bracketed paste');
  await page.keyboard.press('Control+C');
  await until(() => Buffer.concat(fixture.received).toString().endsWith('\x03'), 'Ctrl+C interrupt');
  await app!.evaluate(({ clipboard }) => { (globalThis as any).__clipboardReadForTest = clipboard.readText; clipboard.readText = () => new Promise<string>(() => {}); });
  const beforeBlockedPaste = Buffer.concat(fixture.received).toString();
  await page.locator('.terminal-pane.visible .xterm-screen').click({ button: 'right', position: { x: 80, y: 30 } });
  await page.getByRole('status').filter({ hasText: '访问系统剪贴板超时' }).waitFor();
  assert.equal(Buffer.concat(fixture.received).toString(), beforeBlockedPaste);
  await app!.evaluate(({ clipboard }) => { clipboard.readText = (globalThis as any).__clipboardReadForTest; delete (globalThis as any).__clipboardReadForTest; });
  await app!.evaluate(({ clipboard }) => clipboard.writeText('clipboard-recovered'));
  await page.locator('.terminal-pane.visible .xterm-screen').click({ button: 'right', position: { x: 80, y: 30 } });
  await until(() => Buffer.concat(fixture.received).toString().endsWith('\x1b[200~clipboard-recovered\x1b[201~'), 'clipboard queue recovers after native read timeout');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  fixture.sendToTerminals('\x1b[?1000l\x1b[?1006l');
  await page.screenshot({ path: 'test-results/26-mouse-clipboard-terminal.png' });
  const firstInput = Buffer.concat(fixture.received).toString();
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  await page.locator('.profile-card').filter({ has: page.getByRole('heading', { name: p2.name, exact: true }) }).getByRole('button', { name: '连接', exact: true }).click();
  await poll(page, async () => (await window.harbor!.initial()).runtime.sessions.filter(s => s.status === 'connected').length === 2);
  await app!.evaluate(({ clipboard }) => clipboard.writeText('only_second_session_中文'));
  await page.locator('.terminal-pane.visible .xterm-screen').click({ button: 'right', position: { x: 80, y: 30 } });
  await until(() => Buffer.concat(second.received).toString() === 'only_second_session_中文', 'paste into active second session');
  assert.equal(Buffer.concat(fixture.received).toString(), firstInput);
  await page.keyboard.press('r');
  await until(() => Buffer.concat(second.received).toString().endsWith('中文r'), 'connected R remains ordinary input');
  const sessionId = await page.evaluate(async () => (await window.harbor!.initial()).runtime.sessions.find(s => s.name === '第二台会话_中文粘贴验证')!.id);
  second.endTerminals();
  await page.getByText('会话已结束', { exact: true }).waitFor();
  const disconnected = Buffer.concat(second.received).toString();
  await page.locator('.terminal-pane.visible .xterm-screen').click({ button: 'right', position: { x: 80, y: 30 } });
  await page.keyboard.press('Control+Shift+V');
  assert.equal(Buffer.concat(second.received).toString(), disconnected);
  await until(async () => (await fs.readdir(logDirectory)).some(name => name.startsWith(p2.name + '_') && !name.endsWith('.recording.log')), 'remote disconnect log finalization');
  await page.keyboard.press('r');
  await poll(page, async oldId => { const sessions = (await window.harbor!.initial()).runtime.sessions; return sessions.length === 2 && !sessions.some(session => session.id === oldId) && sessions.every(session => session.status === 'connected'); }, sessionId);
  assert.equal(Buffer.concat(second.received).toString(), disconnected);
  await page.getByText('已连接', { exact: true }).last().waitFor();
  await page.screenshot({ path: 'test-results/34-r-reconnected.png' });
  await app!.close(); app = undefined;
  const finalLogs = await fs.readdir(logDirectory); assert.equal(finalLogs.filter(name => name.endsWith('.log')).length, 3); assert.ok(finalLogs.every(name => !name.endsWith('.recording.log')));
  page = await launch();
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).fontSize), '16px');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'bubu-yier');
  await page.getByLabel('软件密码', { exact: true }).fill('clipboard-ui-password'); await page.getByRole('button', { name: '解锁工作空间' }).click();
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '界面字号', exact: true }).inputValue(), '16');
  assert.equal(await page.getByRole('combobox', { name: '终端字号', exact: true }).inputValue(), '16');
  assert.equal(await page.getByRole('status', { name: '终端日志保存目录', exact: true }).innerText(), logDirectory);
  assert.deepEqual(errors, []);
  console.log('Clipboard/readability UI passed: real mouse drag/double-click copy, empty selection preservation, classic Ctrl+C/V, native right-click + legacy keyboard paste, readable translucent selection and cleanup, compact terminal, Unicode/newline bracketed paste without duplicate input, Ctrl+C, remote mouse mode, tab isolation, disconnected-session R reconnect and connected R input, full device names in grid/list at 1040px/18px, independent font preferences, chosen log directory, live output logs, remote disconnect/quit finalization and restart persistence.');
} catch (error) {
  console.error('Renderer errors:', errors);
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: 'test-results/clipboard-failure.png' }); console.error((await page.locator('body').innerText()).slice(0, 2500)); }
  console.error('Received terminal input:', Buffer.concat(fixture.received).toString());
  throw error;
} finally {
  if (app) { if (savedClipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); await app.close(); }
  await fixture.close(); await second.close(); await fs.rm(directory, { recursive: true, force: true });
}
