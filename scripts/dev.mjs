import { createServer } from 'vite';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const common = { bundle: true, platform: 'node', format: 'cjs', sourcemap: true };
const main = await context({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', external: ['electron', 'ssh2', 'exceljs'] });
const preload = await context({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', external: ['electron'] });
await main.rebuild();
await preload.rebuild();
await main.watch();
await preload.watch();
const childEnv = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: childEnv });
async function close() { await server.close(); await main.dispose(); await preload.dispose(); }
child.on('exit', async (code) => { await close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
