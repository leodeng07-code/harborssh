import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { profile, sshFixture } from '../tests/helpers';
import { themes } from '../src/themes';
import { poll } from './poll.mjs';
import characterSources from '../assets/鬼灭之刃角色图片来源.json';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-themes-'));
const fixture = await sshFixture();
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let savedClipboard: string | undefined;
const errors: string[] = [];
const rgb = (hex: string) => hex.slice(1, 7).match(/../g)!.map(v => parseInt(v, 16));
const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
async function launch() {
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  await app.evaluate(({ dialog, session }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    (globalThis as any).__themeNetworkRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => { (globalThis as any).__themeNetworkRequests++; callback({ cancel: true }); });
  });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); return page;
}
try {
  await fs.mkdir('test-results', { recursive: true }); let page = await launch();
  savedClipboard = await app!.evaluate(({ clipboard }) => clipboard.readText());
  await page.getByLabel('软件密码', { exact: true }).fill('theme-smoke-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('theme-smoke-password');
  await page.getByRole('button', { name: '设置密码并进入' }).click(); await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  const p = profile(fixture.port, { name: '布布一二主题 · 终端中文可读性', groupPath: ['交换机', '11车间', '生产网'] });
  await page.evaluate(p => window.harbor!.saveProfile({ profile: p, secrets: { password: 'test-secret' } }), p);
  await page.reload(); await page.locator('.profile-card').getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).last().waitFor();
  await page.setViewportSize({ width: 1040, height: 700 });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click(); await page.getByLabel('界面字号', { exact: true }).selectOption('18');
  const pictures = themes.filter(t => t.wallpaper); assert.equal(pictures.length, 24);
  assert.equal(new Set(pictures.map(t => t.wallpaper!.image)).size, 24);
  assert.equal(pictures.filter(t => t.characterGroup === 'hashira').length, 9);
  assert.equal(pictures.filter(t => t.characterGroup === 'protagonist').length, 6);
  assert.equal(await page.evaluate(() => typeof (window.harbor as any).themeWallpaper), 'undefined');
  for (const t of pictures) {
    const c = t.colors;
    assert.ok(contrast(rgb(c.text), rgb(c.base)) >= 7, `${t.name}: body text`);
    assert.ok(contrast(rgb(c.muted), rgb(c.base)) >= 4.5, `${t.name}: secondary text`);
    assert.ok(contrast(rgb(c['on-accent']), rgb(c.accent)) >= 4.5, `${t.name}: button text`);
    // Even a completely black/white wallpaper pixel at maximum strength must
    // leave normal terminal text readable, independent of the source picture.
    assert.ok(contrast(rgb(c.text), rgb(c.base).map(v => v * .65 + (t.light ? 0 : 255) * .35)) >= 4.5, `${t.name}: maximum wallpaper strength`);
    await page.getByRole('button', { name: t.name, exact: true }).click();
    assert.equal(await page.locator('.theme-option[aria-pressed=true]').count(), 1);
    assert.equal(await page.locator('html').getAttribute('data-theme'), t.id);
    assert.equal(await page.locator('html').getAttribute('data-wallpaper'), 'true');
    assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme), t.light ? 'light' : 'dark');
    const controls = await page.locator('.theme-option').evaluateAll(nodes => nodes.map(el => ({ clipped: el.scrollWidth > el.clientWidth + 1, name: el.getAttribute('aria-label') })));
    assert.equal(controls.length, 30); assert.ok(controls.every(c => !c.clipped), JSON.stringify(controls));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const slider = page.getByRole('slider', { name: /背景显示强度/ });
    await slider.focus(); await page.keyboard.press('End'); assert.equal(await slider.inputValue(), '35');
    const wallpaper = await page.locator('.main-content').evaluate(el => { const s = getComputedStyle(el, '::before'); return { opacity: s.opacity, image: s.backgroundImage, events: s.pointerEvents }; });
    assert.equal(wallpaper.opacity, '0.35'); assert.ok(wallpaper.image.includes('.jpg')); assert.equal(wallpaper.events, 'none');
    const dimensions = await page.evaluate(() => new Promise<number[]>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => reject(new Error('Offline background failed to load'));
      image.src = getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper').trim().match(/^url\("(.*)"\)$/)![1];
    }));
    assert.deepEqual(dimensions, t.family === 'bubu' ? [3840, 2160] : characterSources.find(source => `kimetsu-${source.id}` === t.id)!.dimensions);
    await slider.focus(); await page.keyboard.press('Home'); assert.equal(await slider.inputValue(), '0');
    assert.equal(await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').opacity), '0');
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    assert.equal(await slider.inputValue(), '14');
    if (t.id === 'bubu-strawberry' || t.id === 'kimetsu-rengoku') {
      await page.setViewportSize({ width: 1366, height: 1000 });
      await page.locator('.settings-page').evaluate(el => { el.scrollTop = 0; });
      if (t.family === 'kimetsu') await page.locator('#theme-family-kimetsu').evaluate(el => el.scrollIntoView({ block: 'start' }));
      await poll(page, () => [...document.querySelectorAll<HTMLImageElement>('.theme-preview>img')].every(img => img.complete && img.naturalWidth > 0));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: `test-results/50-${t.id}-settings.png` });
      await page.setViewportSize({ width: 1040, height: 700 });
    }
    await page.getByRole('button', { name: '终端', exact: true }).click();
    const terminal = page.locator('.terminal-pane.visible');
    await poll(page, () => getComputedStyle(document.querySelector('.terminal-pane.visible .xterm-scrollable-element')!).backgroundColor.endsWith(', 0)'));
    assert.equal(await terminal.locator('.xterm-viewport').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const token = `theme_${t.id.replaceAll('-', '_')}`; fixture.sendToTerminals(`\r\n${token}\r\n\x1b[31m错误\x1b[0m  \x1b[32m运行正常\x1b[0m  \x1b[34m接口状态\x1b[0m\r\n`);
    const row = terminal.locator('.xterm-rows>div').filter({ hasText: token }).first(); await row.waitFor();
    const box = (await row.boundingBox())!; const cell = box.width / fixture.sizes.at(-1)!.cols;
    await page.mouse.dblclick(box.x + cell * 4, box.y + box.height / 2);
    await poll(page, () => !!document.querySelector('.terminal-pane.visible .xterm-selection>div'));
    const selected = await row.locator('span').filter({ hasText: token }).first().evaluate(el => { const s = getComputedStyle(el); return { foreground: s.color, background: s.backgroundColor }; });
    const fg = selected.foreground.match(/[\d.]+/g)!.slice(0, 3).map(Number), bg = selected.background.match(/[\d.]+/g)!.map(Number);
    assert.deepEqual(fg, rgb(c.text));
    if (bg.length === 3 || bg[3] === 1) assert.ok(contrast(fg, bg.slice(0, 3)) >= 4.5, `${t.name}: selected text backing ${selected.background}`);
    const selectionColor = await terminal.locator('.xterm-selection>div').first().evaluate(el => getComputedStyle(el).backgroundColor);
    assert.ok(Number(selectionColor.match(/, ([\d.]+)\)$/)?.[1]) <= .3, selectionColor);
    await page.screenshot({ path: `test-results/51-${t.id}-terminal.png` });
    await page.keyboard.press('Control+C');
    assert.equal(await app!.evaluate(({ clipboard }) => clipboard.readText()), token);
    await poll(page, () => !document.querySelector('.terminal-pane.visible .xterm-selection>div'));
    await page.keyboard.insertText(`echo ${t.id}`); await page.keyboard.press('Enter');
    await poll(page, async id => { const s = (await window.harbor!.initial()).runtime.sessions[0]; return (await window.harbor!.readTerminal(s.id)).data.some(v => atob(v).includes(`echo ${id}`)); }, t.id);
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  }
  await page.setViewportSize({ width: 1366, height: 1250 });
  for (const [title, name] of [['主角团 · 6 人', 'main-cast'], ['九柱 · 9 人', 'hashira']]) {
    await page.getByRole('heading', { name: title, exact: true }).evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `test-results/54-kimetsu-${name}-offline.png` });
  }
  await page.setViewportSize({ width: 1040, height: 700 });
  for (const [oldId, expected] of Object.entries({ 'kimetsu-wisteria': 'kimetsu-shinobu', 'kimetsu-mist': 'kimetsu-muichiro', 'kimetsu-castle': 'kimetsu-rengoku', 'kimetsu-garden': 'kimetsu-tanjiro' })) {
    await page.evaluate(id => localStorage.setItem('harbor-theme', id), oldId); await page.reload();
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), expected);
    assert.ok((await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').backgroundImage)).includes('.jpg'));
  }
  // A saved strength survives switching palettes, including a plain theme.
  const slider = page.getByRole('slider', { name: /背景显示强度/ }); await slider.focus(); await page.keyboard.press('End');
  await page.getByRole('button', { name: '深海绿', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-wallpaper'), 'false');
  assert.equal(await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').backgroundImage), 'none');
  await page.getByRole('button', { name: '鬼灭之刃 · 炼狱杏寿郎', exact: true }).click(); assert.equal(await slider.inputValue(), '35');
  assert.equal(await app!.evaluate(() => (globalThis as any).__themeNetworkRequests), 0);
  await app!.close(); app = undefined; page = await launch();
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'kimetsu-rengoku');
  assert.equal(await page.locator('.lock-screen').evaluate(el => getComputedStyle(el, '::before').opacity), '0.35');
  assert.ok((await page.locator('.lock-screen').evaluate(el => getComputedStyle(el, '::before').backgroundImage)).includes('rengoku'));
  await page.screenshot({ path: 'test-results/52-kimetsu-offline-unlock.png' });
  await page.getByLabel('软件密码', { exact: true }).fill('theme-smoke-password'); await page.getByRole('button', { name: '解锁工作空间' }).click();
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: /背景显示强度/ }).inputValue(), '35');
  await page.getByRole('button', { name: '布布一二', exact: true }).click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'bubu-yier');
  assert.equal(await app!.evaluate(() => (globalThis as any).__themeNetworkRequests), 0);
  assert.deepEqual(errors, []);
  console.log('Offline theme desktop verified: 24 different bundled originals including all 9 Hashira and 6 main characters; 30 cards; HTTP/HTTPS blocked with zero requests on first use and restart; real SSH copy/input and readable selections; 0/14/35% strength; 1040×700/18px layout; all 4 old scene IDs migrate; offline login and persistence.');
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: 'test-results/53-themes-failure.png' }).catch(() => {});
  console.error('Renderer errors:', errors); throw error;
} finally {
  if (app) { if (savedClipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); await app.close(); }
  await fixture.close(); await fs.rm(directory, { recursive: true, force: true });
}
