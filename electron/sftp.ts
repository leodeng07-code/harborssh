import type { Client, SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppEvent, FileTransfer, RemoteDirectory, RemoteFile } from '../shared/types';

const posix = path.posix;
const active = (t: FileTransfer) => ['queued', 'preparing', 'running'].includes(t.status);
export const remotePath = (value: string) => { if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('远程路径无效'); return value || '.'; };
export function remoteName(value: string) { if (!value || value === '.' || value === '..' || /[/\0]/.test(value) || Buffer.byteLength(value) > 255) throw new Error('名称不能为空，不能包含 /，或超过 255 字节'); return value; }
export function localName(value: string) {
  remoteName(value);
  if (/[<>:"\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error(`“${value}”不能作为 Windows 文件名，请先在远程重命名`);
  return value;
}
function failure(error: unknown) {
  const e = error as Error & { code?: number | string };
  if (e.code === 2 || e.code === 'ENOENT') return '文件或目录不存在';
  if (e.code === 3 || e.code === 'EACCES' || e.code === 'EPERM') return '权限不足';
  if (e.code === 'ENOSPC') return '磁盘空间不足';
  return e.message || String(error);
}
interface Job { info: FileTransfer; controller: AbortController; run: () => Promise<void> }
interface Plan { source: string; destination: string; directory: boolean; size: number }
export class SftpService {
  private channels = new Map<string, Promise<SFTPWrapper>>();
  private jobs = new Map<string, Job>();
  private running = 0;
  private eventTimers = new Map<string, NodeJS.Timeout>();
  constructor(private getClient: (id: string) => Client, private emit: (event: AppEvent) => void) {}
  transfers(id: string) { return structuredClone([...this.jobs.values()].map(j => j.info).filter(t => t.sessionId === id)); }
  private publish(id: string, immediate = false) {
    if (immediate) { clearTimeout(this.eventTimers.get(id)); this.eventTimers.delete(id); this.emit({ type: 'transfers', sessionId: id, data: this.transfers(id) }); }
    else if (!this.eventTimers.has(id)) this.eventTimers.set(id, setTimeout(() => { this.eventTimers.delete(id); this.emit({ type: 'transfers', sessionId: id, data: this.transfers(id) }); }, 150));
  }
  private closedChannels = new WeakSet<SFTPWrapper>();
  private openChannel(id: string): Promise<SFTPWrapper> {
    const client = this.getClient(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('开启 SFTP 超时，请确认服务器已启用 SFTP 子系统')), 20000);
      let settled = false;
      const closed = () => done(new Error('SSH 会话已关闭'));
      const done = (error?: Error, sftp?: SFTPWrapper) => {
        if (settled) { sftp?.end(); return; } settled = true; clearTimeout(timer); client.off('close', closed);
        if (error || !sftp) { reject(new Error(`无法开启 SFTP：${failure(error || new Error('子系统不可用'))}`)); return; }
        sftp.on('error', () => {}); sftp.once('close', () => this.closedChannels.add(sftp)); resolve(sftp);
      };
      client.once('close', closed); client.sftp((error, sftp) => done(error, sftp));
    });
  }
  private async channel(id: string): Promise<SFTPWrapper> {
    this.getClient(id);
    if (!this.channels.has(id)) {
      const opening = this.openChannel(id); this.channels.set(id, opening);
      void opening.then(sftp => sftp.once('close', () => { if (this.channels.get(id) === opening) this.channels.delete(id); })).catch(() => { if (this.channels.get(id) === opening) this.channels.delete(id); });
    }
    return this.channels.get(id)!;
  }
  private request<T>(sftp: SFTPWrapper, action: (done: (error?: Error | null, value?: T) => void) => void, signal?: AbortSignal, timeout = 30000): Promise<T> {
    if (this.closedChannels.has(sftp)) return Promise.reject(new Error('SFTP 通道已关闭'));
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error | null, value?: T) => { if (finished) return; finished = true; clearTimeout(timer); sftp.off('close', closed); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(value as T); };
      const closed = () => finish(new Error('SFTP 通道已关闭')), aborted = () => finish(signal?.reason || new Error('已取消传输'));
      const timer = setTimeout(() => finish(new Error('SFTP 操作超时')), timeout);
      sftp.once('close', closed); signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      try { action(finish); } catch (error) { finish(error as Error); }
    });
  }
  private async maybeStat(sftp: SFTPWrapper, filename: string, signal?: AbortSignal) {
    try { return await this.request<Stats>(sftp, done => sftp.lstat(filename, done), signal); }
    catch (error) { if ((error as { code?: number }).code === 2) return undefined; throw error; }
  }
  private async canonical(sftp: SFTPWrapper, value: string, signal?: AbortSignal) {
    value = remotePath(value);
    if (value === '~' || value.startsWith('~/')) { const home = await this.request<string>(sftp, done => sftp.realpath('.', done), signal); value = posix.join(home, value.slice(2)); }
    return this.request<string>(sftp, done => sftp.realpath(value, done), signal);
  }
  async list(id: string, directory: string): Promise<RemoteDirectory> {
    try {
      const sftp = await this.channel(id), resolved = await this.canonical(sftp, directory);
      const entries = await this.request<FileEntryWithStats[]>(sftp, done => sftp.readdir(resolved, done));
      if (entries.length > 20000) throw new Error('目录条目超过 20000 个，请进入更具体的目录');
      return { path: resolved, entries: entries.filter(e => e.filename !== '.' && e.filename !== '..').map(e => {
        remoteName(e.filename); const s = e.attrs;
        return { name: e.filename, path: posix.join(resolved, e.filename), type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'other', size: Number.isFinite(s.size) ? s.size : 0, modified: Number.isFinite(s.mtime) ? s.mtime * 1000 : 0, mode: s.mode || 0 } as RemoteFile;
      }).sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) };
    } catch (error) { throw new Error(failure(error)); }
  }
  async mkdir(id: string, directory: string, name: string) {
    const sftp = await this.channel(id), parent = await this.canonical(sftp, directory);
    await this.request<void>(sftp, done => sftp.mkdir(posix.join(parent, remoteName(name)), { mode: 0o755 }, done)).catch(e => { throw new Error(failure(e)); });
  }
  async rename(id: string, filename: string, name: string) {
    const sftp = await this.channel(id); filename = remotePath(filename); if (posix.normalize(filename) === '/') throw new Error('不能重命名根目录');
    const destination = posix.join(posix.dirname(filename), remoteName(name));
    if (destination === filename) return;
    if (await this.maybeStat(sftp, destination)) throw new Error('目标名称已存在');
    await this.request<void>(sftp, done => sftp.rename(filename, destination, done)).catch(e => { throw new Error(failure(e)); });
  }
  async remove(id: string, filenames: string[]) {
    const sftp = await this.channel(id), results: { path: string; error?: string }[] = [];
    for (let filename of filenames) {
      try {
        filename = remotePath(filename); if (['/', '.', '..'].includes(posix.normalize(filename))) throw new Error('不能删除根目录或当前目录');
        const stats = await this.request<Stats>(sftp, done => sftp.lstat(filename, done));
        await this.request<void>(sftp, done => stats.isDirectory() ? sftp.rmdir(filename, done) : sftp.unlink(filename, done)); results.push({ path: filename });
      } catch (error) { results.push({ path: filename, error: failure(error) }); }
    }
    return results;
  }
  private enqueue(id: string, source: string, destination: string, direction: 'upload' | 'download', overwrite: boolean) {
    const info: FileTransfer = { id: randomUUID(), sessionId: id, name: direction === 'upload' ? path.basename(source) : posix.basename(source), destination, direction, status: 'queued', bytes: 0, total: 0, files: 0, completed: 0 };
    const controller = new AbortController();
    const job: Job = { info, controller, run: () => this.transfer(job, source, destination, overwrite) };
    this.jobs.set(info.id, job); return info.id;
  }
  private capacity(count: number) { if (count < 1 || count > 100 || [...this.jobs.values()].filter(j => active(j.info)).length + count > 100) throw new Error('最多同时排队 100 个传输项目'); }
  async upload(id: string, sources: string[], directory: string, overwrite: boolean) {
    this.capacity(sources.length); const sftp = await this.channel(id), resolved = await this.canonical(sftp, directory);
    const names = new Set<string>();
    for (const source of sources) { const name = remoteName(path.basename(source)); if (names.has(name)) throw new Error('选择的本地项目存在同名文件，请分批上传'); names.add(name); }
    this.capacity(sources.length); sources.forEach(source => this.enqueue(id, source, posix.join(resolved, path.basename(source)), 'upload', overwrite)); this.prune(); this.publish(id, true); this.pump();
  }
  async download(id: string, sources: string[], directory: string, overwrite: boolean) {
    this.capacity(sources.length); this.getClient(id); const local = await fs.realpath(directory), names = new Set<string>();
    for (const source of sources) { const name = localName(posix.basename(remotePath(source))); if (names.has(name.toLocaleLowerCase())) throw new Error('选择的远程项目存在同名文件，请分批下载'); names.add(name.toLocaleLowerCase()); }
    this.capacity(sources.length); sources.forEach(source => this.enqueue(id, source, path.join(local, localName(posix.basename(source))), 'download', overwrite)); this.prune(); this.publish(id, true); this.pump();
  }
  private prune() { const finished = [...this.jobs.values()].filter(j => !active(j.info)); for (const j of finished.slice(0, Math.max(0, this.jobs.size - 200))) this.jobs.delete(j.info.id); }
  private pump() {
    while (this.running < 2) {
      const job = [...this.jobs.values()].find(j => j.info.status === 'queued'); if (!job) return;
      job.info.status = 'preparing'; this.running++; this.publish(job.info.sessionId, true);
      void job.run().then(() => { job.info.status = 'success'; }).catch(error => { job.info.status = job.controller.signal.aborted ? 'cancelled' : 'error'; job.info.message = failure(job.controller.signal.reason || error); }).finally(() => { this.running--; this.publish(job.info.sessionId, true); this.pump(); });
    }
  }
  private async transfer(job: Job, source: string, destination: string, overwrite: boolean) {
    const { info, controller } = job, signal = controller.signal, sftp = await this.openChannel(info.sessionId), plan: Plan[] = [];
    const inspect = async (src: string, dst: string, depth: number) => {
      signal.throwIfAborted(); if (depth > 32 || plan.length >= 10000) throw new Error('文件夹传输最多 32 层、10000 个条目，请分批传输');
      const stats = info.direction === 'upload' ? await fs.lstat(src) : await this.request<Stats>(sftp, done => sftp.lstat(src, done), signal);
      if (!stats.isFile() && !stats.isDirectory()) throw new Error('文件夹传输不跟随符号链接，也不支持特殊设备文件');
      plan.push({ source: src, destination: dst, directory: stats.isDirectory(), size: stats.size });
      if (stats.isFile()) { info.total += stats.size; info.files++; }
      else if (info.direction === 'upload') {
        for (const name of await fs.readdir(src)) { remoteName(name); await inspect(path.join(src, name), posix.join(dst, name), depth + 1); }
      } else {
        const seen = new Set<string>();
        for (const entry of await this.request<FileEntryWithStats[]>(sftp, done => sftp.readdir(src, done), signal)) {
          if (entry.filename === '.' || entry.filename === '..') continue; const name = localName(entry.filename), folded = name.toLocaleLowerCase();
          if (seen.has(folded)) throw new Error(`文件夹中有 Windows 无法区分的同名文件：${name}`); seen.add(folded);
          await inspect(posix.join(src, name), path.join(dst, name), depth + 1);
        }
      }
      this.publish(info.sessionId);
    };
    try {
    signal.throwIfAborted(); await inspect(source, destination, 0); signal.throwIfAborted(); info.status = 'running'; this.publish(info.sessionId, true);
    for (const item of plan) {
      signal.throwIfAborted();
      if (item.directory) {
        if (info.direction === 'upload') {
          const existing = await this.maybeStat(sftp, item.destination, signal);
          if (existing) { if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`目标不是普通目录：${item.destination}`); }
          else await this.request<void>(sftp, done => sftp.mkdir(item.destination, { mode: 0o755 }, done), signal);
        } else {
          try { const existing = await fs.lstat(item.destination); if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`目标不是普通目录：${item.destination}`); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') await fs.mkdir(item.destination, { mode: 0o700 }); else throw e; }
        }
      } else { await this.copyFile(job, sftp, item, overwrite); info.completed++; this.publish(info.sessionId); }
    }
    } finally { sftp.end(); }
  }
  private async copyFile(job: Job, sftp: SFTPWrapper, item: Plan, overwrite: boolean) {
    const { info, controller } = job, signal = controller.signal, uploading = info.direction === 'upload';
    const temporary = uploading ? posix.join(posix.dirname(item.destination), `.harbor-${info.id}.part`) : path.join(path.dirname(item.destination), `.harbor-${info.id}.part`);
    if (uploading) {
      const existing = await this.maybeStat(sftp, item.destination, signal);
      if (existing && (!overwrite || !existing.isFile())) throw new Error(`目标已存在${overwrite ? '且不是普通文件' : '，未勾选覆盖'}：${item.destination}`);
    } else {
      try { const existing = await fs.lstat(item.destination); if (!overwrite || !existing.isFile() || existing.isSymbolicLink()) throw new Error(`目标已存在${overwrite ? '且不是普通文件' : '，未勾选覆盖'}：${item.destination}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    let owned = false, remoteHandle: Buffer | undefined, localHandle: fs.FileHandle | undefined;
    try {
      signal.throwIfAborted();
      if (uploading) {
        localHandle = await fs.open(item.source, 'r');
        remoteHandle = await this.request<Buffer>(sftp, done => sftp.open(temporary, 'wx', 0o600, (error, handle) => { if (!error) { remoteHandle = handle; owned = true; } done(error, handle); }), undefined, 5000);
      } else {
        remoteHandle = await this.request<Buffer>(sftp, done => sftp.open(item.source, 'r', done), undefined, 5000);
        localHandle = await fs.open(temporary, 'wx', 0o600); owned = true;
      }
      const buffer = Buffer.alloc(128 * 1024); let position = 0;
      for (;;) {
        signal.throwIfAborted();
        const count = uploading ? (await localHandle.read(buffer, 0, buffer.length, position)).bytesRead : await this.request<number>(sftp, done => sftp.read(remoteHandle!, buffer, 0, buffer.length, position, (error, count) => done(error, count)), signal);
        if (!count) break;
        if (uploading) await this.request<void>(sftp, done => sftp.write(remoteHandle!, buffer, 0, count, position, done), signal);
        else { let offset = 0; while (offset < count) { const result = await localHandle.write(buffer, offset, count - offset, position + offset); if (!result.bytesWritten) throw new Error('本地文件写入失败'); offset += result.bytesWritten; } }
        position += count; info.bytes += count; this.publish(info.sessionId);
      }
      await localHandle.close(); localHandle = undefined;
      await this.request<void>(sftp, done => sftp.close(remoteHandle!, done), signal); remoteHandle = undefined;
      signal.throwIfAborted();
      if (uploading) {
        const existing = await this.maybeStat(sftp, item.destination, signal);
        if (existing && !overwrite) throw new Error(`目标已存在，原文件已保留：${item.destination}`);
        if (existing) {
          if (!existing.isFile()) throw new Error('覆盖目标不是普通文件');
          try { await this.request<void>(sftp, done => sftp.ext_openssh_rename(temporary, item.destination, done), signal); }
          catch (e) { throw new Error(`服务器不支持安全覆盖或无权限，原文件已保留：${failure(e)}`); }
        } else await this.request<void>(sftp, done => sftp.rename(temporary, item.destination, done), signal);
      } else if (overwrite) await fs.rename(temporary, item.destination);
      else { await fs.link(temporary, item.destination); await fs.unlink(temporary); }
      owned = false;
    } finally {
      await localHandle?.close().catch(() => {});
      if (remoteHandle) await this.request<void>(sftp, done => sftp.close(remoteHandle!, done), undefined, 2000).catch(() => {});
      if (owned) {
        if (uploading) await this.request<void>(sftp, done => sftp.unlink(temporary, done), undefined, 2000).catch(() => {});
        else await fs.unlink(temporary).catch(() => {});
      }
    }
  }

  cancel(id: string) {
    const job = this.jobs.get(id); if (!job || !active(job.info)) return;
    job.controller.abort(new Error('已取消传输'));
    job.info.status = 'cancelled'; job.info.message = '已取消传输'; this.publish(job.info.sessionId, true);
  }
  closeSession(id: string) {
    for (const job of this.jobs.values()) if (job.info.sessionId === id && active(job.info)) this.cancel(job.info.id);
    const channel = this.channels.get(id); this.channels.delete(id); void channel?.then(sftp => sftp.end()).catch(() => {});
    clearTimeout(this.eventTimers.get(id)); this.eventTimers.delete(id);
  }
  dispose() { for (const id of this.channels.keys()) this.closeSession(id); for (const job of this.jobs.values()) if (active(job.info)) this.cancel(job.info.id); }
}
