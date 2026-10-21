import ssh2, { type Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net, { type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { AppEvent, BatchJob, BatchRequest, BatchResult, Profile, RuntimeSnapshot, SessionInfo, TerminalBuffer, TunnelInfo } from '../shared/types';
import { Store } from './store';
import { serveSocks } from './socks';
import { message } from './validation';
import { SftpService } from './sftp';
import { batchCompletion } from './batch-result';
import { SessionLogs } from './session-logs';
import { SystemMonitor } from './system-monitor';

interface Resource { closed: boolean; client?: Client; server?: Server; streams: Set<Duplex>; cancel?: () => void; onCancel?: () => void; onFailure?: (reason: string) => void }
const resource = (): Resource => ({ closed: false, streams: new Set() });
function stop(r: Resource) {
  if (r.closed) return;
  r.closed = true; r.cancel?.(); r.onCancel?.(); r.server?.close();
  for (const stream of r.streams) stream.destroy();
  r.streams.clear(); r.client?.destroy();
}
export class Manager {
  readonly sftp: SftpService;
  readonly system: SystemMonitor;
  private logs: SessionLogs;
  private sessions = new Map<string, SessionInfo>();
  private sessionResources = new Map<string, Resource>();
  private shells = new Map<string, ClientChannel>();
  private buffers = new Map<string, { seq: number; bytes: number; chunks: { seq: number; data: string; bytes: number }[] }>();
  private tunnelStates = new Map<string, TunnelInfo>();
  private tunnelResources = new Map<string, Resource>();
  private jobs: BatchJob[] = [];
  private batchResources = new Map<string, Set<Resource>>();
  private cancelled = new Set<string>();
  private publishTimer?: NodeJS.Timeout;
  constructor(private store: Store, private emit: (event: AppEvent) => void, private verify: (profile: Profile, fingerprint: string) => Promise<boolean>) {
    this.logs = new SessionLogs((id, log) => {
      const session = this.sessions.get(id); if (session) { session.log = log; this.schedulePublish(); }
      if (log.status === 'error') this.emit({ type: 'notice', message: log.message!, error: true });
    });
    this.sftp = new SftpService(id => { const r = this.sessionResources.get(id); if (!r?.client || r.closed || this.sessions.get(id)?.status !== 'connected') throw new Error('请先连接 SSH 终端'); return r.client; }, emit);
    this.system = new SystemMonitor(id => { const r = this.sessionResources.get(id); if (!r?.client || r.closed || this.sessions.get(id)?.status !== 'connected') throw new Error('请先连接 SSH 终端'); return r.client; });
  }
  snapshot(): RuntimeSnapshot { return structuredClone({ sessions: [...this.sessions.values()], tunnels: [...this.tunnelStates.values()], jobs: this.jobs }); }
  private publish() { this.emit({ type: 'runtime', data: this.snapshot() }); }
  private schedulePublish() { if (!this.publishTimer) this.publishTimer = setTimeout(() => { this.publishTimer = undefined; this.publish(); }, 120); }
  private track(r: Resource, stream: Duplex) {
    if (r.closed) { stream.destroy(); return; }
    r.streams.add(stream); stream.once('close', () => r.streams.delete(stream));
    stream.on('error', () => {});
  }
  private async dial(profileId: string, r: Resource): Promise<Client> {
    const p = this.store.profile(profileId);
    const secrets = await this.store.secrets(profileId);
    const config: ConnectConfig = {
      host: p.host, port: p.port, username: p.username, readyTimeout: 90_000,
      keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, callback: (accept: boolean) => void) => {
        const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        void this.verify(p, fingerprint).then(ok => callback(ok && !r.closed)).catch(() => callback(false));
      },
    };
    if (p.authType === 'password') {
      if (!secrets.password) throw new Error('缺少密码，请编辑连接并输入密码后重试');
      config.password = secrets.password;
    } else if (p.authType === 'key') {
      const filename = p.privateKeyPath.startsWith('~/') || p.privateKeyPath.startsWith('~\\') ? path.join(os.homedir(), p.privateKeyPath.slice(2)) : p.privateKeyPath;
      const stat = await fs.stat(filename);
      if (stat.size > 2 * 1024 * 1024 || !stat.isFile()) throw new Error('私钥文件无效或大于 2 MB');
      config.privateKey = await fs.readFile(filename); config.passphrase = secrets.passphrase;
    } else {
      config.agent = p.agentPath || process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : '');
      if (!config.agent) throw new Error('未找到 SSH Agent，请填写 Agent 套接字路径');
    }
    if (r.closed) throw new Error('操作已取消');
    const client = new ssh2.Client(); r.client = client;
    return new Promise<Client>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (!settled) { settled = true; reject(new Error(reason)); }
        else if (!r.closed) r.onFailure?.(reason);
      };
      r.cancel = () => { if (!settled) { settled = true; reject(new Error('操作已取消')); } };
      client.on('error', err => fail(message(err)));
      client.once('close', () => fail('SSH 连接已关闭'));
      client.once('ready', () => { if (r.closed) { client.destroy(); return; } settled = true; resolve(client); });
      try { client.connect(config); } catch (err) { fail(message(err)); }
    });
  }
  startSession(profileId: string): string {
    const p = this.store.profile(profileId);
    if (this.sessionResources.size >= 100) throw new Error('最多同时打开 100 个终端，请先关闭部分标签');
    const id = randomUUID(); const r = resource();
    const info: SessionInfo = { id, profileId, name: p.name, status: 'connecting' };
    this.sessions.set(id, info); this.sessionResources.set(id, r);
    this.buffers.set(id, { seq: 0, bytes: 0, chunks: [] });
    this.logs.start(id, p, this.store.config().terminalLogDirectory!);
    const fail = (reason: string) => {
      if (r.closed) return;
      info.status = 'error'; info.message = reason; this.system.closeSession(id); this.sftp.closeSession(id); stop(r); this.shells.delete(id); this.logs.finish(id, reason); this.publish();
    };
    r.onFailure = fail;
    this.publish();
    void this.dial(profileId, r).then(client => {
      if (r.closed) return;
      client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
        if (r.closed) { stream?.destroy(); return; }
        if (err) { fail(message(err)); return; }
        this.track(r, stream); this.shells.set(id, stream);
        info.status = 'connected'; info.connectedAt = Date.now(); this.publish();
        stream.on('data', (data: Buffer) => this.terminalOutput(id, data));
        stream.stderr.on('data', (data: Buffer) => this.terminalOutput(id, data));
        stream.on('error', (err: Error) => fail(message(err)));
        stream.once('close', () => {
          if (r.closed) return;
          info.status = 'closed'; info.message = '远程会话已结束'; this.system.closeSession(id); this.sftp.closeSession(id); stop(r); this.shells.delete(id); this.logs.finish(id, '远程会话已结束'); this.publish();
        });
      });
    }).catch(err => fail(message(err)));
    return id;
  }
  private terminalOutput(id: string, data: Buffer) {
    const buffer = this.buffers.get(id); if (!buffer) return;
    const drain = this.logs.append(id, data), shell = this.shells.get(id);
    if (drain && shell) { shell.pause(); shell.stderr.pause(); void drain.then(() => { if (!shell.destroyed) { shell.resume(); shell.stderr.resume(); } }); }
    // Keep bounded scrollback in the main process so switching tabs never loses output.
    for (let offset = 0; offset < data.length; offset += 65536) {
      const chunk = data.subarray(offset, offset + 65536);
      const item = { seq: ++buffer.seq, data: chunk.toString('base64'), bytes: chunk.length };
      buffer.chunks.push(item); buffer.bytes += item.bytes;
      while (buffer.bytes > 2 * 1024 * 1024 && buffer.chunks.length > 1) buffer.bytes -= buffer.chunks.shift()!.bytes;
      this.emit({ type: 'terminal', id, seq: item.seq, data: item.data });
    }
  }
  readTerminal(id: string): TerminalBuffer {
    const b = this.buffers.get(id); return { seq: b?.seq || 0, data: b?.chunks.map(c => c.data) || [] };
  }
  write(id: string, data: string) { const s = this.shells.get(id); if (s && !s.destroyed && data.length <= 1024 * 1024) s.write(data); }
  resize(id: string, cols: number, rows: number) {
    const s = this.shells.get(id);
    if (s && !s.destroyed && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 500) s.setWindow(rows, cols, 0, 0);
  }
  disconnect(id: string) {
    this.logs.finish(id, '手动断开');
    this.system.closeSession(id);
    this.sftp.closeSession(id);
    const r = this.sessionResources.get(id); if (r) stop(r);
    this.sessionResources.delete(id); this.shells.delete(id); this.sessions.delete(id); this.buffers.delete(id); this.publish();
  }
  tunnelActive(id: string) { return ['starting', 'running'].includes(this.tunnelStates.get(id)?.status || ''); }
  async startTunnel(id: string) {
    if (this.tunnelActive(id)) return;
    const t = this.store.tunnel(id); const r = resource();
    const info: TunnelInfo = { id, status: 'starting', connections: 0 };
    this.tunnelStates.set(id, info); this.tunnelResources.set(id, r);
    const fail = (reason: string) => { if (r.closed) return; info.status = 'error'; info.message = reason; stop(r); this.publish(); };
    r.onFailure = fail; this.publish();
    try {
      const client = await this.dial(t.profileId, r);
      if (r.closed) return;
      const recordConnection = (stream: Duplex) => { this.track(r, stream); if (!r.closed) { info.connections++; this.schedulePublish(); } };
      if (t.type === 'remote') {
        client.on('tcp connection', (details, accept, reject) => {
          if (r.closed || details.destPort !== t.bindPort) { reject(); return; }
          const local = net.connect({ host: t.targetHost, port: t.targetPort }); this.track(r, local);
          local.setTimeout(15_000, () => local.destroy(new Error('连接本地目标超时')));
          let accepted = false;
          local.once('error', () => { if (!accepted) reject(); });
          local.once('connect', () => {
            if (r.closed) { local.destroy(); reject(); return; }
            accepted = true; local.setTimeout(0);
            const stream = accept(); recordConnection(stream);
            stream.on('error', () => local.destroy()); local.on('error', () => stream.destroy());
            stream.once('close', () => local.destroy()); local.once('close', () => stream.destroy());
            local.pipe(stream).pipe(local);
          });
        });
        await new Promise<void>((resolve, reject) => {
          client.forwardIn(t.bindHost, t.bindPort, err => err ? reject(err) : resolve());
        });
      } else {
        const server = net.createServer(socket => {
          this.track(r, socket);
          if (r.closed) return;
          if (t.type === 'dynamic') { serveSocks(socket, client, recordConnection); return; }
          socket.pause(); socket.setTimeout(15_000, () => socket.destroy());
          client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, t.targetHost, t.targetPort, (err, stream) => {
            if (err) { socket.destroy(); return; }
            if (r.closed || socket.destroyed) { stream.destroy(); return; }
            recordConnection(stream); socket.setTimeout(0);
            stream.on('error', () => socket.destroy()); socket.on('error', () => stream.destroy());
            stream.once('close', () => socket.destroy()); socket.once('close', () => stream.destroy());
            socket.pipe(stream).pipe(socket); socket.resume();
          });
        });
        r.server = server; server.on('error', err => fail(message(err)));
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(t.bindPort, t.bindHost, resolve); });
      }
      if (!r.closed) { info.status = 'running'; info.startedAt = Date.now(); this.publish(); }
    } catch (err) { fail(message(err)); }
  }
  async stopTunnel(id: string) {
    const r = this.tunnelResources.get(id);
    // Wait for the server to acknowledge remote unbinding before reporting stopped.
    const t = this.store.config().tunnels.find(t => t.id === id);
    if (r && !r.closed && t?.type === 'remote' && this.tunnelStates.get(id)?.status === 'running') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1500);
        try { r.client?.unforwardIn(t.bindHost, t.bindPort, () => { clearTimeout(timer); resolve(); }); }
        catch { clearTimeout(timer); resolve(); }
      });
    }
    if (r) stop(r); this.tunnelResources.delete(id);
    const info = this.tunnelStates.get(id); if (info) { info.status = 'stopped'; info.message = undefined; this.publish(); }
  }
  async removeTunnel(id: string) { await this.stopTunnel(id); this.tunnelStates.delete(id); this.publish(); }
  runBatch(request: BatchRequest): string {
    if (this.jobs.some(j => j.status === 'running')) throw new Error('请等待当前批量任务完成或先停止任务');
    const profiles = request.profileIds.map(id => this.store.profile(id));
    const job: BatchJob = { id: randomUUID(), command: request.command, startedAt: Date.now(), status: 'running', results: profiles.map(p => ({ profileId: p.id, name: p.name, status: 'queued', output: '' })) };
    this.jobs.unshift(job); this.jobs = this.jobs.slice(0, 10); this.batchResources.set(job.id, new Set()); this.publish();
    let cursor = 0;
    const worker = async () => {
      while (cursor < job.results.length && !this.cancelled.has(job.id)) { const item = job.results[cursor++]; await this.runOne(job, item, request); }
    };
    void Promise.all(Array.from({ length: Math.min(request.concurrency, profiles.length) }, worker)).finally(() => {
      job.status = this.cancelled.has(job.id) ? 'cancelled' : 'done';
      for (const item of job.results) if (item.status === 'queued') item.status = 'cancelled';
      this.batchResources.delete(job.id); this.cancelled.delete(job.id); this.publish();
    });
    return job.id;
  }
  private async runOne(job: BatchJob, item: BatchResult, request: BatchRequest) {
    const r = resource(); const start = Date.now(); const resources = this.batchResources.get(job.id)!;
    resources.add(r); item.status = 'running'; this.publish();
    await new Promise<void>(resolve => {
      let done = false, exitCode: number | undefined, exitSignal: string | undefined;
      let flush = () => {};
      const finish = (status: BatchResult['status'], reason?: string, code?: number, warning?: string) => {
        if (done) return; done = true; clearTimeout(timer);
        item.status = this.cancelled.has(job.id) ? 'cancelled' : status; item.error = reason; item.warning = warning; item.exitCode = code; item.duration = Date.now() - start;
        stop(r); resources.delete(r); this.publish(); resolve();
      };
      const complete = (reason?: string) => {
        if (done) return; flush();
        const result = batchCompletion(exitCode, exitSignal, !!item.output, reason);
        finish(result.status, result.error, result.exitCode, result.warning);
      };
      const timer = setTimeout(() => finish('error', `执行超时（${request.timeout} 秒）`), request.timeout * 1000);
      r.onFailure = complete;
      // Cancellation must settle workers even while waiting for authentication or exec.
      const cancelCheck = () => finish('cancelled', '任务已停止');
      r.onCancel = cancelCheck;
      void this.dial(item.profileId, r).then(client => {
        if (done || r.closed) return;
        client.exec(request.command, (err, stream) => {
          if (done || r.closed) { stream?.destroy(); return; }
          if (err) { finish('error', message(err)); return; }
          this.track(r, stream);
          const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
          const append = (value: string) => {
            if (done || !value) return;
            const total = job.results.reduce((sum, result) => sum + result.output.length, 0);
            const remaining = Math.min(128 * 1024 - item.output.length, 8 * 1024 * 1024 - total);
            if (remaining > 0) item.output += value.slice(0, remaining);
            if (value.length > remaining && !item.output.endsWith('\n[输出已截断]')) item.output += '\n[输出已截断]';
            this.schedulePublish();
          };
          stream.on('data', (data: Buffer) => append(stdout.write(data)));
          stream.stderr.on('data', (data: Buffer) => append(stderr.write(data)));
          let flushed = false;
          flush = () => { if (flushed) return; flushed = true; append(stdout.end()); append(stderr.end()); };
          stream.on('exit', (code: number | undefined, signal: string | undefined) => { exitCode = code; exitSignal = signal; });
          stream.on('error', (err: Error) => complete(message(err)));
          stream.once('close', (code: number | undefined, signal: string | undefined) => {
            exitCode ??= code; exitSignal ||= signal; complete();
          });
        });
      }).catch(err => finish('error', message(err)));
      // dial installs a handshake cancel callback asynchronously. It rejects its promise on cancel.
    });
  }
  cancelBatch(id: string) {
    const job = this.jobs.find(j => j.id === id); if (!job || job.status !== 'running') return;
    this.cancelled.add(id);
    for (const r of this.batchResources.get(id) || []) stop(r);
    for (const item of job.results) if (item.status === 'queued') item.status = 'cancelled';
    this.publish();
  }
  async closeProfile(id: string) {
    this.assertProfilesDeletable([id]);
    for (const s of this.sessions.values()) if (s.profileId === id) this.disconnect(s.id);
    await Promise.all(this.store.config().tunnels.filter(t => t.profileId === id).map(t => this.removeTunnel(t.id)));
  }
  assertProfilesDeletable(ids: string[]) {
    const selected = new Set(ids);
    if (this.jobs.some(j => j.status === 'running' && j.results.some(r => selected.has(r.profileId) && (r.status === 'queued' || r.status === 'running')))) throw new Error('选中连接正在执行批量任务，请先停止任务再删除');
  }
  activeCount() { return [...this.sessions.values()].filter(s => s.status === 'connected' || s.status === 'connecting').length + [...this.tunnelStates.values()].filter(t => t.status === 'starting' || t.status === 'running').length + this.jobs.filter(j => j.status === 'running').length; }
  dispose() {
    this.system.dispose();
    this.sftp.dispose();
    for (const r of this.sessionResources.values()) stop(r);
    for (const id of this.sessions.keys()) this.logs.finish(id, '软件退出');
    for (const r of this.tunnelResources.values()) stop(r);
    for (const job of this.jobs) this.cancelBatch(job.id);
    if (this.publishTimer) clearTimeout(this.publishTimer);
  }
  async flushLogs() { await this.logs.closeAll(); }
}
