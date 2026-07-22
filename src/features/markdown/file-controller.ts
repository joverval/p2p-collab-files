// File controller — open/save Markdown files

import { $, el } from '../../shared/dom';
import type * as Y from 'yjs';
import type { EditorView } from 'codemirror';
import { FILE_OPEN_ORIGIN } from './document-sync';

export class FileController {
  fileHandle: FileSystemFileHandle | null = null;
  private _fileInput: HTMLInputElement | null = null;

  get filename(): string {
    return ($('topbar-filename') as HTMLElement).textContent || 'Untitled.md';
  }
  set filename(name: string) {
    ($('topbar-filename') as HTMLElement).textContent = name;
  }

  constructor(
    private isHost: () => boolean,
    private onFilenameBroadcast: (name: string) => void,
  ) {}

  async openFile(ydoc: Y.Doc, ytext: Y.Text, editorView: EditorView | null) {
    if (!this.isHost() || !ydoc) return;
    try {
      let name: string, c: string;
      if (this.hasFileSystemAPI()) {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
        this.fileHandle = h; name = h.name; c = await (await h.getFile()).text();
      } else {
        const r = await this.fallbackOpenFile();
        name = r.name; c = r.content;
      }
      ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, c); }, FILE_OPEN_ORIGIN);
      if (editorView) editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: c } });
      this.filename = name;
      this.onFilenameBroadcast(name);
    } catch (err: any) { if (err.name !== 'AbortError') console.error(err); }
  }

  async saveFile(content: string) {
    const name = this.filename;
    if (this.hasFileSystemAPI()) {
      if (this.isHost() && this.fileHandle) {
        try { const w = await this.fileHandle.createWritable(); await w.write(content); await w.close(); return; } catch {}
      }
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
        const w = await h.createWritable(); await w.write(content); await w.close();
        if (this.isHost()) { this.fileHandle = h; this.filename = h.name; this.onFilenameBroadcast(h.name); }
      } catch {}
    } else {
      this.fallbackSaveFile(content, name);
    }
  }

  private hasFileSystemAPI() { return typeof window.showOpenFilePicker === 'function'; }

  private getFileInput(): HTMLInputElement {
    if (!this._fileInput) {
      this._fileInput = el('input', { type: 'file', accept: '.md' }) as HTMLInputElement;
      this._fileInput.style.display = 'none';
      document.body.appendChild(this._fileInput);
    }
    return this._fileInput;
  }

  private fallbackOpenFile(): Promise<{ name: string; content: string }> {
    return new Promise((resolve, reject) => {
      const i = this.getFileInput();
      i.onchange = async () => { const f = i.files?.[0]; if (!f) return reject(new Error('No file')); resolve({ name: f.name, content: await f.text() }); };
      i.click();
    });
  }

  private fallbackSaveFile(content: string, name: string) {
    const b = new Blob([content], { type: 'text/markdown' });
    const a = el('a', { href: URL.createObjectURL(b), download: name }); a.click();
  }
}