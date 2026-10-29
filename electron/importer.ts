import ExcelJS from 'exceljs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import JSZip from 'jszip';
import type { Config, ImportPreview, ImportRow, ProfileInput } from '../shared/types';
import { profileInputSchema, message } from './validation';
import { defaultSerial, protocolOf } from '../shared/connections';
import { buildGroupPath, groupLabel, profileGroupPath } from '../shared/groups';

const aliases: Record<string, string[]> = {
  protocol: ['协议', '连接协议', 'protocol'], encoding: ['终端编码', 'encoding'], baudRate: ['波特率', 'baudrate'], dataBits: ['数据位', 'databits'], stopBits: ['停止位', 'stopbits'], parity: ['校验', 'parity'], flowControl: ['流控', 'flowcontrol'], localEcho: ['本地回显', 'localecho'], enterKey: ['回车发送', 'enterkey'],
  name: ['连接名称', '名称', 'name', 'label'], host: ['主机地址', '地址', '主机', 'ip', 'host', 'hostname', '服务器地址'],
  port: ['端口', 'port'], username: ['用户名', '用户', 'username', 'user'],
  authType: ['认证方式', '认证', 'authtype', 'auth', 'authentication'], password: ['密码', 'password'],
  privateKeyPath: ['私钥路径', '私钥文件', 'privatekeypath', 'keypath', 'identityfile'], passphrase: ['私钥口令', '私钥密码', 'passphrase'],
  group: ['分组', '分组路径', 'group', 'grouppath'], agentPath: ['agent路径', 'agentpath'],
  deviceType: ['设备类型', '一级分组', '第一级分组', 'devicetype', 'group1', 'level1'],
  location: ['地点', '位置', '二级分组', '第二级分组', 'location', 'site', 'group2', 'level2'],
  networkType: ['网络类型', '三级分组', '第三级分组', 'networktype', 'network', 'group3', 'level3'],
};
const normalize = (value: string) => value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const keys = new Map(Object.entries(aliases).flatMap(([key, values]) => values.map(v => [normalize(v), key] as const)));
export const endpoint = (p: { host: string; port: number; username: string; protocol?: string }) => `${p.protocol || 'ssh'}:${p.username}@${p.host.toLowerCase()}:${p.port}`;

