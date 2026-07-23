// Document sync — Yjs doc, update batching, transaction origins

import * as Y from 'yjs';

export const NETWORK_ORIGIN = Symbol('network');
export const FILE_OPEN_ORIGIN = Symbol('file-open');

export class SyncQueue {
  private pendingUpdates: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sendFn: (data: Uint8Array) => void;
  private readonly isConnected: () => boolean;
  private readonly byteThreshold: number;
  private readonly countThreshold: number;
  private readonly flushDelayMs: number;

  constructor(
    sendFn: (data: Uint8Array) => void,
    isConnected: () => boolean,
    opts?: { byteThreshold?: number; countThreshold?: number; flushDelayMs?: number }
  ) {
    this.sendFn = sendFn;
    this.isConnected = isConnected;
    this.byteThreshold = opts?.byteThreshold ?? 48 * 1024;
    this.countThreshold = opts?.countThreshold ?? 32;
    this.flushDelayMs = opts?.flushDelayMs ?? 20;
  }

  enqueue(update: Uint8Array): void {
    this.pendingUpdates.push(update);
    this.pendingBytes += update.byteLength;
    if (this.pendingBytes >= this.byteThreshold || this.pendingUpdates.length >= this.countThreshold) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
    }
  }

  flush(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.pendingUpdates.length || !this.isConnected()) return;
    const merged = Y.mergeUpdates(this.pendingUpdates.splice(0));
    this.pendingBytes = 0;
    this.sendFn(merged);
  }

  get queuedBytes(): number { return this.pendingBytes; }
  get queuedCount(): number { return this.pendingUpdates.length; }

  destroy(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.pendingUpdates = [];
    this.pendingBytes = 0;
  }
}

// ── Legacy module-level API (kept for backward compat) ──

const legacyPendingUpdates: Uint8Array[] = [];
let legacyPendingBytes = 0;
let legacyFlushTimer: any = undefined;

export function createDoc(): { ydoc: Y.Doc; ytext: Y.Text; undoManager: Y.UndoManager } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('document');
  const undoManager = new Y.UndoManager(ytext);
  return { ydoc, ytext, undoManager };
}

export function enqueueLocalUpdate(
  update: Uint8Array,
  sendFn: (data: Uint8Array) => void,
  isConnected: () => boolean
) {
  legacyPendingUpdates.push(update);
  legacyPendingBytes += update.byteLength;
  if (legacyPendingBytes >= 48 * 1024 || legacyPendingUpdates.length >= 32) legacyFlush(sendFn, isConnected);
  else if (!legacyFlushTimer) legacyFlushTimer = setTimeout(() => legacyFlush(sendFn, isConnected), 20);
}

function legacyFlush(sendFn: (data: Uint8Array) => void, isConnected: () => boolean) {
  clearTimeout(legacyFlushTimer);
  legacyFlushTimer = undefined;
  if (!legacyPendingUpdates.length || !isConnected()) return;
  const merged = Y.mergeUpdates(legacyPendingUpdates.splice(0));
  legacyPendingBytes = 0;
  sendFn(merged);
}
