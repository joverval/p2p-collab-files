# Test Additions Architecture — Release-Gate Test Suite

Design for the 55+ unit tests and 7 E2E tests missing from the release-gate suite.
Gap analysis based on `spec-validation-04-release-gate-tests.md` (77 unit, 1 E2E → 132+ unit, 8 E2E target).

---

## 1. File Layout: New Test Files

```
p2p-collab-files/
└── tests/
    ├── unit/
    │   ├── chat/
    │   │   └── chat-controller.test.ts          # NEW — 8 tests (Section 3.4)
    │   ├── participants/
    │   │   └── participants-controller.test.ts  # NEW — 10 tests (Section 3.5)
    │   ├── security/
    │   │   └── sanitization.test.ts             # NEW — 7 tests (Section 3.7)
    │   ├── relay/
    │   │   └── relay-authorization.test.ts      # NEW — 14 authorization tests (Section 3.6)
    │   ├── signaling/                           # EXISTING — needs 1 test added
    │   │   └── signaling-client.test.ts         # + fetchIceConfig caching test
    │   └── sync/                                # EXISTING — needs 2 tests added
    │       └── document-sync.test.ts            # + file-open transaction, remote-apply echo
    ├── integration/
    │   └── session-relay-integration.test.ts    # EXISTING (placeholder)
    └── e2e/
        ├── core/
        │   ├── chat-history.test.ts             # NEW — E2E Test C
        │   ├── participant-list.test.ts         # NEW — E2E Test D
        │   ├── connection-state.test.ts         # NEW — E2E Test H
        │   ├── room-lifetime.test.ts            # NEW — E2E Test J
        │   ├── lifecycle-leaks.test.ts          # NEW — E2E Test K
        │   └── file-open-once.test.ts           # NEW — E2E Test L
        └── ice/
            ├── stun-only-direct.test.ts          # NEW — E2E Test I.1
            ├── all-mode-prefer-direct.test.ts    # NEW — E2E Test I.2
            ├── forced-turn.test.ts               # NEW — E2E Test I.3
            └── direct-unavailable-fallback.test.ts # NEW — E2E Test I.4
```

**Key design points:**

- Unit tests for `chat`, `participants`, `security` are entirely new modules. Each is self-contained, uses vitest + jsdom, and follows the existing pattern of direct imports from `src/`.
- `relay-authorization.test.ts` is split from `relay-protocol.test.ts` to separate happy-path protocol tests (8 existing) from authorization/security boundary tests (14 new). Both share the same `createRelayServer` factory.
- Two additions to existing files (`signaling-client.test.ts`, `document-sync.test.ts`) are small: 1 test each for `fetchIceConfig` caching and 2 tests for file-open transaction count + remote-apply echo.
- E2E tests follow the existing pattern: one file per scenario, importing from `helpers/e2e-helpers.ts` and `helpers/fixtures.ts`. ICE tests go in `tests/e2e/ice/` subdirectory.
- The `tests/e2e/ice/` directory is new but already planned in the test-infrastructure-architecture.md (tests 7-10).

---

## 2. Module Boundaries and Dependencies

### 2.1 Unit Test Module: chat-controller.test.ts

**Source under test:** `src/shell/chat/chat-controller.ts` (ChatController class)
**Dependencies:** Vitest, jsdom (for `document.querySelector`, `textContent`)

```
chat-controller.test.ts
  └── imports: ChatController from src/shell/chat/chat-controller.ts
  └── NO imports: session, signaling, relay, DOM (uses jsdom's document)
```

**Internal structure (8 tests):**

```
describe('ChatController')
  ├── describe('history persistence across panel open/close')
  │   ├── renders full message history when panel opens  (3.4.1)
  │   └── opening/closing panel does not lose messages   (3.4.2)
  ├── describe('live message handling')
  │   ├── incoming message appends to open chat           (3.4.3)
  │   └── unread count increments while chat closed      (3.4.4)
  ├── describe('rendering safety')
  │   ├── senderEmail rendered exactly once per message   (3.4.5)
  │   ├── send callback invoked exactly once              (3.4.6)
  │   ├── HTML payload rendered as text, not DOM          (3.4.7)
  │   └── no innerHTML path receives untrusted content    (3.4.8)
```

