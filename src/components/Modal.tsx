import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = dialog.current!; el.showModal(); return () => el.close(); }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) { const box = dialog.current!.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose(); } }}>
    <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={19} /></button></header>{children}
  </dialog>;
}
export function Confirm({ title, text, onConfirm, onClose }: { title: string; text: ReactNode; onConfirm: () => Promise<void>; onClose: () => void }) {
  const busy = useRef(false);
  return <Modal title={title} onClose={onClose}><div className="confirm-text">{text}</div><footer className="modal-footer"><button className="button" onClick={onClose}>取消</button><button className="button danger" onClick={async () => { if (busy.current) return; busy.current = true; try { await onConfirm(); onClose(); } catch {} finally { busy.current = false; } }}>确认删除</button></footer></Modal>;
}
