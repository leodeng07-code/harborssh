import { useEffect, useState } from 'react';
import { Check, Copy, Download, LoaderCircle, Moon, RefreshCw, Sun } from 'lucide-react';
import { applyWallpaperStrength, defaultWallpaperStrength, getTheme, readWallpaperStrength, themes, wallpaperImage, type ThemeId } from '../themes';
import { loadWallpaper, useWallpaperCache } from '../wallpaper-cache';
import { remoteWallpapers } from '../../shared/wallpapers';
import { api, errorText } from '../api';

const groups = [
  { id: 'bubu', title: '布布一二', description: '黄小B原图 · 9 张不同场景', items: themes.filter(t => t.family === 'bubu') },
  { id: 'kimetsu', title: '鬼灭之刃', description: 'ufotable 官方场景 · 首次选择时获取原图', items: themes.filter(t => t.family === 'kimetsu') },
  { id: 'classic', title: '经典主题', description: '纯色工作台', items: themes.filter(t => !t.wallpaper) },
];
export function ThemePicker({ theme, onChange, notify }: { theme: ThemeId; onChange: (theme: ThemeId) => void; notify: (text: string, error?: boolean) => void }) {
  const [strength, setStrength] = useState(readWallpaperStrength);
  const cache = useWallpaperCache(), selectedTheme = getTheme(theme), wallpaper = selectedTheme.wallpaper;
  const remoteState = wallpaper?.remoteId ? cache[wallpaper.remoteId] : undefined;
  useEffect(() => { for (const id of Object.keys(remoteWallpapers) as (keyof typeof remoteWallpapers)[]) void loadWallpaper(id, false); }, []);
  const updateStrength = (next: number) => { setStrength(next); applyWallpaperStrength(next); };
  return <div className="theme-catalog">
    <nav className="theme-family-nav" aria-label="主题分类">{groups.map(group => <button key={group.id} onClick={() => document.getElementById(`theme-family-${group.id}`)?.scrollIntoView({ block: 'start' })}>{group.title}<span>{group.items.length}</span></button>)}</nav>
    {groups.map(group => <section className="theme-family" key={group.id} aria-labelledby={`theme-family-${group.id}`}>
      <div className="theme-family-heading"><h4 id={`theme-family-${group.id}`}>{group.title}</h4><span>{group.description}</span></div>
      <div className="theme-picker" role="group" aria-label={`选择${group.title}主题`}>{group.items.map(t => {
        const image = wallpaperImage(t.wallpaper);
        return <button key={t.id} aria-label={t.name} aria-describedby={`theme-description-${t.id}`} aria-pressed={theme === t.id} className={`theme-option ${theme === t.id ? 'chosen' : ''}`} onClick={() => onChange(t.id)}>
          <div className={`theme-preview ${t.wallpaper ? 'with-wallpaper' : ''}`} style={{ background: t.colors.base, borderColor: t.colors.border }}>
            {t.wallpaper ? image ? <img src={image} alt={`${t.wallpaper.title}背景预览`} draggable={false} /> : <div className="theme-preview-pending" style={{ color: t.colors.text }}><Download size={23} /><span>{t.wallpaper.title}</span><small>选择后获取官方原图</small></div> : <><i style={{ background: t.colors.sidebar }} /><div><b style={{ background: t.colors.accent }} /><span style={{ background: t.colors.surface }} /><span style={{ background: t.colors.surface }} /></div></>}
            {t.wallpaper && <div className="theme-preview-palette" aria-hidden="true">{[t.colors.sidebar, t.colors.accent, t.colors.text].map((color, index) => <i key={index} style={{ background: color }} />)}</div>}
          </div>
          <div className="theme-option-title"><strong>{t.id === 'bubu-yier' ? '奶油可可' : t.name.replace(/^(布布一二|鬼灭之刃) · /, '')}</strong>{theme === t.id && <Check size={15} aria-hidden="true" />}</div>
          <small id={`theme-description-${t.id}`}>{t.description}</small><span className="theme-kind">{t.light ? <Sun size={12} /> : <Moon size={12} />}{t.light ? '浅色' : '深色'}{t.wallpaper?.remoteId && <span className="theme-download-state">{image ? '已缓存' : '需联网获取'}</span>}</span>
        </button>;
      })}</div>
      {wallpaper && selectedTheme.family === group.id && <div className="wallpaper-settings">
        {wallpaper.remoteId && <div className={`wallpaper-download ${remoteState?.status === 'error' ? 'error' : ''}`} role="status" aria-label="官方壁纸状态">
          {remoteState?.status === 'loading' ? <><LoaderCircle className="spinning" size={16} /><span>正在从 ufotable 获取原图…</span></> : remoteState?.status === 'ready' ? <><Check size={16} /><span>原图已缓存，下次可离线使用。</span></> : <><span>{remoteState?.error || '首次使用需要从官方获取背景图片。'}</span><button className="text-button" onClick={() => { void loadWallpaper(wallpaper.remoteId!, true); }}><RefreshCw size={14} />重试获取图片</button></>}
        </div>}
        <label htmlFor="wallpaper-strength">背景显示强度<output htmlFor="wallpaper-strength">{strength}%</output></label><div className="wallpaper-strength-control"><input id="wallpaper-strength" type="range" min={0} max={35} step={1} value={strength} onChange={e => updateStrength(Number(e.target.value))} /><button className="text-button" onClick={() => updateStrength(defaultWallpaperStrength)}>恢复默认</button></div>
        <p>越低越淡，0% 隐藏图片。所有图片主题共用此设置，界面、终端及登录页同步生效，重启后保留。</p>
        <div className="wallpaper-source"><span>图片来源：{wallpaper.author} · {wallpaper.title}</span><button className="text-button" onClick={async () => { try { await api.copy(wallpaper.source); notify('已复制图片来源链接'); } catch (e) { notify(errorText(e), true); } }}><Copy size={12} />复制图片来源链接</button></div>
        {wallpaper.credit && <p className="wallpaper-credit">{wallpaper.credit} · 仅供个人使用；图片不随软件分发。</p>}
      </div>}
    </section>)}
  </div>;
}