**Testability requirements:**
- ChatController is instantiable without DI: `new ChatController()` works standalone.
- `addLog()` and `renderInto()` are the only public mutation methods.
- `_createEntry()` is private but its behavior is observable: `renderInto()` calls it and we assert `textContent` not `innerHTML`.
- jsdom provides `document.createElement`, `document.querySelector`, and `textContent` -- fully sufficient.

### 2.2 Unit Test Module: participants-controller.test.ts

**Source under test:** `src/shell/participants/participants-controller.ts` (ParticipantsController class)
**Dependencies:** Vitest, jsdom

```
participants-controller.test.ts
  └── imports: ParticipantsController, Participant from src/shell/participants/participants-controller.ts
  └── NO imports: session, signaling, relay
```

**Internal structure (10 tests):**

```
describe('ParticipantsController')
  ├── describe('snapshot management')
  │   ├── complete snapshot replaces local list             (3.5.1)
  │   ├── snapshot deduplicates and orders by joinOrder     (3.5.2)
  │   └── stale version (lower joinOrder) does not overwrite (3.5.3)
  ├── describe('join/leave updates')
  │   ├── adding a participant increments userCount          (3.5.4)
  │   └── removing a participant decrements userCount        (3.5.4 cont.)
  ├── describe('role changes')
  │   ├── promotion changes email's isHost from false→true  (3.5.5)
  │   ├── applyRoleState(true) shows host-only controls     (3.5.7)
  │   ├── applyRoleState(false) hides host-only controls    (3.5.8)
  │   └── save remains available to peers                   (3.5.9)
  ├── describe('render behavior')
  │   ├── open Users panel re-renders without reopening     (3.5.6)
  │   └── promote buttons render only when isHost=true      (3.5.10)
```

**Key test fixture:**
```typescript
function makeParticipant(email: string, overrides?: Partial<Participant>): Participant {
  return {
    email,
    isHost: false,
    participantId: `id-${email}`,
    connected: true,
    joinOrder: 0,
    ...overrides,
  };
}
```

**Testability concern:** `applyRoleState()` is defined in `app.ts`, not `ParticipantsController`. It orchestrates DOM changes (show/hide buttons) across multiple elements. Spec items 3.5.7-3.5.9 require DOM access. These tests should be scoped to `app.ts` integration or covered in E2E. For pure unit tests of `ParticipantsController`:
- 3.5.1–3.5.6, 3.5.10 live here (pure controller behavior).
- 3.5.7–3.5.9 belong in an `app-integration.test.ts` or are covered by E2E test D.

### 2.3 Unit Test Module: sanitization.test.ts (Security)

**Source under test:** ChatController._createEntry() (textContent safety), MarkdownFeature preview rendering
**Dependencies:** Vitest, jsdom

```
sanitization.test.ts
  └── imports: ChatController from src/shell/chat/chat-controller.ts
  └── imports: markdown preview module (if extractable)
  └── NO imports: session, signaling, relay
```

**Internal structure (7 tests):**

```
describe('Security Sanitization')
  ├── describe('ChatController output safety')
  │   ├── chat <img onerror> does not execute            (3.7.1)
  │   ├── markdown <script> removed from preview         (3.7.2)
  │   ├── javascript: link removed from preview          (3.7.3)
  │   ├── unsafe SVG removed from preview                (3.7.4)
  │   └── very long chat/email rejected or truncated     (3.7.5)
  ├── describe('Message spoofing prevention')
  │   ├── control-message spoof from peer rejected       (3.7.6)
  │   └── room-state spoof from peer rejected            (3.7.7)
```

