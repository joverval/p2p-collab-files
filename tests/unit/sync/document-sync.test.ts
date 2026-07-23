// tests/unit/sync/document-sync.test.ts
// Tests B.1–B.10: Yjs document synchronization, state vectors, SyncQueue

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { createDoc, SyncQueue, NETWORK_ORIGIN, FILE_OPEN_ORIGIN } from '../../../src/features/markdown/document-sync';

/** Helper: create a real Yjs update from a text insertion */
function makeYjsUpdate(text: string): Uint8Array {
  const d = new Y.Doc();
  const t = d.getText('document');
  t.insert(0, text);
  return Y.encodeStateAsUpdate(d);
}

describe('Yjs Document Synchronization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // B.1 — Host initial document → peer state-vector sync
  describe('B.1 — Host initial document → peer state-vector sync', () => {
    it('peer receives full initial document from empty state', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, '# Hello\n\nThis is a test document.');
      const fullState = Y.encodeStateAsUpdate(host.ydoc);
      Y.applyUpdate(peer.ydoc, fullState, NETWORK_ORIGIN);

      expect(peer.ytext.toString()).toBe('# Hello\n\nThis is a test document.');
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer.ydoc));
    });

    it('state-vector sync: host sends only what peer is missing', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, 'First edit.');
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      host.ytext.insert(host.ytext.length, ' Second edit.');
      const peerSV = Y.encodeStateVector(peer.ydoc);
      const missing = Y.encodeStateAsUpdate(host.ydoc, peerSV);
      Y.applyUpdate(peer.ydoc, missing, NETWORK_ORIGIN);

      expect(peer.ytext.toString()).toBe('First edit. Second edit.');
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer.ydoc));
    });
  });

  // B.2 — Peer 1 edits → host applies → peer 2 receives
  describe('B.2 — Peer 1 edits → host applies → peer 2 receives', () => {
    it('edit propagates through host to another peer', () => {
      const host = createDoc();
      const peer1 = createDoc();
      const peer2 = createDoc();

      host.ytext.insert(0, 'base content');
      const initUpdate = Y.encodeStateAsUpdate(host.ydoc);
      Y.applyUpdate(peer1.ydoc, initUpdate, NETWORK_ORIGIN);
      Y.applyUpdate(peer2.ydoc, initUpdate, NETWORK_ORIGIN);

      peer1.ytext.insert(peer1.ytext.length, ' + peer1');
      const peer1Update = Y.encodeStateAsUpdate(peer1.ydoc, Y.encodeStateVector(host.ydoc));
      Y.applyUpdate(host.ydoc, peer1Update, NETWORK_ORIGIN);

      const missingForPeer2 = Y.encodeStateAsUpdate(host.ydoc, Y.encodeStateVector(peer2.ydoc));
      Y.applyUpdate(peer2.ydoc, missingForPeer2, NETWORK_ORIGIN);

      expect(peer2.ytext.toString()).toBe('base content + peer1');
      expect(host.ytext.toString()).toBe('base content + peer1');
    });
  });

  // B.3 — Peer 2 late join receives full history
  describe('B.3 — Late join receives full history', () => {
    it('late-joining peer gets all prior edits', () => {
      const host = createDoc();
      const peer1 = createDoc();

      host.ytext.insert(0, 'initial');
      Y.applyUpdate(peer1.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      peer1.ytext.insert(peer1.ytext.length, ' + p1');
      Y.applyUpdate(host.ydoc, Y.encodeStateAsUpdate(peer1.ydoc, Y.encodeStateVector(host.ydoc)), NETWORK_ORIGIN);

      host.ytext.insert(host.ytext.length, ' + host');

      const peer2 = createDoc();
      Y.applyUpdate(peer2.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      expect(peer2.ytext.toString()).toBe('initial + p1 + host');
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer2.ydoc));
    });
  });

  // B.4 — Concurrent host/peer edits converge
  describe('B.4 — Concurrent edits converge', () => {
    it('concurrent edits from host and peer converge', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, 'ABCDEF');
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      host.ytext.insert(3, '111');
      peer.ytext.insert(3, '222');

      const hostUpdate = Y.encodeStateAsUpdate(host.ydoc, Y.encodeStateVector(peer.ydoc));
      const peerUpdate = Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(host.ydoc));

      Y.applyUpdate(host.ydoc, peerUpdate, NETWORK_ORIGIN);
      Y.applyUpdate(peer.ydoc, hostUpdate, NETWORK_ORIGIN);

      expect(host.ytext.toString()).toBe(peer.ytext.toString());
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer.ydoc));
    });

    it('concurrent deletes converge', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, 'ABCDEFGH');
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      host.ytext.delete(2, 3);
      peer.ytext.delete(4, 3);

      Y.applyUpdate(host.ydoc, Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(host.ydoc)), NETWORK_ORIGIN);
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc, Y.encodeStateVector(peer.ydoc)), NETWORK_ORIGIN);

      expect(host.ytext.toString()).toBe(peer.ytext.toString());
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer.ydoc));
    });
  });

  // B.5 — Duplicate updates are harmless
  describe('B.5 — Duplicate updates are harmless', () => {
    it('applying the same update twice does not corrupt state', () => {
      const doc = createDoc();
      doc.ytext.insert(0, 'original text');
      const update = Y.encodeStateAsUpdate(doc.ydoc);

      const doc2 = createDoc();
      Y.applyUpdate(doc2.ydoc, update, NETWORK_ORIGIN);
      const textBefore = doc2.ytext.toString();

      Y.applyUpdate(doc2.ydoc, update, NETWORK_ORIGIN);
      expect(doc2.ytext.toString()).toBe(textBefore);
    });

    it('duplicate partial updates are harmless', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, 'Hello');
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      host.ytext.insert(5, ' World');
      const delta = Y.encodeStateAsUpdate(host.ydoc, Y.encodeStateVector(peer.ydoc));
      Y.applyUpdate(peer.ydoc, delta, NETWORK_ORIGIN);
      Y.applyUpdate(peer.ydoc, delta, NETWORK_ORIGIN);

      expect(peer.ytext.toString()).toBe('Hello World');
    });
  });

  // B.6 — Out-of-order updates converge
  describe('B.6 — Out-of-order updates converge', () => {
    it('concurrent edits from two peers converge when exchanged', () => {
      const docA = createDoc();
      const docB = createDoc();

      docA.ytext.insert(0, 'XY');
      const initUpdate = Y.encodeStateAsUpdate(docA.ydoc);
      Y.applyUpdate(docB.ydoc, initUpdate, NETWORK_ORIGIN);

      docA.ytext.insert(1, '1');
      docB.ytext.insert(1, '2');

      const updateA = Y.encodeStateAsUpdate(docA.ydoc);
      const updateB = Y.encodeStateAsUpdate(docB.ydoc);

      Y.applyUpdate(docB.ydoc, updateA, NETWORK_ORIGIN);
      Y.applyUpdate(docA.ydoc, updateB, NETWORK_ORIGIN);

      expect(docA.ytext.toString()).toBe(docB.ytext.toString());
      expect(Y.encodeStateVector(docA.ydoc)).toEqual(Y.encodeStateVector(docB.ydoc));
    });
  });

  // B.7 — Reconnection state-vector sends only missing data
  describe('B.7 — Reconnection state-vector sends only missing data', () => {
    it('after disconnect, only missing updates are sent', () => {
      const host = createDoc();
      const peer = createDoc();

      host.ytext.insert(0, 'Start');
      Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(host.ydoc), NETWORK_ORIGIN);

      host.ytext.insert(host.ytext.length, ' more edits by host');

      const peerSV = Y.encodeStateVector(peer.ydoc);
      const missing = Y.encodeStateAsUpdate(host.ydoc, peerSV);
      Y.applyUpdate(peer.ydoc, missing, NETWORK_ORIGIN);

      expect(peer.ytext.toString()).toBe('Start more edits by host');
      expect(Y.encodeStateVector(host.ydoc)).toEqual(Y.encodeStateVector(peer.ydoc));
    });

    it('state vector on identical docs produces minimal header-only update', () => {
      const doc = createDoc();
      doc.ytext.insert(0, 'synced');
      const sv = Y.encodeStateVector(doc.ydoc);
      const missing = Y.encodeStateAsUpdate(doc.ydoc, sv);

      // Yjs includes a minimal header even when nothing is missing
      // Applying this to a fresh doc should leave it empty
      const doc2 = createDoc();
      Y.applyUpdate(doc2.ydoc, missing, NETWORK_ORIGIN);
      expect(doc2.ytext.toString()).toBe('');
    });
  });

  // B.8 — File-open transaction synchronizes once
  describe('B.8 — File-open transaction synchronizes once', () => {
    it('FILE_OPEN_ORIGIN marks bulk file-open updates', () => {
      const doc = createDoc();
      doc.ydoc.transact(() => {
        doc.ytext.insert(0, '# File Content\n\nLots of text here.');
      }, FILE_OPEN_ORIGIN);

      expect(doc.ytext.toString()).toBe('# File Content\n\nLots of text here.');

      let receivedOrigin: any = undefined;
      const doc2 = createDoc();
      doc2.ydoc.on('update', (_update, origin) => {
        receivedOrigin = origin;
      });

      Y.applyUpdate(doc2.ydoc, Y.encodeStateAsUpdate(doc.ydoc), FILE_OPEN_ORIGIN);
      expect(doc2.ytext.toString()).toBe('# File Content\n\nLots of text here.');
      expect(receivedOrigin).toBe(FILE_OPEN_ORIGIN);
    });

    it('file-open update is applied exactly once per peer', () => {
      const host = createDoc();
      host.ydoc.transact(() => {
        host.ytext.insert(0, 'file contents');
      }, FILE_OPEN_ORIGIN);

      const peer = createDoc();
      const fullState = Y.encodeStateAsUpdate(host.ydoc);
      Y.applyUpdate(peer.ydoc, fullState, FILE_OPEN_ORIGIN);
      Y.applyUpdate(peer.ydoc, fullState, FILE_OPEN_ORIGIN);
      expect(peer.ytext.toString()).toBe('file contents');
    });
  });

  // B.9 — Queued edits flush after reconnect (SyncQueue)
  describe('B.9 — Queued edits flush after reconnect (SyncQueue)', () => {
    it('SyncQueue accumulates updates while disconnected and flushes on reconnect', async () => {
      let connected = false;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { flushDelayMs: 5, byteThreshold: 100000, countThreshold: 10 });

      queue.enqueue(makeYjsUpdate('hello'));
      queue.enqueue(makeYjsUpdate('world'));

      expect(queue.queuedCount).toBe(2);
      expect(sent.length).toBe(0);

      connected = true;
      queue.flush();

      expect(sent.length).toBe(1);
      expect(queue.queuedCount).toBe(0);
      expect(queue.queuedBytes).toBe(0);
    });

    it('SyncQueue flushes immediately when byte threshold is exceeded', () => {
      let connected = true;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const bigUpdate = makeYjsUpdate('x'.repeat(200)); // large enough
      const queue = new SyncQueue(sendFn, () => connected, { byteThreshold: 5, countThreshold: 100 });

      queue.enqueue(bigUpdate);
      expect(sent.length).toBe(1);
      expect(queue.queuedCount).toBe(0);
    });

    it('SyncQueue flushes after count threshold', () => {
      let connected = true;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { countThreshold: 2, byteThreshold: 100000 });

      queue.enqueue(makeYjsUpdate('a'));
      expect(sent.length).toBe(0);
      queue.enqueue(makeYjsUpdate('b'));
      expect(sent.length).toBe(1);
    });

    it('SyncQueue flush debounces via timer', () => {
      vi.useFakeTimers();
      let connected = true;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { flushDelayMs: 20, byteThreshold: 100000 });

      queue.enqueue(makeYjsUpdate('x'));
      expect(sent.length).toBe(0);

      vi.advanceTimersByTime(20);
      expect(sent.length).toBe(1);

      vi.useRealTimers();
    });

    it('SyncQueue multiple enqueues are batched into single flush', () => {
      vi.useFakeTimers();
      let connected = true;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { flushDelayMs: 20, byteThreshold: 100000 });

      queue.enqueue(makeYjsUpdate('p'));
      queue.enqueue(makeYjsUpdate('q'));
      queue.enqueue(makeYjsUpdate('r'));
      expect(sent.length).toBe(0);

      vi.advanceTimersByTime(20);
      expect(sent.length).toBe(1);

      vi.useRealTimers();
    });
  });

  // B.10 — Destroy clears timers and queue
  describe('B.10 — Destroy clears timers and queue', () => {
    it('destroy clears all pending state', () => {
      let connected = false;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { flushDelayMs: 20 });

      const up = makeYjsUpdate('test');
      queue.enqueue(up);
      queue.enqueue(up);
      expect(queue.queuedCount).toBe(2);
      expect(queue.queuedBytes).toBeGreaterThan(0);

      queue.destroy();

      expect(queue.queuedCount).toBe(0);
      expect(queue.queuedBytes).toBe(0);
    });

    it('destroy cancels pending flush timer', () => {
      vi.useFakeTimers();
      let connected = true;
      const sent: Uint8Array[] = [];
      const sendFn = (data: Uint8Array) => { sent.push(data); };

      const queue = new SyncQueue(sendFn, () => connected, { flushDelayMs: 20, byteThreshold: 100000 });

      queue.enqueue(makeYjsUpdate('x'));
      expect(sent.length).toBe(0);

      queue.destroy();

      vi.advanceTimersByTime(20);
      expect(sent.length).toBe(0);

      vi.useRealTimers();
    });
  });

  // Extra: NETWORK_ORIGIN prevents echo
  describe('origin filtering', () => {
    it('NETWORK_ORIGIN distinguishes remote updates from local', () => {
      const origins: any[] = [];
      const doc = createDoc();
      doc.ydoc.on('update', (_update, origin) => {
        origins.push(origin);
      });

      // Local edit
      doc.ytext.insert(0, 'local');
      expect(origins.length).toBe(1);
      expect(origins[0]).toBeNull(); // Yjs uses null for local edits

      // Create an update from a separate doc to apply as "network" update
      const remoteDoc = createDoc();
      remoteDoc.ytext.insert(0, 'remote data');
      const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc.ydoc);

      Y.applyUpdate(doc.ydoc, remoteUpdate, NETWORK_ORIGIN);
      expect(origins.length).toBe(2);
      expect(origins[1]).toBe(NETWORK_ORIGIN);
    });
  });
});