import type { PortModeInfo } from '../../shared/types';

export function PortModeBadge({ mode, compact = false }: { mode?: PortModeInfo; compact?: boolean }) {
  const kind = mode?.kind || 'unknown';
  const title = [mode?.source, mode?.oid, mode?.value === undefined ? '' : `读取值：${mode.value}`, mode?.reason].filter(Boolean).join('\n');
  return <span className="port-mode-info"><span className={`port-mode-badge ${kind}`} title={title || '未确定端口类型，保持展开'} tabIndex={0} aria-label={[mode?.label || '未知', mode?.reason].filter(Boolean).join('，')}>{mode?.label || '未知'}</span>{!compact && mode?.source && <small>{mode.source}</small>}{!compact && kind === 'unknown' && <small className="port-mode-reason">{mode?.reason || '未返回模式，保持展开'}</small>}</span>;
}
