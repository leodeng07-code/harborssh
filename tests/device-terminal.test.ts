import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { SerialPortMock } from 'serialport';
import iconv from 'iconv-lite';
import { profile, tempStore, until, freePort } from './helpers';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { profileSchema } from '../electron/validation';
import { TelnetCodec, TelnetLogin } from '../electron/telnet';
import { DeviceTerminal } from '../electron/device-terminal';
import { defaultSerial, sameHost } from '../shared/connections';
import { exportProfiles, parseImport, importSelection } from '../electron/importer';

const MockBinding = SerialPortMock.binding;
const output = (manager: Manager, id: string) => Buffer.concat(manager.readTerminal(id).data.map(v => Buffer.from(v, 'base64'))).toString();
test('legacy profiles stay SSH; serial and Telnet are validated independently', () => {
  assert.equal(profileSchema.parse(profile(22)).protocol, 'ssh');
  assert.throws(() => profileSchema.parse(profile(22, { username: '' })));
  assert.equal(profileSchema.parse(profile(23, { protocol: 'telnet', username: '' })).username, '');
  const serial = profileSchema.parse(profile(22, { protocol: 'serial', host: 'com12', username: '' }));
  assert.equal(serial.host, 'COM12'); assert.deepEqual(serial.serial, defaultSerial);
  for (const host of ['C:/Windows/system.ini', '/tmp/test', '/dev/../etc/passwd', 'COM0']) assert.throws(() => profileSchema.parse({ ...serial, host }));
  assert.throws(() => profileSchema.parse({ ...serial, serial: { ...defaultSerial, baudRate: -1 } }));
  assert.throws(() => profileSchema.parse({ ...serial, authType: 'key' }));
  assert.equal(sameHost('2001:db8:0:0:0:0:0:1', '2001:db8::1'), true);
});

test('shared Telnet passwords reference encrypted SSH secrets, follow rotation/restart, and protect dependencies', async () => {
  const state = await tempStore();
  try {
    const ssh = profile(22), telnet = profile(23, { protocol: 'telnet', username: 'telnet-admin', telnetCredentialProfileId: ssh.id });
    await state.store.saveProfile({ profile: ssh, secrets: { password: 'first-device-secret' } });
    await state.store.saveProfile({ profile: telnet, secrets: { password: 'must-not-copy' } });
    assert.equal(await state.store.telnetPassword(telnet.id), 'first-device-secret');
    assert.deepEqual(await state.store.secrets(telnet.id), {});
    const disk = await fs.readFile(path.join(state.directory, 'config.json'), 'utf8');
    assert.ok(!disk.includes('first-device-secret') && !disk.includes('must-not-copy'));
    await state.store.saveProfile({ profile: ssh, secrets: { password: 'rotated-device-secret' } });
    const restored = new Store(state.directory, state.vault); await restored.load();
    assert.equal(await restored.telnetPassword(telnet.id), 'rotated-device-secret');
    assert.equal(restored.profile(telnet.id).hasSecret, true);
    await assert.rejects(state.store.saveProfile({ profile: { ...telnet, host: '192.0.2.99' } }), /同 IP/);
    await assert.rejects(state.store.saveProfile({ profile: { ...ssh, host: '192.0.2.99' } }), /Telnet 共用/);
    await assert.rejects(state.store.saveProfile({ profile: ssh, clearSecret: true }), /Telnet 共用/);
    await assert.rejects(state.store.deleteProfiles([ssh.id]), /共用/);
    await state.store.deleteProfiles([ssh.id, telnet.id]); assert.equal(state.store.config().profiles.length, 0);
  } finally { await state.cleanup(); }
});

test('Telnet negotiation is fragmented safely; NAWS/terminal type work and unknown options are refused', () => {
  const replies: Buffer[] = [], data: Buffer[] = [], codec = new TelnetCodec(v => replies.push(v), v => data.push(v));
  const wire = Buffer.from([255, 253, 31, 255, 253, 24, 255, 251, 1, 255, 251, 99, 255, 250, 24, 1, 255, 240, 65, 13, 0, 66, 255, 255]);
  for (const byte of wire) codec.feed(Buffer.from([byte]));
  assert.deepEqual([...Buffer.concat(data)], [65, 13, 66, 255]);
  assert.ok(replies.some(v => v.equals(Buffer.from([255, 253, 1]))));
  assert.ok(replies.some(v => v.equals(Buffer.from([255, 254, 99]))));
  assert.ok(Buffer.concat(replies).includes(Buffer.from('xterm-256color')));
  const previous = replies.length; codec.feed(Buffer.from([255, 253, 31])); assert.equal(replies.length, previous);
  codec.resize(255, 42); assert.deepEqual([...replies.at(-1)!], [255, 250, 31, 0, 255, 255, 0, 42, 255, 240]);
  assert.deepEqual([...codec.encode(Buffer.from([65, 255, 66]))], [65, 255, 255, 66]);
  codec.feed(Buffer.concat([Buffer.from([255, 250]), Buffer.alloc(10000, 4), Buffer.from([255, 240, 90])]));
  assert.equal(Buffer.concat(data).at(-1), 90);
});