**Testability constraints:**
- 3.7.2–3.7.4 test markdown preview rendering. If preview uses a library (markdown-it/showdown), tests intercept the rendered output and assert unsafe content is absent. If rendered via CodeMirror's markdown mode, tests create the editor and read the preview DOM.
- 3.7.5 tests input validation: `addLog()` with a 100KB string should either reject or truncate.
- 3.7.6–3.7.7 test session-controller message handling: `[SYNC]`, `[FILENAME]`, `[ROOM]` control prefixes are host-only in the protocol. Test that a peer's control message is ignored (or only host's is processed). This requires SessionController context -- these 2 tests may need to live in `session-controller.test.ts` or a new `session-security.test.ts`.

### 2.4 Unit Test Module: relay-authorization.test.ts

**Source under test:** `server/ws-relay.js` (createRelayServer factory)
**Dependencies:** Vitest, `ws` (for WebSocket client), `createRelayServer`

```
relay-authorization.test.ts
  └── imports: createRelayServer from server/ws-relay.js
  └── imports: WebSocket from 'ws'
  └── follows same pattern as relay-protocol.test.ts
```

**Internal structure (14 authorization tests + 2 TURN):**

```
describe('Relay Authorization')
  ├── describe('Role enforcement')
  │   ├── non-host cannot approve a peer join             (3.6.8)
  │   ├── non-host cannot reject a peer join              (3.6.8 cont.)
  │   ├── non-host cannot promote a peer                  (3.6.9)
  │   └── wrong promotion target cannot commit            (3.6.10)
  ├── describe('Token security')
  │   ├── token cannot be used by wrong intended participant (3.6.11)
  │   └── duplicate active email/identity policy enforced (3.6.12)
  ├── describe('Input validation')
  │   ├── oversized payload rejected                      (3.6.13)
  │   └── invalid schema rejected (malformed JSON)        (3.6.14)
  ├── describe('Origin security')
  │   └── disallowed WebSocket Origin rejected            (3.6.15)
  ├── describe('Room lifecycle')
  │   ├── active room survives beyond offer TTL           (3.6.16)
  │   └── expired offer deleted without deleting room     (3.6.17)
  ├── describe('Connection handling')
  │   ├── heartbeat removes dead socket                   (3.6.18)
  │   └── rate limits work                                (3.6.19)
  ├── describe('TURN credentials')
  │   ├── TURN credentials absent when disabled           (3.6.20)
  │   └── TURN credentials short-lived, never expose secret (3.6.21)
```

**Testability:** All of these test the relay server via WebSocket messages. They use `createRelayServer({ port: 0 })` for ephemeral ports. The `getState()` API exposes internal `rooms` and `tokenRoom` maps for assertions.

For TURN credential tests, `createRelayServer({ turnConfig: { enabled: false } })` and `{ turnConfig: { enabled: true, ... } }` control the config.

### 2.5 Existing File Additions

**signaling-client.test.ts (1 test):**
```
── fetchIceConfig() caches token and refreshes near expiry
```
Creates a `SignalingClient` with a fake WS. Calls `fetchIceConfig()` twice. Asserts the HTTP fetch (mocked) is called once on first call, then again only after advancing time past the TTL threshold.

**document-sync.test.ts (2 tests):**
```
├── file-open creates exactly one Yjs transaction       (B.7)
└── remote apply does not create local editor mutation  (B.8)
```
Both tests create a `SyncQueue` or use `createDoc()`, apply an update with `FILE_OPEN_ORIGIN` or `NETWORK_ORIGIN`, and observe transaction side effects.

---

## 3. E2E Test Architecture

### 3.1 Test C: Chat History Visibility

**File:** `tests/e2e/core/chat-history.test.ts`
**Scenario:** Host + peer, send chat messages, verify both see history. Close and reopen chat panel, verify history persists.

