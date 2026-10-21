import type { Socket } from 'node:net';
import type { Client } from 'ssh2';

// Incremental SOCKS5 parser. Only CONNECT with no authentication is exposed on loopback.
export function serveSocks(socket: Socket, client: Client, track: (stream: import('node:stream').Duplex) => void) {
  let pending: Buffer = Buffer.alloc(0);
  let phase: 'greeting' | 'request' | 'opening' = 'greeting';
  const fail = (code: number) => socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  socket.setTimeout(15_000, () => socket.destroy());
  const receive = (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    if (pending.length > 65536) return socket.destroy();
    if (phase === 'greeting') {
      if (pending.length < 2) return;
      if (pending[0] !== 5 || pending[1] === 0) return socket.destroy();
      const length = 2 + pending[1];
      if (pending.length < length) return;
      if (!pending.subarray(2, length).includes(0)) { socket.end(Buffer.from([5, 255])); return; }
      socket.write(Buffer.from([5, 0])); pending = pending.subarray(length); phase = 'request';
    }
    if (phase !== 'request' || pending.length < 4) return;
    if (pending[0] !== 5 || pending[2] !== 0) return socket.destroy();
    if (pending[1] !== 1) { fail(7); return; }
    let host: string; let end: number;
    const type = pending[3];
    if (type === 1) { end = 8; if (pending.length < end + 2) return; host = [...pending.subarray(4, 8)].join('.'); }
    else if (type === 3) {
      if (pending.length < 5) return;
      end = 5 + pending[4]; if (pending.length < end + 2) return;
      host = pending.subarray(5, end).toString('utf8'); if (!host || /[\s\x00-\x1f]/.test(host)) { fail(8); return; }
    } else if (type === 4) {
      end = 20; if (pending.length < end + 2) return;
      host = Array.from({ length: 8 }, (_, i) => pending.readUInt16BE(4 + i * 2).toString(16)).join(':');
    } else { fail(8); return; }
    const port = pending.readUInt16BE(end);
    if (!port) { fail(1); return; }
    phase = 'opening'; socket.pause(); socket.removeListener('data', receive);
    const remainder = pending.subarray(end + 2); pending = Buffer.alloc(0);
    try {
      client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, host, port, (err, stream) => {
        if (err) { fail(5); return; }
        if (socket.destroyed) { stream.destroy(); return; }
        track(stream); socket.setTimeout(0);
        stream.on('error', () => socket.destroy()); socket.once('close', () => stream.destroy()); stream.once('close', () => socket.destroy());
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (remainder.length) stream.write(remainder);
        socket.pipe(stream).pipe(socket); socket.resume();
      });
    } catch { fail(1); }
  };
  socket.on('data', receive);
}
