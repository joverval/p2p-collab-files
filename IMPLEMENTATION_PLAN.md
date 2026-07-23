# P2P-COLLAB-FILES — Functional Correctness Implementation Plan

## Current State Assessment

Contrary to the spec's opening description, the codebase has already progressed beyond some claimed gaps. Key findings:

**Already in place:**
- `SignalingClient` already implements `connect()`, `send()`, `request()`, `on()`, `fetchIceConfig()`, `iceConfig`, `refreshIfNeeded()`, `close()` — the full API the spec asks for.
- `npm run typecheck` already exists in `package.json`.
- `env` vars `VITE_SIGNAL_WS_URL` / `VITE_SIGNAL_HTTP_URL` already read.
- `onPeerJoined` already sends `Y.encodeStateAsUpdate(ydoc)` as minimum fallback.
- `handleFeatureData` already has SYNC_STEP_1/SYNC_STEP_2 subprotocol dispatch.
- `handleFeatureData` does NOT manually replace CodeMirror — it calls `Y.applyUpdate` and stops.
- `FileController.openFile` uses a single `ydoc.transact()` — no manual `editorView.dispatch()`.
- `approvePeer()` already validates, accepts answer with exact `offerId`, sends relay after.
- `handlePromotionRequest` already consumes the `commit-promotion` response via `await`, not a duplicate listener.
- `registerPermanentHandlers` already guards against re-registration.
- `panel.setSendChat` is wired, `participants.onPromote` is wired.
- `session.onRoleChanged`, `onRoomState`, `onFeatureData`, `onControlMessage`, `onChatMessage` are all wired in `app.ts`.

**Actual gaps (what needs fixing):**
- `session.setConnected` is never assigned in `app.ts` — the callback is a no-op.
- `onConnected()` in MarkdownFeature is empty.
- Legacy module-level `enqueueLocalUpdate` is used instead of the `SyncQueue` class, and keeps scheduling timers while disconnected (endless retry loop).
- `ChatController` stores HTML strings, `renderChat()` creates empty DOM without injecting history.
- `PanelController.renderChat()` doesn't call `chat.renderInto()` to populate the log.
- Chat is concatenated into `innerHTML` (XSS risk).
- `ParticipantsController` has no `replaceSnapshot()` method; `allUsers` setter doesn't trigger re-render.
- Participant type is minimal (`email`, `isHost`), no `participantId`, `role`, `connected`, `joinOrder`.
- Room state snapshots are not broadcast consistently on join/leave/promotion/failover.
- `onRoleChanged` in `app.ts` only updates `isHost` and participant roles; missing file-control enable/disable, invite button state, manual-answer toggles, top-bar label.
- `handlePromotionRequest` closes old room before new one connects (line 322 vs 323 in session-controller.ts).
- Connection state jumps to `connected` on relay `approved` (line 58) instead of waiting for real P2P `onConnect`.
- `setupRoomHandlers` adds handlers per-room but never removes them from old rooms.
- No `destroy()` on SessionController for cleaning pending requests, timers.
- `SyncQueue` class exists but unused; `destroy()` on SyncQueue doesn't cancel flush timers properly.

---

## Task Dependency Graph

```
P0 (API reconciliation + typecheck)
 │
 └─► P1 (app.ts wiring completion)
      │
      ├─► P2 (late-join sync) ───── can run in parallel ─┐
      ├─► P3 (chat history)       ───── can run in parallel ─┤
      ├─► P4 (participant list)   ───── can run in parallel ─┤
      ├─► P5 (role-change UI)     ───── can run in parallel ─┤
      └─► P6 (approval + conn)    ───── can run in parallel ─┘
                                                           │
                                                           ▼
                                                          P7 (cleanup pass)
```

**Why P0 is foundational:** Must ensure `npm run typecheck` passes before touching anything else. Type errors in current code could cascade into fixes in P1-P6.

