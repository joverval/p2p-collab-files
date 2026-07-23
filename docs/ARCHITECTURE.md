# P2P Collab Files — Architecture Design Document

> Architect review of `p2p-collab-files` functional correctness. Validates and extends the P0-P7 implementation plan. Delivers architectural decisions, module contracts, and structural concerns beyond code fixes.

**Date:** 2026-07-23
**Status:** Draft, pending review
**Projects:** `p2p-collab` (base library) + `p2p-collab-files` (app)

---

## 1. System Context

```
┌────────────────────────────────────────────────────┐
│  p2p-collab-files (app)                            │
│  ┌──────────┐  ┌──────────────────────────────┐    │
│  │  app.ts  │  │  features/markdown/           │    │
│  │  (wiring)│  │  markdown-feature.ts          │    │
│  └────┬─────┘  │  editor/file/preview ctrls    │    │
│       │        │  document-sync.ts (SyncQueue)  │    │
│  ┌────┴──────────────────────────────────┐     │    │
│  │  shell/                               │     │    │
│  │  session-controller.ts (state machine)│     │    │
│  │  signaling-client.ts  (WS relay)      │     │    │
│  │  chat/  participants/  panels/        │     │    │
│  │  protocol/message-envelope.ts         │     │    │
│  └────┬──────────────────────────────────┘     │    │
│       │  imports                                │    │
│  ┌────┴────┐                                    │    │
│  │ shared/ │  types.ts, dom.ts                  │    │
│  └─────────┘                                    │    │
└──────────────────────┬─────────────────────────┘
                       │ depends on
┌──────────────────────┴─────────────────────────┐
│  @joverval/p2p-collab (library)                 │
│  P2PRoom, createRoom(), joinRoom()              │
│  WebRTC data channels, URL-encoded SDP          │
└────────────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
     Relay Server            Direct P2P
  (wss://relay.joverval.cl)  (WebRTC DataChannel)
```

## 2. Module Architecture

### 2.1 Layer Map

```
┌─────────────────────────────────────────┐
│  Layer 3: Composition (app.ts)          │  Creates instances, wires callbacks
├─────────────────────────────────────────┤
│  Layer 2a: Features (markdown-feature)  │  CollaborationFeature interface
│  Layer 2b: Shell (session-controller,   │  Session lifecycle, relay, chat
│            signaling, panels, chat)     │
├─────────────────────────────────────────┤
│  Layer 1: Shared (types, dom)           │  Cross-cutting contracts + helpers
├─────────────────────────────────────────┤
│  Layer 0: Base Library (p2p-collab)     │  P2PRoom, WebRTC, SDP signals
└─────────────────────────────────────────┘
```

Dependency rule: layers only import from below. Layer 2a ↔ 2b communicate only through explicit callbacks defined in Layer 1 interfaces.

### 2.2 Module Boundaries

| Module | Responsibility | Exposes | Consumes |
|--------|---------------|---------|----------|
| `shared/types.ts` | Interface contracts | `CollaborationFeature`, `FeatureContext`, `IceConfigProvider` | Nothing |
| `session-controller.ts` | Room lifecycle, P2P connection, promotion, message routing | Callbacks (onLog, onConnected, etc.) + send methods | `P2PRoom`, `SignalingClient`, `message-envelope` |
| `signaling-client.ts` | WebSocket relay communication | `connect()`, `send()`, `request()`, `on()`, ICE config | Nothing (leaf) |
| `markdown-feature.ts` | Yjs doc sync, editor orchestration | `CollaborationFeature` impl | `document-sync`, editor/file/preview controllers |
| `chat-controller.ts` | Chat message log | `addLog()`, `markRead()` | `dom.ts`, `message-envelope` |
| `participants-controller.ts` | Participant list rendering | `allUsers` get/set, `render()`, `onPromote` | `dom.ts` |
| `panel-controller.ts` | Right panel open/close, tab switching | `open()`, `close()`, `setSendChat()` | Chat, Participants controllers |
| `message-envelope.ts` | 1-byte prefix protocol encoding | `encodeChat()`, `encodeYjs()`, `decodeMessage()` | Nothing (leaf) |

## 3. Architectural Decisions

