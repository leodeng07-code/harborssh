import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { groupLabel, type GroupNode } from '../../shared/groups';

export function GroupTree({ nodes, selected, onSelect }: { nodes: GroupNode[]; selected: string; onSelect: (key: string) => void }) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const render = (items: GroupNode[]) => <ul className="group-tree">{items.map(node => {
    const open = !collapsed.has(node.key), hasChildren = node.children.length > 0;
    const label = groupLabel(node.path);
    return <li key={node.key}><div className={`group-tree-row ${selected === node.key ? 'active' : ''}`}>
      {hasChildren ? <button className="group-expander" aria-label={`${open ? '折叠' : '展开'}分组 ${label}`} aria-expanded={open} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="group-expander-spacer" />}
      <button className="group-tree-button" title={`${label} · ${node.count} 台主机`} aria-label={`选择分组 ${label}`} aria-current={selected === node.key ? 'true' : undefined} onClick={() => onSelect(node.key)}>{hasChildren && open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="group-name">{node.name}</span><span className="group-count">{node.count}</span></button>
    </div>{hasChildren && open && render(node.children)}</li>;
  })}</ul>;
  return <nav aria-label="分级主机分组">{render(nodes)}</nav>;
}