```
┌─ Test C: Chat history ─────────────────────────────────┐
│ 1. Host creates room                                    │
│ 2. Peer joins, host approves                            │
│ 3. Both open chat panel                                 │
│ 4. Host sends message "Hello from host"                 │
│ 5. Peer verifies message appears in chat                │
│ 6. Peer sends message "Hello from peer"                 │
│ 7. Host verifies message appears                        │
│ 8. Both close chat panel, then reopen                   │
│ 9. Both verify all 2 messages still present             │
│ 10. Unread indicator works when chat closed             │
└─────────────────────────────────────────────────────────┘
```

**New helpers needed:** `openChatPanel(page)`, `sendChatMessage(page, text)`, `getChatMessages(page): string[]`, `closeChatPanel(page)`

**E2E Helper API additions:**
```typescript
openChatPanel(page: Page): Promise<void>;
sendChatMessage(page: Page, text: string): Promise<void>;
getChatMessages(page: Page): Promise<string[]>;
closeChatPanel(page: Page): Promise<void>;
```

### 3.2 Test D: Participant List Consistency

**File:** `tests/e2e/core/participant-list.test.ts`
**Scenario:** 3 peers join sequentially. Each join updates the participant list on all connected clients.

```
┌─ Test D: Participant list ─────────────────────────────┐
│ 1. Host creates room (sees self as Host)                │
│ 2. Peer A joins, host approves                          │
│ 3. Host verifies: 2 participants (Host + Peer A)        │
│ 4. Peer A verifies: 2 participants                      │
│ 5. Peer B joins, host approves                          │
│ 6. All verify: 3 participants                           │
│ 7. Verify participant order and roles are correct       │
│ 8. Verify Peer A sees Peer B (not just self + host)     │
└─────────────────────────────────────────────────────────┘
```

**New helpers needed:** `getParticipantCount(page): number`, `getParticipantEmails(page): string[]`

### 3.3 Test H: Real Connection State

**File:** `tests/e2e/core/connection-state.test.ts`
**Scenario:** Verify `connection-state` diagnostic reflects actual WebRTC state transitions.

```
┌─ Test H: Connection state ─────────────────────────────┐
│ 1. Host creates room → assert state transitions from    │
│    idle → signaling → negotiating → connected           │
│ 2. Peer joins → assert same transition on peer side     │
│ 3. Host disconnects → assert peer sees reconnecting     │
│ 4. Auto-failover completes → assert connected again     │
│ 5. Verify connection route is populated (direct/TURN)   │
└─────────────────────────────────────────────────────────┘
```

**Dependency:** `connection-state` data-testid element (Section 6 of test-infra-architecture.md). Uses `page.evaluate(() => (window as any).__P2P_TEST__.getConnectionState())`.

### 3.4 Test I: STUN/TURN Route (4 sub-scenarios)

**Files:** `tests/e2e/ice/stun-only-direct.test.ts`, `all-mode-prefer-direct.test.ts`, `forced-turn.test.ts`, `direct-unavailable-fallback.test.ts`

These 4 files already exist in the test-infra-architecture.md plan as Tests 7-10. They are scoped as E2E tests but their files don't exist yet. This design confirms them.

**Test I.1 — STUN-only, direct connection:**
```
1. VITE_ICE_MODE=stun-only
2. Host + peer on same network → direct P2P established
3. getRoute() returns 'Direct P2P'
4. No TURN candidates in ICE config
```

**Test I.2 — ALL mode, prefer direct:**
```
1. VITE_ICE_MODE=all
2. Host + peer → direct P2P preferred
3. getRoute() returns 'Direct P2P'
4. TURN candidates present but not selected
```

**Test I.3 — TURN-only, forced relay:**
```
1. VITE_ICE_MODE=turn-only
2. Host + peer → TURN relay forced
3. getRoute() returns 'TURN relay'
4. Connection established even though forced relay
```

**Test I.4 — Direct unavailable, TURN fallback:**
```
1. VITE_ICE_MODE=all
2. Block STUN at network level (page.route intercept)
3. Host + peer → TURN fallback
4. getRoute() returns 'TURN relay'
```