test('Telnet auto login waits for fragmented prompts, sends once, and cancels on manual input or shell prompt', () => {
  const sent: string[] = [], login = new TelnetLogin('admin', 'secret', v => sent.push(v));
  login.feed('Welcome\r\nUser'); assert.equal(sent.length, 0); login.feed('name: '); assert.deepEqual(sent, ['admin\r\n']);
  login.feed('\r\nPass'); login.feed('word: '); login.feed('Password: '); assert.deepEqual(sent, ['admin\r\n', 'secret\r\n']);
  const manual = new TelnetLogin('admin', 'never-send', v => sent.push(v)); manual.cancel(); manual.feed('Password:'); assert.equal(sent.length, 2);
  const shell = new TelnetLogin('admin', 'never-send', v => sent.push(v)); shell.feed('Welcome\r\n<HUAWEI>'); shell.feed('Password:'); assert.equal(sent.length, 2);
  const change = new TelnetLogin('', 'never-send', v => sent.push(v)); change.feed('New password:'); change.feed('\r\nConfirm password:'); assert.equal(sent.length, 2);
});

async function telnetFixture(encoding = 'utf8', manual = false) {
  const clients = new Set<net.Socket>(), received: string[] = [], wire: Buffer[] = [];
  let last: net.Socket | undefined;
  const server = net.createServer(socket => {
    last = socket; clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    let line = ''; const decoder = iconv.getDecoder(encoding);
    const parser = new TelnetCodec(() => {}, data => {
      line += decoder.write(data);
      while (line.includes('\r\n')) {
        const end = line.indexOf('\r\n'), value = line.slice(0, end); line = line.slice(end + 2); received.push(value);
        if (received.length === 1) socket.write('Pass');
        if (received.length === 1) setTimeout(() => { if (!socket.destroyed) socket.write('word: '); }, 10);
        if (received.length === 2) {
          const bytes = iconv.encode('\r\n中文设备已登录\r\n<HUAWEI>', encoding);
          socket.write(bytes.subarray(0, 3)); setTimeout(() => { if (!socket.destroyed) socket.write(bytes.subarray(3)); }, 10);
        } else if (received.length > 2) socket.write(iconv.encode(`\r\n执行:${value}\r\n<HUAWEI>`, encoding));
      }
    });
    socket.on('data', data => { const bytes = Buffer.from(data); wire.push(bytes); parser.feed(bytes); });
    socket.write(Buffer.from([255, 253, 31, 255, 253, 24, 255, 251, 1]));
    socket.write(manual ? 'Login: ' : 'User');
    if (!manual) setTimeout(() => { if (!socket.destroyed) socket.write('name: '); }, 10);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, received, wire, end: () => last?.end(), close: async () => { clients.forEach(v => v.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('real TCP Telnet: shared password login, split GB18030, terminal input/resize/Break, saved logs and remote close', async () => {
  const f = await telnetFixture('gb18030'), state = await tempStore();
  const manager = new Manager(state.store, () => {}, async () => { throw new Error('Telnet must not dial SSH'); });
  try {
    const ssh = profile(22), p = profile(f.port, { protocol: 'telnet', encoding: 'gb18030', username: 'telnet-admin', telnetCredentialProfileId: ssh.id });
    await state.store.saveProfile({ profile: ssh, secrets: { password: 'shared-telnet-secret' } }); await state.store.saveProfile({ profile: p });
    const id = manager.startSession(p.id); await until(() => output(manager, id).includes('中文设备已登录'));
    assert.deepEqual(f.received, ['telnet-admin', 'shared-telnet-secret']);
    assert.equal(manager.snapshot().sessions[0].protocol, 'telnet');
    manager.write(id, 'display 中文\r'); manager.resize(id, 255, 42); await manager.sendBreak(id);
    await until(() => output(manager, id).includes('执行:display 中文'));
    assert.ok(Buffer.concat(f.wire).includes(Buffer.from([255, 250, 31, 0, 255, 255, 0, 42, 255, 240])));
    await until(() => Buffer.concat(f.wire).includes(Buffer.from([255, 243])));
    f.end(); await until(() => manager.snapshot().sessions[0].status === 'closed'); await manager.flushLogs();
    const log = manager.snapshot().sessions[0].log; assert.equal(log?.status, 'saved');
    const content = await fs.readFile(log!.path, 'utf8'); assert.match(content, /协议：Telnet/); assert.match(content, /中文设备已登录/); assert.ok(!content.includes('shared-telnet-secret')); assert.ok(!content.includes('\ufffd'));
    await assert.rejects(manager.sftp.list(id, '.'), /SSH/);
  } finally { manager.dispose(); await manager.flushLogs(); await f.close(); await state.cleanup(); }
});

test('Telnet allows manual login with no saved password; refused and cancelled opens release resources', async () => {
  const f = await telnetFixture('utf8', true), state = await tempStore(), manager = new Manager(state.store, () => {}, async () => true);
  try {
    const p = profile(f.port, { protocol: 'telnet', username: '' }); await state.store.saveProfile({ profile: p });
    const id = manager.startSession(p.id); await until(() => output(manager, id).includes('Login:'));
    assert.deepEqual(f.received, []); manager.write(id, 'manual-user\r'); await until(() => f.received[0] === 'manual-user');
    manager.write(id, 'manual-password\r'); await until(() => output(manager, id).includes('已登录')); manager.disconnect(id);
    const unreachable = profile(await freePort(), { protocol: 'telnet' }); await state.store.saveProfile({ profile: unreachable });
    manager.startSession(unreachable.id); await until(() => manager.snapshot().sessions[0]?.status === 'error');
    assert.match(manager.snapshot().sessions[0].message!, /Telnet/);
    const pending = manager.startSession(p.id); manager.disconnect(pending); await new Promise(resolve => setTimeout(resolve, 40)); assert.ok(!manager.snapshot().sessions.some(v => v.id === pending));
  } finally { manager.dispose(); await manager.flushLogs(); await f.close(); await state.cleanup(); }
});

test('serial driver binding: configured line settings, split Chinese, CRLF, local echo, Break and reopen', async () => {
  const state = await tempStore(), portPath = '/dev/HARBOR_TEST'; MockBinding.createPort(portPath, { record: true });
  let port: SerialPortMock | undefined;
  const manager = new Manager(state.store, () => {}, async () => true, p => {
    const s = p.serial!; port = new SerialPortMock({ path: p.host, baudRate: s.baudRate, dataBits: s.dataBits, stopBits: s.stopBits, parity: s.parity, rtscts: s.flowControl === 'hardware', autoOpen: false }); return port;
  });
  try {
    const p = profile(22, { protocol: 'serial', host: portPath, username: '', encoding: 'gb18030', serial: { ...defaultSerial, baudRate: 115200, parity: 'even', stopBits: 2, flowControl: 'hardware', localEcho: true, enterKey: 'crlf' } });
    await state.store.saveProfile({ profile: p, secrets: { password: 'must-not-store' } }); assert.deepEqual(await state.store.secrets(p.id), {});
    const id = manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status === 'connected');
    const binding = port!.port!; assert.equal(binding.openOptions.baudRate, 115200); assert.equal(binding.openOptions.parity, 'even'); assert.equal(binding.openOptions.stopBits, 2); assert.equal(binding.openOptions.rtscts, true);
    const chinese = iconv.encode('串口中文提示', 'gb18030'); binding.emitData(chinese.subarray(0, 1)); binding.emitData(chinese.subarray(1));
    await until(() => output(manager, id).includes('串口中文提示'));
    manager.write(id, '测试\r'); await until(() => binding.recording.length > 0); assert.ok(binding.recording.equals(iconv.encode('测试\r\n', 'gb18030')));
    await until(() => output(manager, id).includes('测试\r\n')); await manager.sendBreak(id);
    manager.disconnect(id); await until(() => !binding.isOpen); await manager.flushLogs();
    const reopened = manager.startSession(p.id); await until(() => manager.snapshot().sessions.find(v => v.id === reopened)?.status === 'connected'); manager.disconnect(reopened);
  } finally { manager.dispose(); await manager.flushLogs(); await state.cleanup(); }
});

test('serial cancellation while driver opens closes late handles and reports open failures', async () => {
  let closed = 0;
  class LatePort extends Duplex {
    isOpen = false; _read() {} _write(_data: Buffer, _enc: BufferEncoding, cb: () => void) { cb(); }
    open(cb: (error: Error | null) => void) { setTimeout(() => { this.isOpen = true; cb(null); }, 25); }
    close(cb?: (error: Error | null) => void) { this.isOpen = false; closed++; cb?.(null); }
    set(_flags: { brk: boolean }, cb: (error: Error | null) => void) { cb(null); }
  }
  const p = profile(22, { protocol: 'serial', host: 'COM3' });
  const channel = new DeviceTerminal(p, () => assert.fail('cancelled channel became ready'), () => new LatePort()); channel.on('error', () => {});
  await new Promise(resolve => setTimeout(resolve, 5)); channel.destroy(); await until(() => closed === 1);
  const failure = new DeviceTerminal(p, () => assert.fail('invalid port became ready'), () => { throw new Error('driver missing'); });
  await new Promise<void>(resolve => failure.once('error', error => { assert.match(error.message, /driver missing/); resolve(); }));
});

test('real native serial IO through a Linux PTY, without physical hardware', { skip: process.platform !== 'linux' }, async () => {
  const script = `import os,pty,tty,select,sys,json,base64\nm,s=pty.openpty();tty.setraw(s);print(os.ttyname(s),flush=True)\nwhile True:\n r,_,_=select.select([m,sys.stdin],[],[],1)\n if sys.stdin in r:\n  line=sys.stdin.readline()\n  if not line: break\n  os.write(m,base64.b64decode(json.loads(line)['write']))\n if m in r:\n  try: print(json.dumps({'read':base64.b64encode(os.read(m,4096)).decode()}),flush=True)\n  except OSError: pass\n`;
  const child = spawn('python3', ['-u', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '', slave = '', received = ''; child.stdout.on('data', data => {
    text += data; while (text.includes('\n')) { const end = text.indexOf('\n'), line = text.slice(0, end); text = text.slice(end + 1); if (!slave) slave = line; else received += Buffer.from(JSON.parse(line).read, 'base64').toString(); }
  });
  const state = await tempStore(), manager = new Manager(state.store, () => {}, async () => true);
  try {
    await until(() => !!slave);
    const p = profile(22, { protocol: 'serial', host: slave, username: '', serial: { ...defaultSerial, baudRate: 115200 } }); await state.store.saveProfile({ profile: p });
    const id = manager.startSession(p.id); await until(() => manager.snapshot().sessions[0]?.status !== 'connecting');
    assert.equal(manager.snapshot().sessions[0].status, 'connected', manager.snapshot().sessions[0].message || 'serial should open');
    child.stdin.write(JSON.stringify({ write: Buffer.from('真实串口驱动\r\n').toString('base64') }) + '\n'); await until(() => output(manager, id).includes('真实串口驱动'));
    manager.write(id, 'display version\r'); await until(() => received.includes('display version\r')); manager.disconnect(id); await manager.flushLogs();
  } finally { manager.dispose(); await manager.flushLogs(); child.stdin.end(); child.kill(); await state.cleanup(); }
});

test('Excel export/import retains protocol and serial settings without exporting shared passwords', async () => {
  const state = await tempStore();
  try {
    const a = profile(23, { protocol: 'telnet', username: '' }), b = profile(22, { protocol: 'serial', host: 'COM14', username: '', encoding: 'gb18030', serial: { ...defaultSerial, baudRate: 115200, flowControl: 'software' } });
    await state.store.saveProfile({ profile: a }); await state.store.saveProfile({ profile: b });
    const filename = path.join(state.directory, 'mixed.xlsx'); await exportProfiles(filename, state.store.config());
    const draft = await parseImport(filename, { profiles: [], tunnels: [] }); assert.ok(draft.preview.rows.every(v => !v.error), JSON.stringify(draft.preview.rows));
    const entries = importSelection(draft, draft.preview.rows.map(v => v.row), { profiles: [], tunnels: [] }, true, false);
    assert.equal(entries[0].profile.protocol, 'telnet'); assert.equal(entries[1].profile.protocol, 'serial'); assert.equal(entries[1].profile.serial?.baudRate, 115200); assert.equal(entries[1].profile.serial?.flowControl, 'software');
  } finally { await state.cleanup(); }
});
