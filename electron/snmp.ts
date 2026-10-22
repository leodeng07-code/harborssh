import snmp, { type Session, type Varbind } from 'net-snmp';
import { isIP } from 'node:net';
import type { EventEmitter } from 'node:events';
import type { InterfaceSnapshot, InterfaceChange, InterfaceChangeResult, LldpSnapshot, MacLookup, MacMatch, NetworkInterface, ParameterDefinition } from '../shared/types';
import { Store } from './store';
import { interfaceChangeSchema } from './validation';
import { LLDP_OIDS, parseLldp } from './lldp';
import { readIpQuery } from './network-reader';
import type { NetworkQueryData, NetworkQueryKind } from '../shared/types';

export const OIDS = {
  sysName: '1.3.6.1.2.1.1.5.0', sysDescr: '1.3.6.1.2.1.1.1.0', objectId: '1.3.6.1.2.1.1.2.0',
  index: '1.3.6.1.2.1.2.2.1.1', description: '1.3.6.1.2.1.2.2.1.2', speed: '1.3.6.1.2.1.2.2.1.5', mac: '1.3.6.1.2.1.2.2.1.6',
  adminStatus: '1.3.6.1.2.1.2.2.1.7', operStatus: '1.3.6.1.2.1.2.2.1.8',
  name: '1.3.6.1.2.1.31.1.1.1.1', highSpeed: '1.3.6.1.2.1.31.1.1.1.15', alias: '1.3.6.1.2.1.31.1.1.1.18',
  bridgeIf: '1.3.6.1.2.1.17.1.4.1.2', fdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  qFdbPort: '1.3.6.1.2.1.17.7.1.2.2.1.2', vlanFdb: '1.3.6.1.2.1.17.7.1.4.2.1.3',
  pvid: '1.3.6.1.2.1.17.7.1.4.5.1.1', duplexStatus: '1.3.6.1.2.1.10.7.2.1.19',
};
const text = (v?: Varbind) => Buffer.isBuffer(v?.value) ? v.value.toString('utf8').replace(/\0+$/, '') : String(v?.value ?? '');
const number = (v?: Varbind) => typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : undefined;
const macText = (v?: Varbind) => Buffer.isBuffer(v?.value) ? [...v.value].map(n => n.toString(16).padStart(2, '0')).join(':').toUpperCase() : '';
export const defaultPvid: ParameterDefinition = { field: 'pvid', oid: OIDS.pvid, index: 'bridgePort', type: 'Unsigned32', choices: [] };
export function normalizeMac(value: string) {
  const input = value.trim();
  if (!/^(?:[\da-f]{12}|[\da-f]{2}(?::[\da-f]{2}){5}|[\da-f]{2}(?:-[\da-f]{2}){5}|[\da-f]{4}(?:\.[\da-f]{4}){2}|[\da-f]{4}(?:-[\da-f]{4}){2})$/i.test(input)) throw new Error('请输入有效的 MAC 地址，例如 AA:BB:CC:DD:EE:FF、aabb.ccdd.eeff 或 aabb-ccdd-eeff');
  return input.replace(/[:.\-]/g, '').toUpperCase().match(/../g)!.join(':');
}
// All requests are bounded, all sockets are closed, and transport errors never
// escape as unhandled EventEmitter errors. Never include communities in errors.
class Reader {
  private timer: NodeJS.Timeout;
  private closed = false;
  private failure?: Error;
  private pending = new Set<(error: Error) => void>();
  constructor(private session: Session) {
    (session as unknown as EventEmitter).on('error', () => this.abort(new Error('SNMP 网络连接错误')));
    this.timer = setTimeout(() => this.abort(new Error('SNMP 查询超过 45 秒，请检查设备、ACL 和 Community')), 45_000);
  }
  private abort(error: Error) { if (this.closed) return; this.failure = error; for (const reject of [...this.pending]) reject(error); this.close(); }
  private request<T>(invoke: (done: (error: Error | null, result?: T) => void) => void): Promise<T> {
    if (this.closed) return Promise.reject(this.failure || new Error('SNMP 会话已关闭'));
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => { this.pending.delete(fail); reject(error); };
      this.pending.add(fail);
      const done = (error: Error | null, result?: T) => { this.pending.delete(fail); if (error) reject(new Error('SNMP 请求失败，请检查设备支持情况、访问权限和网络：' + error.message.replace(/community\s*[:=].*/ig, '[已隐藏]'))); else resolve(result as T); };
      try { invoke(done); } catch { fail(new Error('SNMP 请求无法发送')); }
    });
  }
  get(oids: string[]) { return this.request<Varbind[]>(done => this.session.get(oids, (err, vars) => done(err, vars?.filter(v => !snmp.isVarbindError(v))))); }
  set(varbind: Varbind) { return this.request<Varbind[]>(done => this.session.set([varbind], (err, vars) => {
    const invalid = vars?.find(v => snmp.isVarbindError(v));
    done(err || (invalid ? new Error(snmp.varbindError(invalid)) : null), vars);
  })); }
  walk(oid: string) {
    return this.request<Varbind[]>(done => {
      const values: Varbind[] = []; let stopped = false;
      this.session.subtree(oid, 30, vars => {
        if (stopped || this.closed) return true;
        for (const v of vars) {
          if (!snmp.isVarbindError(v) && v.oid.startsWith(oid + '.')) values.push(v);
          if (values.length > 100_000) { stopped = true; done(new Error('表超过 100000 项，查询已停止，结果未标记为完整')); return true; }
        }
      }, error => { if (!stopped) done(error, values); });
    });
  }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.timer); for (const reject of [...this.pending]) reject(this.failure || new Error('SNMP 查询已关闭')); this.session.close(); }
}
export class SnmpService {
  private active = new Set<Reader>();
  private opening = 0;
  private writing = new Set<string>();
  private disposed = false;
  constructor(private store: Store) {}
  private definitions(id: string) {
    const custom = this.store.config().snmp?.find(t => t.profileId === id)?.parameters || [];
    return [defaultPvid, ...custom].filter((d, i, all) => !all.slice(i + 1).some(v => v.field === d.field));
  }
  private async use<T>(id: string, write: boolean, action: (reader: Reader) => Promise<T>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('SNMP 服务已关闭');
    if (this.opening + this.active.size >= 8) throw new Error('SNMP 查询较多，请稍后再试');
    this.opening++;
    let reader: Reader;
    try {
    const p = this.store.profile(id), target = this.store.config().snmp?.find(t => t.profileId === id);
    const secrets = await this.store.snmpSecrets(id), community = write ? secrets.writeCommunity : secrets.readCommunity;
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('SNMP 服务已关闭');
    if (!target || !community) throw new Error(write ? '请先单独配置读写 Community' : '请先配置 SNMP v2c 只读 Community');
    reader = new Reader(snmp.createSession(p.host, community, { port: target.port, version: snmp.Version2c, transport: isIP(p.host) === 6 ? 'udp6' : 'udp4', timeout: 1800, retries: write ? 0 : 1, backoff: 1 }));
    this.active.add(reader);
    } finally { this.opening--; }
    const cancel = () => reader.close(); signal?.addEventListener('abort', cancel, { once: true });
    try { signal?.throwIfAborted(); return await action(reader); } finally { signal?.removeEventListener('abort', cancel); reader.close(); this.active.delete(reader); }
  }
  private async column(reader: Reader, oid: string, label: string, warnings: string[], required = false) {
    try { const rows = await reader.walk(oid); if (!rows.length && !required) warnings.push(`${label} 未返回数据，可能不支持或无访问权限`); return rows; }
    catch (error) { if (required) throw error; warnings.push(`${label} 读取失败，结果可能不完整`); return []; }
  }
  async interfaces(id: string): Promise<InterfaceSnapshot> {
    return this.use(id, false, async reader => {
      const warnings: string[] = [], info = await reader.get([OIDS.sysName, OIDS.sysDescr, OIDS.objectId]);
      const indices = await this.column(reader, OIDS.index, '接口索引', warnings, true);
      if (!indices.length) throw new Error('设备未返回 IF-MIB 接口，可能不支持或无访问权限');
      const columns = new Map<string, Map<number, Varbind>>();
      const fields = ['description', 'name', 'alias', 'adminStatus', 'operStatus', 'speed', 'highSpeed', 'mac'] as const;
      // Four concurrent columns avoid serial waits on optional unsupported OIDs.
      for (let i = 0; i < fields.length; i += 4) await Promise.all(fields.slice(i, i + 4).map(async field => {
        const oid = OIDS[field], values = await this.column(reader, oid, field, warnings);
        columns.set(field, new Map(values.map(v => [Number(v.oid.slice(oid.length + 1)), v])));
      }));
      const [bridges, duplex] = await Promise.all([this.column(reader, OIDS.bridgeIf, '桥端口映射', warnings), this.column(reader, OIDS.duplexStatus, '双工状态', warnings)]);
      const parameterColumns = new Map<string, Map<number, Varbind>>(), definitions = this.definitions(id);
      for (const def of definitions) {
        const values = await this.column(reader, def.oid, def.field, warnings);
        parameterColumns.set(def.field, new Map(values.map(v => [Number(v.oid.slice(def.oid.length + 1)), v])));
      }
      const interfaces: NetworkInterface[] = indices.map(v => {
        const index = Number(v.oid.slice(OIDS.index.length + 1));
        const get = (field: string) => columns.get(field)?.get(index);
        const high = number(get('highSpeed')), speed = number(get('speed'));
        const bridgeRows = bridges.filter(row => number(row) === index);
        const bridgePort = bridgeRows.length === 1 ? Number(bridgeRows[0].oid.slice(OIDS.bridgeIf.length + 1)) : undefined;
        const parameters: NetworkInterface['parameters'] = {};
        for (const def of definitions) {
          const instance = def.index === 'ifIndex' ? index : bridgePort;
          const cell = instance === undefined ? undefined : parameterColumns.get(def.field)?.get(instance);
          if (cell) parameters[def.field] = (def.type === 'Integer' || def.type === 'Unsigned32') ? number(cell) : text(cell);
        }
        return { index, name: text(get('name')) || text(get('description')) || `ifIndex ${index}`, description: text(get('description')), alias: text(get('alias')), adminStatus: number(get('adminStatus')), operStatus: number(get('operStatus')), speedMbps: high && high > 0 ? high : speed !== undefined && speed !== 4294967295 ? speed / 1_000_000 : undefined, mac: macText(get('mac')), bridgePort, duplexStatus: number(duplex.find(row => row.oid === `${OIDS.duplexStatus}.${index}`)), parameters };
      }).filter(v => Number.isInteger(v.index) && v.index > 0).sort((a, b) => a.index - b.index);
      return { profileId: id, host: this.store.profile(id).host, name: text(info.find(v => v.oid === OIDS.sysName)), description: text(info.find(v => v.oid === OIDS.sysDescr)), objectId: text(info.find(v => v.oid === OIDS.objectId)), interfaces, warnings, readAt: Date.now() };
    });
  }
  async change(raw: InterfaceChange): Promise<InterfaceChangeResult> {
    const input = interfaceChangeSchema.parse(raw), key = `${input.profileId}:${input.index}`;
    if (this.writing.has(key)) throw new Error('此接口正在修改，请稍后刷新');
    this.writing.add(key);
    try { return await this.use(input.profileId, true, async reader => {
      const def = this.definitions(input.profileId).find(d => d.field === input.field);
      let instance = input.index;
      if (def?.index === 'bridgePort') {
        const candidates = (await reader.walk(OIDS.bridgeIf)).filter(v => number(v) === input.index);
        if (candidates.length !== 1) throw new Error('无法唯一映射桥端口，不能修改此参数');
        instance = Number(candidates[0].oid.slice(OIDS.bridgeIf.length + 1));
      }
      const standard = input.field === 'alias' || input.field === 'adminStatus';
      if (!standard && !def) throw new Error('此参数尚未配置可写 MIB 映射');
      if (def) {
        const valid = def.field === 'pvid' && !def.choices.length ? typeof input.value === 'number' && input.value >= 1 && input.value <= 4094 : def.choices.some(c => c.value === input.value);
        if (!valid) throw new Error('参数值不在此设备已适配的枚举范围内');
      }
      const oid = `${standard ? OIDS[input.field as 'alias' | 'adminStatus'] : def!.oid}.${instance}`;
      const type = input.field === 'alias' ? 'OctetString' : input.field === 'adminStatus' ? 'Integer' : def!.type;
      const before = (await reader.get([oid]))[0];
      if (!before) throw new Error('设备未返回该接口参数，不能执行修改');
      const read = (v: Varbind) => (type === 'Integer' || type === 'Unsigned32') ? number(v) : text(v);
      if (read(before) !== input.expected) throw new Error('接口参数已变化，请刷新后重新确认');
      try { await reader.set({ oid, type: snmp.ObjectType[type], value: input.value }); }
      catch { return { verified: false, message: '未确认 SET 结果，设备可能已执行。请刷新接口核对；检查读写权限，避免直接重复操作。' }; }
      try {
        const after = (await reader.get([oid]))[0];
        return after && read(after) === input.value ? { verified: true, message: '修改已生效，并已回读验证' } : { verified: false, message: 'SET 已应答，但回读值不一致，请刷新核对' };
      } catch { return { verified: false, message: 'SET 已应答，但回读失败，请刷新核对，避免直接重复操作' }; }
    }); } finally { this.writing.delete(key); }
  }
  async mac(id: string, input: string, signal?: AbortSignal): Promise<MacLookup> {
    const mac = normalizeMac(input), suffix = mac.split(':').map(v => parseInt(v, 16)).join('.');
    return this.use(id, false, async reader => {
      const warnings: string[] = [], matches: MacMatch[] = [];
      await reader.get([OIDS.sysName]);
      const qRows = await this.column(reader, OIDS.qFdbPort, 'Q-BRIDGE MAC 表', warnings);
      const classic = await this.column(reader, OIDS.fdbPort, 'BRIDGE MAC 表', warnings);
      signal?.throwIfAborted();
      const relevantQ = qRows.filter(v => v.oid.endsWith('.' + suffix) && number(v)! > 0);
      const relevantClassic = classic.filter(v => v.oid.slice(OIDS.fdbPort.length + 1) === suffix && number(v)! > 0);
      const vlanRows = relevantQ.length ? await this.column(reader, OIDS.vlanFdb, 'VLAN 与 FDB 对应表', warnings) : [];
      for (const [rows, root, source] of [[relevantQ, OIDS.qFdbPort, 'Q-BRIDGE'], [relevantClassic, OIDS.fdbPort, 'BRIDGE']] as const) for (const v of rows) {
        signal?.throwIfAborted();
        const bridgePort = number(v)!, index = v.oid.slice(root.length + 1).split('.').map(Number);
        if (index.length !== (source === 'Q-BRIDGE' ? 7 : 6)) continue;
        let entryStatus: number | undefined;
        try { entryStatus = number((await reader.get([`${root.slice(0, -1)}3.${index.join('.')}`]))[0]); }
        catch { warnings.push('MAC 条目状态读取失败'); }
        if (entryStatus === 2) continue; // Invalid rows can remain in an agent's FDB view.
        const fdbId = source === 'Q-BRIDGE' ? index[0] : undefined;
        const vlans = [...new Set(vlanRows.filter(row => number(row) === fdbId).map(row => Number(row.oid.split('.').at(-1))).filter(vlan => vlan >= 1 && vlan <= 4094))].sort((a, b) => a - b);
        let ifIndex: number | undefined, interfaceName = `桥端口 ${bridgePort}（未映射接口）`;
        try {
          ifIndex = number((await reader.get([`${OIDS.bridgeIf}.${bridgePort}`]))[0]);
          if (ifIndex) {
            const vars = await reader.get([`${OIDS.name}.${ifIndex}`, `${OIDS.description}.${ifIndex}`]);
            interfaceName = text(vars.find(v => v.oid === `${OIDS.name}.${ifIndex}`)) || text(vars.find(v => v.oid === `${OIDS.description}.${ifIndex}`)) || `ifIndex ${ifIndex}`;
          }
        } catch { warnings.push(`桥端口 ${bridgePort} 的接口映射读取失败`); }
        matches.push({ bridgePort, ifIndex, interfaceName, fdbId, vlans, source, entryStatus });
      }
      return { profileId: id, host: this.store.profile(id).host, mac, matches, warnings, readAt: Date.now(), available: !!(qRows.length || classic.length) };
    }, signal);
  }
  async query(id: string, kind: NetworkQueryKind, query: string, signal?: AbortSignal): Promise<NetworkQueryData> {
    const isMac = query.includes(':');
    if (kind !== 'mac' && !(kind === 'auto' && isMac)) return this.use(id, false, reader => readIpQuery(reader, kind, query, signal), signal);
    const fdb = async (): Promise<NetworkQueryData> => {
      const result = await this.mac(id, query, signal);
      return { available: !!result.available, readAt: result.readAt, warnings: result.warnings,
        rows: result.matches.map((row, index) => ({ key: `mac:${index}`, kind: 'mac', source: row.source, mac: result.mac, interfaceName: row.interfaceName, ifIndex: row.ifIndex, vlans: row.vlans, description: `桥端口 ${row.bridgePort}${row.fdbId === undefined ? '' : ` · FDB ${row.fdbId}`}` })) };
    };
    if (kind === 'mac') return fdb();
    const parts = await Promise.allSettled([this.use(id, false, reader => readIpQuery(reader, 'arp', query, signal), signal), fdb()]);
    signal?.throwIfAborted();
    if (parts.every(part => part.status === 'rejected')) throw (parts[0] as PromiseRejectedResult).reason;
    const data: NetworkQueryData = { rows: [], warnings: [], available: false, readAt: Date.now() };
    for (const [index, part] of parts.entries()) if (part.status === 'fulfilled') { data.rows.push(...part.value.rows); data.warnings.push(...part.value.warnings); data.available ||= part.value.available; }
    else data.warnings.push(`${index ? 'MAC 转发表' : 'ARP 表'}查询失败，其他命中已保留`);
    return data;
  }
  async lldp(id: string): Promise<LldpSnapshot> {
    return this.use(id, false, async reader => {
      const warnings: string[] = [];
      const optional = async (oid: string, label: string) => { try { return await reader.walk(oid); } catch { warnings.push(`${label} 读取失败，结果可能不完整`); return []; } };
      const [remote, local, management, identity] = await Promise.all([
        reader.walk(LLDP_OIDS.remote), optional(LLDP_OIDS.localPorts, 'LLDP 本地端口'), optional(LLDP_OIDS.management, 'LLDP 管理地址'),
        reader.get([LLDP_OIDS.localChassisSubtype, LLDP_OIDS.localName]).catch(() => { warnings.push('LLDP 本机标识读取失败'); return []; }),
      ]);
      const neighbors = parseLldp(remote, local, management, warnings);
      if (neighbors.length && !local.length) warnings.push('未取得 LLDP 本地端口标识，仅显示 LLDP 端口编号；此编号不等同于 ifIndex');
      return { profileId: id, host: this.store.profile(id).host, localName: text(identity.find(value => value.oid === LLDP_OIDS.localName)), available: !!(identity.length || remote.length || local.length), neighbors, warnings, readAt: Date.now() };
    });
  }
  dispose() { this.disposed = true; for (const reader of this.active) reader.close(); this.active.clear(); }
}
