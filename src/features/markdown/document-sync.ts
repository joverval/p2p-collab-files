// Document sync — Yjs doc, update batching, transaction origins

import * as Y from 'yjs';

export const NETWORK_ORIGIN = Symbol('network');
export const FILE_OPEN_ORIGIN = Symbol('file-open');

const pendingUpdates: Uint8Array[] = [];
let pendingBytes = 0;
let flushTimer: any = undefined;

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
  pendingUpdates.push(update);
  pendingBytes += update.byteLength;
  if (pendingBytes >= 48 * 1024 || pendingUpdates.length >= 32) flush(sendFn, isConnected);
  else if (!flushTimer) flushTimer = setTimeout(() => flush(sendFn, isConnected), 20);
}

function flush(sendFn: (data: Uint8Array) => void, isConnected: () => boolean) {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pendingUpdates.length || !isConnected()) return;
  const merged = Y.mergeUpdates(pendingUpdates.splice(0));
  pendingBytes = 0;
  sendFn(merged);
}