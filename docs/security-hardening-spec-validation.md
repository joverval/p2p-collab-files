# Security Hardening Spec Validation

Validated by: Mara (Product Agent)
Date: 2026-07-23
Source spec: 02_p2p-collab-files-security-hardening.txt

## Summary

The spec is well-structured and covers the right attack surfaces. However, it describes the codebase as it existed BEFORE the v2.0 relay rewrite. Several items in Section 1 and Section 2 are already fixed in the current code. The spec should be updated to reflect current state so the remaining gaps are clear.

The biggest gaps are: authorization checks (Section 3), WS origin enforcement (Section 5), and rate limiting (Section 8) — all three are completely absent.

---

## Per-Section Analysis

### 1. TURN Credentials — PARTIALLY DONE

**Already fixed:**
- `|| true` removed. `TURN_ENABLED` is now `process.env.TURN_ENABLED === '1' || process.env.TURN_ENABLED === 'true'` (line 60 of ws-relay.js). No hard-default to true.
- Default credentials removed. `TURN_USER` and `TURN_PASS` default to empty string `''` (lines 63-64).
- Startup fails gracefully when `TURN_ENABLED=1` but credentials missing (lines 67-70).
- `/turn-credentials` has `Cache-Control: no-store` (line 242).
- `/turn-credentials` returns STUN-only when TURN disabled (line 252 `if` guard).

**Still needed:**
- Items 4: Rotate the currently deployed TURN password. Operational action, not code.
- Items 6-7: Coturn uses `lt-cred-mech` (static long-term credentials) in `server/coturn.conf`. Must switch to `use-auth-secret` with time-limited HMAC-SHA1 credentials (30-60 min).
- Items 8-9: No per-IP rate limiting on `/turn-credentials`. No coturn user/total quotas.
- Item 10: No bandwidth/allocation monitoring.
- "Do not fetch from ifconfig.me": `server/start-coturn.sh` calls `curl -s ifconfig.me` at startup. The relay itself doesn't, but the coturn wrapper does. This is a deployment concern.

**Testability:** Items 1-5 are testable (env-var checks, startup behavior). Items 6-7 require a live coturn instance to test credential generation. Items 8-9 need rate-limit testing infrastructure.

**Production config issue:** `server/start-relay.sh` sets `TURN_ENABLED=1` and `TURN_USER="${TURN_USER:-turnuser}"` — a default username in production config. The spec says remove all defaults. This is a deployment config file, not source code, but still violates the spirit.

---

### 2. XSS Protection — MOSTLY DONE

**Already fixed:**
- ChatController: Uses `textContent` exclusively (line 58: `div.textContent = ...`). No `innerHTML` concatenation. The spec's claim that it uses `innerHTML` is describing the old code.
- Markdown preview: Already imports and uses DOMPurify (line 4 of preview-controller.ts: `import DOMPurify from 'dompurify'`, line 26: `DOMPurify.sanitize(rawHTML)`).
- DOMPurify installed (`dompurify: ^3.4.12` in package.json).
- `@types/dompurify` installed (`^3.0.5` in package.json).

**Still needed:**
- Content Security Policy: No CSP header or `<meta>` tag in the deployed page. The spec says "Add a restrictive Content Security Policy to the deployed page where possible."
- Specific XSS tests: No tests exist that verify DOMPurify blocks `<script>`, `onerror=`, `onclick=`, `javascript:` URLs, SVG payloads, iframe/object/embed. The spec lists these as required test cases.

**Testability:** Fully testable. Unit tests can inject payload strings and verify the rendered output. E2E tests can verify CSP headers.

**Missing acceptance criteria:** The spec says "Chat and preview XSS tests pass" in the Definition of Done but doesn't list which specific payloads must be blocked. The payload list in Section 2 should be promoted to explicit acceptance criteria.

---

### 3. Relay Authorization — NOT DONE

**Current state:** None of the authorization checks listed in the spec are implemented. The relay uses `roomId` as lookup but does not verify the sender's identity or role for privileged operations.

**Gap inventory:**

