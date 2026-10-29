import net from 'node:net';
import { Duplex } from 'node:stream';
import { SerialPort } from 'serialport';
import iconv from 'iconv-lite';
import type { Profile, SerialPortInfo } from '../shared/types';
import { defaultSerial } from '../shared/connections';
import { TelnetCodec, TelnetLogin } from './telnet';

export type SerialDevice = Duplex & { isOpen: boolean; open(callback: (error: Error | null) => void): void; close(callback?: (error: Error | null) => void): void; set(options: { brk: boolean }, callback: (error: Error | null) => void): void };
export type SerialFactory = (profile: Profile) => SerialDevice;
export const createSerial: SerialFactory = profile => {
  const s = { ...defaultSerial, ...profile.serial };
  return new SerialPort({ path: profile.host, baudRate: s.baudRate, dataBits: s.dataBits, stopBits: s.stopBits, parity: s.parity, rtscts: s.flowControl === 'hardware', xon: s.flowControl === 'software', xoff: s.flowControl === 'software', autoOpen: false, lock: true });
};
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try { return (await SerialPort.list()).map(port => ({ path: port.path, manufacturer: port.manufacturer, serialNumber: port.serialNumber, friendlyName: (port as typeof port & { friendlyName?: string }).friendlyName })).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })); }
  catch { throw new Error('无法枚举串口，请检查 USB 转串口驱动；也可手动填写 COM 端口'); }
}

// One stream contract lets existing terminal buffering, logs and lifecycle work
// for SSH, Telnet and serial. All native handles stay in the main process.
export class DeviceTerminal extends Duplex {
  private device?: SerialDevice;
  private socket?: net.Socket;
  private codec?: TelnetCodec;
  private login?: TelnetLogin;
  private decoder;
  private timeout?: NodeJS.Timeout;
  private breakTimer?: NodeJS.Timeout;
  private breakReject?: (error: Error) => void;
  private breakPending = false;
  private encoding: string;
  constructor(private profile: Profile, private ready: () => void, serialFactory: SerialFactory = createSerial, password = '') {
    super();
    this.encoding = profile.encoding || 'utf8'; this.decoder = iconv.getDecoder(this.encoding);
    this.timeout = setTimeout(() => this.destroy(new Error('连接超时，请检查地址、端口或串口驱动')), 15_000);
    // Open after callers have installed error/data/close listeners.
    queueMicrotask(() => {
      if (this.destroyed) return;
      try {
        if (profile.protocol === 'serial') {
          const port = this.device = serialFactory(profile);
          port.on('error', error => this.destroy(new Error(`串口 ${profile.host}：${error.message}`)));
          port.on('data', (data: Buffer) => this.receive(data));
          port.once('close', () => this.destroy());
          port.open(error => {
            if (this.destroyed) { if (port.isOpen) port.close(() => {}); return; }
            if (error) { this.destroy(new Error(`无法打开串口 ${profile.host}：${error.message}。请检查端口是否被占用、驱动及访问权限`)); return; }
            this.opened();
          });
        } else {
          this.socket = new net.Socket();
          this.codec = new TelnetCodec(data => this.socket?.write(data), data => this.receive(data));
          this.login = new TelnetLogin(profile.username, password, text => this.send(text)); password = '';
          this.socket.setNoDelay(true); this.socket.setKeepAlive(true, 15_000);
          this.socket.on('error', error => this.destroy(new Error(`Telnet 连接失败：${error.message}`)));
          this.socket.on('data', (data: Buffer) => this.codec!.feed(data));
          this.socket.once('close', () => this.destroy());
          this.socket.once('connect', () => this.opened());
          this.socket.connect(profile.port, profile.host);
        }
      } catch (error) { this.destroy(error as Error); }
    });
  }
  private opened() { clearTimeout(this.timeout); if (!this.destroyed) this.ready(); }
  private receive(data: Buffer) {
    const decoded = this.decoder.write(data);
    if (decoded) { if (!this.push(Buffer.from(decoded, 'utf8'))) { this.device?.pause(); this.socket?.pause(); } this.login?.feed(decoded); }
  }
  _read() { this.device?.resume(); this.socket?.resume(); }
  private send(text: string, done?: (error?: Error | null) => void) {
    const bytes = iconv.encode(text, this.encoding);
    const transport = this.device || this.socket;
    if (!transport || transport.destroyed || this.destroyed) { done?.(new Error('连接已关闭')); return; }
    transport.write(this.codec ? this.codec.encode(bytes) : bytes, done);
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.login?.cancel();
    const s = { ...defaultSerial, ...this.profile.serial }, text = chunk.toString('utf8');
    if (this.device && s.localEcho) this.push(Buffer.from(text.replace(/\r(?!\n)/g, '\r\n')));
    this.send(text.replace(/\r\n|\r|\n/g, this.codec || s.enterKey === 'crlf' ? '\r\n' : '\r'), callback);
  }
  setWindow(rows: number, cols: number, _height = 0, _width = 0) { this.codec?.resize(cols, rows); }
  async sendBreak(): Promise<void> {
    if (this.destroyed) throw new Error('连接已关闭');
    if (!this.device) { this.socket?.write(Buffer.from([255, 243])); return; }
    if (this.breakPending) throw new Error('正在发送 Break');
    this.breakPending = true;
    try { await new Promise<void>((resolve, reject) => {
      this.breakReject = reject;
      this.device!.set({ brk: true }, error => {
        if (this.destroyed) return;
        if (error) { reject(error); return; }
        this.breakTimer = setTimeout(() => this.device!.set({ brk: false }, error => error ? reject(error) : resolve()), 250);
      });
    }); } catch (error) { throw new Error(`发送串口 Break 失败，请确认驱动支持该控制信号：${(error as Error).message}`); }
    finally { this.breakPending = false; this.breakReject = undefined; clearTimeout(this.breakTimer); }
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearTimeout(this.timeout); clearTimeout(this.breakTimer); this.breakReject?.(new Error('连接已关闭')); this.login?.cancel();
    const tail = this.decoder.end(); if (tail) this.push(Buffer.from(tail));
    this.socket?.destroy();
    if (this.device?.isOpen) this.device.close(() => callback(error)); else callback(error);
  }
}