### ADR-001: Shell/Feature boundary uses callback-driven interface

**Context:** The app has infrastructure code (session management, relay, chat) and domain code (markdown editing, Yjs sync). These must be decoupled so features can be added or replaced.

**Decision:** Define `CollaborationFeature` and `FeatureContext` interfaces in `shared/types.ts`. The shell calls `feature.start(ctx)`, `feature.handleFeatureData(data, peerId)`, etc. The feature calls back through `ctx.sendFeatureData()`, `ctx.isHost()`, `ctx.isConnected()`.

**Consequence:** Adding a new feature (e.g., whiteboard) requires only implementing `CollaborationFeature` and wiring it in `app.ts`. The shell code never imports from `features/`.

**Validation:** The interface is sound. However, `FeatureContext.sendFeatureDataToPeer` and `broadcastFeatureDataExcept` are declared but unused by `markdown-feature.ts`. These should either be implemented or removed from the interface.

### ADR-002: P2P connection state lives in SessionController, not spread across callbacks

**Context:** Currently, `SessionController._connectionState` jumps to `'connected'` on relay `approved` event (line 58 of session-controller.ts) rather than waiting for real P2P `onConnect`. Additionally, `app.ts` maintains its own `isHost` boolean outside the session. And `setConnected` callback is declared but never assigned.

**Decision:** `SessionController` is the single source of truth for connection state. The relay `approved` event transitions to `'negotiating'`, not `'connected'`. Only `P2PRoom.onConnect` transitions to `'connected'`. `app.ts` reads connection state from `session.isConnected` and role from `session.onRoleChanged`.

**Consequence:** This is P6a (connection state machine fix) + P1 (setConnected wiring). The architectural principle is: no module outside `SessionController` tracks connection state independently.

### ADR-003: Participant list is a host-authoritative snapshot, not a locally assembled list

**Context:** Currently, participants are assembled piecemeal: `app.ts` pushes to `participants.allUsers` on `onPeerJoin`, filters on `onPeerLeave`, and maps on `onRoleChanged`. This creates drift between peers' views. Additionally, `ParticipantsController` has its own `_peerEmails` map that shadows `SessionController._peerEmails`.

**Decision:** The host builds and broadcasts a `RoomSnapshot` (versioned, with full participant list including roles, connection status, and join order). All peers replace their local participant list with the snapshot on receipt. `ParticipantsController` exposes `replaceSnapshot(snapshot)` and does not accumulate entries.

**Consequence:** This is P4. It eliminates the dual identity tracking (`_peerEmails` in two places) and ensures all peers see the same participant list by design.

### ADR-004: Chat messages are typed structures, not concatenated HTML strings

**Context:** Currently, `ChatController` stores chat history as a single HTML string (`_logHTML`) with `innerHTML` concatenation. Remote chat messages pass through `addLog('received', text)` which injects unsanitized remote strings into the DOM.

**Decision:** Chat messages are typed `ChatMessage` objects stored in an array. Rendering uses `textContent` assignments on DOM elements, never `innerHTML` for remote data. The send path constructs a structured message with `senderEmail`, `senderRole`, `text`, `timestamp`, and `id`.

**Consequence:** This is P3. It eliminates XSS risk, enables chat history replay on late join, and decouples storage from rendering.

### ADR-005: Legacy module-level sync queue must be replaced with SyncQueue instance

**Context:** `document-sync.ts` defines both a `SyncQueue` class and a legacy module-level `enqueueLocalUpdate`/`legacyFlush`. The legacy queue uses module-level mutable state that cannot be properly destroyed and keeps scheduling timers even after the feature is torn down.

**Decision:** `MarkdownFeature` owns a `SyncQueue` instance. On `start()`, it creates the queue. On `destroy()`, it tears it down. The legacy `enqueueLocalUpdate` is deprecated and removed after migration.

**Consequence:** This is P2d-P2h. It fixes the endless retry loop when disconnected and enables proper cleanup.

### ADR-006: Room handler subscriptions must be unsubscribed on room swap

**Context:** `SessionController.setupRoomHandlers()` adds `onMessage` and `onPeerJoin` handlers to a Room instance. When `handlePromotionRequest` creates a new room and swaps it in, the old room's handlers are never removed. This causes listener leaks and potential stale message processing.