**Why P1 must precede P2-P6:** P1 ensures all callback hooks exist and are wired. P2-P6 each depend on specific callbacks being functional. Without P1's `setConnected` wiring, P2's reconnect logic can't work. Without P1 confirming all callbacks are correct, P3-P5 can't rely on the data flow.

**Why P3-P6 can run in parallel after P1:** They touch disjoint files/concerns:
- P3: chat-controller.ts + panel-controller.ts
- P4: participants-controller.ts + session-controller.ts (room-state broadcasting)
- P5: app.ts (role-aware UI) + session-controller.ts (promotion timing)
- P6: session-controller.ts (connection state machine) + signaling-client.ts

**Why P7 is last:** Cleanup pass must be aware of all changes from P0-P6, removing stale handlers, adding destroy methods, and ensuring no listener leaks across the full lifecycle.

---

## P0 — API Reconciliation + Typecheck

**Files:** `tsconfig.json`, `src/shell/signaling-client.ts`, `src/shared/types.ts`

**Changes:**
1. Add typed message interfaces to `src/shared/types.ts`:
   - `SignalingMessage` base type with `type: string` + `requestId?: string`
   - `OutgoingSignalMessage` for `send()`/`request()` params
   - `IncomingSignalMessage` union discriminated by `type`

2. Tighten `SignalingClient` signatures:
   - `send(msg: OutgoingSignalMessage): void`
   - `request<T>(msg: OutgoingSignalMessage, timeoutMs?: number): Promise<T>`
   - `on<T>(type: string, handler: (message: T) => void): () => void`

3. Run `npm run typecheck` and fix all revealed errors. Known likely issues:
   - `session-controller.ts` line 58: `this._connectionState = 'connected'` on relay `approved` — type is fine but logic is wrong (deferred to P6).
   - `app.ts` line 72: non-null assertions `offerId!`, `answerB64!` — may flag under strict null checks.
   - `session-controller.ts` `onMessage` callback receives `(data, peerId)` but `peerId` may be `string | undefined` — check P2PRoom type.
   - Potential mismatches between `onChatMessage` signature `(sender: string, text: string)` and how it's called.

4. Ensure `tsconfig.json` has `"noUnusedLocals": true` and `"noUnusedParameters": true` to catch dead code.

**Estimated complexity:** SMALL — mostly adding types and fixing compile errors.

**Dependencies:** None. Must complete first.

---

## P1 — Complete app.ts Callback Wiring

**Files:** `src/app.ts`, `src/shell/session-controller.ts`

**Changes:**
1. Wire `session.setConnected`:
   ```ts
   let connectionState: 'connected' | 'disconnected' = 'disconnected';
   session.setConnected = (connected) => {
     connectionState = connected ? 'connected' : 'disconnected';
   };
   ```
   Pass `connectionState` to `PanelController` constructor instead of `() => session.isConnected` (which uses the premature relay-based state). Update `PanelController` constructor to accept `() => boolean` for `isConnectedFn` — already does, but verify it reflects real P2P state.

2. Verify all callback wirings are correct against SessionController's declared callback signatures:
   - `onFeatureData(data: Uint8Array, peerId: string)` ✓ line 102
   - `onControlMessage(text: string)` ✓ line 103
   - `onChatMessage(sender: string, text: string)` ✓ line 104
   - `onRoomState(peers: Participant[])` ✓ line 105
   - `onRoleChanged(isHost: boolean, hostEmail: string)` ✓ lines 97-101
   - `onPeerJoin(peerId: string, peerEmail: string)` ✓ lines 82-86
   - `onPeerLeave(email: string)` ✓ lines 87-89
   - `onConnected(route: string)` ✓ lines 91-96
   - `onPendingRequest(email, token, offerId?, answerB64?)` ✓ lines 67-80

3. Fix `onPendingRequest` to bind approve/reject directly (no returned-callback pattern). Current code already does this (lines 71-79). ✓ No change needed.

4. Wire `participants.onPromote` and `panel.setSendChat`:
   - `participants.onPromote` ✓ lines 110-112
   - `panel.setSendChat` ✓ lines 34-37

