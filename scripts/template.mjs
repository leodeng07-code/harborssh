// Run with the Codex bundled artifact-tool runtime; this is an authoring script, not an app dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const root = process.cwd();
const out = path.join(root, 'outputs/harborssh');
await fs.mkdir(out, { recursive: true });
const wb = Workbook.create();
const sheet = wb.worksheets.add('连接列表');
const notes = wb.worksheets.add('填写说明');
sheet.showGridLines = false; notes.showGridLines = false;
sheet.getRange('A1:L1').values = [['连接名称', '主机地址', '端口', '用户名', '认证方式', '密码', '私钥路径', '私钥口令', '设备类型', '地点', '网络类型', 'Agent 路径']];
sheet.getRange('A1:L21').format.font = { name: 'Arial', size: 11, color: '#243541' };
sheet.getRange('A1:L1').format = { fill: '#174B49', font: { name: 'Arial', size: 11, bold: true, color: '#FFFFFF' }, rowHeight: 30, horizontalAlignment: 'center', verticalAlignment: 'center' };
sheet.getRange('A2:L21').format.rowHeight = 24;
sheet.getRange('A1:L21').format.columnWidth = 21;
sheet.getRange('B1:B21').format.columnWidth = 30;
sheet.getRange('C1:C21').format.columnWidth = 10;
sheet.getRange('G1:G21').format.columnWidth = 42;
sheet.getRange('L1:L21').format.columnWidth = 30;
sheet.getRange('A2:B2001').setNumberFormat('@');
sheet.getRange('D2:L2001').setNumberFormat('@');
sheet.getRange('C2:C2001').dataValidation = { rule: { type: 'whole', operator: 'between', formula1: 1, formula2: 65535 } };
sheet.getRange('E2:E2001').dataValidation = { rule: { type: 'list', values: ['password', 'key', 'agent'] } };
sheet.freezePanes.freezeRows(1);
notes.getRange('A2').values = [['Harbor SSH 连接导入说明']];
notes.getRange('A4:D4').values = [['字段', '填写规则', '密码认证示例', '私钥认证示例']];
notes.getRange('A5:D16').values = [
  ['连接名称', '可选，留空使用主机地址', '生产 Web', '数据库主机'],
  ['主机地址', '必填，IP 地址或域名，不带协议与端口', '192.0.2.10', 'db.example.com'],
  ['端口', '整数 1–65535，留空默认为 22', 22, 2222],
  ['用户名', '必填，SSH 登录用户名', 'admin', 'ubuntu'],
  ['认证方式', 'password / key / agent，也支持“密码”“私钥”', 'password', 'key'],
  ['密码', '密码认证使用，保留空格；建议单元格使用文本格式', '填写你的登录密码', '留空'],
  ['私钥路径', '私钥认证必填，填写运行此程序的电脑上的文件路径', '留空', 'C:\\Users\\you\\.ssh\\id_ed25519'],
  ['私钥口令', '可选，填写加密私钥的口令', '留空', '未加密私钥留空'],
  ['设备类型（一级）', '可选，第一级分组；填写下级前必须先填写本级', '交换机', '防火墙'],
  ['地点（二级）', '可选，第二级分组；相同地点可属于不同设备类型', '上海', '北京'],
  ['网络类型（三级）', '可选，第三级分组；留空时停留在二级', '办公网', '生产网'],
  ['Agent 路径', '可选，留空使用系统 SSH Agent', '留空', '留空'],
];
notes.getRange('A19').values = [['使用方法']];
notes.getRange('A20').values = [['在“连接列表”第 2 行起填写真实连接。此说明页的示例不会被导入。']];
notes.getRange('A21').values = [['支持 .xlsx 和 UTF-8 .csv；旧版 .xls 请先另存为 .xlsx。每次最多 2000 条，文件上限 10 MB。']];
notes.getRange('A22').values = [['同一地址、端口、用户名视为重复；导入预览会标记并跳过。请粘贴为纯文本，不要使用公式。']];
notes.getRange('A23').values = [['Excel 中的密码为明文。导入后请妥善保管或删除文件；可在导入时选择用 Windows 系统加密保存凭据。']];
notes.getRange('A24').values = [['私钥支持 OpenSSH / PEM；PuTTY .ppk 请先转换为 OpenSSH。SOCKS5 仅转发 TCP，不支持 UDP。']];
notes.getRange('A25').values = [['旧表“分组”列仍可使用，例如：交换机 / 上海 / 办公网。与三级字段同时填写时，两者必须一致。']];
notes.getRange('A26').values = [['可只填写设备类型，或填写前两级。不能跳过设备类型或地点直接填写下级。旧版分组升级后保留为一级。']];
notes.getRange('A2:D26').format.font = { name: 'Arial', size: 11, color: '#243541' };
notes.getRange('A2').format.font = { name: 'Arial', size: 16, bold: true, color: '#174B49' };
notes.getRange('A4:D4').format = { fill: '#174B49', font: { bold: true, color: '#FFFFFF' }, rowHeight: 30, horizontalAlignment: 'center' };
notes.getRange('A5:D16').format.rowHeight = 28;
notes.getRange('A1:A26').format.columnWidth = 21;
notes.getRange('B1:B26').format.columnWidth = 62;
notes.getRange('C1:C26').format.columnWidth = 27;
notes.getRange('D1:D26').format.columnWidth = 47;
notes.getRange('A19').format.font = { bold: true, color: '#174B49' };
notes.getRange('A20:A26').format.rowHeight = 26;
wb.recalculate();
console.log((await wb.inspect({ kind: 'table', range: '连接列表!A1:L3', tableMaxRows: 3, tableMaxCols: 12, maxChars: 1800 })).ndjson);
console.log((await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 10 }, maxChars: 1000 })).ndjson);
for (const [name, range, image] of [['连接列表', 'A1:L9', 'template-preview.png'], ['填写说明', 'A2:D26', 'instructions-preview.png']]) {
  const preview = await wb.render({ sheetName: name, range, scale: 1.4, format: 'png' });
  await fs.writeFile(path.join(out, image), new Uint8Array(await preview.arrayBuffer()));
}
const exported = await SpreadsheetFile.exportXlsx(wb);
await exported.save(path.join(out, 'SSH导入模板.xlsx'));
await fs.mkdir(path.join(root, 'assets'), { recursive: true });
await fs.copyFile(path.join(out, 'SSH导入模板.xlsx'), path.join(root, 'assets/SSH导入模板.xlsx'));
console.log('Import template exported and embedded in assets.');