| Operation | Spec requires | Current behavior |
|-----------|--------------|------------------|
| `store-offer-next` | Sender is current host | Any connected WS can call it with a valid roomId |
| `host-approve` | Sender is current host, token belongs to that room | Checks token → room lookup but NOT sender identity |
| `host-reject` | Sender is current host | Same as host-approve: no sender check |
| `promote-peer` | Sender is current host | No host check |
| `store-promotion-offer` | Sender is selected promotion target | No target check |
| `commit-promotion` | Sender is selected promotion target | Checks promotionId match but NOT sender identity |
| Auto failover commit | Sender is elected target | Candidate timeout logic exists but commit sender not verified |
| Token fetch/answer | Token exists, not expired, intended identity matches | Token existence and room lookup only; no identity matching |

The spec's `RoomSession` / `MemberSession` type definitions are not implemented. The relay uses ad-hoc Maps without a consistent membership model.

**Testability:** Fully testable. Each authorization check can be verified by unit tests that connect as different roles and attempt unauthorized operations.

**Missing acceptance criteria:** The spec lists operations and who should be authorized but doesn't specify what the relay should DO when an unauthorized sender attempts an operation. Should it return an error? Close the socket? Just ignore? This needs clarification.

---

### 4. Identity Validation — PARTIALLY DONE

**Already done:**
- Email normalization: `normalizeEmail()` function exists (lines 104-106 of ws-relay.js) — trim + lowercase.

**Still needed:**
- Email length enforcement (max 254 chars): Not implemented.
- Control character / markup rejection: Not implemented.
- Stable random `participantId`: Does not exist. Identity is tracked by email only.
- Duplicate active participant rejection: Not implemented.
- Token binding to `participantId` instead of email: Not implemented.
- Email treated as display metadata only: Not implemented; email is the primary key.

**Testability:** Fully testable. Length enforcement, character rejection, and duplicate detection are straightforward unit tests. participantId assignment is deterministic.

**Gap note:** The spec says "Do not use email as the primary connection key" but doesn't specify what the key should be. The suggestion is `participantId`, but the relay needs to know how to map between the two. This needs more detail.

---

### 5. WebSocket Origin — NOT DONE

**Current state:** The relay has an `allowedOrigins` config (line 13) but only applies it to HTTP CORS headers (lines 226-228). The WebSocket `connection` event (line 292) does NOT check the `Origin` header during upgrade.

**Still needed:**
- Serve WS on a specific path (`/ws`): The current relay uses the same HTTP server for everything — no path-based routing.
- Check `Origin` header during upgrade: Not implemented.
- Allow only configured origins: Config exists but isn't used for WS.
- Reject missing origin in production: Not implemented.
- Separate local dev origins from production: Config exists via `APP_ORIGINS` env var but isn't applied to WS.

**Testability:** Testable. Unit tests can verify that the upgrade handler checks Origin. The `ws` library exposes the upgrade request, so the header is accessible.

**Missing acceptance criteria:** The spec says "Do not treat Origin checking as full authentication; keep capability checks too." This is conceptual guidance, not a testable requirement. It should be rephrased as "Origin check rejects connections from unlisted origins; capability checks still apply to all connected clients."

---

### 6. Message Schemas — NOT DONE

**Current state:** Manual validation exists via `validateMessage()` (lines 109-156) but only checks field presence, not types or sizes. No Zod or Valibot.

**Still needed:**
- Install Zod or Valibot: Neither is in package.json.
- Validate every incoming message by `type`: Partial — field presence checked but not types.
- Limits for: WS maxPayload, SDP size, email length, chat length, participants per room, pending offers per room, offers per IP/min, promotion attempts, credential requests, rooms per IP.
- Reject invalid messages with typed error: Partially done — errors are returned but not typed.
- Do not silently swallow malformed JSON: Currently silent (line 303: `try { msg = JSON.parse(raw.toString()); } catch { return; }`). The spec is right — this silently swallows.

**Testability:** Fully testable with Zod/Valibot schemas. Each limit can be tested by sending payloads that exceed it.

**Missing acceptance criteria:** The spec lists limits but doesn't specify the actual values. "Maximum participants per room" needs a number. "Maximum SDP offer/answer size" needs a byte count. Without these, QA can't write tests.

---

### 7. Room/Offer TTL — NOT DONE (CRITICAL)

**Current state:** The relay's cleanup interval uses room `created` time for expiration (line 617: `now - room.created > tokenTTL`). This means active rooms die after 5 minutes regardless of activity. This IS the bug the spec describes.

**What exists:**
- `lastActivityAt` is tracked (line 97, updated throughout the code).
- WebSocket ping/pong heartbeat exists (lines 279-299).
- `gracePeriod` (10s) for host reconnect exists.

