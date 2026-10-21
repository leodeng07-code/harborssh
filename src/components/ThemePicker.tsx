import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { applyWallpaperStrength, defaultWallpaperStrength, getTheme, readWallpaperStrength, themes, type ThemeId } from '../themes';
import { api, errorText } from '../api';

export function ThemePicker({ theme, onChange, notify }: { theme: ThemeId; onChange: (theme: ThemeId) => void; notify: (text: string, error?: boolean) => void }) {
  const [strength, setStrength] = useState(readWallpaperStrength);
  const wallpaper = getTheme(theme).wallpaper;
  const updateStrength = (next: number) => { setStrength(next); applyWallpaperStrength(next); };
  return <><div className="theme-picker" role="group" aria-label="选择界面主题">{themes.map(t => <button key={t.id} aria-pressed={theme === t.id} className={`theme-option ${theme === t.id ? 'chosen' : ''}`} onClick={() => onChange(t.id)}><div className={`theme-preview ${t.wallpaper ? 'with-wallpaper' : ''}`} style={{ background: t.colors.base, borderColor: t.colors.border }}>{t.wallpaper && <img src={t.wallpaper.image} alt="" loading="lazy" draggable={false} />}<i style={{ background: t.colors.sidebar }} /><div><b style={{ background: t.colors.accent }} /><span style={{ background: t.colors.surface }} /><span style={{ background: t.colors.surface }} /></div></div><strong>{t.name}</strong><small>{t.description}</small>{theme === t.id && <Check size={14} />}</button>)}</div>
    {wallpaper && <div className="wallpaper-settings"><label htmlFor="wallpaper-strength">背景显示强度<output htmlFor="wallpaper-strength">{strength}%</output></label><div className="wallpaper-strength-control"><input id="wallpaper-strength" type="range" min={0} max={35} step={1} value={strength} onChange={e => updateStrength(Number(e.target.value))} /><button className="text-button" onClick={() => updateStrength(defaultWallpaperStrength)}>恢复默认</button></div><p>越低越淡，0% 隐藏图片。界面、终端及登录页同步生效，重启后保留。</p><div className="wallpaper-source"><span>原图作者：{wallpaper.author} · 一二和布布电脑壁纸</span><button className="text-button" onClick={async () => { try { await api.copy(wallpaper.source); notify('已复制黄小B原帖链接'); } catch (e) { notify(errorText(e), true); } }}><Copy size={12} />复制作者原帖链接</button></div></div>}
  </>;
}
