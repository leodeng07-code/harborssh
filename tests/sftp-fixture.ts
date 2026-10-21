import type { Session } from 'ssh2';
import ssh2 from 'ssh2';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

export interface SftpFixtureOptions { root: string; writeDelay?: number; deny?: string; channels?: { count: number }; singleSession?: boolean }
export function attachSftp(session: Session, options: SftpFixtureOptions) {
  session.on('sftp', accept => {
    options.channels && options.channels.count++; const s = accept();
    const handles = new Map<string, { file?: fs.FileHandle; directory?: string; listed?: boolean }>(); let serial = 0; let closed = false;
    const stats = (v: Stats) => ({ mode: v.mode, uid: v.uid, gid: v.gid, size: v.size, atime: Math.floor(v.atimeMs / 1000), mtime: Math.floor(v.mtimeMs / 1000) });
    const resolve = (name: string) => { if (options.deny && name.includes(options.deny)) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); const relative = path.posix.resolve('/', name === '.' ? '/' : name); return path.join(options.root, relative); };
    const fail = (id: number, error: unknown) => { if (closed) return; const code = (error as NodeJS.ErrnoException).code; s.status(id, code === 'ENOENT' ? ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE : code === 'EACCES' ? ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED : ssh2.utils.sftp.STATUS_CODE.FAILURE, (error as Error).message); };
    const wrap = (fn: (id: number, ...args: any[]) => Promise<void>) => (id: number, ...args: any[]) => { void fn(id, ...args).catch(error => fail(id, error)); };
    const handle = (id: number, value: { file?: fs.FileHandle; directory?: string }) => { const b = Buffer.from(String(++serial)); handles.set(b.toString(), value); s.handle(id, b); };
    const get = (b: Buffer) => { const value = handles.get(b.toString()); if (!value) throw new Error('Invalid handle'); return value; };
    s.on('REALPATH', wrap(async (id, name: string) => { const absolute = await fs.realpath(resolve(name)); const relative = '/' + path.relative(options.root, absolute).split(path.sep).join('/'); s.name(id, [{ filename: relative, longname: relative, attrs: stats(await fs.stat(absolute)) }]); }));
    s.on('STAT', wrap(async (id, name) => s.attrs(id, stats(await fs.stat(resolve(name))))));
    s.on('LSTAT', wrap(async (id, name) => s.attrs(id, stats(await fs.lstat(resolve(name))))));
    s.on('FSTAT', wrap(async (id, b: Buffer) => s.attrs(id, stats(await get(b).file!.stat()))));
    s.on('OPENDIR', wrap(async (id, name: string) => { const directory = resolve(name); if (!(await fs.stat(directory)).isDirectory()) throw new Error('Not directory'); handle(id, { directory }); }));
    s.on('READDIR', wrap(async (id, b: Buffer) => { const h = get(b); if (h.listed) { s.status(id, ssh2.utils.sftp.STATUS_CODE.EOF); return; } h.listed = true;
      const names = await fs.readdir(h.directory!); if (!names.length) { s.status(id, ssh2.utils.sftp.STATUS_CODE.EOF); return; }
      s.name(id, await Promise.all(names.map(async filename => ({ filename, longname: filename, attrs: stats(await fs.lstat(path.join(h.directory!, filename))) }))));
    }));
    s.on('OPEN', wrap(async (id, name: string, flags: number, attrs: { mode?: number }) => { const file = await fs.open(resolve(name), ssh2.utils.sftp.flagsToString(flags) || 'r', attrs.mode || 0o600); if (closed) { await file.close(); return; } handle(id, { file }); }));
    s.on('READ', wrap(async (id, b: Buffer, offset: number, length: number) => { const data = Buffer.alloc(Math.min(length, 128 * 1024)); const { bytesRead } = await get(b).file!.read(data, 0, data.length, offset); if (bytesRead) s.data(id, data.subarray(0, bytesRead)); else s.status(id, ssh2.utils.sftp.STATUS_CODE.EOF); }));
    s.on('WRITE', wrap(async (id, b: Buffer, offset: number, data: Buffer) => { const file = get(b).file!; if (options.writeDelay) await new Promise(resolve => setTimeout(resolve, options.writeDelay)); if (closed) return; await file.write(data, 0, data.length, offset); s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('CLOSE', wrap(async (id, b: Buffer) => { const h = get(b); handles.delete(b.toString()); await h.file?.close(); if (!closed) s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('MKDIR', wrap(async (id, name: string, attrs: { mode?: number }) => { await fs.mkdir(resolve(name), { mode: attrs.mode || 0o755 }); s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('RMDIR', wrap(async (id, name: string) => { await fs.rmdir(resolve(name)); s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('REMOVE', wrap(async (id, name: string) => { await fs.unlink(resolve(name)); s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('RENAME', wrap(async (id, source: string, destination: string) => { try { await fs.lstat(resolve(destination)); throw new Error('Destination exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await fs.rename(resolve(source), resolve(destination)); s.status(id, ssh2.utils.sftp.STATUS_CODE.OK); }));
    s.on('close', () => { closed = true; for (const h of handles.values()) void h.file?.close().catch(() => {}); handles.clear(); });
  });
}
