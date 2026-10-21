import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Check, Copy, Eraser, FileText, Folder, RotateCw, Search, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { SessionInfo } from '../../shared/types';
import { api, errorText } from '../api';
import { SftpPanel } from './SftpPanel';
import { terminalTheme, type ThemeId } from '../themes';
import { bindTerminalClipboard } from '../terminalClipboard';

export function TerminalPane({ session, visible, onReconnect, notify, fontSize, theme }: { session: SessionInfo; visible: boolean; onReconnect: () => void; notify: (text: string, error?: boolean) => void; fontSize: number; theme: ThemeId }) {
  const container = useRef<HTMLDivElement>(null); const term = useRef<Terminal | null>(null); const fit = useRef<FitAddon | null>(null); const search = useRef<SearchAddon | null>(null);
  const [filesOpen, setFilesOpen] = useState(false); const [filesMounted, setFilesMounted] = useState(false); const [fileWidth, setFileWidth] = useState(46); const split = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState(false); const [query, setQuery] = useState(''); const [copied, setCopied] = useState(false);
  const clipboard = useRef<ReturnType<typeof bindTerminalClipboard> | null>(null);
  const activeRef = useRef(visible); activeRef.current = visible;
  const statusRef = useRef(session.status); statusRef.current = session.status;
  const reconnectRef = useRef(onReconnect); reconnectRef.current = onReconnect;
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, cursorStyle: 'bar', scrollback: 10000, fontSize, lineHeight: 1.25, fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Liberation Mono", monospace', theme: terminalTheme(theme), allowTransparency: true, allowProposedApi: false });
    const fitAddon = new FitAddon(), searchAddon = new SearchAddon(); terminal.loadAddon(fitAddon); terminal.loadAddon(searchAddon); terminal.open(container.current!);
    term.current = terminal; fit.current = fitAddon; search.current = searchAddon;
    let disposed = false, ready = false, seq = 0;
    const queued: { seq: number; data: string }[] = [];
    const write = (data: string) => terminal.write(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    const unsubscribe = api.onEvent(event => {
      if (event.type !== 'terminal' || event.id !== session.id || disposed) return;
      if (!ready) { queued.push(event); return; }
      if (event.seq > seq) { seq = event.seq; write(event.data); }
    });
    void api.readTerminal(session.id).then(buffer => {
      if (disposed) return;
      buffer.data.forEach(write); seq = buffer.seq; ready = true;
      for (const chunk of queued) if (chunk.seq > seq) { seq = chunk.seq; write(chunk.data); }
      queued.length = 0;
    }).catch(err => { if (!disposed) terminal.writeln(errorText(err)); });
    const input = terminal.onData(data => { if (statusRef.current === 'connected') api.write(session.id, data); });
    const resize = terminal.onResize(({ cols, rows }) => api.resize(session.id, cols, rows));
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;
    const clipboardActions = bindTerminalClipboard(terminal, container.current!, {
      connected: () => statusRef.current === 'connected', active: () => activeRef.current,
      copy: text => api.copy(text), paste: () => api.paste(),
      onCopied: () => { clearTimeout(copiedTimer); setCopied(true); copiedTimer = setTimeout(() => setCopied(false), 1500); },
      onError: err => notify(errorText(err), true),
    });
    clipboard.current = clipboardActions;
    let copyingKey = false, reconnecting = false;
    terminal.attachCustomKeyEventHandler(event => {
      if (event.code === 'KeyR' && !event.ctrlKey && !event.altKey && !event.metaKey && activeRef.current && ['closed', 'error'].includes(statusRef.current)) {
        event.preventDefault();
        if (event.type === 'keydown' && !event.repeat && !reconnecting) {
          reconnecting = true;
          void Promise.resolve().then(() => reconnectRef.current()).catch(err => { if (!disposed) notify(errorText(err), true); }).finally(() => { reconnecting = false; });
        }
        return false;
      }
      if (event.code === 'KeyC' && event.type === 'keyup') { const consumed = copyingKey; copyingKey = false; if (consumed) event.preventDefault(); return !consumed; }
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      // Consume the entire key sequence, including keypress after async copy
      // clears the selection, so Ctrl+C never leaks an interrupt when copying.
      if (event.code === 'KeyC' && event.type === 'keydown' && !event.repeat) copyingKey = terminal.hasSelection() || event.shiftKey;
      if (event.code === 'KeyC' && copyingKey) {
        event.preventDefault(); if (event.type === 'keydown') clipboardActions.copySelection(); return false;
      }
      if (event.code === 'KeyV') { event.preventDefault(); if (event.type === 'keydown') clipboardActions.paste(); return false; }
      if (event.type === 'keydown' && event.shiftKey && event.code === 'KeyF') { event.preventDefault(); setFind(true); return false; }
      return true;
    });
    const observer = new ResizeObserver(() => { if (container.current?.clientWidth) { fitAddon.fit(); api.resize(session.id, terminal.cols, terminal.rows); } });
    observer.observe(container.current!);
    return () => { disposed = true; clipboardActions.dispose(); clipboard.current = null; clearTimeout(copiedTimer); unsubscribe(); observer.disconnect(); input.dispose(); resize.dispose(); terminal.dispose(); term.current = null; };
    // Each session owns its terminal for the lifetime of its tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  useEffect(() => { if (term.current) term.current.options.theme = terminalTheme(theme); }, [theme]);
  useEffect(() => { if (term.current) { term.current.options.fontSize = fontSize; if (visible) fit.current?.fit(); } }, [fontSize, visible]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fit.current?.fit(); if (term.current) { api.resize(session.id, term.current.cols, term.current.rows); term.current.focus(); } });
    return () => cancelAnimationFrame(frame);
  }, [visible, session.status, session.id]);
  return <div className={`terminal-pane ${visible ? 'visible' : ''}`}>
    <div className="terminal-toolbar"><div><span className={`status-dot ${session.status}`} /><span>{session.status === 'connected' ? '已连接' : session.status === 'connecting' ? '正在连接…' : session.status === 'error' ? '连接失败' : '会话已结束'}</span><span className="mono faint">xterm-256color · UTF-8</span></div><div><button className={`button small sftp-toggle ${filesOpen ? 'opened' : ''}`} aria-label="SFTP 文件管理" aria-expanded={filesOpen} disabled={session.status !== 'connected' && !filesMounted} onClick={() => { setFilesMounted(true); setFilesOpen(!filesOpen); }}><Folder size={14} />文件</button><button className="icon-button" title="搜索终端 Ctrl+Shift+F" aria-label="搜索终端" onClick={() => setFind(!find)}><Search size={15} /></button><button className="icon-button" title={copied ? '已复制选中内容' : '鼠标选中自动复制 · Ctrl+C'} aria-label="复制终端选中内容" onClick={() => clipboard.current?.copySelection()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button><button className="icon-button" title="清空终端" aria-label="清空终端" onClick={() => term.current?.clear()}><Eraser size={15} /></button></div></div>
    {find && <div className="terminal-search"><Search size={14} /><input autoFocus placeholder="搜索终端内容" value={query} onChange={e => { setQuery(e.target.value); search.current?.findNext(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') e.shiftKey ? search.current?.findPrevious(query) : search.current?.findNext(query); if (e.key === 'Escape') setFind(false); }} /><button className="icon-button" onClick={() => setFind(false)} aria-label="关闭搜索"><X size={14} /></button></div>}
    {session.log?.status === 'error' && <div className="session-message error" role="alert"><span>{session.log.message}</span></div>}
    {session.message && <div className={`session-message ${session.status === 'error' ? 'error' : ''}`}><span>{session.message} · 按 R 重连</span><button className="button small" title="重新连接（R）" onClick={onReconnect}><RotateCw size={13} />重新连接</button></div>}
    <div className={`terminal-split ${filesOpen ? 'with-files' : ''}`} ref={split}><div className="terminal-console"><div ref={container} className="terminal-container" /></div>{filesMounted && <><div style={{ display: filesOpen ? undefined : 'none' }} className="sftp-divider" role="separator" aria-label="调整文件面板宽度" aria-orientation="vertical" aria-valuemin={32} aria-valuemax={65} aria-valuenow={fileWidth} tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setFileWidth(w => Math.min(65, Math.max(32, w + (e.key === 'ArrowLeft' ? 3 : -3)))); } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId) && split.current) { const box = split.current.getBoundingClientRect(); setFileWidth(Math.min(65, Math.max(32, (box.right - e.clientX) / box.width * 100))); } }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} /><div className="sftp-region" style={{ width: `${fileWidth}%`, display: filesOpen ? undefined : 'none' }}><SftpPanel session={session} notify={notify} onClose={() => setFilesOpen(false)} /></div></>}</div>
    <div className="terminal-bottom"><span>选中自动复制 · Ctrl+C 复制（无选区中断） · Ctrl+V / 右键粘贴</span><span className={`terminal-log ${session.log?.status || ''}`} title={session.log?.path}><FileText size={13} />{session.log?.status === 'recording' ? '日志记录中' : session.log?.status === 'saved' ? '日志已保存' : session.log?.status === 'error' ? '日志异常' : ''}</span></div>
  </div>;
}
