import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { WallpaperCache } from '../electron/wallpapers';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const source = { url: 'https://www.ufotable.com/fixture.jpg', sha256: createHash('sha256').update(jpeg).digest('hex'), bytes: jpeg.length };
const catalog = { 'kimetsu-fixture': source }, uri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
async function withCache(fn: (directory: string) => Promise<void>) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-wallpapers-')); try { await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); } }

test('official wallpaper cache rejects arbitrary IDs and cache-only reads never access the network', () => withCache(async directory => {
  let calls = 0; const cache = new WallpaperCache(directory, async () => { calls++; throw new Error('offline'); }, catalog);
  assert.equal(await cache.read('kimetsu-fixture', false), null);
  for (const id of ['https://localhost/private', '../../vault.json', '__proto__', 'constructor']) await assert.rejects(cache.read(id, true), /未知/);
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(directory), []);
}));

test('downloads are deduplicated, pinned to the original bytes and reused offline after restart', () => withCache(async directory => {
  let calls = 0;
  const cache = new WallpaperCache(directory, async (url, init) => {
    calls++; assert.equal(url, source.url); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    await new Promise(resolve => setTimeout(resolve, 15)); return new Response(jpeg);
  }, catalog);
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => cache.read('kimetsu-fixture', true))), Array(4).fill(uri));
  assert.equal(calls, 1);
  const files = await fs.readdir(directory); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.jpg'));
  assert.deepEqual(await fs.readFile(path.join(directory, files[0])), jpeg);
  const offline = new WallpaperCache(directory, async () => { throw new Error('must stay offline'); }, catalog);
  assert.equal(await offline.read('kimetsu-fixture', true), uri); assert.equal(await offline.read('kimetsu-fixture', false), uri);
}));

test('corrupt cached files are not displayed and can be replaced with a verified download', () => withCache(async directory => {
  const cache = new WallpaperCache(directory, async () => new Response(jpeg), catalog);
  await cache.read('kimetsu-fixture', true); const filename = path.join(directory, (await fs.readdir(directory))[0]);
  const broken = Buffer.from(jpeg); broken[5] = 99; await fs.writeFile(filename, broken);
  assert.equal(await cache.read('kimetsu-fixture', false), null);
  assert.equal(await cache.read('kimetsu-fixture', true), uri);
}));

test('HTTP, altered, oversized and interrupted downloads leave no partial image and allow retry', () => withCache(async directory => {
  let mode = 0;
  const cache = new WallpaperCache(directory, async () => {
    if (mode === 0) return new Response('unavailable', { status: 503 });
    if (mode === 1) return new Response(Buffer.alloc(jpeg.length));
    if (mode === 2) return new Response(Buffer.alloc(jpeg.length + 1));
    if (mode === 3) return new Response(new ReadableStream({ start(controller) { controller.enqueue(jpeg.subarray(0, 4)); controller.error(new Error('connection reset')); } }));
    return new Response(jpeg);
  }, catalog);
  for (mode = 0; mode < 4; mode++) { await assert.rejects(cache.read('kimetsu-fixture', true)); assert.deepEqual(await fs.readdir(directory), []); }
  assert.equal(await cache.read('kimetsu-fixture', true), uri);
}));

test('a stalled download times out and remains retryable', () => withCache(async directory => {
  let stall = true;
  const cache = new WallpaperCache(directory, async (_url, init) => {
    if (!stall) return new Response(jpeg);
    return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, catalog, 20);
  // Keep the event loop alive while testing the service's unref'ed timeout.
  const keepAlive = setInterval(() => {}, 50);
  try { await assert.rejects(cache.read('kimetsu-fixture', true), /超时/); } finally { clearInterval(keepAlive); }
  assert.deepEqual(await fs.readdir(directory), []); stall = false; assert.equal(await cache.read('kimetsu-fixture', true), uri);
}));
