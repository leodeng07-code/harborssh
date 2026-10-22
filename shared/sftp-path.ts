// Device storage volumes (flash:/, hda1:/, slot1#flash:/) are absolute SFTP
// paths. Keep their prefixes; POSIX normalization can discard them at /.. .
const volume = (value: string) => /^([a-z\d_.#-]+:)(?=\/|$)/i.exec(value)?.[1];
export const absoluteRemotePath = (value: string) => value.startsWith('/') || !!volume(value);
export const joinRemotePath = (parent: string, child: string) => `${parent.replace(/\/+$/, '')}/${child}`;
export function remoteRoot(value: string) {
  const prefix = volume(value);
  if (!prefix && !value.startsWith('/')) return false;
  const parts: string[] = [];
  for (const part of value.slice(prefix?.length || 0).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return !parts.length;
}
export function remoteParent(value: string) {
  if (remoteRoot(value)) return value;
  const trimmed = value.replace(/\/+$/, ''), slash = trimmed.lastIndexOf('/');
  return slash < 0 ? '.' : slash === 0 ? '/' : volume(trimmed.slice(0, slash)) === trimmed.slice(0, slash) ? trimmed.slice(0, slash + 1) : trimmed.slice(0, slash);
}
export function resolveRemoteInput(directory: string, input: string) {
  const value = input.trim() || '.';
  return absoluteRemotePath(value) || value.startsWith('~') ? value : joinRemotePath(directory || '.', value);
}
