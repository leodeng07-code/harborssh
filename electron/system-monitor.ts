import type { Client, ClientChannel } from 'ssh2';
import type { SystemMemory, SystemSnapshot } from '../shared/types';

export const SYSTEM_PROBE = 'uname -s';
// Fixed commands only. Never source os-release, interpolate profile data, use
// sudo, or write to the interactive shell. Local filesystems avoid NFS waits.
export const SYSTEM_SAMPLE = `LC_ALL=C; export LC_ALL
printf '__HARBOR_SYS_V1__\\n[host]\\n'; uname -n
printf '[kernel]\\n'; uname -r
printf '[release]\\n'; cat /etc/os-release 2>/dev/null
printf '[uptime]\\n'; cat /proc/uptime 2>/dev/null
printf '[load]\\n'; cat /proc/loadavg 2>/dev/null
printf '[cores]\\n'; getconf _NPROCESSORS_ONLN 2>/dev/null
printf '[cpu]\\n'; head -n 1 /proc/stat 2>/dev/null
printf '[memory]\\n'; cat /proc/meminfo 2>/dev/null
printf '[network]\\n'; cat /proc/net/dev 2>/dev/null
printf '[disk]\\n'; if command -v timeout >/dev/null 2>&1; then timeout 3 df -kP -l; else df -kP -l; fi 2>/dev/null
printf '[end]\\n'`;
export interface SystemSample { snapshot: SystemSnapshot; cpu?: number[] }
const number = (text: string | undefined) => text !== undefined && text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 ? Number(text) : undefined;
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 4096);
export function parseSystemSample(sessionId: string, output: string, previous?: SystemSample, readAt = Date.now()): SystemSample {
  if (!output.includes('__HARBOR_SYS_V1__\n') || !output.includes('[end]')) throw new Error('未取得完整的 Linux 状态数据');
  const sections = new Map<string, string[]>(); let key = '';
  for (const line of output.split(/\r?\n/)) {
    if (/^\[(host|kernel|release|uptime|load|cores|cpu|memory|network|disk|end)\]$/.test(line)) { key = line.slice(1, -1); sections.set(key, []); }
    else if (key) sections.get(key)!.push(line);
  }
  const text = (name: string) => (sections.get(name) || []).join('\n').trim();
  const warnings: string[] = [];
  const uptime = number(text('uptime').split(/\s+/)[0]);
  const load = text('load').split(/\s+/).slice(0, 3).map(number);
  const fields = text('cpu').trim().split(/\s+/);
  const cpu = fields[0] === 'cpu' && fields.length >= 5 ? fields.slice(1, 9).map(number) : [];
  const snapshot: SystemSnapshot = { sessionId, platform: 'linux', readAt, hostname: clean(text('host')), kernel: clean(text('kernel')), uptime, cores: number(text('cores')), load: load.length === 3 && load.every(v => v !== undefined) ? load as number[] : undefined, disks: [], networks: [], warnings };
  const pretty = sections.get('release')?.find(line => line.startsWith('PRETTY_NAME='))?.slice(12).trim();
  snapshot.release = pretty ? clean(pretty.replace(/^(["'])(.*)\1$/, '$2').replace(/\\(["\\$`])/g, '$1')) : 'Linux';
  const validCpu = cpu.length >= 4 && cpu.every(v => Number.isSafeInteger(v)) ? cpu as number[] : undefined;
  const sameBoot = uptime !== undefined && previous?.snapshot.uptime !== undefined && uptime > previous.snapshot.uptime;
  if (sameBoot && validCpu && previous?.cpu?.length === validCpu.length) {
    const delta = validCpu.map((value, i) => value - previous.cpu![i]);
    const total = delta.reduce((sum, value) => sum + value, 0);
    if (total > 0 && delta.every(value => value >= 0)) snapshot.cpuPercent = clamp((total - delta[3] - (delta[4] || 0)) / total * 100, 100);
  }
  const memory = new Map((sections.get('memory') || []).flatMap(line => { const match = /^(\w+):\s+(\d+)\s+kB\s*$/.exec(line); const value = match ? Number(match[2]) * 1024 : NaN; return match && Number.isSafeInteger(value) ? [[match[1], value] as const] : []; }));
  const usage = (total?: number, available?: number, estimated = false): SystemMemory | undefined => total !== undefined && available !== undefined ? { total, available: clamp(available, total), used: total - clamp(available, total), percent: total ? (total - clamp(available, total)) / total * 100 : 0, estimated } : undefined;
  const estimated = !memory.has('MemAvailable');
  const available = estimated && memory.has('MemFree') ? memory.get('MemFree')! + (memory.get('Buffers') || 0) + (memory.get('Cached') || 0) + (memory.get('SReclaimable') || 0) - (memory.get('Shmem') || 0) : memory.get('MemAvailable');
  snapshot.memory = usage(memory.get('MemTotal'), available, estimated); snapshot.swap = usage(memory.get('SwapTotal'), memory.get('SwapFree'));
  for (const line of sections.get('network') || []) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line); if (!match) continue;
    const counters = match[2].trim().split(/\s+/).map(number), name = clean(match[1].trim());
    if (!name || counters.length < 16 || !Number.isSafeInteger(counters[0]) || !Number.isSafeInteger(counters[8])) continue;
    const received = counters[0]!, sent = counters[8]!, before = previous?.snapshot.networks.find(row => row.name === name);
    const seconds = sameBoot ? uptime! - previous!.snapshot.uptime! : 0;
    snapshot.networks.push({ name, received, sent, receiveRate: seconds && before && received >= before.received ? (received - before.received) / seconds : undefined, sendRate: seconds && before && sent >= before.sent ? (sent - before.sent) / seconds : undefined });
    if (snapshot.networks.length === 256) { warnings.push('网络接口超过 256 个，仅显示前 256 个'); break; }
  }
  for (const line of sections.get('disk') || []) {
    const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line); if (!match) continue;
    const total = Number(match[2]) * 1024, used = Number(match[3]) * 1024, available = Number(match[4]) * 1024;
    if (![total, used, available].every(Number.isSafeInteger) || !total) continue;
    snapshot.disks.push({ device: clean(match[1]), total, used, available, percent: Number(match[5]), mount: clean(match[6].replace(/\\(040|011|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))) });
    if (snapshot.disks.length === 128) { warnings.push('挂载点超过 128 个，仅显示前 128 个'); break; }
  }
  if (!validCpu) warnings.push('CPU 计数未返回'); if (!snapshot.memory) warnings.push('内存数据未返回');
  if (!snapshot.disks.length) warnings.push('磁盘数据未返回，可能缺少 df、访问受限或查询超时');
  if (!snapshot.networks.length) warnings.push('网卡数据未返回');
  return { snapshot, cpu: validCpu };
}

interface MonitorState { sample?: SystemSample; value?: SystemSnapshot; pending?: Promise<SystemSnapshot>; cancel?: () => void; closed: boolean }
export class SystemMonitor {
  private states = new Map<string, MonitorState>();
  private active = 0;
  constructor(private client: (id: string) => Client, private timeout = 8000) {}
  read(id: string): Promise<SystemSnapshot> {
    const client = this.client(id);
    let state = this.states.get(id); if (!state) { state = { closed: false }; this.states.set(id, state); }
    if (state.pending) return state.pending;
    if (state.value && (state.value.platform === 'unsupported' || Date.now() - state.value.readAt < 2000)) return Promise.resolve(structuredClone(state.value));
    if (this.active >= 8) return Promise.reject(new Error('状态查询繁忙，请稍后重试'));
    this.active++;
    const current = state;
    current.pending = this.collect(id, client, current).finally(() => { current.pending = undefined; this.active--; });
    return current.pending;
  }
  private async collect(id: string, client: Client, state: MonitorState) {
    if (!state.sample) {
      const probe = await this.exec(client, state, SYSTEM_PROBE);
      if (probe.code !== 0 || probe.output.trim() !== 'Linux') {
        state.value = { sessionId: id, platform: 'unsupported', reason: '未识别为 Linux，或服务器未开放 SSH 命令执行通道', readAt: Date.now(), disks: [], networks: [], warnings: [] };
        return structuredClone(state.value);
      }
    }
    const result = await this.exec(client, state, SYSTEM_SAMPLE);
    if (state.closed) throw new Error('SSH 会话已断开');
    if (result.code !== 0) throw new Error('Linux 状态采集失败，请检查账号权限和 /proc 可用性');
    state.sample = parseSystemSample(id, result.output, state.sample); state.value = state.sample.snapshot;
    return structuredClone(state.value);
  }
  private exec(client: Client, state: MonitorState, command: string): Promise<{ output: string; code?: number }> {
    return new Promise((resolve, reject) => {
      let done = false, channel: ClientChannel | undefined, size = 0, code: number | undefined; const chunks: Buffer[] = [];
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); state.cancel = undefined; channel?.close(); error ? reject(error) : resolve({ output: Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n'), code }); };
      const timer = setTimeout(() => finish(new Error('Linux 状态查询超时，可稍后重试')), this.timeout);
      state.cancel = () => finish(new Error('SSH 会话已断开'));
      if (state.closed) { state.cancel(); return; }
      try {
        client.exec(command, (error, stream) => {
          if (done || state.closed) { stream?.on('error', () => {}); stream?.close(); return; }
          if (error) { if (command === SYSTEM_PROBE) { code = 1; finish(); } else finish(new Error('服务器拒绝状态查询通道，可继续使用终端')); return; }
          channel = stream; stream.on('error', () => finish(new Error('Linux 状态查询通道异常')));
          stream.on('data', (data: Buffer) => { size += data.length; if (size > 256 * 1024) finish(new Error('Linux 状态输出超过 256 KB，已停止本次查询')); else chunks.push(Buffer.from(data)); });
          stream.stderr.on('data', () => {});
          stream.on('exit', (value: number | undefined) => { code = value; });
          stream.once('close', (value?: number) => { code ??= value; finish(); });
        });
      } catch { finish(new Error('无法创建 Linux 状态查询通道')); }
    });
  }
  closeSession(id: string) { const state = this.states.get(id); if (state) { state.closed = true; state.cancel?.(); this.states.delete(id); } }
  dispose() { for (const id of this.states.keys()) this.closeSession(id); }
}
