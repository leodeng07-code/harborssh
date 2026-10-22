import { z } from 'zod';
import { buildGroupPath, groupLabel, profileGroupPath, GROUP_DEPTH, GROUP_NAME_LIMIT } from '../shared/groups';

const host = z.string().trim().min(1, '请填写主机地址').max(253).refine(v => !/[\s\x00-\x1f]/.test(v), '地址中不能包含空格或控制字符');
export const idSchema = z.string().uuid();
const port = z.number().int().min(1, '端口必须为 1–65535').max(65535, '端口必须为 1–65535');
export const profileSchema = z.object({
  id: idSchema, name: z.string().trim().min(1, '请填写连接名称').max(100),
  host, port, username: z.string().trim().min(1, '请填写用户名').max(128),
  group: z.string().trim().max(256).default('未分组'),
  groupPath: z.array(z.string().trim().min(1, '分组不能跳过上一级').max(GROUP_NAME_LIMIT, '每一级分组名称不能超过 80 个字符')).max(GROUP_DEPTH, '最多支持三级分组').optional(),
  authType: z.enum(['password', 'key', 'agent']),
  privateKeyPath: z.string().max(4096).default(''), agentPath: z.string().max(4096).default(''),
  favorite: z.boolean().default(false), color: z.enum(['teal', 'blue', 'violet', 'amber', 'rose']).default('teal'),
  hasSecret: z.boolean().default(false), rememberSecret: z.boolean().default(false),
}).refine(p => p.authType !== 'key' || p.privateKeyPath.trim().length > 0, { message: '请选择私钥文件', path: ['privateKeyPath'] })
  .superRefine((p, ctx) => { try { buildGroupPath(profileGroupPath(p)); } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['groupPath'] }); } })
  .transform(p => { const groupPath = profileGroupPath(p); return { ...p, groupPath, group: groupLabel(groupPath) }; });
export const profileInputSchema = z.object({
  profile: profileSchema,
  secrets: z.object({ password: z.string().max(16384).optional(), passphrase: z.string().max(16384).optional() }).optional(),
  clearSecret: z.boolean().optional(),
});
export const tunnelSchema = z.object({
  id: idSchema, name: z.string().trim().min(1, '请填写隧道名称').max(100), profileId: idSchema,
  type: z.enum(['local', 'remote', 'dynamic']), bindHost: host, bindPort: port,
  targetHost: z.string().trim().max(253), targetPort: z.number().int().min(1).max(65535),
}).refine(t => t.type === 'dynamic' || (t.targetHost.length > 0 && !/[\s\x00-\x1f]/.test(t.targetHost)), { message: '请填写有效的目标地址', path: ['targetHost'] });
export const batchSchema = z.object({
  profileIds: z.array(idSchema).min(1).max(2000).transform(ids => [...new Set(ids)]),
  command: z.string().min(1).max(65536).refine(c => c.trim().length > 0, '请输入命令'),
  concurrency: z.number().int().min(1).max(20), timeout: z.number().int().min(5).max(3600),
});
const community = z.string().min(1).max(256).refine(v => !v.includes('\0'), 'Community 不能含空字符');
const oid = z.string().max(200).regex(/^[12](?:\.(?:0|[1-9]\d*))+$/, 'OID 请使用数字列 OID，不含接口索引或前导点');
const parameterSchema = z.object({ field: z.enum(['pvid', 'vlanMode', 'speed', 'duplex']), oid, index: z.enum(['ifIndex', 'bridgePort']), type: z.enum(['Integer', 'Unsigned32', 'OctetString', 'OID']), choices: z.array(z.object({ label: z.string().trim().min(1).max(64), value: z.union([z.number().int().min(-2147483648).max(4294967295), z.string().max(256)]) })).min(1).max(100) })
  .superRefine((p, ctx) => { if (p.choices.some(c => p.type === 'Integer' || p.type === 'Unsigned32' ? typeof c.value !== 'number' || c.value < (p.type === 'Unsigned32' ? 0 : -2147483648) || c.value > (p.type === 'Integer' ? 2147483647 : 4294967295) : typeof c.value !== 'string' || (p.type === 'OID' && !oid.safeParse(c.value).success))) ctx.addIssue({ code: 'custom', message: '枚举值必须符合所选 ASN.1 类型' }); });
const parameters = z.array(parameterSchema).max(4).refine(v => new Set(v.map(p => p.field)).size === v.length, '每个参数只能适配一次');
export const snmpConfigSchema = z.object({ profileId: idSchema, port, readCommunity: community.optional(), writeCommunity: community.optional(), clearWrite: z.boolean().optional(), parameters: parameters.optional() });
export const batchSnmpConfigSchema = z.object({ profileIds: z.array(idSchema).min(1, '请选择设备范围').max(2000).transform(ids => [...new Set(ids)]), port: port.optional(), readCommunity: community, writeCommunity: community.optional(), clearWrite: z.boolean().optional() });
export const snmpTargetSchema = z.object({ profileId: idSchema, port, hasReadCommunity: z.boolean().default(false), hasWriteCommunity: z.boolean().default(false), parameters: parameters.optional() });
export const interfaceChangeSchema = z.object({ profileId: idSchema, index: z.number().int().min(1).max(2147483647), field: z.enum(['adminStatus', 'alias', 'pvid', 'vlanMode', 'speed', 'duplex']), value: z.union([z.number().int(), z.string().max(256)]), expected: z.union([z.number(), z.string().max(1024)]) })
  .superRefine((v, ctx) => {
    if ((v.field === 'adminStatus' && (![1, 2].includes(Number(v.value)) || typeof v.value !== 'number' || ![1, 2, 3].includes(Number(v.expected)) || typeof v.expected !== 'number')) || (v.field === 'alias' && (typeof v.value !== 'string' || Buffer.byteLength(v.value, 'utf8') > 64 || /[\x00-\x1f\x7f]/.test(v.value) || typeof v.expected !== 'string'))) ctx.addIssue({ code: 'custom', message: '接口状态仅支持启用/停用；接口描述限 64 字节且不含控制字符' });
  });
export function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(i => i.message).join('；');
  return error instanceof Error ? error.message : String(error);
}
