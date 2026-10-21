import type { Terminal } from '@xterm/xterm';

// Keep native clipboard operations ordered, including when switching SSH tabs.
let clipboardOperation: Promise<void> = Promise.resolve();

export function bindTerminalClipboard(terminal: Terminal, element: HTMLElement, options: {
  connected: () => boolean;
  active: () => boolean;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<string>;
  onCopied: () => void;
  onError: (error: unknown) => void;
}) {
  let disposed = false, selecting = false;
  const view = element.ownerDocument.defaultView!;
  const enqueue = (operation: () => Promise<void>) => {
    const pending = clipboardOperation.then(async () => { if (!disposed) await operation(); });
    clipboardOperation = pending.catch(() => {});
    void pending.catch(error => { if (!disposed) options.onError(error); });
  };
  const copySelection = (clearAfter = true) => {
    const text = terminal.getSelection();
    const position = terminal.getSelectionPosition();
    // A plain click or an empty selection must never erase the clipboard.
    if (!text) return;
    enqueue(async () => {
      await options.copy(text);
      if (!disposed) {
        // Do not clear a newer selection made while the native copy was pending.
        if (clearAfter && !selecting && JSON.stringify(terminal.getSelectionPosition()) === JSON.stringify(position)) terminal.clearSelection();
        options.onCopied();
      }
    });
  };
  const paste = () => {
    if (!options.connected() || !options.active()) return;
    terminal.focus();
    enqueue(async () => {
      if (!options.connected() || !options.active()) return;
      const text = await options.paste();
      if (!disposed && options.connected() && options.active() && text) {
        // xterm normalizes line endings and honors the remote bracketed-paste mode.
        terminal.clearSelection(); terminal.paste(text);
      }
    });
  };
  const mouseDown = (event: MouseEvent) => {
    if (event.button === 0) selecting = true;
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); }
  };
  const mouseUp = (event: MouseEvent) => {
    if (event.button !== 0 || !selecting) return;
    selecting = false;
    // Window bubbling runs after xterm's document mouseup selection handling.
    copySelection(false);
  };
  const rightRelease = (event: MouseEvent) => {
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); }
  };
  const contextMenu = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation(); paste();
  };
  const cancelSelection = () => { selecting = false; };
  element.addEventListener('mousedown', mouseDown, true);
  element.addEventListener('mouseup', rightRelease, true);
  element.addEventListener('auxclick', rightRelease, true);
  element.addEventListener('contextmenu', contextMenu, true);
  view.addEventListener('mouseup', mouseUp);
  view.addEventListener('blur', cancelSelection);
  return {
    copySelection, paste,
    dispose() {
      disposed = true; selecting = false;
      element.removeEventListener('mousedown', mouseDown, true);
      element.removeEventListener('mouseup', rightRelease, true);
      element.removeEventListener('auxclick', rightRelease, true);
      element.removeEventListener('contextmenu', contextMenu, true);
      view.removeEventListener('mouseup', mouseUp);
      view.removeEventListener('blur', cancelSelection);
    },
  };
}