**What's broken:**
- Cleanup uses `room.created` instead of `room.lastActivityAt`.
- Single TTL for everything: offers, rooms, active rooms, pending approvals all share the same 5-minute timer.
- No TTL separation as specified.

**Still needed:**
- Offer TTL: short, 5 min (separate from room TTL).
- Pending approval TTL: short.
- Inactive room TTL: based on `lastActivityAt`.
- Active room: retained while heartbeat + active sockets exist.
- Promotion TTL: short and rollback-safe.
- Clean stale offers without deleting the room.

**Testability:** Fully testable with fake timers. The `createRelayServer` factory already accepts an injectable `clock`, making this straightforward to test.

**Critical fix:** The cleanup loop at line 617 is the highest-priority bug. Change `room.created` to `room.lastActivityAt` and add separate TTLs.

---

### 8. Rate Limiting — NOT DONE

**Current state:** Zero rate limiting. No IP tracking. No room/peer/offer limits. No backpressure checks.

**Still needed (all of it):**
- Max rooms per source IP
- Max peers per room
- Max outstanding offers per room
- Max promotion offers
- Request rate limits
- Bounded maps (Maps are currently unbounded)
- Cleanup on socket close (partial — participants cleaned but not offers)
- Cleanup for failed promotions
- Backpressure checks before `ws.send()`
- Logging without SDP or document content

**Testability:** Testable but requires infrastructure for rate-limit testing (sending many messages rapidly, verifying throttling). The spec should specify whether rate limits are hard (reject) or soft (delay).

**Missing acceptance criteria:** Specific numbers for all limits. "Max rooms per IP" — what's the number? "Request rate limits" — what's the rate? Without these, the spec is a direction, not a specification.

---

### 9. TURN Credential Delivery — PARTIALLY DONE

