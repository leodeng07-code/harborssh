import type { Profile, SerialSettings } from './types';

export const defaultSerial: SerialSettings = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', localEcho: false, enterKey: 'cr' };
export const protocolOf = (p: Pick<Profile, 'protocol'>) => p.protocol || 'ssh';
export const protocolLabel = (p: Pick<Profile, 'protocol'>) => ({ ssh: 'SSH', telnet: 'Telnet', serial: '串口' })[protocolOf(p)];
export function normalizedHost(host: string) {
  const value = host.trim().toLowerCase();
  try { return new URL(`http://${value.includes(':') && !value.startsWith('[') ? `[${value}]` : value}/`).hostname; } catch { return value; }
}
export const sameHost = (a: string, b: string) => normalizedHost(a) === normalizedHost(b);
export function connectionAddress(p: Profile) {
  if (protocolOf(p) === 'serial') { const s = { ...defaultSerial, ...p.serial }; return `${p.host} · ${s.baudRate} · ${s.dataBits}${s.parity === 'none' ? 'N' : s.parity[0].toUpperCase()}${s.stopBits}`; }
  return `${p.username ? `${p.username}@` : ''}${p.host}:${p.port}`;
}