**Decision:** `setupRoomHandlers` returns cleanup functions. `teardownRoomHandlers` calls all cleanup functions. Room swap calls `teardown` before `setup` on the new room. The old room is kept alive until the new room's `onConnect` fires, then closed.

**Consequence:** This is P5c + P7c + P7d. The architectural principle: every subscription must have a corresponding unsubscription path.

## 4. Structural Concerns Beyond P0-P7

### SC-1: `app.ts` directly accesses feature internals

**Current:** Lines 117-121 in `app.ts`:
```ts
if (feature.doc && feature.text && feature.editor) feature.file?.openFile(...)
if (feature.text) feature.file?.saveFile(feature.text.toString())
```

**Problem:** `app.ts` knows about `feature.doc`, `feature.text`, `feature.editor`, `feature.file`. These are MarkdownFeature internals that break the `CollaborationFeature` abstraction. If a whiteboard feature is added, these accessors don't exist.

**Fix:** Add `triggerFileOpen()` and `triggerFileSave()` to the `CollaborationFeature` interface, or expose a `getFileActions()` method. The feature decides what to expose; the shell doesn't reach into its guts.

**Severity:** MEDIUM. Not a correctness bug, but an architectural leak.

### SC-2: Control message protocol uses fragile string prefix matching

**Current:** Session controller and markdown feature parse control messages by checking `startsWith('[FILENAME]')`, `startsWith('[ROOM]')`, etc. These are bare strings inside the chat message envelope (type 0x00).

**Problem:** No type discriminator. A chat message starting with `[FILENAME]` would be misinterpreted as a control message. Prefix collisions are possible.

**Fix:** Add a control message envelope type (e.g., 0x02 byte prefix) to `message-envelope.ts`, or embed control messages within the 0x00 chat envelope with a structured JSON discriminator `{kind: 'control', subkind: 'filename', ...}`.

**Severity:** LOW for now (prefixes are unlikely in real chat), but architectural fragility that will cause bugs as the protocol grows.

### SC-3: `p2p-collab` Room.onMessage uses single-handler setter pattern

**Current:** `Room.onMessage` is a setter — it stores one handler (`this._onMessage = handler`). Each call overwrites the previous handler with no error.

**Code flow analysis:**
- `createRoom()` creates host Room → calls `setupRoomHandlers(r, ...)` → `r.onMessage(...)` (line 142). One handler.
- `peerAutoJoin()` creates peer Room → calls `peer.onMessage(...)` (line 259). Different Room instance — no conflict.
- `handlePromotionRequest()` creates new host Room (`nextRoom`) → calls `setupRoomHandlers(this.room!, ...)` (line 327) on the NEW room. Old room is closed. No conflict.

**Conclusion:** No handler-overwrite bug in current code paths because each Room instance gets `onMessage` called exactly once. However, the API is fragile: if future code calls `onMessage` twice on the same Room, one handler silently replaces the other.

**Recommendation:** Future `p2p-collab` API change: rename to `setOnMessage()` or support `addMessageListener()`/`removeMessageListener()` for clarity. Not blocking for this fix cycle.

**Severity:** LOW (not currently triggered, but API fragility).

### SC-4: No typed message envelope for Room-level control messages

**Context:** Room messages currently use a 1-byte prefix (0x00 = chat, 0x01 = yjs). Chat messages are further dispatched by string prefix matching in `setupRoomHandlers`. Room state snapshots use JSON embedded in `[ROOM]` and `[USERS]` prefixes.

**Fix:** Extend `message-envelope.ts` with a 0x02 prefix for structured control messages (room state, email registration, filename changes, sync requests). Each control message type gets a typed interface with a discriminator field.

**Severity:** MEDIUM. Not blocking functionality but makes the protocol fragile and hard to extend.

### SC-5: Message routing duplicates logic between host and peer paths

**Context:** `setupRoomHandlers` (lines 141-181) and `peerAutoJoin`'s inline `onMessage` (lines 259-270) both decode messages and route them. The routing logic is similar but not identical — e.g., peer path handles `[USERS]` prefix but host path doesn't.

