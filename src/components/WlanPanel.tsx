import { useEffect, useRef, useState } from 'react';
import { api, errorText, isDesktop } from '../api';
import { getTheme, type ThemeId } from '../themes';
import { WLAN_ORIGIN } from '../../shared/wlan';

export function WlanPanel({ active, theme }: { active: boolean; theme: ThemeId }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);

  function open() {
    setError('');
    void api.openWlan().then(setSource, err => setError(errorText(err)));
  }

  useEffect(() => { if (isDesktop) open(); }, []);

  function syncTheme() {
    const { colors, light, wallpaper } = getTheme(theme);
    frame.current?.contentWindow?.postMessage({ type: 'harbor-wlan-theme', colors, light, wallpaper: !!wallpaper }, WLAN_ORIGIN);
  }

  useEffect(syncTheme, [theme]);

  return <div className="wlan-workspace" hidden={!active}>
    {source ? <iframe ref={frame} className="wlan-frame" title="园区无线监测" src={source}
      sandbox="allow-scripts allow-same-origin allow-forms" onLoad={syncTheme} />
      : <div className="empty-state" role="status">
        <p>{!isDesktop ? '请在 Windows 版 Harbor SSH 中使用无线监测。' : error || '正在打开无线监测…'}</p>
        {error && <button type="button" className="button" onClick={open}>重试</button>}
      </div>}
  </div>;
}
