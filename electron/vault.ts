import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Cipher } from './store';

interface Envelope { version: 1; salt: string; wrappedKey: string }
const seal = (key: Buffer, text: string) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
};
const open = (key: Buffer, value: string) => {
  const bytes = Buffer.from(value, 'base64'); if (bytes.length < 28) throw new Error('无效密文');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
};
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export class Vault implements Cipher {
  private envelope?: Envelope;
  private key?: Buffer;
  private busy = false;
  private failures = 0;
  private retryAt = 0;
  constructor(private directory: string, private legacyDecrypt?: (value: string) => Promise<string>) {}
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.directory, 'vault.json'), 'utf8'));
      if (raw.version !== 1 || typeof raw.salt !== 'string' || Buffer.from(raw.salt, 'base64').length !== 32 || typeof raw.wrappedKey !== 'string') throw new Error('格式错误');
      this.envelope = raw;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('软件密码文件无法读取，请恢复完整配置备份'); }
  }
  status() { return { configured: !!this.envelope, unlocked: !!this.key }; }
  available() { return !!this.key; }
  private validate(password: string) { if (password.length < 8 || password.length > 256) throw new Error('软件密码须为 8–256 个字符'); }
  private async unwrap(password: string) {
    if (!this.envelope) throw new Error('请先设置软件密码');
    if (Date.now() < this.retryAt) throw new Error('尝试过于频繁，请稍后再试');
    const wrappingKey = await derive(password, Buffer.from(this.envelope.salt, 'base64'));
    try {
      const key = Buffer.from(open(wrappingKey, this.envelope.wrappedKey), 'base64'); if (key.length !== 32) throw new Error('密钥无效');
      this.failures = 0; this.retryAt = 0; return key;
    } catch { this.failures++; this.retryAt = Date.now() + Math.min(30000, this.failures >= 5 ? 5000 : 500); throw new Error('软件密码不正确'); }
    finally { wrappingKey.fill(0); }
  }
  private async writeEnvelope(password: string, key: Buffer) {
    const salt = randomBytes(32), wrappingKey = await derive(password, salt);
    try {
      const envelope: Envelope = { version: 1, salt: salt.toString('base64'), wrappedKey: seal(wrappingKey, key.toString('base64')) };
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = path.join(this.directory, 'vault.json');
      await fs.writeFile(`${filename}.tmp`, JSON.stringify(envelope), { mode: 0o600 }); await fs.rename(`${filename}.tmp`, filename);
      this.envelope = envelope;
    } finally { wrappingKey.fill(0); }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('正在处理软件密码，请稍候'); this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async setup(password: string) { return this.exclusive(async () => {
    if (this.envelope) throw new Error('已经设置软件密码'); this.validate(password);
    const key = randomBytes(32);
    try { await this.writeEnvelope(password, key); this.key = key; } catch (error) { key.fill(0); throw error; }
  }); }
  async unlock(password: string) { return this.exclusive(async () => {
    if (this.key) return; this.key = await this.unwrap(password);
  }); }
  async changePassword(current: string, next: string) { return this.exclusive(async () => {
    if (!this.key) throw new Error('软件尚未解锁'); this.validate(next);
    const verified = await this.unwrap(current);
    try { await this.writeEnvelope(next, verified); } finally { verified.fill(0); }
  }); }
  lock() { this.key?.fill(0); this.key = undefined; }
  async encrypt(value: string) { if (!this.key) throw new Error('软件尚未解锁'); return `vault:v1:${seal(this.key, value)}`; }
  async decrypt(value: string) {
    if (!this.key) throw new Error('软件尚未解锁');
    if (value.startsWith('vault:v1:')) return open(this.key, value.slice(9));
    if (this.legacyDecrypt) return this.legacyDecrypt(value);
    throw new Error('旧版凭据无法解密，请从 Excel 重新补充');
  }
}
