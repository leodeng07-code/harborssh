import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const parent = path.resolve('.local');
const output = path.join(parent, 'wlan-win');
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(path.join(parent, 'wlan-build-'));
try {
  const backend = path.join(staging, 'backend');
  const result = spawnSync(process.env.HARBOR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
    'modules/wlan/packaging/windows/build.py', '--backend-only', backend,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('无法构建无线监测 Windows 运行时');
  rmSync(output, { recursive: true, force: true });
  renameSync(backend, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
