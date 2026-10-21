import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Reuse electron-builder's pinned NSIS compiler without its signed-uninstaller workflow.
const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const { nsisEscapeString } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const root = process.cwd();
const filename = path.join(root, `release/HarborSSH-${pkg.version}-setup-x64.exe`);
await fs.access(path.join(root, 'release/win-unpacked/Harbor SSH.exe'));
const compiler = await getMakeNsisPath();
const quote = value => `"${nsisEscapeString(value)}"`;
const args = ['-WX', '-INPUTCHARSET', 'UTF8',
  `-DPRODUCT_NAME=${nsisEscapeString(pkg.build.productName)}`,
  `-DVERSION=${nsisEscapeString(pkg.version)}`,
  `-DPROJECT_DIR=${nsisEscapeString(root)}`,
  '-XUnicode true', '-XSetCompressor zlib',
  `-XOutFile ${quote(filename)}`,
  `-XVIProductVersion ${pkg.version}.0`,
  `-XVIAddVersionKey /LANG=2052 ProductName ${quote(pkg.build.productName)}`,
  `-XVIAddVersionKey /LANG=2052 ProductVersion ${quote(pkg.version)}`,
  `-XVIAddVersionKey /LANG=2052 CompanyName ${quote(typeof pkg.author === 'string' ? pkg.author : pkg.author.name)}`,
  `-XVIAddVersionKey /LANG=2052 LegalCopyright ${quote('Copyright 2026 Harbor SSH contributors')}`,
  `-XVIAddVersionKey /LANG=2052 FileDescription ${quote(pkg.description)}`,
  `-XVIAddVersionKey /LANG=2052 FileVersion ${quote(pkg.version)}`,
  path.join(root, 'build/installer.nsi'),
];
await new Promise((resolve, reject) => {
  const child = spawn(compiler.path, args, { stdio: 'inherit', env: { ...process.env, ...compiler.env } });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`NSIS installer build failed (${code})`)));
});
console.log(`Windows installer created: ${filename}`);
