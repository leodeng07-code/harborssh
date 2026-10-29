import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { profile } from '../tests/helpers';
import { snmpFixture } from '../tests/snmp-fixture';
async function poll(check: () => Promise<boolean>, timeout = 30000) { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for network query UI'); await new Promise(resolve => setTimeout(resolve, 50)); } }

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-ip-ui-'));
const fixture = await snmpFixture();
const blackhole = dgram.createSocket('udp4'); await new Promise<void>(resolve => blackhole.bind(0, '127.0.0.1', resolve));
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  await fs.mkdir('test-results', { recursive: true });
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('软件密码', { exact: true }).fill('network-query-test-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('network-query-test-password'); await page.getByRole('button', { name: '设置密码并进入' }).click(); await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  const a = profile(22, { name: 'WH_S5130S_10CJ_核心交换机_全网查询协议验证', groupPath: ['交换机', '10车间', '生产网'] });
  const b = profile(22, { name: 'WH_S6520X_10CJ_接入交换机', groupPath: ['交换机', '10车间', '生产网'] });
  const c = profile(22, { name: 'WH_S5130S_11CJ_不在查询范围', groupPath: ['交换机', '11车间', '办公网'] });
  const d = profile(22, { name: 'WH_TIMEOUT_10CJ_超时设备', groupPath: ['交换机', '10车间', '生产网'] });
  await page.evaluate(async ({ devices, port, timeoutPort }) => {
    for (const profile of devices) await window.harbor!.saveProfile({ profile });
    await window.harbor!.snmpConfigure({ profileId: devices[0].id, port, readCommunity: 'fixture-read' });
    await window.harbor!.snmpConfigure({ profileId: devices[3].id, port: timeoutPort, readCommunity: 'fixture-read' });
  }, { devices: [a, b, c, d], port: fixture.port, timeoutPort: blackhole.address().port });
  await page.reload(); await page.getByRole('button', { name: '网络管理', exact: true }).click();
  const modal = page.getByRole('dialog');
  await page.getByRole('button', { name: '批量 SNMP 配置', exact: true }).click();
  await modal.getByLabel('网络查询设备范围', { exact: true }).selectOption(JSON.stringify(['交换机', '10车间']));
  await modal.getByText('本次将应用到 1 台设备（展开核对名单）', { exact: true }).waitFor();
  await modal.getByLabel('统一只读团体名', { exact: true }).fill('fixture-read');
  await modal.getByRole('checkbox', { name: '统一 UDP 端口', exact: true }).check(); await modal.getByLabel('统一 SNMP UDP 端口', { exact: true }).fill(String(fixture.port));
  await modal.getByRole('button', { name: '应用到 1 台设备', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  const configured = await page.evaluate(async () => (await window.harbor!.initial()).config.snmp!);
  assert.equal(configured.length, 3); assert.equal(configured.find(target => target.profileId === b.id)?.port, fixture.port); assert.equal(configured.find(target => target.profileId === d.id)?.port, blackhole.address().port); assert.ok(!configured.some(target => target.profileId === c.id));
  console.log('Uniform community and group/port preservation verified.');
  await page.getByRole('tab', { name: 'ARP 查询', exact: true }).click();
  await page.getByLabel('ARP 查询地址', { exact: true }).fill('192.0.2.99'); await page.getByRole('button', { name: '查询当前设备', exact: true }).click();
  await poll(async () => (await page.locator('.network-query-panel:visible .network-query-progress').innerText()).includes('本轮完成'), 10000);
  assert.equal(await page.locator('.network-query-panel:visible .network-query-table tbody tr').count(), 1); assert.match(await page.locator('.network-query-panel:visible .network-query-table').innerText(), /AA:BB:CC:DD:EE:FF/);
  await page.getByRole('tab', { name: '路由查询', exact: true }).click(); await page.getByLabel('路由查询地址', { exact: true }).fill('192.0.2.99'); await page.getByRole('button', { name: '查询当前设备', exact: true }).click();
  await poll(async () => (await page.locator('.network-query-panel:visible .network-query-progress').innerText()).includes('本轮完成'), 10000);
  assert.equal(await page.locator('.network-query-panel:visible .network-query-table tbody tr').count(), 2); assert.match(await page.locator('.network-query-panel:visible .network-query-table').innerText(), /192.0.2.0\/24/); assert.match(await page.locator('.network-query-panel:visible .network-query-table').innerText(), /OSPF/);
  await page.getByRole('tab', { name: 'IP 接口', exact: true }).click(); await page.getByRole('button', { name: '查询当前设备', exact: true }).click();
  await poll(async () => (await page.locator('.network-query-panel:visible .network-query-progress').innerText()).includes('本轮完成'), 10000);
  assert.equal(await page.locator('.network-query-panel:visible .network-query-table tbody tr').count(), 2); assert.match(await page.locator('.network-query-panel:visible .network-query-table').innerText(), /启用 \/ UP/);
  await page.getByRole('button', { name: '全网查询', exact: true }).click();
  const global = page.getByLabel('全网查询', { exact: true });
  assert.equal(await global.getByLabel('网络查询自动刷新', { exact: true }).inputValue(), '30');
  await global.getByLabel('网络查询设备范围', { exact: true }).selectOption(JSON.stringify(['交换机', '11车间'])); assert.equal(await global.getByRole('button', { name: '查询全网', exact: true }).isDisabled(), true);
  await global.getByLabel('网络查询设备范围', { exact: true }).selectOption(JSON.stringify(['交换机', '10车间']));
  const input = global.getByRole('textbox', { name: '全网查询 IP 或 MAC', exact: true }); await page.keyboard.press('Control+k'); assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await input.fill('192.0.2.99'); await global.getByRole('button', { name: '查询全网', exact: true }).click();
  await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'), 12000);
  assert.equal(await global.locator('.network-query-table tbody tr').count(), 6);
  assert.match(await global.locator('.network-query-progress').innerText(), /3 \/ 3 台 · 2 台命中/);
  await global.locator('.network-query-coverage summary').click(); await global.getByText('查询失败', { exact: true }).waitFor(); assert.match(await global.locator('.network-query-coverage').innerText(), /WH_TIMEOUT/);
  await page.screenshot({ path: 'test-results/39-network-ip-search.png' });
  // Verify one real 30-second interval. The next start must follow completion, not overlap it.
  if (!process.env.HARBOR_QUERY_QUICK) {
    const firstStart = await global.locator('.network-query-progress>span').innerText();
    await poll(async () => (await global.locator('.network-query-progress>span').innerText()) !== firstStart, 38000);
    await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'), 12000);
  }
  console.log(`ARP, IP brief and longest-prefix/ECMP verified${process.env.HARBOR_QUERY_QUICK ? ' (quick payload probe)' : '; one real 30-second network refresh verified'}.`);
  await global.getByRole('button', { name: '暂停刷新', exact: true }).click();
  await global.getByLabel('网络查询自动刷新', { exact: true }).selectOption('0');
  for (const mac of process.env.HARBOR_QUERY_QUICK ? ['aabb-ccdd-eeff'] : ['aabb.ccdd.eeff', 'aabb-ccdd-eeff', 'AA:BB:CC:DD:EE:FF', 'AA-BB-CC-DD-EE-FF']) {
    await input.fill(mac); await global.getByRole('button', { name: '查询全网', exact: true }).click(); await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'), 12000);
    assert.equal(await global.locator('.network-query-table tbody tr').count(), 4); assert.match(await global.locator('.network-query-table').innerText(), /VLAN 20/);
  }
  console.log('MAC inputs and per-device timeout coverage verified.');
  await global.getByLabel('网络查询自动刷新', { exact: true }).selectOption('30');
  await global.getByRole('button', { name: '查询全网', exact: true }).click(); await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'), 12000);
  const cachedTable = await global.locator('.network-query-table').innerText();
  const cachedInput = await input.inputValue();
  const cachedTime = await global.locator('.network-query-progress>span').innerText();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  assert.equal(await global.isVisible(), false);
  if (!process.env.HARBOR_QUERY_QUICK) await page.waitForTimeout(31000);
  await page.getByRole('button', { name: '网络管理', exact: true }).click();
  assert.equal(await global.getByRole('button', { name: '暂停刷新', exact: true }).count(), 0);
  assert.equal(await input.inputValue(), cachedInput); assert.equal(await global.locator('.network-query-table').innerText(), cachedTable);
  assert.ok((await global.locator('.network-query-progress>span').innerText()).includes(cachedTime.split(' · ')[0]));
  await page.getByRole('button', { name: '单台设备', exact: true }).click();
  await page.getByRole('tab', { name: 'ARP 查询', exact: true }).click();
  assert.equal(await page.getByLabel('ARP 查询地址', { exact: true }).inputValue(), '192.0.2.99');
  assert.equal(await page.locator('.network-query-panel:visible .network-query-table tbody tr').count(), 1);
  await page.getByRole('button', { name: '全网查询', exact: true }).click();
  assert.equal(await global.locator('.network-query-table').innerText(), cachedTable);

  await page.setViewportSize({ width: 1040, height: 740 });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click(); await page.getByRole('combobox', { name: '界面字号', exact: true }).selectOption('18'); await page.getByRole('button', { name: '布布一二', exact: true }).click();
  await page.getByRole('button', { name: '网络管理', exact: true }).click(); await page.getByRole('button', { name: '全网查询', exact: true }).click();
  await input.fill('192.0.2.99'); await global.getByRole('button', { name: '查询全网', exact: true }).click(); await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('本轮完成'), 12000);
  await page.screenshot({ path: 'test-results/40-network-ip-bubu-small.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const tableBox = (await global.locator('.interfaces-scroll').boundingBox())!; assert.ok(tableBox.height >= 100, JSON.stringify(tableBox));
  assert.equal(await global.locator('.network-query-table td code').first().evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
  await page.screenshot({ path: 'test-results/40-network-ip-bubu-small.png' });
  await input.fill('192.0.2.99'); await global.getByRole('button', { name: '查询全网', exact: true }).click(); await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('查询中'), 5000); await global.getByRole('button', { name: '停止', exact: true }).click();
  await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('已停止'), 5000);
  await global.getByRole('button', { name: '查询全网', exact: true }).click();
  await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('查询中'), 5000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await poll(async () => app!.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), 5000);
  await poll(async () => (await global.locator('.network-query-progress').innerText()).includes('已停止'), 5000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await poll(async () => page.evaluate(() => window.harbor!.windowVisible()), 5000);
  await page.getByRole('button', { name: '单台设备', exact: true }).click();
  await page.getByRole('tab', { name: 'ARP 查询', exact: true }).click(); await page.getByLabel('ARP 查询地址', { exact: true }).fill('192.0.2.99'); await page.getByRole('button', { name: '查询当前设备', exact: true }).click(); await poll(async () => (await page.locator('.network-query-panel:visible .network-query-progress').innerText()).includes('本轮完成'), 10000);
  assert.equal(fixture.writes.length, 0); assert.ok(!(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).includes('fixture-read')); assert.deepEqual(errors, []);
  console.log('Network IP UI passed (retained query rows/input/time across navigation, tab/mode switches and paused hidden refresh): grouped uniform credentials, preserved custom ports, ARP, LPM/ECMP routes, IP brief, scoped network auto IP/MAC, MAC formats, per-device timeout/coverage, polling controls, cancellation/native window visibility/navigation cleanup, Ctrl+K and 18px Bubu small-window layout; no SNMP SET.');
} finally { if (app) await app.close(); await fixture.close(); await new Promise<void>(resolve => blackhole.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
