import { app, protocol } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { WLAN_ORIGIN, WLAN_SCHEME } from '../shared/wlan';

protocol.registerSchemesAsPrivileged([
  { scheme: WLAN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const reads = new Set(['/', '/open', '/settings', '/app.js', '/theme.js', '/styles.css', '/settings.js', '/settings.css',
  '/api/dashboard', '/api/ap', '/api/events', '/api/desktop']);
const writes = new Set(['/api/diagnostics', '/api/desktop/prepare', '/api/desktop/save', '/api/desktop/start', '/api/desktop/stop']);
let child: ChildProcessWithoutNullStreams | undefined;
let startup: Promise<URL> | undefined;
let endpoint: URL | undefined;

export function openWlan() {
  const developmentRoot = !app.isPackaged ? process.env.HARBOR_WLAN_ROOT : undefined;
  if (process.platform !== 'win32' && !developmentRoot) throw new Error('无线监测采集支持 Windows x64，请使用 Windows 版 Harbor SSH。');
  if (endpoint) return Promise.resolve(WLAN_ORIGIN + '/open');
  if (!startup) {
    const root = developmentRoot || path.join(process.resourcesPath, 'wlan');
    const processHandle = spawn(path.join(root, 'runtime', 'python.exe'), [
      '-X', 'utf8', '-u', path.join(root, 'app', 'desktop.py'),
    ], { windowsHide: true });
    child = processHandle;
    startup = new Promise<URL>((resolve, reject) => {
      let output = '';
      let alreadyRunning = false;
      const timer = setTimeout(() => { processHandle.kill(); reject(new Error('无线采集服务启动超时')); }, 15000);
      processHandle.stderr.on('data', data => {
        alreadyRunning ||= String(data).includes('无线采集服务已打开');
      });
      processHandle.once('error', () => {
        clearTimeout(timer);
        reject(new Error('无法启动无线采集服务，请完整解压或重新安装 Harbor SSH'));
      });
      processHandle.once('close', () => {
        clearTimeout(timer);
        if (child === processHandle) { child = undefined; startup = undefined; endpoint = undefined; }
        reject(new Error(alreadyRunning ? '无线采集服务已打开，请先关闭独立无线监测应用' : '无线采集服务已退出，请重试'));
      });
      processHandle.stdout.setEncoding('utf8').on('data', chunk => {
        if (!output && endpoint) return;
        output += chunk;
        const end = output.indexOf('\n');
        if (end === -1 && output.length < 4096) return;
        clearTimeout(timer);
        try {
          const url = new URL(output.slice(0, end).trim());
          const token = url.searchParams.get('token') || '';
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
              url.username || url.password || url.pathname !== '/open' || !/^[\w-]{43}$/.test(token)) throw new Error();
          output = '';
          endpoint = url;
          resolve(url);
        } catch {
          processHandle.kill();
          reject(new Error('无法连接无线采集服务'));
        }
      });
    });
  }
  return startup.then(() => WLAN_ORIGIN + '/open');
}

export function stopWlan() {
  child?.stdin.end();
}

export function registerWlanProtocol(devURL?: string) {
  const parent = devURL ? new URL(devURL).origin : 'file:';
  protocol.handle(WLAN_SCHEME, async request => {
    const source = new URL(request.url);
    const target = endpoint;
    if (!target || source.host !== 'monitor' || source.username || source.password) return new Response(null, { status: 403 });
    const post = request.method === 'POST';
    if (post ? !writes.has(source.pathname) || request.headers.get('origin') !== WLAN_ORIGIN
      : request.method !== 'GET' || !reads.has(source.pathname)) return new Response(null, { status: 403 });
    const token = target.searchParams.get('token')!;
    const remote = source.pathname === '/open' ? target : new URL(source.pathname + source.search, target);
    const headers: Record<string, string> = { Cookie: `wlan_${token.slice(0, 8)}=${token}` };
    let body: string | undefined;
    if (post) {
      if (request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 415 });
      body = await request.text();
      if (Buffer.byteLength(body) > 16384) return new Response(null, { status: 413 });
      headers['Content-Type'] = 'application/json';
      headers.Origin = target.origin;
    }
    try {
      const response = await fetch(remote, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(70000) });
      const next = response.headers.get('location');
      if (source.pathname === '/open' && response.status === 303 && (next === '/' || next === '/settings')) {
        return Response.redirect(WLAN_ORIGIN + next, 303);
      }
      const contentType = response.headers.get('content-type') || 'text/plain; charset=utf-8';
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'self'; frame-ancestors ${parent}; base-uri 'none'; form-action 'self'`,
      } });
    } catch {
      return Response.json({ error: '无线采集服务暂时不可用' }, { status: 502 });
    }
  });
}
