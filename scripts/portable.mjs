import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const archiver = require('archiver');
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const filename = `release/HarborSSH-${version}-windows-x64.zip`;
await fs.access('release/win-unpacked/Harbor SSH.exe');
await fs.copyFile('README.md', 'release/win-unpacked/使用说明.md');
await fs.copyFile('assets/SSH导入模板.xlsx', 'release/win-unpacked/SSH导入模板.xlsx');
const output = createWriteStream(filename);
const archive = archiver('zip', { zlib: { level: 1 } });
archive.on('error', error => output.destroy(error));
archive.pipe(output); archive.directory('release/win-unpacked', false);
await archive.finalize(); await finished(output);
console.log(`Windows portable ZIP created: ${filename}`);
