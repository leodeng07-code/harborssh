import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { poll } from './poll.mjs';
import { profile, until } from '../tests/helpers';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-console-ui-'));
const connections: net.Socket[] = [], credentials: string[][] = [];
const server = net.createServer(socket => {
  connections.push(socket); const lines: string[] = []; credentials.push(lines); let tail = '';
  socket.on('error', () => {}); socket.write('Username: ');
  socket.on('data', data => {
    tail += data.toString();
    while (tail.includes('\r\n')) {
      const end = tail.indexOf('\r\n'), line = tail.slice(0, end); tail = tail.slice(end + 2); lines.push(line);
      socket.write(lines.length === 1 ? 'Password: ' : lines.length === 2 ? '\r\nTelnet console ready\r\n<HUAWEI>' : `\r\nresult:${line}\r\n<HUAWEI>`);
    }
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as net.AddressInfo).port;
const python = spawn('python3', ['-u', '-c', `import os,pty,tty,select,sys,json,base64\nm,s=pty.openpty();tty.setraw(s);print(os.ttyname(s),flush=True)\nwhile True:\n r,_,_=select.select([m,sys.stdin],[],[],1)\n if sys.stdin in r:\n  line=sys.stdin.readline()\n  if not line:break\n  os.write(m,base64.b64decode(json.loads(line)['write']))\n if m in r:\n  try:print(json.dumps({'read':base64.b64encode(os.read(m,4096)).decode()}),flush=True)\n  except OSError:pass\n`]);
let slave = '', stdout = '', serialInput = '';
python.stdout.on('data', data => {
  stdout += data; while (stdout.includes('\n')) { const end = stdout.indexOf('\n'), line = stdout.slice(0, end); stdout = stdout.slice(end + 1); if (!slave) slave = line; else serialInput += Buffer.from(JSON.parse(line).read, 'base64').toString(); }
});
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  await until(() => !!slave);
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', HARBOR_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [process.env.HARBOR_SMOKE_APP || '.', '--no-sandbox', '--ozone-platform=x11'], env, timeout: 20000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('软件密码', { exact: true }).fill('console-fixture-password'); await page.getByLabel('确认软件密码', { exact: true }).fill('console-fixture-password');
  await page.getByRole('button', { name: '设置密码并进入', exact: true }).click();
  await page.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  const source = profile(22, { name: '共用密码来源 SSH' });
  await page.evaluate(async p => window.harbor!.saveProfile({ profile: p, secrets: { password: 'first-login-secret' } }), source); await page.reload();
  await page.getByRole('button', { name: '新建连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('华为 Telnet 测试'); await page.getByLabel('连接协议', { exact: true }).selectOption('telnet');
  assert.equal(await page.getByLabel('端口', { exact: true }).inputValue(), '23');
  await page.getByLabel('主机地址', { exact: true }).fill('127.0.0.1'); await page.getByLabel('端口', { exact: true }).fill(String(port));
  await page.getByLabel('用户名（可选）', { exact: true }).fill('telnet-admin'); await page.getByRole('checkbox', { name: '使用同 IP 的 SSH 密码', exact: true }).check();
  assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(), 0);
  assert.ok(!(await page.getByRole('dialog').innerText()).includes('first-login-secret'));
  await page.setViewportSize({ width: 1040, height: 700 });
  await page.getByLabel('共用密码的 SSH 连接', { exact: true }).scrollIntoViewIfNeeded();
  await fs.mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/60-telnet-shared-password.png' });
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.locator('.profile-card').filter({ has: page.getByRole('heading', { name: '华为 Telnet 测试', exact: true }) }).getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).last().waitFor(); await until(() => credentials[0]?.length === 2);
  assert.deepEqual(credentials[0], ['telnet-admin', 'first-login-secret']);
  const pane = page.locator('.terminal-pane.visible');
  assert.equal(await pane.getByRole('button', { name: 'SFTP 文件管理', exact: true }).count(), 0);
  assert.equal(await pane.getByRole('button', { name: 'Linux 运行状态', exact: true }).count(), 0);
  await pane.locator('.terminal-container').click(); await page.keyboard.insertText('display lldp neighbor brief'); await page.keyboard.press('Enter'); await until(() => credentials[0].includes('display lldp neighbor brief'));
  await page.screenshot({ path: 'test-results/61-live-telnet.png' });
  await page.evaluate(async p => window.harbor!.saveProfile({ profile: p, secrets: { password: 'rotated-login-secret' } }), source);
  connections[0].end(); await pane.getByText(/Telnet 远程会话已结束/).waitFor();
  await pane.locator('.terminal-container').click(); await page.keyboard.press('r'); await until(() => credentials[1]?.length === 2); assert.equal(credentials[1][1], 'rotated-login-secret');
  await page.getByRole('button', { name: '连接管理', exact: true }).click(); await page.getByRole('button', { name: '新建连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('串口 Console 测试'); await page.getByLabel('连接协议', { exact: true }).selectOption('serial');
  await page.getByLabel('串口端口', { exact: true }).fill(slave); await page.getByLabel('波特率', { exact: true }).fill('115200');
  assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(), 0);
  await page.getByRole('button', { name: '刷新串口', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await page.screenshot({ path: 'test-results/62-serial-profile.png' });
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.locator('.profile-card').filter({ has: page.getByRole('heading', { name: '串口 Console 测试', exact: true }) }).getByRole('button', { name: '连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).last().waitFor();
  python.stdin.write(JSON.stringify({ write: Buffer.from('Serial console ready\r\n<HUAWEI>').toString('base64') }) + '\n');
  await poll(page, async () => { const state = await window.harbor!.initial(); const session = state.runtime.sessions.find(s => s.protocol === 'serial'); if (!session) return false; return (await window.harbor!.readTerminal(session.id)).data.some(v => atob(v).includes('Serial console ready')); });
  await page.locator('.terminal-pane.visible .terminal-container').click(); await page.keyboard.insertText('display version'); await page.keyboard.press('Enter'); await until(() => serialInput.includes('display version\r'));
  await page.locator('.terminal-pane.visible').getByRole('button', { name: 'Break', exact: true }).click();
  const toast = page.locator('.toast.error'); await toast.waitFor(); assert.match(await toast.innerText(), /Break.*驱动/); await toast.locator('button').click();
  await page.locator('.terminal-pane.visible .terminal-container').click(); await page.keyboard.insertText('after-break'); await page.keyboard.press('Enter'); await until(() => serialInput.includes('after-break'));
  await page.screenshot({ path: 'test-results/63-live-serial.png' });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click(); await page.getByRole('button', { name: '布布一二', exact: true }).click();
  await page.getByRole('button', { name: '终端', exact: true }).click(); await page.screenshot({ path: 'test-results/64-console-bubu-small.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '关闭会话 串口 Console 测试', exact: true }).click();
  await page.getByRole('button', { name: '关闭会话 华为 Telnet 测试', exact: true }).click();
  const state = await page.evaluate(() => window.harbor!.initial()); assert.equal(state.runtime.sessions.length, 0);
  let savedLogs = 0; for (let i = 0; i < 100 && savedLogs !== 3; i++) { savedLogs = (await fs.readdir(path.join(directory, 'logs'))).filter(v => v.endsWith('.log') && !v.endsWith('.recording.log')).length; if (savedLogs !== 3) await new Promise(resolve => setTimeout(resolve, 30)); } assert.equal(savedLogs, 3);
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  const ids = state.config.profiles.map(p => p.id); await page.evaluate(ids => window.harbor!.deleteProfiles(ids), ids); assert.equal((await page.evaluate(() => window.harbor!.initial())).config.profiles.length, 0);
  assert.deepEqual(errors, []);
  console.log('Desktop protocols passed: Telnet UI/shared encrypted password/rotation/R reconnect/keyboard, native serial PTY/115200/unsupported-Break error without disconnect, protocol-specific actions, 1040x700 dark+Bubu and finalized logs.');
} finally {
  if (app) await app.close(); connections.forEach(v => v.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); python.stdin.end(); python.kill(); await fs.rm(directory, { recursive: true, force: true });
}