5. Remove unused imports. Check for:
   - Any import from `encodeChat` or `encodeYjs` in `app.ts` — currently none imported directly. ✓

6. Update `PanelController` constructor call to use real P2P connection state instead of `session.isConnected`:
   - Line 21: `const panel = new PanelController(chat, participants, () => isHost, () => session.isConnected);`
   - Change to: `const panel = new PanelController(chat, participants, () => isHost, () => connectionState === 'connected');`

**Estimated complexity:** SMALL — mostly verification and one new wiring (`setConnected`).

**Dependencies:** P0 (typecheck must pass first).

---

## P2 — Fix Late-Join Document Sync and Appended Edits

**Files:** `src/features/markdown/markdown-feature.ts`, `src/features/markdown/document-sync.ts`, `src/shared/types.ts`

**Changes:**

### 2a. Implement `onConnected()` in MarkdownFeature
Currently empty (line 70). When the P2P data channel opens:
- If peer (not host), initiate sync by sending own state vector:
  ```ts
  onConnected(): void {
    if (!this.ctx?.isConnected() || !this.ydoc) return;
    if (!this.ctx.isHost()) {
      // Peer: request sync from host
      const sv = Y.encodeStateVector(this.ydoc);
      this.ctx.sendFeatureData(encodeSyncStep1(sv));
    }
  }
  ```
  Wire `onConnected` to be called from `session.onConnected` in app.ts after `ensureEditorVisible()`.

### 2b. Fix state-vector handshake to target specific peer
Current `handleFeatureData` SYNC_STEP_2 uses `sendFeatureData` (broadcast) instead of `sendFeatureDataToPeer`. Need `peerId` in the handler:
- `handleFeatureData(data: Uint8Array, peerId?: string)` already receives `peerId`.
- Change SYNC_STEP_2 response (line 90) from `this.ctx!.sendFeatureData(...)` to `this.ctx!.sendFeatureDataToPeer(peerId!, ...)` if `peerId` is provided.

### 2c. Wire `onConnected` → feature in app.ts
In `session.onConnected` handler (app.ts line 91-96), add after `ensureEditorVisible()`:
```ts
feature.onConnected();
```

### 2d. Replace legacy update queue with SyncQueue instance
- In `markdown-feature.ts`, add a `private syncQueue: SyncQueue | null = null;`
- In `start()`, create it:
  ```ts
  this.syncQueue = new SyncQueue(
    (data) => ctx.sendFeatureData(data),
    () => ctx.isConnected(),
  );
  ```
- Replace `enqueueLocalUpdate(...)` call (line 60-63) with `this.syncQueue.enqueue(update)`.
- Remove the import of `enqueueLocalUpdate`.

### 2e. Fix SyncQueue to not discard updates when disconnected
Current `flush()` (document-sync.ts line 42) returns early if not connected but leaves updates in queue. The timer keeps firing. Fix:
- When disconnected, clear the flush timer and stop scheduling new ones.
- When reconnected, call `flushNow()`.
- Expose `flushNow()` as public method.
- Add `onReconnect()` to `SyncQueue` that re-enables flushing.

### 2f. Call `syncQueue.flushNow()` on reconnect
In `onConnected()` (after the sync handshake), call `this.syncQueue?.flushNow()`.

### 2g. Deprecate legacy module-level queue
Mark `enqueueLocalUpdate` as `@deprecated` in document-sync.ts. Keep for backward compat during transition.

**Estimated complexity:** MEDIUM — multiple files, sync protocol changes, queue lifecycle.

**Dependencies:** P1 (needs `setConnected` wired so `isConnected()` returns correct state in SyncQueue).

---

## P3 — Fix Chat History, Transport, and Safety

**Files:** `src/shell/chat/chat-controller.ts`, `src/shell/panels/panel-controller.ts`, `src/shared/types.ts`, `src/shell/protocol/message-envelope.ts`

**Changes:**

