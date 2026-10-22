import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NetworkQueryJob, NetworkQueryRequest } from '../shared/types';
import { groupLabel, profileGroupPath } from '../shared/groups';
import { idSchema } from './validation';
import type { Store } from './store';
import { normalizeMac, type SnmpService } from './snmp';
import { ipv4 } from './ip-mib';

const schema = z.object({ profileIds: z.array(idSchema).min(1, '请选择已配置 SNMP 的设备').max(2000), kind: z.enum(['auto', 'arp', 'routes', 'ipInterfaces', 'mac']), query: z.string().trim().max(64) });
export function queryRequest(raw: unknown): NetworkQueryRequest {
  const request = schema.parse(raw); request.profileIds = [...new Set(request.profileIds)];
  if (request.kind === 'mac') request.query = normalizeMac(request.query);
  else if (request.kind === 'auto') {
    if (ipv4(request.query) === undefined) request.query = normalizeMac(request.query);
  } else if (request.query) {
    if (request.kind === 'routes') { if (ipv4(request.query) === undefined) throw new Error('路由查询请输入完整 IPv4 地址'); }
    else if (!/^\d{1,3}(\.\d{0,3}){0,3}$/.test(request.query) || request.query.split('.').some(part => Number(part) > 255)) throw new Error('请输入 IPv4 地址或地址片段，例如 172.23. 或 172.23.1.10');
  }
  if (request.profileIds.length > 1 && !request.query) throw new Error('全网查询请填写 IPv4 地址或 MAC，避免读取所有设备的完整表');
  return request;
}
export class NetworkQueryService {
  private jobs = new Map<string, { job: NetworkQueryJob; controller: AbortController }>();
  private disposed = false;
  constructor(private store: Store, private snmp: SnmpService) {}
  start(raw: unknown): string {
    if (this.disposed) throw new Error('网络查询服务已关闭');
    const request = queryRequest(raw);
    if ([...this.jobs.values()].some(item => item.job.status === 'running')) throw new Error('上一轮查询仍在执行，请先停止或等待完成');
    const devices = request.profileIds.map(id => {
      const profile = this.store.profile(id), target = this.store.config().snmp?.find(t => t.profileId === id);
      if (!target?.hasReadCommunity) throw new Error(`${profile.name} 尚未配置 SNMP 只读 Community`);
      return { profileId: id, name: profile.name, host: profile.host, group: groupLabel(profileGroupPath(profile)), status: 'queued' as const };
    });
    // Keep at most two bounded snapshots; credentials never enter a job.
    while (this.jobs.size >= 2) this.jobs.delete(this.jobs.keys().next().value!);
    const job: NetworkQueryJob = { id: randomUUID(), kind: request.kind, query: request.query, startedAt: Date.now(), status: 'running', devices };
    const controller = new AbortController(); this.jobs.set(job.id, { job, controller });
    void this.run(job, controller); return job.id;
  }
  private async run(job: NetworkQueryJob, controller: AbortController) {
    let cursor = 0, totalRows = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < job.devices.length) {
        const device = job.devices[cursor++]; device.status = 'running';
        try {
          const data = await this.snmp.query(device.profileId, job.kind, job.query, controller.signal);
          if (controller.signal.aborted) { device.status = 'cancelled'; continue; }
          const allowed = Math.max(0, 20000 - totalRows);
          if (data.rows.length > allowed) { data.rows = data.rows.slice(0, allowed); data.warnings.push('本轮命中超过 20000 条，结果已截断，请按分组缩小范围'); }
          totalRows += data.rows.length; device.data = data; device.status = 'done';
        } catch (error) {
          device.status = controller.signal.aborted ? 'cancelled' : 'error';
          if (!controller.signal.aborted) device.error = (error as Error).message;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, job.devices.length) }, worker));
    for (const device of job.devices) if (device.status === 'queued' || device.status === 'running') device.status = 'cancelled';
    job.status = controller.signal.aborted ? 'cancelled' : 'done'; job.finishedAt = Date.now();
  }
  read(id: string): NetworkQueryJob {
    const item = this.jobs.get(id); if (!item) throw new Error('查询记录已过期，请重新查询'); return structuredClone(item.job);
  }
  cancel(id: string) { this.jobs.get(id)?.controller.abort(); }
  pause() { for (const item of this.jobs.values()) if (item.job.status === 'running') item.controller.abort(); }
  dispose() { this.disposed = true; this.pause(); }
}
