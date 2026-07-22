// MarkdownFeature — implements CollaborationFeature for the shell

import * as Y from 'yjs';
import type { EditorView } from 'codemirror';
import type { CollaborationFeature, FeatureContext } from '../../shared/types';
import { createDoc, NETWORK_ORIGIN, enqueueLocalUpdate, FILE_OPEN_ORIGIN } from './document-sync';
import { createEditor } from './editor-controller';
import { FileController } from './file-controller';
import { PreviewController } from './preview-controller';
import { encodeChat } from '../../shell/protocol/message-envelope';

export class MarkdownFeature implements CollaborationFeature {
  private ydoc: Y.Doc | null = null;
  private ytext: Y.Text | null = null;
  private undoManager: Y.UndoManager | null = null;
  private editorView: EditorView | null = null;
  private fileController: FileController | null = null;
  private preview: PreviewController | null = null;
  private ctx: FeatureContext | null = null;

  start(ctx: FeatureContext): void {
    this.ctx = ctx;
    const { ydoc, ytext, undoManager } = createDoc();
    this.ydoc = ydoc; this.ytext = ytext; this.undoManager = undoManager;

    this.fileController = new FileController(
      () => ctx.isHost(),
      (name) => ctx.sendControlMessage(`[FILENAME]${name}`)
    );

    this.preview = new PreviewController(() => this.ytext);

    this.editorView = createEditor(ytext, undoManager,
      () => this.preview?.schedule(),
      (line, totalLines) => {
        const p = document.getElementById('preview');
        if (p) p.scrollTop = (line / totalLines) * (p.scrollHeight - p.clientHeight);
      }
    );

    // Send locally-created updates
    ydoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === NETWORK_ORIGIN) return;
      if (ctx.isConnected()) {
        enqueueLocalUpdate(update,
          (data) => ctx.sendFeatureData(data),
          () => ctx.isConnected()
        );
      }
    });

    this.preview.render();
  }

  onConnected(): void {}

  onDisconnected(): void {}

  handleFeatureData(data: Uint8Array, _peerId?: string): void {
    if (!this.ydoc || !this.ytext) return;
    // Decode outer envelope: data = [0x01, seqHi, seqLo, ...update]
    const update = data.slice(3);
    Y.applyUpdate(this.ydoc, update, NETWORK_ORIGIN);
    this.preview?.schedule();
  }

  handleControlMessage(text: string): void {
    if (text.startsWith('[FILENAME]')) {
      this.fileController!.filename = text.slice(10);
    } else if (text.startsWith('[SYNC]')) {
      if (this.ydoc && this.ctx) {
        this.ctx.sendFeatureData(Y.encodeStateAsUpdate(this.ydoc));
      }
    }
  }

  get editor(): EditorView | null { return this.editorView; }
  get doc(): Y.Doc | null { return this.ydoc; }
  get text(): Y.Text | null { return this.ytext; }
  get file(): FileController | null { return this.fileController; }
  get undo(): Y.UndoManager | null { return this.undoManager; }
  get previewCtrl(): PreviewController | null { return this.preview; }

  destroy(): void {
    this.editorView?.destroy();
    this.ydoc?.destroy();
  }
}