### 3a. Add typed ChatMessage interface to shared/types.ts
```ts
export interface ChatMessage {
  id: string;
  senderEmail: string;
  senderRole: 'host' | 'peer' | 'system';
  text: string;
  timestamp: number;
}
```

### 3b. Replace HTML string storage with typed array in ChatController
- Replace `private _logHTML = ''` with `private messages: ChatMessage[] = []`.
- Add `addMessage(msg: ChatMessage): void` — pushes to array, calls `renderIfOpen()`.
- Add `renderInto(container: HTMLElement): void` — renders all messages as DOM nodes using `textContent` (not `innerHTML`).
- Add `addSystemMessage(text: string): void` — convenience for system log entries.
- Migrate `addLog(type, text)` to create proper `ChatMessage` objects internally.

### 3c. Fix renderChat() to inject history immediately
In `panel-controller.ts` `renderChat()`:
- After creating `#chat-log` element, call `this.chat.renderInto(logEl)`.
- Scroll log to bottom.
- Wire send button to `this._sendChatFn` (already done, line 50-56).

### 3d. Structured chat encoding
Add to `message-envelope.ts`:
```ts
export function encodeStructuredChatV2(msg: ChatMessage): Uint8Array { ... }
export function decodeChatMessage(data: Uint8Array): ChatMessage { ... }
```
Use JSON envelope: `{ kind: 'chat', id, senderEmail, senderRole, text, timestamp }`.

### 3e. Fix send path in app.ts
Current line 34-37:
```ts
panel.setSendChat((text: string) => {
  chat.addLog('sent', isHost ? `[Host]: ${text}` : text);
  session.sendChatMessage(text);
});
```
Change to construct a proper `ChatMessage` and use structured encoding:
```ts
panel.setSendChat((text: string) => {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    senderEmail: email,
    senderRole: isHost ? 'host' : 'peer',
    text,
    timestamp: Date.now(),
  };
  chat.addMessage(msg);
  session.sendChatMessage(JSON.stringify(msg)); // or use encodeStructuredChatV2
});
```

### 3f. Fix receive path in session-controller.ts
Current `onChatMessage` callback signature is `(sender: string, text: string)`. Update to either:
- Option A: Keep signature, parse structured message in app.ts callback.
- Option B: Change callback to `(message: ChatMessage) => void`.

Prefer Option B for type safety. Update session-controller.ts to decode structured chat messages.

### 3g. Remove old sendChat method from ChatController
Current `sendChat()` method (line 34-41) is unused — the send path goes through `panel.setSendChat`. Remove it.

### 3h. Safety: Use textContent for all remote text
In `renderInto()`, create DOM elements with `textContent` assignments, never `innerHTML` concatenation of remote data.

**Estimated complexity:** MEDIUM — chat controller rewrite, encoding changes, touch 4 files.

**Dependencies:** P1 (needs `panel.setSendChat` wired and `onChatMessage` callback confirmed).

---

## P4 — Share One Authoritative Participant List

**Files:** `src/shared/types.ts`, `src/shell/participants/participants-controller.ts`, `src/shell/session-controller.ts`, `src/app.ts`

**Changes:**

### 4a. Add RoomSnapshot + full Participant types to shared/types.ts
```ts
export interface Participant {
  participantId: string;
  email: string;
  role: 'host' | 'peer';
  connected: boolean;
  joinOrder: number;
}

export interface RoomSnapshot {
  roomId: string;
  version: number;
  hostParticipantId: string;
  participants: Participant[];
}
```

### 4b. Add replaceSnapshot() to ParticipantsController
```ts
replaceSnapshot(snapshot: RoomSnapshot): void {
  // Normalize and deduplicate by participantId
  // Replace complete list
  // Re-render open Users panel immediately
  // Update count
  // Sort by joinOrder
}
```

### 4c. Build and broadcast RoomSnapshot in SessionController
Add `private buildRoomSnapshot(): RoomSnapshot` that constructs from `_peerEmails` + local identity.

