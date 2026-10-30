import { useSyncExternalStore } from 'react';
import { api, errorText } from './api';
import { registerWallpaperLoader, setWallpaperImage } from './themes';
import type { RemoteWallpaperId } from '../shared/wallpapers';

type WallpaperState = { image?: string; status: 'loading' | 'ready' | 'error'; error?: string };
let snapshot: Partial<Record<RemoteWallpaperId, WallpaperState>> = {};
const listeners = new Set<() => void>(), pending = new Map<string, Promise<void>>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const current = () => snapshot;
function update(id: RemoteWallpaperId, value: WallpaperState) { snapshot = { ...snapshot, [id]: value }; for (const listener of listeners) listener(); }
export function useWallpaperCache() { return useSyncExternalStore(subscribe, current); }
export function loadWallpaper(id: RemoteWallpaperId, download: boolean) {
  if (snapshot[id]?.image) return Promise.resolve();
  const key = `${id}:${download}`, existing = pending.get(key); if (existing) return existing;
  if (download) update(id, { status: 'loading' });
  const job = api.themeWallpaper(id, download).then(image => {
    if (image) { setWallpaperImage(id, image); update(id, { image, status: 'ready' }); }
  }).catch(error => { if (download) update(id, { status: 'error', error: errorText(error) }); }).finally(() => { pending.delete(key); });
  pending.set(key, job); return job;
}
export function initializeWallpapers() { registerWallpaperLoader(id => { void loadWallpaper(id, true); }); }
