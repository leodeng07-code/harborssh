import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Server, X } from 'lucide-react';
import type { Profile, SnmpTarget } from '../../shared/types';
import { groupLabel, profileGroupPath } from '../../shared/groups';

export function NetworkTargetPicker({ profiles, targets, selected, onSelect, query, onQueryChange }: {
  profiles: Profile[]; targets: SnmpTarget[]; selected?: Profile; onSelect: (id: string) => void;
  query: string; onQueryChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [configuredOnly, setConfiguredOnly] = useState(false);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const configured = new Set(targets.filter(target => target.hasReadCommunity).map(target => target.profileId));
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = profiles.filter(profile => {
    const text = `${profile.name} ${profile.host} ${groupLabel(profileGroupPath(profile))}`.toLocaleLowerCase();
    return (!configuredOnly || configured.has(profile.id)) && words.every(word => text.includes(word));
  });
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const choose = (profile: Profile) => { onSelect(profile.id); onQueryChange(''); input.current?.focus(); setOpen(false); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => { if (query) { setOpen(true); setActive(0); } }, [query]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index, open, listId, configuredOnly]);
  return <div className="network-target-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <div className="network-target-field"><label className="network-target-label" htmlFor="network-host-search">查找目标设备</label>
    <div className={`network-target-search ${open ? 'opened' : ''}`}><Search size={17} /><input ref={input} id="network-host-search" role="combobox" aria-label="搜索网络管理主机" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && matches.length ? `${listId}-${index}` : undefined} autoComplete="off" placeholder="搜索名称、IP、地点或分组，可输入多个关键词" value={query} onFocus={() => setOpen(true)} onChange={event => { onQueryChange(event.target.value); setActive(0); setOpen(true); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(value => matches.length ? (Math.min(value, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0); }
      if (event.key === 'Enter') { event.preventDefault(); if (open && matches[index]) choose(matches[index]); else setOpen(true); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }} />{query && <button className="icon-button" aria-label="清除主机搜索" onClick={() => { onQueryChange(''); setActive(0); input.current?.focus(); setOpen(true); }}><X size={15} /></button>}<button className="icon-button" aria-label="选择网络管理目标设备" aria-expanded={open} onClick={() => { if (!open) input.current?.focus(); setOpen(!open); }}><ChevronDown size={16} /></button></div>
    {open && <div className="network-target-popover"><div className="network-target-filters"><span role="status">匹配 {matches.length} / {profiles.length} 台</span><label className="checkbox-label"><input type="checkbox" checked={configuredOnly} onChange={event => { setConfiguredOnly(event.target.checked); setActive(0); }} />仅已配置 SNMP</label></div><ul id={listId} role="listbox" aria-label="网络管理主机搜索结果" className="network-target-results">{matches.map((profile, item) => <li id={`${listId}-${item}`} key={profile.id} role="option" aria-selected={selected?.id === profile.id} className={index === item ? 'active' : ''} onMouseMove={() => setActive(item)}><button type="button" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(profile)}><Server size={17} /><span className="network-target-option"><strong>{profile.name}</strong><span><code>{profile.host}:{profile.port}</code><span>{groupLabel(profileGroupPath(profile))}</span></span></span><span className={`network-target-badge ${configured.has(profile.id) ? 'configured' : ''}`}>{configured.has(profile.id) ? 'SNMP 已配置' : '待配置'}</span>{selected?.id === profile.id && <Check size={15} />}</button></li>)}</ul>{!matches.length && <p className="network-target-empty">没有匹配设备，试试其他名称、IP 或分组。</p>}<p className="network-target-hint">选择结果后切换目标 · ↑↓ 选择 · Enter 确认 · Esc 收起</p></div>}
    </div>{selected && <div className="network-current-target" aria-label="当前网络管理目标"><Server size={18} /><div><small>当前目标</small><strong>{selected.name}</strong><span><code>{selected.host}</code><span>{groupLabel(profileGroupPath(selected))}</span></span></div><span className={`network-target-badge ${configured.has(selected.id) ? 'configured' : ''}`}>{configured.has(selected.id) ? 'SNMP 已配置' : 'SNMP 待配置'}</span></div>}
  </div>;
}