**Fix:** Extract message routing into a shared `routeMessage(data: Uint8Array, peerId: string, context: RoutingContext)` function used by both host and peer paths.

**Severity:** MEDIUM. Duplication leads to drift (e.g., `[USERS]` vs `[ROOM]` for room state).

## 5. Dependency Graph Validation

The P0-P7 plan's dependency graph is architecturally sound:

```
P0 (API reconciliation + typecheck)
 └─► P1 (app.ts wiring completion)
      ├─► P2 (late-join sync)       ─┐
      ├─► P3 (chat history)          ├─ parallel
      ├─► P4 (participant list)      ├─ parallel
      ├─► P5 (role-change UI)        ├─ parallel
      └─► P6 (approval + conn)       ─┘
                                       │
                                       ▼
                                      P7 (cleanup pass)
```

**Validation notes:**

- P0 must complete first because it establishes type contracts that P1-P6 depend on. Confirmed.
- P1 must complete before P2-P6 because P2-P6 depend on `setConnected` wiring, callback signatures, and the IS_CONNECTED truth source. Confirmed.
- P2-P6 touch disjoint files. Verified: P2 (document-sync.ts, markdown-feature.ts), P3 (chat-controller.ts, panel-controller.ts, message-envelope.ts, app.ts), P4 (participants-controller.ts, session-controller.ts, types.ts, app.ts), P5 (app.ts, session-controller.ts), P6 (session-controller.ts, signaling-client.ts). There is some overlap in app.ts (P3, P4, P5 all touch it) but these changes are to different sections: P3 touches chat send wiring (lines 33-37), P4 touches `onRoomState` (line 105), P5 touches `onRoleChanged` (lines 97-101) and the `ensureEditorVisible` area. If a single developer implements sequentially, no conflict. If parallel, minor merge in app.ts.
- P5 lists P4 as a dependency because of `applyRoleState` referencing participant concepts. This is correct.