Broadcast after every state-changing event:
- Host creates room → initial snapshot
- Peer approved → updated snapshot to all
- Peer rejected/removed → updated snapshot to all
- Peer disconnect → updated snapshot to remaining
- Manual promotion commit → updated snapshot to all
- Automatic failover → updated snapshot to all
- Reconnection → send current snapshot to reconnecting peer

Use a monotonically increasing `version` counter. Recipients ignore snapshots with `version <= lastSeenVersion`.

### 4d. Wire relay-room-state events
In `SignalingClient.on('room-state', ...)` handler in SessionController: parse snapshot, call `onRoomState?.(snapshot)`.

### 4e. For manual signaling mode
Host sends snapshot over P2P control message `[ROOM]` (already partially implemented at line 153, 265). Standardize the format to match `RoomSnapshot` JSON.

### 4f. Update app.ts handler
Current line 105: `session.onRoomState = (peers) => { participants.allUsers = peers; updateTopBar(); }`
Change to:
```ts
session.onRoomState = (snapshot: RoomSnapshot) => {
  participants.replaceSnapshot(snapshot);
  updateRoleAwareUI();
};
```

### 4g. Remove duplicate identity state
Remove `ParticipantsController._peerEmails` and `_pendingPeerEmail`. Identity mapping lives in `SessionController._peerEmails`. ParticipantsController only holds the snapshot.

**Estimated complexity:** LARGE — touches session controller heavily (broadcast points), new types, participants controller rewrite.

**Dependencies:** P1 (needs `onRoomState` wired correctly).

---

## P5 — Update UI When Host Role Changes

**Files:** `src/app.ts`, `src/shell/session-controller.ts`

**Changes:**

### 5a. Create applyRoleState() function in app.ts
```ts
function applyRoleState(nextIsHost: boolean, hostEmail: string): void {
  const wasHost = isHost;
  isHost = nextIsHost;

  // Host/peer labels
  setTextContent('role-label', nextIsHost ? 'Host' : 'Peer');

  // File controls
  const openBtn = $('open-file-btn') as HTMLButtonElement;
  const saveBtn = $('save-file-btn') as HTMLButtonElement;
  openBtn.style.display = nextIsHost ? '' : 'none';
  openBtn.disabled = !nextIsHost;
  saveBtn.disabled = false; // peers can still save locally

  // Invite button
  ($('copy-invite-btn') as HTMLButtonElement).style.display = nextIsHost ? '' : 'none';

  // Promote buttons (will re-render when users panel opens)
  // Manual-answer controls
  if (!nextIsHost) {
    ($('manual-answer-input') as HTMLInputElement).style.display = 'none';
    ($('manual-answer-btn') as HTMLButtonElement).style.display = 'none';
  }

  // Top-bar role indicator
  setTextContent('topbar-role', nextIsHost ? '👑 Host' : '👤 Peer');

  // Re-render open Users panel if visible
  const panelBody = $('panel-body');
  if (panelBody.children.length > 0 && ($('right-panel') as HTMLElement).classList.contains('panel-hidden') === false) {
    participants.render(nextIsHost, panelBody);
  }

  // Update participant roles in list
  participants.allUsers = participants.allUsers.map(u => ({
    ...u,
    isHost: u.email === hostEmail,
  }));

  updateTopBar();
}
```

### 5b. Wire onRoleChanged
Already wired (line 97-101). Enhance to call `applyRoleState`:
```ts
session.onRoleChanged = (host, hostEmail) => {
  applyRoleState(host, hostEmail);
};
```
Remove the inline `isHost = host` at line 98 — `applyRoleState` handles it.

### 5c. Fix promotion commit timing (swap rooms safely)
In `handlePromotionRequest` (session-controller.ts lines 289-335):
Current order:
```
322: if (this.room) this.room.close();
323: this.room = this.nextRoom;
```
Fix: keep old room alive until after switch:
```ts
const oldRoom = this.room;
this.room = this.nextRoom;
this.nextRoom = null;
// ... setup handlers on new room ...
oldRoom?.close();  // close old room last
```

