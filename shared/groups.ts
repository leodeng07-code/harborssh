import type { Profile } from './types';

export const GROUP_DEPTH = 3;
export const GROUP_NAME_LIMIT = 80;
export const UNGROUPED = '未分组';
export const GROUP_LEVELS = ['设备类型', '地点', '网络类型'] as const;

export function buildGroupPath(levels: readonly string[]): string[] {
  if (levels.length > GROUP_DEPTH) throw new Error('最多支持三级分组：设备类型 → 地点 → 网络类型');
  const path = levels.map(value => value.trim());
  while (path.length && !path.at(-1)) path.pop();
  if (path.some(value => !value)) throw new Error('请先填写上一级分组，不能跳过设备类型或地点');
  if (path.some(value => value.length > GROUP_NAME_LIMIT)) throw new Error('每一级分组名称不能超过 80 个字符');
  return path;
}

// Pre-0.2 configurations have a single literal group name. Do not split it on upgrade.
export function profileGroupPath(profile: Pick<Profile, 'group' | 'groupPath'>): string[] {
  if (profile.groupPath) return [...profile.groupPath];
  return profile.group?.trim() && profile.group !== UNGROUPED ? [profile.group.trim()] : [];
}
export const groupLabel = (path: readonly string[]) => path.length ? path.join(' / ') : UNGROUPED;
export const groupKey = (path: readonly string[]) => `group:${JSON.stringify(path)}`;
export function groupPathFromKey(key: string): string[] | null {
  if (!key.startsWith('group:')) return null;
  try {
    const path: unknown = JSON.parse(key.slice(6));
    return Array.isArray(path) && path.length > 0 && path.length <= GROUP_DEPTH && path.every(value => typeof value === 'string') ? path : null;
  } catch { return null; }
}
export function inGroup(profile: Pick<Profile, 'group' | 'groupPath'>, parent: readonly string[]): boolean {
  const path = profileGroupPath(profile);
  const effective = path.length ? path : [UNGROUPED];
  return parent.length <= effective.length && parent.every((value, index) => effective[index] === value);
}
export interface GroupNode { name: string; path: string[]; key: string; count: number; children: GroupNode[] }
export function buildGroupTree(profiles: readonly Pick<Profile, 'group' | 'groupPath'>[]): GroupNode[] {
  const roots: GroupNode[] = [];
  const nodes = new Map<string, GroupNode>();
  for (const profile of profiles) {
    const ownPath = profileGroupPath(profile);
    const path = ownPath.length ? ownPath : [UNGROUPED];
    let siblings = roots;
    for (let index = 0; index < path.length; index++) {
      const prefix = path.slice(0, index + 1), key = groupKey(prefix);
      let node = nodes.get(key);
      if (!node) { node = { name: path[index], path: prefix, key, count: 0, children: [] }; nodes.set(key, node); siblings.push(node); }
      node.count++; siblings = node.children;
    }
  }
  const sort = (items: GroupNode[]) => { items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); for (const item of items) sort(item.children); };
  sort(roots); return roots;
}
export function groupNodeCount(tree: readonly GroupNode[]): number { return tree.reduce((sum, node) => sum + 1 + groupNodeCount(node.children), 0); }
export function groupSuggestions(profiles: readonly Profile[], levels: readonly string[], depth: number): string[] {
  return [...new Set(profiles.map(profileGroupPath).filter(path => path[depth] && levels.slice(0, depth).every((part, index) => part.trim() === path[index])).map(path => path[depth]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