### 3.5 Test J: Active Room Lifetime

**File:** `tests/e2e/core/room-lifetime.test.ts`
**Scenario:** Verify a room survives longer than the offer TTL.

```
┌─ Test J: Room lifetime ────────────────────────────────┐
│ 1. Host creates room, peer joins and approves           │
│ 2. Wait past offer TTL (5 minutes in relay config)      │
│ 3. Send new chat message → verify delivered             │
│ 4. New peer joins → verify works                        │
│ 5. Room not garbage-collected while active              │
└─────────────────────────────────────────────────────────┘
```

**Note:** This test uses `createRelayServer({ tokenTTL: 2000 })` with a 2-second TTL to be testable. The E2E test uses `page.waitForTimeout(3000)` to cross the TTL boundary.

### 3.6 Test K: Repeated Lifecycle and Listener Leaks

**File:** `tests/e2e/core/lifecycle-leaks.test.ts`
**Scenario:** Host promotes peer, original host reconnects, promote again. Repeat 3 cycles. Verify no listener leaks.

```
┌─ Test K: Lifecycle leaks ──────────────────────────────┐
│ 1. Host A creates room, Peer B joins                    │
│ 2. Promote B → A becomes peer                           │
│ 3. B promotes A → A becomes host again                  │
│ 4. Repeat steps 2-3 two more times                      │
│ 5. After each cycle: verify document sync still works   │
│ 6. After final cycle: verify chat still works           │
│ 7. No memory leaks: listener count stable               │
└─────────────────────────────────────────────────────────┘
```

**Dependency:** `getSignalingListenerCount()` from `__P2P_TEST__` diagnostics (partially missing, needs implementation).

### 3.7 Test L: File Open Exactly Once

**File:** `tests/e2e/core/file-open-once.test.ts`
**Scenario:** Host opens a file. Verify exactly one Yjs transaction is created (not multiple competing transactions).

```
┌─ Test L: File open once ───────────────────────────────┐
│ 1. Host creates room                                    │
│ 2. Host opens a .md file via file input                 │
│ 3. Verify editor contains file content                  │
│ 4. Verify ytext.doc.transact was called once (not N)    │
│ 5. Peer joins, receives full document (one transaction) │
└─────────────────────────────────────────────────────────┘
```

**Dependency:** `getStateVector()` from `__P2P_TEST__` diagnostics (partially missing, needs implementation). File open requires Playwright's `page.setInputFiles()`.

---

## 4. Dependency Graph

```
                         ┌─────────────────────┐
                         │  __P2P_TEST__ fixes  │
                         │ (getStateVector,     │
                         │  getChatMessages,    │
                         │  getSignalingLstnr)  │
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ chat-controller  │   │ participants     │   │ sanitization     │
│ .test.ts         │   │ -controller      │   │ .test.ts         │
│ (8 tests)        │   │ .test.ts         │   │ (5 tests)        │
│ NO deps          │   │ (8 tests)        │   │ NO deps          │
└──────────────────┘   │ NO deps          │   └──────────────────┘
                       └──────────────────┘
          │                         │
          ▼                         ▼
┌──────────────────┐   ┌──────────────────┐
│ relay-auth.test  │   │ E2E C: chat      │
│ (16 tests)       │   │ history.test.ts  │
│ needs: relay     │   │ needs: helpers   │
│ factory, ws pkg  │   │ + chat API       │
└──────────────────┘   └──────────────────┘
          │                    │
          ▼                    ▼
┌──────────────────┐   ┌──────────────────┐
│ session-security │   │ E2E D: part.list │
│ (2 spoof tests)  │   │ .test.ts         │
│ needs: Session   │   │ needs: helpers   │
│ Controller mock  │   │ + part. API      │
└──────────────────┘   └──────────────────┘
                                   │
          ┌────────────────────────┼─────────────────────────┐
          │                        │                         │
          ▼                        ▼                         ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ E2E H: conn.state│   │ E2E J: room-life │   │ E2E K: lifecycle │
│ .test.ts         │   │ .test.ts         │   │ leaks.test.ts    │
│ needs: conn diag │   │ needs: short TTL │   │ needs: listener  │
└──────────────────┘   │ relay config     │   │ count diagnostic │
                       └──────────────────┘   └──────────────────┘
          │
          ▼
┌──────────────────┐
│ E2E L: file-open │
│ .test.ts         │
│ needs: file API  │
│ + stateVector    │
└──────────────────┘

┌─────────────────────────────────────────────┐
│ ICE E2E tests (parallel block)              │
│ I.1 stun-only-direct.test.ts               │
│ I.2 all-mode-prefer-direct.test.ts         │
│ I.3 forced-turn.test.ts                    │
│ I.4 direct-unavailable-fallback.test.ts    │
│ needs: VITE_ICE_MODE + coturn container    │
└─────────────────────────────────────────────┘
```

