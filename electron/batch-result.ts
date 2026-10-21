import type { BatchResult } from '../shared/types';

// Network appliances may omit exit-status and reset the transport after output.
// Output alone is evidence of a response, never proof that every command succeeded.
export function batchCompletion(code: number | undefined, signal: string | undefined, hasOutput: boolean, transportError?: string): Pick<BatchResult, 'status' | 'error' | 'warning' | 'exitCode'> {
  if (signal) return { status: 'error', error: `进程收到信号 ${signal}`, exitCode: code };
  if (code !== undefined) return code === 0
    ? { status: 'success', exitCode: code, warning: transportError ? `命令已返回退出码 0，连接随后中断：${transportError}。请核对已接收的输出是否完整。` : undefined }
    : { status: 'error', exitCode: code, error: `退出码 ${code}${transportError ? `；${transportError}` : ''}` };
  if (transportError && !hasOutput) return { status: 'error', error: transportError };
  return { status: 'unconfirmed', warning: `设备未返回 SSH 退出码，无法确认命令是否全部成功${transportError ? `；连接中断：${transportError}` : ''}。请核对输出，避免重复执行配置命令。` };
}
