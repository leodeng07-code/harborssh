import { build as bundle } from 'esbuild';
import { build } from 'vite';

await bundle({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'ssh2', 'exceljs', 'net-snmp'], sourcemap: true });
await bundle({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await build();