### Execution order for implementation:

```
Phase 1 (no deps — can run in parallel):
  ├── chat-controller.test.ts
  ├── participants-controller.test.ts
  ├── sanitization.test.ts (ChatController portion)
  ├── relay-authorization.test.ts
  ├── signaling-client: fetchIceConfig test
  └── document-sync: file-open + remote-apply tests

Phase 2 (needs Phase 1 + __P2P_TEST__ fixes):
  ├── E2E C: chat-history.test.ts
  ├── E2E D: participant-list.test.ts
  └── E2E K: lifecycle-leaks.test.ts (needs getSignalingListenerCount)

Phase 3 (needs __P2P_TEST__ diagnostics complete):
  ├── E2E H: connection-state.test.ts
  ├── E2E J: room-lifetime.test.ts
  └── E2E L: file-open-once.test.ts (needs getStateVector)

Phase 4 (needs coturn in CI):
  └── ICE E2E tests I.1–I.4
```

---

## 5. Interface Contracts

### 5.1 New Helper API (E2E helpers additions)

```typescript
// Added to tests/e2e/helpers/e2e-helpers.ts E2EHelpers interface

/** Open the chat panel. */
openChatPanel(page: Page): Promise<void>;

/** Send a chat message. */
sendChatMessage(page: Page, text: string): Promise<void>;

/** Get all chat message text contents. */
getChatMessages(page: Page): Promise<string[]>;

/** Close the right panel (any tab). */
closeChatPanel(page: Page): Promise<void>;

/** Get the participant email list from the UI. */
getParticipantEmails(page: Page): Promise<string[]>;

/** Get the participant count from the UI. */
getParticipantCount(page: Page): Promise<number>;

/** Wait for connection state to reach a specific value. */
waitForConnectionState(page: Page, state: string, timeout?: number): Promise<void>;
```

### 5.2 __P2P_TEST__ diagnostic additions (test-api.ts)

```typescript
// Added to P2PTestAPI interface in src/test-api.ts

/** Yjs state vector for the local document. */
getStateVector(): number[];  // serialized as number array for transfer

/** Recent chat messages (last N). */
getChatMessages(): { sender: string; text: string; role: string }[];

/** Count of active signaling event listeners. */
getSignalingListenerCount(): number;
```

### 5.3 Relay factory test config additions

The existing `createRelayServer(options)` already supports:
- `port: 0` for ephemeral ports
- `clock` for fake timers
- `idGenerator` for deterministic IDs
- `tokenTTL` for shortened TTL in tests
- `turnConfig` for TURN credential tests
- `getState()` for internal state inspection

**No new relay factory options needed.** The existing API surface covers all 14 authorization tests.

---

## 6. Test-to-Source Mapping

