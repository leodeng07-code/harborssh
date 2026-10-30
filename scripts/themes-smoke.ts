import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { profile, sshFixture } from '../tests/helpers';
import { themes } from '../src/themes';
import { remoteWallpapers } from '../shared/wallpapers';

const live = process.argv.includes('--live');
import { poll } from './poll.mjs';

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
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
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
  const bubu = themes.filter(t => t.family === 'bubu'); assert.equal(bubu.length, 9);
  assert.equal(new Set(bubu.map(t => t.wallpaper!.image)).size, 9);
  await app!.evaluate(({ net }) => { (globalThis as any).__themeOriginalFetch = net.fetch; net.fetch = async () => new Response('unavailable', { status: 503 }); });
  await page.getByRole('button', { name: '鬼灭之刃 · 藤袭山', exact: true }).click();
  await page.getByRole('status', { name: '官方壁纸状态' }).filter({ hasText: 'HTTP 503' }).waitFor();
  assert.equal(await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').backgroundImage), 'none');
  await app!.evaluate(({ net }) => { net.fetch = (globalThis as any).__themeOriginalFetch; });
  if (live) {
    await page.getByRole('button', { name: '重试获取图片', exact: true }).click();
    await page.getByRole('status', { name: '官方壁纸状态' }).filter({ hasText: '原图已缓存' }).waitFor({ timeout: 30000 });
    // A late image download may populate its cache but cannot overwrite the
    // background after the user has switched to another theme.
    await app!.evaluate(({ net }) => { (globalThis as any).__themeFetches = 0; net.fetch = async (url, options) => { (globalThis as any).__themeFetches++; await new Promise(resolve => setTimeout(resolve, 200)); return (globalThis as any).__themeOriginalFetch(url, options); }; });
    await page.getByRole('button', { name: '鬼灭之刃 · 狭雾山', exact: true }).click();
    await page.getByRole('button', { name: '布布一二', exact: true }).click();
    await poll(page, async () => !!await window.harbor!.themeWallpaper('kimetsu-mist', false));
    assert.ok(await app!.evaluate(() => (globalThis as any).__themeFetches) > 0);
    assert.ok((await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').backgroundImage)).includes('bubu-yier-cafe'));
    await app!.evaluate(({ net }) => { net.fetch = (globalThis as any).__themeOriginalFetch; });
  }
  const imageThemes = live ? themes.filter(t => t.wallpaper) : bubu;
  for (const t of imageThemes) {
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
    assert.equal(controls.length, 19); assert.ok(controls.every(c => !c.clipped), JSON.stringify(controls));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const slider = page.getByRole('slider', { name: /背景显示强度/ });
    await slider.focus(); await page.keyboard.press('End'); assert.equal(await slider.inputValue(), '35');
    const wallpaper = await page.locator('.main-content').evaluate(el => { const s = getComputedStyle(el, '::before'); return { opacity: s.opacity, image: s.backgroundImage, events: s.pointerEvents }; });
    assert.equal(wallpaper.opacity, '0.35'); assert.equal(wallpaper.events, 'none');
    if (t.wallpaper!.remoteId) {
      await page.getByRole('status', { name: '官方壁纸状态' }).filter({ hasText: '原图已缓存' }).waitFor({ timeout: 30000 });
    }
    const dimensions = await page.evaluate(() => new Promise<number[]>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => reject(new Error('Background image failed to load'));
      image.src = getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper').trim().match(/^url\("(.*)"\)$/)![1];
    }));
    assert.deepEqual(dimensions, t.family === 'bubu' ? [3840, 2160] : [1280, 720]);
    await slider.focus(); await page.keyboard.press('Home'); assert.equal(await slider.inputValue(), '0');
    assert.equal(await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').opacity), '0');
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    assert.equal(await slider.inputValue(), '14');
    if (t.id === 'bubu-strawberry' || t.id === 'bubu-cocoa' || t.id === 'kimetsu-castle') {
      await page.setViewportSize({ width: 1366, height: 1000 });
      await page.locator('.settings-page').evaluate(el => { el.scrollTop = 0; });
      if (t.family === 'kimetsu') await page.locator('#theme-family-kimetsu').scrollIntoViewIfNeeded();
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
  // A saved strength survives switching palettes, including a plain theme.
  const slider = page.getByRole('slider', { name: /背景显示强度/ }); await slider.focus(); await page.keyboard.press('End');
  await page.getByRole('button', { name: '深海绿', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-wallpaper'), 'false');
  assert.equal(await page.locator('.main-content').evaluate(el => getComputedStyle(el, '::before').backgroundImage), 'none');
  const persistedTheme = live ? 'kimetsu-castle' : 'bubu-cocoa';
  await page.getByRole('button', { name: live ? '鬼灭之刃 · 无限城' : '布布一二 · 可可夜色', exact: true }).click(); assert.equal(await slider.inputValue(), '35');
  if (live) {
    for (const [id, source] of Object.entries(remoteWallpapers)) {
      const data = await fs.readFile(path.join(directory, 'theme-wallpapers', `${id}-${source.sha256.slice(0, 16)}.jpg`)); assert.equal(data.length, source.bytes);
    }
  }
  await app!.close(); app = undefined; page = await launch();
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
  if (live) {
    await app!.evaluate(({ net }) => { (globalThis as any).__themeOfflineFetches = 0; net.fetch = async () => { (globalThis as any).__themeOfflineFetches++; throw new Error('Offline restart'); }; });
    await page.reload(); await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
    await poll(page, () => getComputedStyle(document.documentElement).getPropertyValue('--theme-wallpaper').includes('data:image/jpeg;base64,'));
    assert.equal(await app!.evaluate(() => (globalThis as any).__themeOfflineFetches), 0);
  }
  assert.equal(await page.locator('html').getAttribute('data-theme'), persistedTheme);
  assert.equal(await page.locator('.lock-screen').evaluate(el => getComputedStyle(el, '::before').opacity), '0.35');
  await page.screenshot({ path: 'test-results/52-picture-theme-unlock.png' });
  await page.getByLabel('软件密码', { exact: true }).fill('theme-smoke-password'); await page.getByRole('button', { name: '解锁工作空间' }).click();
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: /背景显示强度/ }).inputValue(), '35');
  await page.getByRole('button', { name: '布布一二', exact: true }).click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'bubu-yier');
  assert.deepEqual(errors, []);
  console.log(`Picture theme desktop verified: ${imageThemes.length} distinct original backgrounds, real SSH output/copy/input, text contrast, 0/14/35% strength, 19 cards at 1040×700/18px, HTTP failure feedback, original-theme compatibility and restart persistence.${live ? ' Also verified 4 live official downloads, retry, late-download isolation, unchanged cached originals and offline login/preview after restart.' : ''}`);
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: 'test-results/53-themes-failure.png' }).catch(() => {});
  console.error('Renderer errors:', errors); throw error;
} finally {
  if (app) { if (savedClipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); await app.close(); }
  await fixture.close(); await fs.rm(directory, { recursive: true, force: true });
}