### 5d. Ensure new room's data channel is ready
After `this.room = this.nextRoom`, wait for `onConnect` before broadcasting state. The `_connectionState` is already set to `connected` on line 326, but it should wait for the real callback.

**Estimated complexity:** MEDIUM — primarily app.ts refactoring, one session-controller fix.

**Dependencies:** P1 (needs `onRoleChanged` confirmed wired), P4 (shares `updateRoleAwareUI` concept).

---

## P6 — Fix Approval and Connection State

**Files:** `src/shell/session-controller.ts`, `src/shell/signaling-client.ts`

**Changes:**

### 6a. Fix connection state machine
Current: jumps to `connected` on relay `approved` event (line 58). Should only enter `connected` after real P2P `onConnect` callback fires.

State transitions:
```
idle → signaling (on createRoom/peerAutoJoin start)
signaling → negotiating (RTC connection in progress)
negotiating → connected (P2P onConnect fires)
connected → reconnecting (connection lost, new-host event)
reconnecting → negotiating → connected (new connection established)
any → failed (unrecoverable error)
any → closed (explicit close)
```

### 6b. Fix relay `approved` handler
Change line 57-60 from:
```ts
this.signaling.on('approved', () => {
  this._connectionState = 'connected';
  this.setConnected?.(true);
});
```
To:
```ts
this.signaling.on('approved', () => {
  this._connectionState = 'negotiating';
  // Wait for P2P onConnect before marking connected
  this.onLog?.('system', '✅ Approved — establishing P2P connection...');
});
```

### 6c. Add real P2P onConnect tracking
In `peerAutoJoin`, the `onConnect` callback (line 241-248) already sets `_connectionState = 'connected'` and calls `setConnected?.(true)`. This is correct. The relay `approved` handler was prematurely overriding this.

In `createRoom`, the `onPeerConnect` callback (line 120-123) also sets `_connectionState = 'connected'`. Correct.

### 6d. Update FeatureContext.isConnected()
Currently `MarkdownFeature.start()` receives `isConnected: () => session.isConnected` which checks `_connectionState === 'connected'`. After P6a, this will reflect real P2P state. ✓

### 6e. Remove reliance on _currentOfferId in manualAcceptAnswer
Current `manualAcceptAnswer` (line 207-211) uses `this._currentOfferId`. Instead, require the caller to pass `offerId` explicitly, or track the latest offerId properly.

Change signature:
```ts
manualAcceptAnswer(signalUrl: string, offerId: string): void {
  const m = signalUrl.match(/#sdp=(.*)/);
  const b64 = m ? decodeURIComponent(m[1]) : signalUrl;
  this.room?.acceptAnswer(offerId, `#sdp=${b64}`);
}
```
Update `app.ts` line 182-184 to pass the current offerId from session.

### 6f. Expose currentOfferId
Add getter to SessionController that returns the most recent offer ID (from relay or local).

**Estimated complexity:** SMALL — mostly trimming premature state transitions, one method signature change.

**Dependencies:** P1 (needs `setConnected` to work correctly).

---

## P7 — Clean Up Listeners and Room Lifecycles

**Files:** `src/shell/session-controller.ts`, `src/shell/signaling-client.ts`, `src/features/markdown/markdown-feature.ts`, `src/features/markdown/document-sync.ts`, `src/app.ts`

**Changes:**

### 7a. Add destroy() to SessionController
```ts
destroy(): void {
  // Reject all pending signaling requests
  for (const [id, p] of this.signaling['pending']) {
    p.reject(new Error('Session destroyed'));
  }
  this.signaling['pending'].clear();

  // Close current room (and nextRoom if pending)
  this.room?.close();
  this.nextRoom?.close();

  // Close signaling
  this.signaling.close();

  // Clear state
  this._peerEmails.clear();
  this._connectionState = 'closed';
  this.promotionInProgress = false;
}
```

### 7b. Add destroy() to SignalingClient
```ts
destroy(): void {
  // Reject pending requests
  for (const [id, p] of this.pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Client destroyed'));
  }
  this.pending.clear();
  // Clear all event handlers
  this.handlers.clear();
  // Close WebSocket
  this.close();
}
```

### 7c. Unsubscribe room-level handlers on room swap
In `setupRoomHandlers`, store the unsubscribe functions and expose a `teardownRoomHandlers`:
```ts
private roomHandlerCleanups: (() => void)[] = [];