| Test Category | Source Module | Public API Tested | Private Behavior |
|--------------|---------------|-------------------|------------------|
| Chat (8 tests) | `chat/chat-controller.ts` | `addLog()`, `renderInto()`, `markRead()`, `unread` | `_createEntry()` (via output) |
| Participants (8 tests) | `participants/participants-controller.ts` | `replaceSnapshot()`, `allUsers`, `userCount()`, `render()` | none |
| Security sanitization (5 tests) | `chat/chat-controller.ts` | `addLog()` → `_createEntry()` output | textContent vs innerHTML |
| Security spoofing (2 tests) | `session-controller.ts` | `onControlMessage?`, `onRoomState?` | message prefix gating |
| Relay auth (16 tests) | `server/ws-relay.js` | `createRelayServer()`, WS protocol | internal room/token maps |
| Signaling add (1 test) | `signaling-client.ts` | `fetchIceConfig()` | caching + refresh logic |
| Sync add (2 tests) | `document-sync.ts` | `createDoc()`, `SyncQueue` | transaction count, origin flags |

---

## 7. CI Integration Notes

The existing `test.yml` has 4 jobs: check, unit, e2e-direct, e2e-turn. The spec requires 6 jobs. New tests map to existing jobs:

| New Test Files | CI Job |
|----------------|--------|
| chat-controller, participants-controller, sanitization | `unit` (vitest) |
| relay-authorization | `unit` (vitest) — but should be a separate `relay-security` job per spec |
| signaling-client, document-sync additions | `unit` (vitest) |
| E2E C, D, H, J, K, L | `e2e-direct` (Playwright, stun-only) |
| ICE tests I.1–I.4 | `e2e-direct` (I.1, I.2) and `e2e-turn` (I.3, I.4) |

**CI gap:** Spec requires a separate `relay-security` job. Currently relay tests run in the `unit` job. Either split into a separate job or tag tests with `@security` and add a grep filter.

---

## 8. Summary of Files to Create

| # | File | Type | Test Count |
|---|------|------|-----------|
| 1 | `tests/unit/chat/chat-controller.test.ts` | Unit | 8 |
| 2 | `tests/unit/participants/participants-controller.test.ts` | Unit | 8 |
| 3 | `tests/unit/security/sanitization.test.ts` | Unit | 7 |
| 4 | `tests/unit/relay/relay-authorization.test.ts` | Unit | 16 |
| 5 | `tests/e2e/core/chat-history.test.ts` | E2E | 1 (Test C) |
| 6 | `tests/e2e/core/participant-list.test.ts` | E2E | 1 (Test D) |
| 7 | `tests/e2e/core/connection-state.test.ts` | E2E | 1 (Test H) |
| 8 | `tests/e2e/core/room-lifetime.test.ts` | E2E | 1 (Test J) |
| 9 | `tests/e2e/core/lifecycle-leaks.test.ts` | E2E | 1 (Test K) |
| 10 | `tests/e2e/core/file-open-once.test.ts` | E2E | 1 (Test L) |
| 11 | `tests/e2e/ice/stun-only-direct.test.ts` | E2E | 1 (Test I.1) |
| 12 | `tests/e2e/ice/all-mode-prefer-direct.test.ts` | E2E | 1 (Test I.2) |
| 13 | `tests/e2e/ice/forced-turn.test.ts` | E2E | 1 (Test I.3) |
| 14 | `tests/e2e/ice/direct-unavailable-fallback.test.ts` | E2E | 1 (Test I.4) |

**Files to modify:**

| # | File | Change | Test Count |
|---|------|--------|-----------|
| 15 | `tests/unit/signaling/signaling-client.test.ts` | Add 1 test | +1 |
| 16 | `tests/unit/sync/document-sync.test.ts` | Add 2 tests | +2 |
| 17 | `tests/e2e/helpers/e2e-helpers.ts` | Add 7 helper methods | — |
| 18 | `src/test-api.ts` | Add 3 diagnostics | — |

**Total new tests: 55 unit + 10 E2E = 65 tests**

This matches the spec validation's estimate of ~55 unit + 7 E2E, with the difference being the 4 ICE tests counted as E2E (they were planned but not yet filed).
