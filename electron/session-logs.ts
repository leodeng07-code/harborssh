import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Profile, TerminalLogInfo } from '../shared/types';

interface RecordLog {
  id: string; name: string; filename: string; handle?: FileHandle;
  tail: Promise<void>; queued: number; failed: boolean; finishing: boolean;
}
function timestamp(date = new Date()) {
  const n = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${n(date.getMonth() + 1)}-${n(date.getDate())}_${n(date.getHours())}-${n(date.getMinutes())}-${n(date.getSeconds())}-${n(date.getMilliseconds(), 3)}`;
}
export function logName(name: string) {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/, '') || 'SSH';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  let result = '';
  for (const char of safe) { if (Buffer.byteLength(result + char, 'utf8') > 140) break; result += char; }
  return result.replace(/[. ]+$/, '') || 'SSH';
}
export class SessionLogs {
  private records = new Map<string, RecordLog>();
  private pending = new Set<Promise<void>>();
  constructor(private changed: (id: string, info: TerminalLogInfo) => void) {}
  start(id: string, profile: Profile, directory: string) {
    const name = logName(profile.name);
    const filename = path.join(directory, `${name}_连接中_${timestamp()}_${id}.recording.log`);
    const record: RecordLog = { id, name, filename, tail: Promise.resolve(), queued: 0, failed: false, finishing: false };
    this.records.set(id, record);
    this.changed(id, { status: 'recording', path: filename });
    record.tail = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      record.handle = await fs.open(filename, 'wx', 0o600);
      await record.handle.writeFile(`Harbor SSH 终端日志\r\n连接名称：${profile.name.replace(/[\r\n]/g, ' ')}\r\n设备：${profile.host}:${profile.port}\r\n开始时间：${new Date().toISOString()}\r\n--- 远端终端输出 ---\r\n`);
    })().catch(error => this.fail(record, error));
  }
  private fail(record: RecordLog, error: unknown) {
    if (record.failed) return;
    record.failed = true;
    this.changed(record.id, { status: 'error', path: record.filename, message: `终端日志保存失败：${error instanceof Error ? error.message : String(error)}。请检查保存目录、权限及剩余空间；已写入的日志保留在原路径。` });
  }
  append(id: string, data: Buffer): Promise<void> | undefined {
    const record = this.records.get(id);
    if (!record || record.failed || record.finishing) return;
    const chunk = Buffer.from(data); record.queued += chunk.length;
    record.tail = record.tail.then(async () => {
      try { if (!record.failed) await record.handle!.writeFile(chunk); }
      finally { record.queued -= chunk.length; }
    }).catch(error => this.fail(record, error));
    // Pause SSH reads while the disk catches up, keeping the memory queue bounded.
    return record.queued >= 1024 * 1024 ? record.tail : undefined;
  }
  finish(id: string, reason: string, disconnectedAt = new Date()) {
    const record = this.records.get(id); if (!record || record.finishing) return;
    record.finishing = true;
    const finalPath = path.join(path.dirname(record.filename), `${record.name}_${timestamp(disconnectedAt)}_${id}.log`);
    const finish = record.tail.then(async () => {
      try {
        if (record.handle && !record.failed) {
          await record.handle.writeFile(`\r\n--- 会话结束 ---\r\n断开时间：${disconnectedAt.toISOString()}\r\n原因：${reason.replace(/[\r\n]/g, ' ')}\r\n`);
          await record.handle.sync();
        }
      } catch (error) { this.fail(record, error); }
      finally { try { await record.handle?.close(); } catch (error) { this.fail(record, error); } }
      if (!record.failed) {
        try {
          // Neither operation overwrites an existing log. The fallback supports
          // removable filesystems that do not implement hard links.
          try { await fs.link(record.filename, finalPath); }
          catch (error) {
            if (!['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
            await fs.copyFile(record.filename, finalPath, constants.COPYFILE_EXCL);
          }
          await fs.unlink(record.filename);
          record.filename = finalPath;
          this.changed(id, { status: 'saved', path: finalPath });
        } catch (error) { this.fail(record, error); }
      }
      this.records.delete(id);
    }).catch(error => this.fail(record, error));
    this.pending.add(finish); void finish.finally(() => this.pending.delete(finish));
  }
  async closeAll() {
    for (const id of this.records.keys()) this.finish(id, '软件退出');
    await Promise.all([...this.pending]);
  }
}