private setupRoomHandlers(r: Room, useRelay: boolean) {
  const unsub1 = r.onMessage(...);
  const unsub2 = r.onPeerJoin(...);
  this.roomHandlerCleanups = [unsub1, unsub2];
}

private teardownRoomHandlers() {
  this.roomHandlerCleanups.forEach(fn => fn());
  this.roomHandlerCleanups = [];
}
```
Call `teardownRoomHandlers()` before closing old room in `handlePromotionRequest`.

### 7d. Keep old room alive until replacement succeeds
Already addressed in P5c. Verify the fix is robust across all code paths:
- `handlePromotionRequest` — P5c fix
- `new-host` handler (line 66-91) — closes `this.room` immediately at line 69. Fix: delay close until new room's `onConnect`.
- Any reconnection path.

### 7e. Clean up MarkdownFeature destroy()
Enhance `destroy()` in `markdown-feature.ts`:
```ts
destroy(): void {
  this.syncQueue?.destroy();
  // Remove ydoc update listener
  this.ydoc?.off('update', this.updateHandler); // need to store handler ref
  this.editorView?.destroy();
  this.ydoc?.destroy();
  this.preview?.destroy();
}
```

### 7f. Fix SyncQueue.destroy()
Current `destroy()` (document-sync.ts lines 51-55) clears arrays but doesn't reject pending operations. Enhance:
```ts
destroy(): void {
  if (this.flushTimer !== null) {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
  this.pendingUpdates = [];
  this.pendingBytes = 0;
}
```
(This is already correct — just verify.)

### 7g. Add idempotency checks
- Promotion: track `lastPromotionId` in SessionController, ignore duplicate `promotion-request` events with same ID.
- Room state: track `lastSnapshotVersion` in ParticipantsController, ignore stale snapshots (version ≤ current). Already partially designed in P4c.

### 7h. Remove deprecated legacy queue
Once P2 migration to `SyncQueue` instance is complete, remove `enqueueLocalUpdate` and `legacyFlush` from `document-sync.ts`.

**Estimated complexity:** MEDIUM — broad but mechanical, touches many files.

**Dependencies:** All of P0-P6 (must know final state of all modules to clean up correctly).

---

## Summary Table

| Priority | Files Modified | Est. Complexity | Depends On |
|----------|---------------|-----------------|------------|
| P0 | `types.ts`, `signaling-client.ts` | SMALL | — |
| P1 | `app.ts`, `session-controller.ts` | SMALL | P0 |
| P2 | `markdown-feature.ts`, `document-sync.ts`, `types.ts`, `app.ts` | MEDIUM | P1 |
| P3 | `chat-controller.ts`, `panel-controller.ts`, `types.ts`, `message-envelope.ts`, `session-controller.ts` | MEDIUM | P1 |
| P4 | `types.ts`, `participants-controller.ts`, `session-controller.ts`, `app.ts` | LARGE | P1 |
| P5 | `app.ts`, `session-controller.ts` | MEDIUM | P1, P4 |
| P6 | `session-controller.ts`, `signaling-client.ts` | SMALL | P1 |
| P7 | `session-controller.ts`, `signaling-client.ts`, `markdown-feature.ts`, `document-sync.ts`, `app.ts` | MEDIUM | P0-P6 |

## Execution Order Recommendation

```
Day 1: P0 → P1 (foundation)
Day 2: P2 + P3 (parallel, different owners or sequential)
Day 3: P4 + P5 + P6 (parallel; P5 should start after P4 design settles)
Day 4: P7 (cleanup pass)
Day 5: Integration testing, npm run typecheck final, npm run test:all
```