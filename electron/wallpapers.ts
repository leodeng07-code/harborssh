import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { remoteWallpapers, type RemoteWallpaperSource } from '../shared/wallpapers';

export class WallpaperCache {
  private downloads = new Map<string, Promise<string>>();
  constructor(private directory: string, private fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch, private catalog: Record<string, RemoteWallpaperSource> = remoteWallpapers, private timeout = 20000) {}
  private valid(data: Buffer, source: RemoteWallpaperSource) {
    return data.length === source.bytes && data[0] === 0xff && data[1] === 0xd8 && createHash('sha256').update(data).digest('hex') === source.sha256;
  }
  private filename(id: string, source: RemoteWallpaperSource) { return path.join(this.directory, `${id}-${source.sha256.slice(0, 16)}.jpg`); }
  private async cached(id: string, source: RemoteWallpaperSource) {
    const file = this.filename(id, source);
    try {
      const stat = await fs.stat(file); if (!stat.isFile() || stat.size !== source.bytes) return null;
      const data = await fs.readFile(file); return this.valid(data, source) ? `data:image/jpeg;base64,${data.toString('base64')}` : null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async read(id: string, download: boolean): Promise<string | null> {
    if (!Object.hasOwn(this.catalog, id) || !/^[a-z0-9-]+$/.test(id)) throw new Error('未知的官方壁纸');
    const source = this.catalog[id], cached = await this.cached(id, source); if (cached || !download) return cached;
    const pending = this.downloads.get(id); if (pending) return pending;
    const task = this.download(id, source); this.downloads.set(id, task);
    try { return await task; } finally { this.downloads.delete(id); }
  }
  private async download(id: string, source: RemoteWallpaperSource) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeout); timer.unref();
    let temporary: string | undefined;
    try {
      const response = await this.fetcher(source.url, { signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`官方图片下载失败（HTTP ${response.status}），请稍后重试`);
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > source.bytes) throw new Error('官方图片大小已变化，请更新软件后重试');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = Buffer.concat(chunks);
      if (!this.valid(data, source)) throw new Error('官方图片校验未通过，请更新软件后重试');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = this.filename(id, source); temporary = `${filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, filename); temporary = undefined;
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('下载官方壁纸超时，请检查互联网连接后重试');
      throw new Error(`无法获取官方壁纸：${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
}
