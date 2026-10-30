// Official originals are fetched only for the user's local wallpaper cache.
// Keep these images out of the repository and distributable application.
export interface RemoteWallpaperSource { url: string; sha256: string; bytes: number }
export const remoteWallpapers = {
  'kimetsu-garden': { url: 'https://www.ufotable.com/kmt_wallpaper/img/bg01.jpg', sha256: '5ccba6779534ce781aee1c01d4e35dbef98c125c73f5f20261d7bba51d6e322c', bytes: 595475 },
  'kimetsu-wisteria': { url: 'https://www.ufotable.com/kmt_wallpaper/img/bg03.jpg', sha256: 'ca036f07f5b934bb0e6ad4f43c58749822d2de37a086a09b46f20d2b1b955661', bytes: 957664 },
  'kimetsu-mist': { url: 'https://www.ufotable.com/kmt_wallpaper/img/bg04.jpg', sha256: '9926e6f8ecc89e58e9e82b2e682126c86cfc468d5924ebdc229e53973e429f9b', bytes: 538467 },
  'kimetsu-castle': { url: 'https://www.ufotable.com/kmt_wallpaper/img/bg05.jpg', sha256: '052f4f17e50201d7529c894b5db1ab4c8b837554832b4807c0cecc1fe23274c1', bytes: 396904 },
} satisfies Record<string, RemoteWallpaperSource>;
export type RemoteWallpaperId = keyof typeof remoteWallpapers;
