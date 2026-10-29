import { useState } from 'react';
import { Check, Copy, Moon, Sun } from 'lucide-react';
import { applyWallpaperStrength, defaultWallpaperStrength, getTheme, readWallpaperStrength, themes, type ThemeId } from '../themes';
import { api, errorText } from '../api';

export function ThemePicker({ theme, onChange, notify }: { theme: ThemeId; onChange: (theme: ThemeId) => void; notify: (text: string, error?: boolean) => void }) {
  const [strength, setStrength] = useState(readWallpaperStrength);
  const wallpaper = getTheme(theme).wallpaper;
  const updateStrength = (next: number) => { setStrength(next); applyWallpaperStrength(next); };
  return <div className="theme-catalog">{[
    { title: '布布一二', description: '黄小B原图背景 · 5 套浅色与 1 套夜色', items: themes.filter(t => t.wallpaper) },
    { title: '经典主题', description: '纯色工作台', items: themes.filter(t => !t.wallpaper) },
  ].map((group, index) => <section className="theme-family" key={group.title} aria-labelledby={`theme-family-${index}`}>
    <div className="theme-family-heading"><h4 id={`theme-family-${index}`}>{group.title}</h4><span>{group.description}</span></div>
    <div className="theme-picker" role="group" aria-label={`选择${group.title}主题`}>{group.items.map(t => <button key={t.id} aria-label={t.name} aria-describedby={`theme-description-${t.id}`} aria-pressed={theme === t.id} className={`theme-option ${theme === t.id ? 'chosen' : ''}`} onClick={() => onChange(t.id)}>
      <div className={`theme-preview ${t.wallpaper ? 'with-wallpaper' : ''}`} style={{ background: t.colors.base, borderColor: t.colors.border }}>{t.wallpaper && <img src={t.wallpaper.image} alt="" loading="lazy" draggable={false} />}<i style={{ background: t.colors.sidebar }} /><div><b style={{ background: t.colors.accent }} /><span style={{ background: t.colors.surface }} /><span style={{ background: t.colors.surface }} /></div></div>
      <div className="theme-option-title"><strong>{t.id === 'bubu-yier' ? '奶油可可' : t.name.replace('布布一二 · ', '')}</strong>{theme === t.id && <Check size={15} aria-hidden="true" />}</div>
      <small id={`theme-description-${t.id}`}>{t.description}</small><span className="theme-kind">{t.light ? <Sun size={12} /> : <Moon size={12} />}{t.light ? '浅色' : '深色'}</span>
    </button>)}</div>
    {index === 0 && wallpaper && <div className="wallpaper-settings"><label htmlFor="wallpaper-strength">背景显示强度<output htmlFor="wallpaper-strength">{strength}%</output></label><div className="wallpaper-strength-control"><input id="wallpaper-strength" type="range" min={0} max={35} step={1} value={strength} onChange={e => updateStrength(Number(e.target.value))} /><button className="text-button" onClick={() => updateStrength(defaultWallpaperStrength)}>恢复默认</button></div><p>越低越淡，0% 隐藏图片。所有布布一二配色共用此设置，界面、终端及登录页同步生效，重启后保留。</p><div className="wallpaper-source"><span>原图作者：{wallpaper.author} · 一二和布布电脑壁纸</span><button className="text-button" onClick={async () => { try { await api.copy(wallpaper.source); notify('已复制黄小B原帖链接'); } catch (e) { notify(errorText(e), true); } }}><Copy size={12} />复制作者原帖链接</button></div></div>}
  </section>)}</div>;
}
