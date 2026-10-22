import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { profile } from '../tests/helpers';
import { snmpFixture } from '../tests/snmp-fixture';
async function until(check: () => Promise<boolean>, timeout = 12000) { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('MAC-mode UI timed out'); await new Promise(resolve => setTimeout(resolve, 50)); } }
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-mac-mode-'));
const access = await snmpFixture({ portMode: 'h3c', modeValue: 2 }), trunk = await snmpFixture({ portMode: 'h3c', modeValue: 1 }), hybrid = await snmpFixture({ portMode: 'huawei', modeValue: 3 }), unknown = await snmpFixture();
const fixtures = [access, trunk, hybrid, unknown];
const profiles = [profile(22, { name: 'ACCESS_FIXTURE_终端接入口', groupPath: ['交换机', '10车间', '生产网'] }), profile(22, { name: 'TRUNK_FIXTURE_核心上联_保留折叠后可检查完整设备名称', groupPath: ['交换机', '10车间', '生产网'] }), profile(22, { name: 'HYBRID_FIXTURE_混合端口', groupPath: ['交换机', '11车间', '办公网'] }), profile(22, { name: 'UNKNOWN_FIXTURE_未适配设备', groupPath: ['交换机', '11车间', '办公网'] })];
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  await fs.mkdir('test-results', { recursive: true });
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('软件密码', { exact: true }).fill('mac-mode-smoke-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('mac-mode-smoke-password'); await page.getByRole('button', { name: '设置密码并进入' }).click(); await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  await page.evaluate(async items => { for (const item of items) { await window.harbor!.saveProfile({ profile: item.profile }); await window.harbor!.snmpConfigure({ profileId: item.profile.id, port: item.port, readCommunity: 'fixture-read' }); } }, profiles.map((profile, index) => ({ profile, port: fixtures[index].port })));
  await page.reload(); await page.getByRole('button', { name: '网络管理', exact: true }).click(); await page.getByRole('button', { name: '全网查询', exact: true }).click();
  const global = page.getByLabel('全网查询', { exact: true }), input = global.getByLabel('全网查询 IP 或 MAC', { exact: true });
  await global.getByLabel('全网查询类型', { exact: true }).selectOption('mac'); await input.fill('aabb-ccdd-eeff'); await global.getByRole('button', { name: '查询全网', exact: true }).click();
  await until(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'));
  assert.match(await global.locator('.network-query-progress').innerText(), /4 台命中 · 4 条/);
  assert.equal(await global.locator('.network-result-table .network-query-table tbody tr').count(), 3);
  assert.equal(await global.locator('.port-mode-badge.access').count(), 1); assert.equal(await global.locator('.port-mode-badge.hybrid').count(), 1); assert.equal(await global.locator('.port-mode-badge.unknown').count(), 1);
  const toggle = global.getByRole('button', { name: '展开或折叠全网 Trunk 学习结果', exact: true });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); assert.equal(await global.locator('.port-mode-badge.trunk').count(), 0);
  await page.screenshot({ path: 'test-results/41-mac-port-types.png' });
  await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); assert.equal(await global.locator('.network-query-table tr[data-port-mode=trunk]').count(), 1); assert.equal(await global.locator('.port-mode-badge.trunk').count(), 1);
  if (!process.env.HARBOR_QUERY_QUICK) {
    const started = await global.locator('.network-query-progress>span').innerText();
    await until(async () => (await global.locator('.network-query-progress>span').innerText()) !== started, 38000);
    await until(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'));
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); assert.equal(await global.locator('.network-query-table tr[data-port-mode=trunk] .port-mode-badge.trunk').count(), 1);
  }
  await global.getByLabel('网络查询自动刷新', { exact: true }).selectOption('0');
  await page.setViewportSize({ width: 1040, height: 740 }); await page.getByRole('button', { name: '偏好设置', exact: true }).click(); await page.getByRole('combobox', { name: '界面字号', exact: true }).selectOption('18'); await page.locator('.theme-option').filter({ hasText: '布布一二' }).click();
  await page.getByRole('button', { name: '网络管理', exact: true }).click(); await page.getByRole('button', { name: '全网查询', exact: true }).click(); await global.getByLabel('全网查询类型', { exact: true }).selectOption('mac'); await input.fill('AA-BB-CC-DD-EE-FF'); await global.getByRole('button', { name: '查询全网', exact: true }).click(); await until(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); await toggle.click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const bottom = await global.locator('.network-query-coverage').boundingBox(); assert.ok(bottom && bottom.y + bottom.height <= 710, JSON.stringify(bottom));
  const trunkViewport = (await global.locator('.network-result-table .interfaces-scroll').boundingBox())!; assert.ok(trunkViewport.height >= 60, JSON.stringify(trunkViewport));
  await page.screenshot({ path: 'test-results/42-mac-trunk-expanded-bubu.png' });
  await global.locator('.network-query-table tr[data-port-mode=trunk]').getByRole('button', { name: profiles[1].name, exact: true }).click();
  await page.getByRole('tab', { name: 'MAC 查端口', exact: true }).click(); await page.getByLabel('查询 MAC 地址', { exact: true }).fill('aabb.ccdd.eeff'); await page.getByRole('button', { name: '查询当前设备', exact: true }).click();
  const singleToggle = page.getByRole('button', { name: '展开或折叠 Trunk 学习结果', exact: true }); await singleToggle.waitFor(); assert.equal(await singleToggle.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('.mac-results .mac-match-table tbody tr').count(), 0); assert.match(await page.locator('.mac-results').innerText(), /1 条命中/);
  await singleToggle.click(); assert.equal(await page.locator('.mac-trunk-results .port-mode-badge.trunk').count(), 1);
  trunk.mib.setTableSingleCell('h3cPortMode', 5, [909], 2);
  await page.getByRole('button', { name: '查询当前设备', exact: true }).click(); await page.locator('.mac-results .port-mode-badge.access').waitFor(); assert.equal(await singleToggle.count(), 0);
  for (const index of [2, 3]) {
    const picker = page.getByRole('combobox', { name: '搜索网络管理主机', exact: true }); await picker.fill(index === 2 ? 'HYBRID_FIXTURE' : 'UNKNOWN_FIXTURE'); await page.keyboard.press('Enter'); await page.getByRole('tab', { name: 'MAC 查端口', exact: true }).click(); await page.getByLabel('查询 MAC 地址', { exact: true }).fill('aabb-ccdd-eeff'); await page.getByRole('button', { name: '查询当前设备', exact: true }).click();
    await page.locator(`.mac-results .port-mode-badge.${index === 2 ? 'hybrid' : 'unknown'}`).waitFor(); assert.equal(await page.locator('.mac-results .mac-match-table tbody tr').count(), 1); assert.equal(await singleToggle.count(), 0);
  }
  assert.equal(fixtures.reduce((sum, fixture) => sum + fixture.writes.length, 0), 0); assert.deepEqual(errors, []);
  console.log('MAC mode desktop verified: H3C/Huawei mapping, Access visible, Hybrid/unknown never hidden, Trunk default collapse and explicit expansion, accurate total count, refresh retains expansion, new reads reflect changed mode, global→device navigation, 18px Bubu small-window display, read-only queries.');
} catch (error) { if (app) await (await app.firstWindow()).screenshot({ path: 'test-results/43-mac-mode-failure.png' }).catch(() => {}); throw error; }
finally { if (app) await app.close(); for (const fixture of fixtures) await fixture.close(); await fs.rm(directory, { recursive: true, force: true }); }
