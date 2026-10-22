import ssh2, { type Connection, type ServerChannel } from 'ssh2';
import net, { type Server, type Socket } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Profile } from '../shared/types';
import { Store } from '../electron/store';
import { Vault } from '../electron/vault';
import { attachSftp, type SftpFixtureOptions } from './sftp-fixture';

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check: () => boolean, timeout = 6000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for state'); await delay(20); } }
export async function portOf(server: Server) { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return (server.address() as net.AddressInfo).port; }
export async function freePort() { const server = net.createServer(); const port = await portOf(server); await new Promise<void>(resolve => server.close(() => resolve())); return port; }
export function profile(port: number, extra: Partial<Profile> = {}): Profile { return { id: randomUUID(), name: '测试主机', host: '127.0.0.1', port, username: 'tester', group: '本机测试', authType: 'password', privateKeyPath: '', agentPath: '', favorite: false, color: 'teal', hasSecret: false, rememberSecret: false, ...extra }; }
export async function tempStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harborssh-test-'));
  const vault = new Vault(directory); await vault.load(); await vault.setup('fixture-master-password');
  const store = new Store(directory, vault);
  await store.load(); return { store, vault, directory, cleanup: () => { vault.lock(); return fs.rm(directory, { recursive: true, force: true }); } };
}
export async function sshFixture(sftpOptions?: SftpFixtureOptions, execHandler?: (command: string, stream: ServerChannel) => boolean) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'pkcs1' } }).privateKey;
  const peers = new Set<Connection>(); const sockets = new Set<Socket>(); const servers = new Set<Server>(); const sizes: { rows: number; cols: number }[] = [];
  const shellStreams = new Set<ServerChannel>(); const received: Buffer[] = [];
  const execCommands: string[] = [];
  const track = (s: Socket) => { sockets.add(s); s.on('error', () => {}); s.once('close', () => sockets.delete(s)); return s; };
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    peers.add(client); client.on('error', () => {}); client.once('close', () => peers.delete(client));
    client.on('authentication', ctx => { if (ctx.username === 'tester' && (ctx.method === 'password' && ctx.password === 'test-secret' || ctx.method === 'publickey')) ctx.accept(); else ctx.reject(); });
    client.on('ready', () => {
      let sessions = 0;
      client.on('session', (accept, reject) => {
        const sessionIndex = sessions++;
        if (sftpOptions?.singleSession && sessionIndex) { reject(); return; }
        const session = accept();
        if (sessionIndex && (sftpOptions?.rejectSubsystemAfterShell || sftpOptions?.stallSubsystemAfterShell)) session.on('sftp', (_accept, reject) => { if (sftpOptions.rejectSubsystemAfterShell) reject(); });
        else if (sftpOptions) attachSftp(session, sftpOptions);
        session.on('pty', (accept, _reject, info) => { sizes.push({ cols: info.cols, rows: info.rows }); accept?.(); });
        session.on('window-change', (accept, _reject, info) => { sizes.push({ cols: info.cols, rows: info.rows }); accept?.(); });
        session.on('shell', accept => {
          const stream = accept(); stream.on('error', () => {});
          shellStreams.add(stream); stream.once('close', () => shellStreams.delete(stream));
          const text = Buffer.from('欢迎使用 SSH 测试终端\r\n'); stream.write(text.subarray(0, 2)); stream.write(text.subarray(2));
          stream.on('data', (chunk: Buffer) => { received.push(Buffer.from(chunk)); stream.write(Buffer.concat([Buffer.from('echo:'), chunk])); });
        });
        session.on('exec', (accept, _reject, info) => {
          const stream = accept(); stream.on('error', () => {});
          execCommands.push(info.command); if (execHandler?.(info.command, stream)) return;
          if (info.command === 'hang') return;
          if (info.command === 'no-exit') { stream.write('Interface output\r\nHRP_S<fixture>\r\n'); stream.end(); return; }
          if (info.command === 'exit-then-disconnect') { stream.write('complete\n'); stream.exit(0); setTimeout(() => client.end(), 30); return; }
          if (info.command === 'disconnect-with-output') { stream.write('partial output\n'); setTimeout(() => client.end(), 30); return; }
          if (info.command === 'fail') { stream.stderr.write('failure detail\n'); stream.exit(7); stream.end(); return; }
          stream.write(`主机结果: ${info.command}\n`); stream.exit(0); stream.end();
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        const socket = track(net.connect({ host: info.destIP, port: info.destPort }));
        socket.once('error', reject);
        socket.once('connect', () => { const stream = accept(); stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy()); socket.once('close', () => stream.destroy()); socket.pipe(stream).pipe(socket); });
      });
      const forwards = new Map<number, Server>();
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const listener = net.createServer(socket => {
            track(socket);
            client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, (err, stream) => {
              if (err) { socket.destroy(); return; }
              stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy()); socket.once('close', () => stream.destroy()); socket.pipe(stream).pipe(socket);
            });
          });
          servers.add(listener); listener.once('error', () => reject?.());
          listener.listen(info.bindPort, info.bindAddr, () => { forwards.set(info.bindPort, listener); accept?.(); });
        } else if (name === 'cancel-tcpip-forward') { forwards.get(info.bindPort)?.close(); forwards.delete(info.bindPort); accept?.(); }
        else reject?.();
      });
      client.once('close', () => { for (const listener of forwards.values()) listener.close(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  const echo = net.createServer(socket => { track(socket); socket.pipe(socket); }); const echoPort = await portOf(echo);
  return { port, echoPort, sizes, received, execCommands, connectionCount: () => peers.size, endTerminals: () => { for (const stream of shellStreams) stream.end(); }, sendToTerminals: (data: string) => { for (const stream of shellStreams) stream.write(data); }, close: async () => {
    for (const peer of peers) peer.end(); for (const socket of sockets) socket.destroy(); for (const listener of servers) listener.close();
    await Promise.all([new Promise<void>(resolve => echo.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
  } };
}
export function socketReader(socket: Socket) {
  let buffer: Buffer = Buffer.alloc(0); let waiting: { size: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | null = null;
  const flush = () => { if (waiting && buffer.length >= waiting.size) { const item = waiting; waiting = null; const value = buffer.subarray(0, item.size); buffer = buffer.subarray(item.size); item.resolve(value); } };
  socket.on('data', data => { buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data]); flush(); });
  socket.on('error', err => { waiting?.reject(err); waiting = null; });
  socket.setTimeout(5000, () => socket.destroy(new Error('Socket read timeout')));
  return (size: number) => new Promise<Buffer>((resolve, reject) => { waiting = { size, resolve, reject }; flush(); });
}