**Adjustment:** P5 should also note it depends on P6 because `applyRoleState` must respect the corrected connection state from P6 (the host's connection state being real P2P, not relay `approved`).

## 6. Module Contract Specifications

### 6.1 CollaborationFeature (shared/types.ts)

```typescript
export interface CollaborationFeature {
  start(context: FeatureContext): void;
  onConnected(): void;          // P2P data channel established
  onDisconnected(): void;       // P2P data channel lost
  onPeerJoined?(peerId: string): void;
  onPeerLeft?(peerId: string): void;
  handleFeatureData(data: Uint8Array, peerId?: string): void;
  handleControlMessage?(message: string): void;
  destroy(): void;
}
```

**Contract:** `start()` is called once. `handleFeatureData()` receives feature-specific payloads after message envelope decoding. `onConnected()` is called when real P2P connection is established (post-P6 fix). `destroy()` must clean up all resources (Yjs doc, editor, sync queue, timers).

### 6.2 FeatureContext (shared/types.ts)

```typescript
export interface FeatureContext {
  isHost(): boolean;
  isConnected(): boolean;       // Must reflect real P2P state, not relay state
  sendFeatureData(data: Uint8Array): void;
  sendFeatureDataToPeer(peerId: string, data: Uint8Array): void;
  sendControlMessage(message: string): void;
  reportStatus(message: string): void;
}
```

**Contract:** `isConnected()` returns `true` only after actual P2P data channel establishment. `sendFeatureData()` broadcasts to all connected peers. `sendFeatureDataToPeer()` targets a specific peer. `reportStatus()` is for user-visible log messages.

### 6.3 SessionController Callbacks

| Callback | Signature | When Fired | Consumer |
|----------|-----------|------------|----------|
| `onLog` | `(type: string, text: string)` | Any significant event | `chat.addLog` |
| `onPendingRequest` | `(email, token, offerId?, answerB64?)` | Host: peer wants to join | app.ts toast |
| `onConnected` | `(route: string)` | Real P2P connection established | app.ts |
| `onPeerJoin` | `(peerId: string, peerEmail: string)` | New peer connected | app.ts + feature |
| `onPeerLeave` | `(email: string)` | Peer disconnected | app.ts |
| `onFeatureData` | `(data: Uint8Array, peerId: string)` | Feature payload received | feature.handleFeatureData |
| `onControlMessage` | `(text: string)` | Control message received | feature.handleControlMessage |
| `onChatMessage` | `(sender: string, text: string)` | Chat message received | chat.addLog |
| `onRoomState` | `(snapshot: RoomSnapshot)` | Room participant list changed | participants.replaceSnapshot |
| `onRoleChanged` | `(isHost: boolean, hostEmail: string)` | Host role changed (promotion, failover) | app.ts applyRoleState |
| `getEmail` | `() => string` | Anywhere email is needed | session-controller internals |
| `setConnected` | `(v: boolean) => void` | Connection state changed | **P1: must be assigned** |

## 7. File Change Map (P0-P7)

| Priority | Files Modified | Lines Changed (est.) | Risk |
|----------|---------------|---------------------|------|
| P0 | `shared/types.ts`, `signaling-client.ts` | ~40 | LOW — additive types |
| P1 | `app.ts`, `session-controller.ts` | ~15 | LOW — simple wiring |
| P2 | `markdown-feature.ts`, `document-sync.ts`, `shared/types.ts`, `app.ts` | ~60 | MEDIUM — queue lifecycle |
| P3 | `chat-controller.ts`, `panel-controller.ts`, `shared/types.ts`, `message-envelope.ts`, `session-controller.ts` | ~100 | MEDIUM — chat rewrite |
| P4 | `shared/types.ts`, `participants-controller.ts`, `session-controller.ts`, `app.ts` | ~120 | HIGH — snapshot broadcast |
| P5 | `app.ts`, `session-controller.ts` | ~50 | MEDIUM — state timing |
| P6 | `session-controller.ts`, `signaling-client.ts` | ~30 | LOW — state machine trim |
| P7 | All of the above + cleanup | ~60 | MEDIUM — listener lifecycle |

## 8. Risks and Open Questions

1. **`p2p-collab` Room.onMessage handler pattern:** Verified: single-handler setter, each Room instance gets exactly one `onMessage` call in current code paths. No bug. But the API is fragile — future code calling `onMessage` twice on the same Room would silently overwrite. Mitigated by SC-3 documentation.

2. **Relay server protocol:** The signaling protocol uses string-keyed message types. Any changes here must coordinate with the relay server. Who owns the relay server?

3. **ICE/TURN configuration:** The `VITE_ICE_MODE` env var allows `stun-only`, `turn-only`, or `all`. This is an architectural decision that should be documented: when do we use TURN vs direct P2P? What's the fallback behavior?

4. **Manual mode vs relay mode:** The system supports two signaling paths: relay-mediated and manual (URL exchange). The manual mode has limited testing. P2-P6 changes must work in both modes.

5. **E2E test coverage:** 6 E2E tests exist. After P0-P7, these must pass. New tests should cover: chat history persistence, participant list consistency, role-change UI updates.

## 9. Execution Order (Architect's Recommendation)

```
Phase 1 (Foundation):  P0 → P1
Phase 2 (Parallel):    P2, P3, P6   (no shared files)
Phase 3 (Sequential):  P4 → P5       (P5 depends on P4 types)
Phase 4 (Cleanup):     P7
Phase 5 (Verify):      typecheck + e2e tests + manual smoke test
```

**Rationale for Phase 2 ordering:** P6 has minimal changes and fixes the connection state that P2 depends on for `isConnected()`. Run P6 before or alongside P2. P3 is fully independent of P2 and P6 (only touches chat files).

## 10. Post-P7 Improvements (Not Blocking)

These are architectural improvements that don't block functional correctness but improve maintainability:

- **SC-1 fix:** Add `triggerFileOpen()`/`triggerFileSave()` to `CollaborationFeature`
- **SC-2 fix:** Add control message envelope type to `message-envelope.ts`
- **SC-5 fix:** Extract shared message routing function
- **ADR-001 cleanup:** Remove unused `sendFeatureDataToPeer`/`broadcastFeatureDataExcept` from `FeatureContext` or implement them
- **Type coverage:** Add `noUnusedLocals` / `noUnusedParameters` to `tsconfig.json` (listed in P0)