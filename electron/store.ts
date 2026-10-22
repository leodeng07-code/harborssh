import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config, Profile, ProfileInput, Secrets, Tunnel, SnmpConfigInput, SnmpTarget, BatchSnmpConfigInput } from '../shared/types';
import { profileSchema, tunnelSchema, snmpConfigSchema, snmpTargetSchema, batchSnmpConfigSchema } from './validation';

export interface Cipher { available(): boolean; encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
interface DiskState { version: 1; profiles: Profile[]; tunnels: Tunnel[]; credentials: Record<string, string>; knownHosts: Record<string, string>; snmpTargets?: SnmpTarget[]; snmpCredentials?: Record<string, string>; terminalLogDirectory?: string }
export class Store {
  private state: DiskState = { version: 1, profiles: [], tunnels: [], credentials: {}, knownHosts: {} };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private cipher: Cipher) {}
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.directory, 'config.json'), 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.profiles) || !Array.isArray(raw.tunnels)) throw new Error('配置文件格式错误');
      this.state = {
        version: 1, profiles: raw.profiles.map((p: unknown) => profileSchema.parse(p)), tunnels: raw.tunnels.map((t: unknown) => tunnelSchema.parse(t)),
        credentials: this.stringRecord(raw.credentials), knownHosts: this.stringRecord(raw.knownHosts),
        snmpTargets: (raw.snmpTargets || []).map((v: unknown) => snmpTargetSchema.parse(v)), snmpCredentials: this.stringRecord(raw.snmpCredentials),
        terminalLogDirectory: typeof raw.terminalLogDirectory === 'string' && path.isAbsolute(raw.terminalLogDirectory) ? raw.terminalLogDirectory : undefined,
      };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取配置，请先备份 ${this.directory}：${(e as Error).message}`); }
  }
  private stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => typeof v === 'string' && k !== '__proto__'));
  }
  config(): Config {
    return structuredClone({
      profiles: this.state.profiles.map(p => ({ ...p, hasSecret: !!this.state.credentials[p.id], rememberSecret: true })),
      tunnels: this.state.tunnels,
      snmp: this.state.snmpTargets || [],
      terminalLogDirectory: this.state.terminalLogDirectory || path.join(this.directory, 'logs'),
    });
  }
  profile(id: string) { const p = this.config().profiles.find(p => p.id === id); if (!p) throw new Error('连接不存在'); return p; }
  async saveLogDirectory(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('请选择绝对路径的日志目录');
    await this.mutate(next => { next.terminalLogDirectory = path.resolve(directory); }); return this.config();
  }
  tunnel(id: string) { const t = this.state.tunnels.find(t => t.id === id); if (!t) throw new Error('隧道不存在'); return structuredClone(t); }
  async secrets(id: string): Promise<Secrets> {
    const encrypted = this.state.credentials[id];
    if (!encrypted) return {};
    try { return JSON.parse(await this.cipher.decrypt(encrypted)); }
    catch { throw new Error('凭据无法解密，请编辑连接并重新输入密码或私钥口令'); }
  }
  async snmpSecrets(id: string): Promise<{ readCommunity?: string; writeCommunity?: string }> {
    this.profile(id);
    const value = this.state.snmpCredentials?.[id];
    if (!value) return {};
    try { return JSON.parse(await this.cipher.decrypt(value)); }
    catch { throw new Error('SNMP 凭据无法解密，请重新填写 Community'); }
  }
  async saveSnmp(raw: SnmpConfigInput) {
    const input = snmpConfigSchema.parse(raw);
    await this.mutate(next => this.applySnmp(next, input)); return this.config();
  }
  async saveSnmpBatch(raw: BatchSnmpConfigInput) {
    const input = batchSnmpConfigSchema.parse(raw);
    await this.mutate(async next => {
      for (const profileId of input.profileIds) {
        const port = input.port ?? next.snmpTargets?.find(t => t.profileId === profileId)?.port ?? 161;
        await this.applySnmp(next, { profileId, port, readCommunity: input.readCommunity, writeCommunity: input.writeCommunity, clearWrite: input.clearWrite });
      }
    }); return this.config();
  }
  private async applySnmp(next: DiskState, input: SnmpConfigInput) {
    if (!next.profiles.some(p => p.id === input.profileId)) throw new Error('连接不存在');
    const current = next.snmpCredentials?.[input.profileId];
    const secrets = current ? JSON.parse(await this.cipher.decrypt(current)) : {};
    if (input.readCommunity !== undefined) secrets.readCommunity = input.readCommunity;
    if (input.clearWrite) delete secrets.writeCommunity;
    else if (input.writeCommunity !== undefined) secrets.writeCommunity = input.writeCommunity;
    if (!secrets.readCommunity) throw new Error('请填写只读 Community');
    next.snmpCredentials ||= {};
    next.snmpCredentials[input.profileId] = await this.cipher.encrypt(JSON.stringify(secrets));
    const previous = next.snmpTargets?.find(t => t.profileId === input.profileId);
    const target = { profileId: input.profileId, port: input.port, hasReadCommunity: true, hasWriteCommunity: !!secrets.writeCommunity, parameters: input.parameters ?? previous?.parameters ?? [] };
    next.snmpTargets = [...(next.snmpTargets || []).filter(t => t.profileId !== input.profileId), target];
  }
  private mutate(fn: (next: DiskState) => Promise<void> | void) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      await fn(next);
      const filename = path.join(this.directory, 'config.json');
      const temp = `${filename}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temp, filename);
      this.state = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async applyProfile(next: DiskState, input: ProfileInput) {
    const p = profileSchema.parse(input.profile);
    const old = next.profiles.find(v => v.id === p.id);
    let secret: Secrets = {};
    if (!input.clearSecret && old?.authType === p.authType) {
      if (next.credentials[p.id]) {
        try { secret = JSON.parse(await this.cipher.decrypt(next.credentials[p.id])); }
        catch { if (!input.secrets?.password && !input.secrets?.passphrase) throw new Error('原凭据无法解密，请重新输入或清除凭据'); }
      }
    }
    if (p.authType === 'password' && input.secrets?.password) secret.password = input.secrets.password;
    if (p.authType === 'key' && input.secrets?.passphrase) secret.passphrase = input.secrets.passphrase;
    if (p.authType === 'agent') secret = {};
    const hasSecret = !!secret.password || !!secret.passphrase;
    delete next.credentials[p.id];
    if (hasSecret) {
      if (!this.cipher.available()) throw new Error('凭据库尚未解锁，请使用软件密码登录');
      next.credentials[p.id] = await this.cipher.encrypt(JSON.stringify(secret));
    }
    const saved = { ...p, hasSecret: false, rememberSecret: true };
    const index = next.profiles.findIndex(v => v.id === p.id);
    if (index < 0) next.profiles.push(saved); else next.profiles[index] = saved;
  }
  async saveProfile(input: ProfileInput) { await this.mutate(next => this.applyProfile(next, input)); return this.config(); }
  async importProfiles(inputs: ProfileInput[] | ((config: Config) => ProfileInput[])) {
    await this.mutate(async next => { const selected = typeof inputs === 'function' ? inputs(this.config()) : inputs; for (const input of selected) await this.applyProfile(next, input); });
    return this.config();
  }
  async deleteProfile(id: string) {
    return this.deleteProfiles([id]);
  }
  async deleteProfiles(ids: string[]) {
    const selected = new Set(ids);
    await this.mutate(next => {
      next.profiles = next.profiles.filter(p => !selected.has(p.id)); next.tunnels = next.tunnels.filter(t => !selected.has(t.profileId));
      for (const id of selected) delete next.credentials[id];
      next.snmpTargets = next.snmpTargets?.filter(t => !selected.has(t.profileId));
      for (const id of selected) if (next.snmpCredentials) delete next.snmpCredentials[id];
    }); return this.config();
  }
  async saveTunnel(tunnel: Tunnel) {
    this.profile(tunnel.profileId);
    await this.mutate(next => { const index = next.tunnels.findIndex(t => t.id === tunnel.id); if (index < 0) next.tunnels.push(tunnel); else next.tunnels[index] = tunnel; });
    return this.config();
  }
  async deleteTunnel(id: string) { await this.mutate(next => { next.tunnels = next.tunnels.filter(t => t.id !== id); }); return this.config(); }
  knownHost(endpoint: string) { return this.state.knownHosts[endpoint]; }
  async migrateCredentials() {
    if (!Object.values(this.state.credentials).some(value => !value.startsWith('vault:v1:'))) return;
    await this.mutate(async next => {
      for (const [id, value] of Object.entries(next.credentials)) {
        if (value.startsWith('vault:v1:')) continue;
        // Keep unreadable legacy ciphertext for recovery rather than deleting it.
        try { next.credentials[id] = await this.cipher.encrypt(await this.cipher.decrypt(value)); } catch {}
      }
    });
  }
  async trustHost(endpoint: string, fingerprint: string) { await this.mutate(next => {
    if (next.knownHosts[endpoint] && next.knownHosts[endpoint] !== fingerprint) throw new Error('主机指纹与已信任记录不一致');
    next.knownHosts[endpoint] = fingerprint;
  }); }
  async forgetHost(endpoint: string) { await this.mutate(next => { delete next.knownHosts[endpoint]; }); }
}
