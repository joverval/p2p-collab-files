# Spec Validation: Release-Gate Test Suite (04)

**Date**: 2026-07-23
**Project**: p2p-collab-files
**Status**: 77 unit tests, 6 E2E test files, CI workflow in place

---

## 1. TEST STACK — DONE

All package.json scripts match the spec exactly. vitest, jsdom, playwright, local relay, and coturn container config (docker-compose.turn.yml) are in place. vitest.config.ts and playwright.config.ts exist.

- typecheck: ✓
- test:unit / test:coverage: ✓
- test:e2e / test:e2e:headed: ✓
- check (typecheck+test:unit+build+test:e2e): ✓ (slightly more comprehensive than spec's version)
- test:all: ✓

---

## 2. TESTABILITY REQUIREMENTS — MOSTLY DONE

| # | Requirement | Status |
|---|------------|--------|
| 1 | Endpoints from environment variables | ✓ |
| 2 | Relay startable on ephemeral port (`port: 0`) | ✓ |
| 3 | Export controllers/factories (not just page side effects) | ✓ |
| 4 | Stable `data-testid` attributes (16 selectors) | ✓ |
| 5 | `window.__P2P_TEST__` diagnostics | PARTIAL |

**__P2P_TEST__ gaps** (test-api.ts implements 7 of 9 spec diagnostics):

| Diagnostic | Status |
|-----------|--------|
| getText() | ✓ |
| getStateVector() | ✗ MISSING |
| getParticipants() | ✓ (returns empty array — placeholder) |
| getRole() | ✓ |
| getConnectionState() | ✓ |
| getConnectionRoute() | ✓ |
| getRoomId() | ✓ |
| getChatMessages() | ✗ MISSING |
| getSignalingListenerCount() | ✗ MISSING |

---

## 3. UNIT TESTS — COVERAGE GAPS

### 3.1 SignalingClient API — MOSTLY DONE (30 tests, 1 file)

Coverage: C.1-C.12 fully covered.

| Spec item | Status |
|-----------|--------|
| Required methods exist | ✓ (implicit via usage) |
| Request IDs are unique | ✓ |
| Matching response resolves correct Promise | ✓ |
| Unsolicited event reaches subscribers | ✓ |
| Error rejects request | ✓ |
| Timeout removes request | ✓ |
| Close rejects all pending requests | ✓ |
| Reconnect does not duplicate listeners | ✓ |
| Malformed JSON is handled | ✓ |
| `fetchIceConfig()` caches and refreshes appropriately | ✗ **MISSING** |

### 3.2 Message Envelope — DONE (20 tests, 1 file)

All 6 spec items covered (chat round-trip, Yjs round-trip, empty/truncated payload, feature encoding, invalid header, large payload).

### 3.3 Yjs Synchronization — MOSTLY DONE (33 tests, 1 file)

| Spec item | Status |
|-----------|--------|
| Initial state-vector sync | ✓ |
| Late join receives full history | ✓ |
| Host and peer missing updates merge bidirectionally | ✓ |
| Concurrent updates converge | ✓ |
| Duplicate/out-of-order updates converge | ✓ |
| Disconnected queued updates flush after reconnect | ✓ |
| File open creates one Yjs transaction | ✗ **MISSING** (FILE_OPEN_ORIGIN tested but transaction count not verified) |
| Remote apply does not create a second local editor mutation | ✗ **MISSING** |
| Destroy clears timers and queues | ✓ |

### 3.4 ChatController and PanelController — MISSING ENTIRELY

**No chat unit tests exist** despite `src/shell/chat/chat-controller.ts` being present.

All 8 spec items are missing:
- History renders immediately when panel opens
- Opening/closing does not lose messages
- Incoming message appends while open
- Unread state works while closed
- Sender rendered once
- Send callback called once
- HTML payload rendered as text
- No `innerHTML` path receives untrusted chat content

### 3.5 Participants and Role State — MISSING ENTIRELY

**No participant unit tests exist** despite `src/shell/participants/participants-controller.ts` having data-testid attributes.

All 10 spec items are missing:
- Complete snapshot replaces local list
- Snapshot deduplicates and orders
- Stale version ignored
- Join/leave updates count
- Promotion changes host/peer roles
- Open Users panel rerenders without reopening
- `applyRoleState(true)` enables host actions
- `applyRoleState(false)` disables host actions
- Save remains available to peers
- Logic blocks host-only actions even if DOM is manipulated

### 3.6 Relay Authorization and Lifecycle — MINIMAL (8 tests, 1 file)

Only basic protocol happy-path covered (store-offer, fetch-offer, submit-answer, approve, reject, store-offer-next, ping/pong). **14 of 16 spec items are missing:**

| Spec item | Status |
|-----------|--------|
| store-offer → token returned | ✓ |
| fetch-offer → SDP returned | ✓ |
| submit-answer flow | ✓ |
| host-approve flow | ✓ |
| host-reject flow | ✓ |
| store-offer-next (second offer in room) | ✓ |
| ping/pong | ✓ |
| Non-host cannot approve/reject | ✗ **MISSING** |
| Non-host cannot promote | ✗ **MISSING** |
| Wrong promotion target cannot commit | ✗ **MISSING** |
| Token cannot be used by wrong intended participant | ✗ **MISSING** |
| Duplicate active email/identity policy | ✗ **MISSING** |
| Oversized payload rejected | ✗ **MISSING** |
| Invalid schema rejected | ✗ **MISSING** |
| Disallowed WebSocket Origin rejected | ✗ **MISSING** |
| Active room survives beyond offer TTL | ✗ **MISSING** |
| Expired offer deleted without deleting room | ✗ **MISSING** |
| Heartbeat removes dead socket | ✗ **MISSING** |
| Rate limits work | ✗ **MISSING** |
| TURN credentials absent when disabled | ✗ **MISSING** |
| TURN credentials short-lived, never expose shared secret | ✗ **MISSING** |

### 3.7 Security Unit Tests — MISSING ENTIRELY

**No security unit tests exist.** All 7 spec items are missing:

- Chat `<img onerror>` does not execute
- Markdown `<script>` removed
- `javascript:` link removed
- Unsafe SVG removed
- Very long chat/email rejected
- Control-message spoof from peer rejected
- Room-state spoof from peer rejected

---

## 4. PLAYWRIGHT E2E TESTS — 6 OF 12 DONE

| Test | Description | Status |
|------|------------|--------|
| A | Late join receives complete file | ✓ | `late-join-history.test.ts` |
| B | Host + two peers with history | ✓ | `concurrent-convergence.test.ts` |
| C | Chat history visibility | ✗ **MISSING** |
| D | Participant list consistency | ✗ **MISSING** |
| E | Manual host promotion UI | ✓ | `host-promotion.test.ts` |
| F | Automatic host failover UI | ✓ | `auto-failover.test.ts` |
| G | Failed promotion rollback | ✓ | `failed-promotion-rollback.test.ts` |
| H | Real connection state | ✗ **MISSING** |
| I | STUN/TURN route (4 sub-scenarios) | ✗ **MISSING** |
| J | Active room lifetime | ✗ **MISSING** |
| K | Repeated lifecycle and listener leaks | ✗ **MISSING** |
| L | File open exactly once | ✗ **MISSING** |

---

## 5. CI AND DEPLOYMENT GATES — PARTIAL

### test.yml (exists)
- check job: typecheck + build + relay smoke test ✓
- unit job: vitest with coverage ✓
- e2e-direct job: STUN-only, @direct grep ✓
- e2e-turn job: TURN-only, @turn grep ✓

### Gaps vs spec

| Spec requirement | Status |
|-----------------|--------|
| 6 required jobs (check, unit, relay integration/security, direct E2E, TURN E2E, prod build) | ✗ Only 4 jobs; relay/security not separate, no prod build job |
| E2E failure artifacts: Playwright trace | ✓ |
| E2E failure artifacts: Screenshots | ✓ |
| E2E failure artifacts: Browser console | ✓ (in report) |
| E2E failure artifacts: Relay logs | ✗ **MISSING** |
| E2E failure artifacts: Coturn logs | ✗ **MISSING** |
| E2E failure artifacts: ICE pair diagnostics | ✗ **MISSING** |
| Deploy workflow runs only after test workflow succeeds | ✗ **MISSING** (deploy.yml triggers on push to master independently) |
| Branch protection requires test workflow | ✗ Unknown (GitHub settings, external to repo) |

### deploy.yml — DOES NOT REQUIRE TESTS

Current deploy.yml triggers on push to master with no dependency on test.yml. Spec requires: "The deploy workflow must run only after the required test workflow succeeds."

---

## 6. KNOWN BUG: Failing Test Contradicts Spec

`tests/unit/session/session-controller.test.ts:232` — **D.3 "should go to connected when relay approved event fires"** — expects `connected` but receives `idle`. This test is actually **correctly failing** per spec Section H: "Relay approval alone must not show Connected." The test expectation is wrong, not the code. Remove or rewrite this test.

---

## 7. SUMMARY: Effort Estimate

| Category | Items Done | Items Missing |
|----------|-----------|---------------|
| Test stack/scripts | All | — |
| Testability requirements | 5/8 | getStateVector, getChatMessages, getSignalingListenerCount |
| SignalingClient unit | 9/10 | fetchIceConfig caching |
| Yjs sync unit | 7/9 | file-open transaction count, remote-apply echo |
| Chat unit tests | 0/8 | All |
| Participants/role unit | 0/10 | All |
| Relay auth unit | 7/23 | 14 authorization + 2 TURN tests |
| Security unit | 0/7 | All |
| E2E A-L | 6/12 | C, D, H, I, J, K, L |
| CI gate completeness | Mostly | relay/security separate job, prod build job, relay/coturn/ICE artifacts, deploy dependency |
| Fix bugs | — | 1 failing test (wrong expectation) |
| **Total new tests needed** | **~80+** | **~55 unit + 7 E2E + CI fixes** |
