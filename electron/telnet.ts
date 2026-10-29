// RFC 854 / 855, RFC 1073 (NAWS), RFC 1091 (terminal type).
// Parse negotiation independently of TCP packet boundaries. Never render IAC bytes.
const IAC = 255, WILL = 251, WONT = 252, DO = 253, DONT = 254, SB = 250, SE = 240;
const BINARY = 0, ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;
export const escapeIac = (data: Buffer) => Buffer.from([...data].flatMap(byte => byte === IAC ? [IAC, IAC] : [byte]));
export class TelnetCodec {
  private state: 'data' | 'iac' | 'option' | 'sub' | 'sub-iac' = 'data';
  private command = 0;
  private sub: number[] = [];
  private overflow = false;
  private pendingCr = false;
  private local = new Set<number>();
  private remote = new Set<number>();
  private cols = 100; private rows = 30;
  constructor(private send: (data: Buffer) => void, private output: (data: Buffer) => void) {}
  private subnegotiation(option: number, bytes: Buffer) { this.send(Buffer.concat([Buffer.from([IAC, SB, option]), escapeIac(bytes), Buffer.from([IAC, SE])])); }
  resize(cols: number, rows: number) {
    this.cols = cols; this.rows = rows;
    if (!this.local.has(NAWS)) return;
    const size = Buffer.alloc(4); size.writeUInt16BE(cols, 0); size.writeUInt16BE(rows, 2); this.subnegotiation(NAWS, size);
  }
  encode(data: Buffer) { return escapeIac(data); }
  private negotiate(option: number) {
    if (this.command === WILL) {
      if ([BINARY, ECHO, SGA].includes(option)) { if (!this.remote.has(option)) { this.remote.add(option); this.send(Buffer.from([IAC, DO, option])); } }
      else this.send(Buffer.from([IAC, DONT, option]));
    } else if (this.command === WONT) {
      if (this.remote.delete(option)) this.send(Buffer.from([IAC, DONT, option]));
    } else if (this.command === DO) {
      if ([BINARY, SGA, TTYPE, NAWS].includes(option)) {
        if (!this.local.has(option)) { this.local.add(option); this.send(Buffer.from([IAC, WILL, option])); if (option === NAWS) this.resize(this.cols, this.rows); }
      } else this.send(Buffer.from([IAC, WONT, option]));
    } else if (this.command === DONT && this.local.delete(option)) this.send(Buffer.from([IAC, WONT, option]));
  }
  feed(data: Buffer) {
    const plain: number[] = [];
    const application = (byte: number) => {
      if (!this.remote.has(BINARY) && this.pendingCr && byte === 0) { this.pendingCr = false; return; }
      this.pendingCr = byte === 13; plain.push(byte);
    };
    for (const byte of data) {
      if (this.state === 'data') { if (byte === IAC) this.state = 'iac'; else application(byte); }
      else if (this.state === 'iac') {
        if (byte === IAC) { application(byte); this.state = 'data'; }
        else if ([WILL, WONT, DO, DONT].includes(byte)) { this.command = byte; this.state = 'option'; }
        else if (byte === SB) { this.sub = []; this.overflow = false; this.state = 'sub'; }
        else this.state = 'data';
      } else if (this.state === 'option') { this.negotiate(byte); this.state = 'data'; }
      else if (this.state === 'sub') {
        if (byte === IAC) this.state = 'sub-iac';
        else if (this.sub.length < 4096) this.sub.push(byte); else this.overflow = true;
      } else {
        if (byte === SE) {
          if (!this.overflow && this.local.has(TTYPE) && this.sub[0] === TTYPE && this.sub[1] === 1) this.subnegotiation(TTYPE, Buffer.concat([Buffer.from([0]), Buffer.from('xterm-256color')]));
          this.sub = []; this.state = 'data';
        } else { if (this.sub.length < 4096) this.sub.push(byte); else this.overflow = true; this.state = 'sub'; }
      }
    }
    if (plain.length) this.output(Buffer.from(plain));
  }
}

export class TelnetLogin {
  private tail = '';
  private active = true;
  private usernameSent = false;
  private started = Date.now();
  constructor(private username: string, private password: string, private send: (text: string) => void) {}
  cancel() { this.active = false; this.tail = ''; this.username = ''; this.password = ''; }
  feed(text: string) {
    if (!this.active) return;
    if (Date.now() - this.started > 60_000) { this.cancel(); return; }
    this.tail = (this.tail + text).slice(-2048);
    const visible = this.tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x00/g, '');
    if (/(?:^|[\r\n])\s*(?:password|密码|口令)\s*[:：]\s*$/i.test(visible) && this.password) {
      const password = this.password; this.cancel(); this.send(password + '\r\n');
    } else if (!this.usernameSent && this.username && /(?:login|username|user name|用户名|登录名)\s*[:：]\s*$/i.test(visible)) {
      this.usernameSent = true; this.tail = ''; this.send(this.username + '\r\n');
    } else if (/(?:^|[\r\n])(?:[^\r\n]{0,120}[$#>]\s*|<[^\r\n]+>\s*)$/.test(visible)) this.cancel();
  }
}
