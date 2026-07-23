// MarkdownFeature — implements CollaborationFeature for the shell

import * as Y from 'yjs';
import type { EditorView } from 'codemirror';
import type { CollaborationFeature, FeatureContext } from '../../shared/types';
import { createDoc, NETWORK_ORIGIN, SyncQueue } from './document-sync';
import { createEditor } from './editor-controller';
import { FileController } from './file-controller';
import { PreviewController } from './preview-controller';

// Sync subprotocol message kinds (2-byte prefix)
// 0x02 0x00 = SYNC_STEP_1 (state vector) — used in onPeerJoined via encodeStateAsUpdate
// 0x03 0x00 = SYNC_STEP_2 (missing update)
function encodeSyncStep1(vector: Uint8Array): Uint8Array {
  const m = new Uint8Array(2 + vector.length);
  m[0] = 0x02; m[1] = 0x00;
  m.set(vector, 2);
  return m;
}
function encodeSyncStep2(update: Uint8Array): Uint8Array {
  const m = new Uint8Array(2 + update.length);
  m[0] = 0x03; m[1] = 0x00;
  m.set(update, 2);
  return m;
}

export class MarkdownFeature implements CollaborationFeature {
  private ydoc: Y.Doc | null = null;
  private ytext: Y.Text | null = null;
  private undoManager: Y.UndoManager | null = null;
  private editorView: EditorView | null = null;
  private fileController: FileController | null = null;
  private preview: PreviewController | null = null;
  private ctx: FeatureContext | null = null;
  private syncQueue: SyncQueue | null = null;

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

    // Send locally-created updates via SyncQueue (batch + throttle)
    this.syncQueue = new SyncQueue(
      (data) => ctx.sendFeatureData(data),
      () => ctx.isConnected()
    );
    ydoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === NETWORK_ORIGIN) return;
      if (ctx.isConnected()) {
        this.syncQueue!.enqueue(update);
      }
    });

    this.preview.render();
  }

  onConnected(): void {
    if (!this.ydoc || !this.ctx || this.ctx.isHost()) return;
    // Late-join sync: request full document state from host via SYNC_STEP_1
    const stateVector = Y.encodeStateVector(this.ydoc);
    const msg = encodeSyncStep1(stateVector);
    this.ctx.sendFeatureData(msg);
  }

  onDisconnected(): void {}

  onPeerJoined(peerId: string): void {
    if (!this.ctx?.isHost() || !this.ydoc) return;
    // Minimum fix: send complete document state as update to the new peer
    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    this.ctx!.sendFeatureDataToPeer(peerId, fullState);
  }

  handleFeatureData(data: Uint8Array, _peerId?: string): void {
    if (!this.ydoc) return;
    const update = data.slice(3); // strip 0x01 + seq envelope

    // Check sync subprotocol prefix
    if (update.length >= 2 && update[0] === 0x02 && update[1] === 0x00) {
      // SYNC_STEP_1: received state vector — compute missing update and reply to specific peer
      const stateVector = update.slice(2);
      const missing = Y.encodeStateAsUpdate(this.ydoc, stateVector);
      if (_peerId) {
        this.ctx!.sendFeatureDataToPeer(_peerId, encodeSyncStep2(missing));
      } else {
        this.ctx!.sendFeatureData(encodeSyncStep2(missing));
      }
    } else if (update.length >= 2 && update[0] === 0x03 && update[1] === 0x00) {
      // SYNC_STEP_2: received missing update — apply it
      Y.applyUpdate(this.ydoc, update.slice(2), NETWORK_ORIGIN);
    } else {
      // Regular update
      Y.applyUpdate(this.ydoc, update, NETWORK_ORIGIN);
    }
    this.preview?.schedule();
  }

  handleControlMessage(text: string): void {
    if (text.startsWith('[FILENAME]')) {
      this.fileController!.filename = text.slice(10);
    } else if (text.startsWith('[SYNC]')) {
      // Manual sync: host sends full state
      if (this.ydoc && this.ctx?.isHost()) {
        const fullState = Y.encodeStateAsUpdate(this.ydoc);
        this.ctx.sendFeatureData(fullState);
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
    this.syncQueue?.destroy();
    this.editorView?.destroy();
    this.ydoc?.destroy();
  }
}