**Already done:**
- `Cache-Control: no-store` (line 242).
- No creds returned when TURN disabled (line 252 `if` guard).
- STUN-only fallback always returned (lines 246-250).
- Coturn shared secret never returned (it's not in the relay code).

**Still needed:**
- Short-lived credentials: Currently static. Needs HMAC-SHA1 time-limited generation.
- Origin enforcement: Not checked on `/turn-credentials`.
- Rate limiting by IP: Not implemented.
- Room/invite capability requirement: Not implemented.
- "Return a clear STUN-only configuration on failure": Partially done — the endpoint always returns STUN servers. But on auth failure there's no specific handling.

**Testability:** Testable. Time-limited credentials can be verified by checking expiration. Origin enforcement can be tested with different Origin headers. Rate limiting needs rate-limit testing infrastructure.

---

### 10. CI Security — NOT DONE

**Current state:**
- GitHub Actions workflow exists (`.github/workflows/test.yml`) with typecheck, unit tests, e2e tests.
- Actions use `@v4` (pinned to major, not SHA).
- No `npm audit` step.
- No Dependabot config (no `.github/dependabot.yml`).
- No CodeQL workflow.
- No secret scanning / push protection.
- No `SECURITY.md`.
- `.env.example` exists at `infra/coturn/.env.example` but not at repo root for the relay.
- No pre-commit hooks or CI checks for committed private keys / TURN secrets.

**Still needed (all of it):**
- Dependabot for npm and GitHub Actions
- CodeQL workflow
- Secret scanning / push protection
- `npm audit --audit-level=high` in CI
- Pin actions to commit SHAs
- `SECURITY.md` reporting policy
- `.env.example` at repo root with placeholders only
- Checks preventing committed keys/secrets

**Testability:** CI configuration is declarative and self-documenting. Verification is binary: the config file exists or doesn't, the workflow runs or doesn't.

**Missing acceptance criteria:** The spec says "npm audit as an informational or enforced step after reviewing false positives." This is ambiguous — is it informational or enforced? The spec needs to decide.

---

### 11. Privacy Logging — PARTIALLY DONE

**Current state (good):**
- No SDP body logging found in `ws-relay.js`.
- No TURN credential logging found.
- No file content logging (relay doesn't handle file content).
- No chat content logging (relay doesn't see chat — it's P2P).
- Console logs are operational: failover events, room creation, grace period transitions.

**Still needed:**
- Full invite URL logging: Not visible, but not explicitly prevented either.
- Raw participant token logging: Tokens are used internally but not logged.
- Minimize persisted email logging: Emails appear in failover console.log statements (lines 189, 593, 596). These should use opaque IDs.
- Opaque IDs in operational logs: Currently logs use emails for failover messages.

**Testability:** Testable by grepping the codebase for sensitive patterns and verifying log output format in tests.

**Gap:** The spec says "Do not log full invite URLs" but the relay doesn't generate invite URLs — that's a client concern. This item may belong in a client-side spec rather than the relay spec.

---

## Overall Assessment

### Testability Score by Section

| Section | Testable? | Notes |
|---------|-----------|-------|
| 1. TURN Credentials | Yes | Env var checks testable; coturn config needs live instance |
| 2. XSS Protection | Yes | Unit tests for payload blocking; E2E for CSP |
| 3. Relay Authorization | Yes | Each operation testable with role-based WS connections |
| 4. Identity Validation | Yes | Straightforward unit tests |
| 5. WS Origin | Yes | WS upgrade handler is testable |
| 6. Message Schemas | Yes | Zod/Valibot schemas are inherently testable |
| 7. Room/Offer TTL | Yes | Fake timers via injectable clock |
| 8. Rate Limiting | Yes | Needs rate-limit test infrastructure |
| 9. TURN Delivery | Yes | Origin, rate limit, credential TTL all testable |
| 10. CI Security | Config | File existence + workflow execution |
| 11. Privacy Logging | Yes | Grep + log output assertions |

All sections are testable. No section is fundamentally untestable.

### Missing Acceptance Criteria

1. **Section 3:** What happens when an unauthorized sender attempts an operation? (Error response? Socket close? Silent ignore?)
2. **Section 6:** Specific numeric values for all limits (max participants, max SDP size, rate limits, etc.)
3. **Section 8:** Specific rate limit values and behavior (hard reject vs. soft delay vs. socket close).
4. **Section 10:** Is `npm audit` informational or enforced?
5. **Section 2:** Which specific XSS payloads must be blocked? The list in the spec should be formalized as test cases.
6. **Section 4:** If email is not the primary key, what is the mapping between participantId and email for display?
7. **Section 11:** "Full invite URLs" — the relay doesn't generate these. Is this a client requirement?

### What's Already Done vs New

**Already done (no action needed):**
- TURN fallback chain: `|| true` removed, defaults removed, graceful disable (Section 1, items 1-3, 5)
- Chat XSS: textContent-only rendering (Section 2, Chat)
- Markdown XSS: DOMPurify installed and used (Section 2, Preview)
- Email normalization: trim + lowercase (Section 4, partial)
- `/turn-credentials`: Cache-Control: no-store, STUN fallback, no creds when disabled (Section 9, partial)
- WebSocket heartbeat: ping/pong with termination (Section 7, partial)
- No SDP/credential logging in relay code (Section 11, partial)

**New work needed (prioritized by risk):**

1. **CRITICAL:** Fix room TTL to use `lastActivityAt` instead of `created` (Section 7). Active rooms dying at 5 min is a functional bug.
2. **HIGH:** Add authorization checks to all privileged relay operations (Section 3). Currently anyone can approve/reject/promote.
3. **HIGH:** WebSocket Origin checking (Section 5). No protection against cross-origin WS connections.
4. **HIGH:** Rate limiting (Section 8). Zero protection against resource exhaustion.
5. **MEDIUM:** Message schemas with Zod and size limits (Section 6).
6. **MEDIUM:** Time-limited TURN credentials with HMAC-SHA1 (Section 1, items 6-7).
7. **MEDIUM:** Identity hardening: participantId, length/char enforcement (Section 4).
8. **LOW:** CI security: Dependabot, CodeQL, SECURITY.md, npm audit (Section 10).
9. **LOW:** Privacy logging: use opaque IDs instead of emails in logs (Section 11).
10. **LOW:** Content Security Policy header (Section 2, CSP).

### Cross-Cutting Concerns

- **Spec freshness:** The spec describes the codebase as it was before the v2.0 relay rewrite. Sections 1 and 2 in particular contain claims that are no longer true. The spec should be updated to reflect current state so the remaining gaps are clearly visible.
- **Production config:** `server/start-relay.sh` and `server/start-coturn.sh` contain defaults and `ifconfig.me` calls that violate the spec. These are deployment artifacts, not source code, but they need the same treatment.
- **Test coverage:** The existing test suite (unit + e2e) doesn't cover security. No security-specific tests exist. Each section above needs corresponding test cases.