async function checkArchive(filename: string) {
  // Check uncompressed sizes before ExcelJS expands XML in memory.
  await new Promise<void>((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err || new Error('无效的 Excel 文件')); return; }
      let size = 0, count = 0;
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        size += entry.uncompressedSize; count++;
        if (size > 64 * 1024 * 1024 || count > 5000) { zip.close(); reject(new Error('Excel 解压后过大，请拆分文件后导入（上限 64 MB）')); return; }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('导入列不能使用公式，请粘贴为纯文本或数值');
    if ('richText' in value) return value.richText.map(r => r.text).join('');
    if ('text' in value) return String(value.text);
    throw new Error('不支持的单元格类型，请使用纯文本');
  }
  return String(value);
}
export interface ImportDraft { preview: ImportPreview; inputs: Map<number, ProfileInput>; createdAt: number }
function importedGroupPath(raw: Record<string, string>): string[] {
  const levels = [raw.deviceType || '', raw.location || '', raw.networkType || ''];
  const explicit = levels.some(value => value.trim());
  const path = raw.group?.trim() ? buildGroupPath(raw.group.split('/')) : [];
  if (!explicit) return path;
  const structured = buildGroupPath(levels);
  if (path.length && JSON.stringify(path) !== JSON.stringify(structured)) throw new Error('分组路径与设备类型、地点、网络类型不一致，请只保留一套填写方式');
  return structured;
}
export async function readExcel(filename: string): Promise<ExcelJS.Workbook> {
  await checkArchive(filename);
  const archive = await JSZip.loadAsync(await fs.readFile(filename));
  // ExcelJS expects unprefixed SpreadsheetML tags; valid XLSX writers may use x: or s:.
  // Normalize that namespace without touching relationship prefixes or cell contents.
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/^xl\/.+\.xml$/.test(entry.name)) continue;
    let xml = await entry.async('string'); let changed = false;
    const prefixes = [...xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/g)].map(m => m[1]);
    for (const prefix of new Set(prefixes)) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      xml = xml.replace(new RegExp(`<(/?)${escaped}:`, 'g'), '<$1');
      xml = xml.replace(new RegExp(`xmlns:${escaped}="${namespace}"`, 'g'), () => { if (xml.includes(`xmlns="${namespace}"`)) return ''; return `xmlns="${namespace}"`; });
      changed = true;
    }
    if (changed) archive.file(entry.name, xml);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await archive.generateAsync({ type: 'arraybuffer' }));
  return wb;
}
export async function parseImport(filename: string, config: Config): Promise<ImportDraft> {
  const stat = await fs.stat(filename);
  if (stat.size > 10 * 1024 * 1024) throw new Error('单次导入文件不能超过 10 MB');
  let wb = new ExcelJS.Workbook();
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xlsx') wb = await readExcel(filename);
  else if (ext === '.csv') await wb.csv.readFile(filename, { parserOptions: { trim: false, ignoreEmpty: true }, map: (value: string) => value });
  else throw new Error('请使用 .xlsx 或 UTF-8 编码的 .csv 文件；旧版 .xls 请先另存为 .xlsx');
  const sheet = wb.getWorksheet('连接列表') || wb.worksheets[0];
  if (!sheet) throw new Error('文件中没有工作表');
  let header = 0; let columns = new Map<number, string>();
  for (let row = 1; row <= Math.min(10, sheet.rowCount); row++) {
    const candidate = new Map<number, string>();
    sheet.getRow(row).eachCell((cell, col) => { const key = keys.get(normalize(cellText(cell))); if (key) candidate.set(col, key); });
    if ([...candidate.values()].includes('host') && ([...candidate.values()].includes('username') || [...candidate.values()].includes('protocol'))) { header = row; columns = candidate; break; }
  }
  if (!header) throw new Error('未识别表头，至少需要“主机地址”和“用户名”两列，请参考导入模板');
  if (new Set(columns.values()).size !== columns.size) throw new Error('表头中存在重复字段，请保留每个字段的一列');
  if (sheet.rowCount - header > 2000) throw new Error('每次最多导入 2000 行，请拆分文件或删除多余格式行');
  const inputs = new Map<number, ProfileInput>(); const rows: ImportRow[] = [];
  const seen = new Set(config.profiles.map(endpoint));
  const seenInFile = new Set<string>();
  for (let index = header + 1; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index); if (!row.hasValues) continue;
    const raw: Record<string, string> = {};
    const preview: ImportRow = { row: index, name: '', host: '', port: 22, username: '', group: '未分组', authType: 'password', hasSecret: false, duplicate: false };
    try {
      for (const [col, key] of columns) raw[key] = cellText(row.getCell(col));
      if (Object.values(raw).every(v => !v.trim())) continue;
      const protocolText = normalize(raw.protocol || 'ssh');
      const protocol = ['serial', '串口', 'console'].includes(protocolText) ? 'serial' : protocolText;
      const auth = normalize(raw.authType || (raw.privateKeyPath ? 'key' : 'password'));
      const authType = protocol !== 'ssh' ? 'password' : ['password', '密码'].includes(auth) ? 'password' : ['key', 'privatekey', '私钥', '密钥'].includes(auth) ? 'key' : ['agent', 'sshagent'].includes(auth) ? 'agent' : auth;
      Object.assign(preview, { protocol, name: raw.name?.trim() || raw.host?.trim() || '', host: raw.host?.trim() || '', port: raw.port?.trim() ? Number(raw.port.trim()) : protocol === 'telnet' ? 23 : 22, username: raw.username?.trim() || '', group: raw.group?.trim() || '未分组', authType, hasSecret: protocol !== 'serial' && (!!raw.password || !!raw.passphrase) });
      const groupPath = importedGroupPath(raw); preview.group = groupLabel(groupPath);
      const input = profileInputSchema.parse({
        profile: { ...preview, protocol, encoding: raw.encoding?.trim() || 'utf8', serial: protocol === 'serial' ? { ...defaultSerial, baudRate: raw.baudRate ? Number(raw.baudRate) : defaultSerial.baudRate, dataBits: raw.dataBits ? Number(raw.dataBits) : 8, stopBits: raw.stopBits ? Number(raw.stopBits) : 1, parity: raw.parity || 'none', flowControl: raw.flowControl || 'none', localEcho: ['true', '1', '是'].includes(raw.localEcho?.trim().toLowerCase()), enterKey: raw.enterKey || 'cr' } : undefined, groupPath, id: randomUUID(), privateKeyPath: raw.privateKeyPath?.trim() || '', agentPath: raw.agentPath?.trim() || '', favorite: false, color: 'teal', rememberSecret: false },
        secrets: { password: raw.password || undefined, passphrase: raw.passphrase || undefined },
      });
      const key = endpoint(input.profile), existing = config.profiles.find(p => endpoint(p) === key);
      preview.duplicate = seen.has(key);
      preview.canFillSecret = !seenInFile.has(key) && !!existing && !existing.hasSecret && existing.authType === input.profile.authType
        && (existing.authType === 'password' ? !!input.secrets?.password : existing.authType === 'key' && existing.privateKeyPath === input.profile.privateKeyPath && !!input.secrets?.passphrase);
      seen.add(key); seenInFile.add(key); inputs.set(index, input);
    } catch (err) { preview.error = message(err); }
    rows.push(preview);
  }
  if (!rows.length) throw new Error('工作表中没有连接记录，请在表头下填写连接信息');
  return { preview: { token: randomUUID(), filename: path.basename(filename), rows }, inputs, createdAt: Date.now() };
}
// Re-check current state at commit time; never overwrite an existing secret or metadata.
export function importSelection(draft: ImportDraft, rows: number[], config: Config, remember: boolean, fillMissing: boolean): ProfileInput[] {
  const seen = new Set<string>();
  return [...new Set(rows)].map(row => {
    const input = draft.inputs.get(row); if (!input) throw new Error(`第 ${row} 行无效`);
    const key = endpoint(input.profile); if (seen.has(key)) throw new Error(`第 ${row} 行在文件内重复`); seen.add(key);
    const existing = config.profiles.find(p => endpoint(p) === key);
    if (existing) {
      const matchingSecret = existing.authType === 'password' ? !!input.secrets?.password : existing.authType === 'key' && existing.privateKeyPath === input.profile.privateKeyPath && !!input.secrets?.passphrase;
      if (!fillMissing || existing.hasSecret || existing.authType !== input.profile.authType || !matchingSecret) throw new Error(`第 ${row} 行与现有连接重复，或该连接已有凭据，请重新预览`);
      return { profile: { ...existing, rememberSecret: remember }, secrets: input.secrets };
    }
    return { ...input, profile: { ...input.profile, rememberSecret: remember } };
  });
}
export async function exportProfiles(filename: string, config: Config) {
  const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('连接列表', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  sheet.columns = [
    { header: '连接名称', key: 'name', width: 24 }, { header: '主机地址', key: 'host', width: 32 }, { header: '端口', key: 'port', width: 10 },
    { header: '用户名', key: 'username', width: 18 }, { header: '认证方式', key: 'authType', width: 14 }, { header: '密码', key: 'password', width: 18 },
    { header: '私钥路径', key: 'privateKeyPath', width: 42 }, { header: '私钥口令', key: 'passphrase', width: 18 },
    { header: '设备类型', key: 'deviceType', width: 20 }, { header: '地点', key: 'location', width: 20 }, { header: '网络类型', key: 'networkType', width: 20 },
    { header: 'Agent 路径', key: 'agentPath', width: 30 },
    ...['protocol', 'encoding', 'baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'localEcho', 'enterKey'].map((key, i) => ({ header: ['协议', '终端编码', '波特率', '数据位', '停止位', '校验', '流控', '本地回显', '回车发送'][i], key, width: 16 })),
  ];
  for (const p of config.profiles) { const [deviceType = '', location = '', networkType = ''] = profileGroupPath(p); sheet.addRow({ ...p, ...(p.serial || {}), protocol: protocolOf(p), encoding: p.encoding || 'utf8', deviceType, location, networkType, password: '', passphrase: '' }); }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 11 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF174B49' } }; sheet.getRow(1).height = 28;
  sheet.getColumn('password').numFmt = '@'; sheet.getColumn('passphrase').numFmt = '@';
  await wb.xlsx.writeFile(filename);
}
