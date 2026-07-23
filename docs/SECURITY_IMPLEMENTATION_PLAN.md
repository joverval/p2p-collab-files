# P2P-COLLAB-FILES — Security Hardening Implementation Plan

**Date:** 2026-07-23
**Status:** Draft, pending review
**Based on:** spec validation report (docs/security-hardening-spec-validation.md)
**Pre-existing work:** IMPLEMENTATION_PLAN.md (functional correctness P0-P7), ARCHITECTURE.md

---

## 0. Current State Summary

The validation report confirmed which security items are already done and which are gaps. Five items are fully addressed by the v2.0 relay rewrite: TURN `|| true` removed, default creds removed, textContent-only chat, DOMPurify preview, Cache-Control on /turn-credentials.

**Critical gaps (zero coverage):**
- Relay authorization: no sender identity checks on privileged operations
- WebSocket Origin checking: config exists but not applied to upgrade handler
- Rate limiting: no protection at any layer
- Room TTL bug: active rooms killed at 5 min regardless of activity

**Foundational gaps (needed by other sections):**
- No Zod or schema validation library
- No stable participantId (email is the primary key)
- Manual field-level validation with no type/size enforcement

---

## 1. Section Dependency Graph

```
S1-F (Message Schemas with Zod + limits)
 │
 ├─► S4-F (Identity: participantId, length/char enforcement)
 │    │
 │    └─► S3 (Relay Authorization — needs participantId for sender checks)
 │
 ├─► S8 (Rate Limiting — needs typed schemas before counting)
 │
 S5 (WS Origin — independent, no schema dependency)
 S7 (Room/Offer TTL — independent, no schema dependency)  ← CRITICAL BUG
 S1-T (Time-limited TURN credentials — independent)
 S2-CSP (CSP header — independent)
 S9-CI (Dependabot, CodeQL, SECURITY.md — independent)
 S10-P (Privacy logging — independent)
```

**Key insight:** S1-F (Zod schemas) is the foundation for authorization and rate limiting, but S7 (TTL bug) and S5 (WS Origin) can be fixed independently and immediately. S7 is the highest-impact one-line fix (change `room.created` to `room.lastActivityAt` on line 617).

---

## 2. Architectural Decisions

### ADR-S1: Zod for relay-side message validation only

**Context:** The relay currently uses manual `validateMessage()` checking field presence only (no types, no sizes). The client has TypeScript compile-time types. Both need the same message contracts.

**Decision:** Install Zod as a relay dependency only (server-side). Define schemas in `server/relay-schemas.js`. The client keeps its TypeScript types and adds a lightweight runtime check layer for incoming relay messages. This avoids bundling Zod into the browser.

**Consequence:** Relay schemas live in server/ and are not shared with the client. If message types diverge, tests catch it. The client's `SignalingClient.validateMessage()` is enhanced with size/type checks without pulling in Zod.

### ADR-S2: MemberSession model with participantId

**Context:** The relay uses email as the primary key for identity. Emails are mutable, can contain control characters, and don't provide a stable identity across reconnections. Authorization checks need a stable identity to verify "sender is current host" or "sender is promotion target."

**Decision:** Introduce `participantId` (stable, server-assigned UUID) as the primary identity key. Email becomes display metadata only. `MemberSession` tracks `{ participantId, email, role, ws, joinOrder }`. The `tokenRoom` map binds tokens to `{ roomId, role, participantId }`.

**Consequence:** This is S4-F (foundational). Changes touch every participant lookup in the relay. Token generation now binds to `participantId` instead of being anonymous. Authorization checks (S3) compare sender's `participantId` against stored expected values.

### ADR-S3: Per-operation authorization checks with typed errors

**Context:** None of the privileged relay operations (store-offer-next, host-approve, host-reject, promote-peer, store-promotion-offer, commit-promotion) verify the sender's identity or role.

**Decision:** Before processing each privileged operation, verify:
1. Sender's WS has an associated `participantId` (authenticated)
2. Room exists and sender belongs to it
3. Sender's role matches the operation's required role

Reject unauthorized operations with `{ type: 'error', code: 'UNAUTHORIZED', message: '...' }`. Never close the socket for authorization failures (distinguish from protocol violations).

**Operation authorization matrix:**

| Operation | Authorized sender | Check |
|-----------|-------------------|-------|
| `store-offer-next` | Current host | `sender.participantId === room.hostParticipantId` |
| `host-approve` | Current host | `sender.participantId === room.hostParticipantId` |
| `host-reject` | Current host | `sender.participantId === room.hostParticipantId` |
| `promote-peer` | Current host | `sender.participantId === room.hostParticipantId` |
| `store-promotion-offer` | Selected promotion target | `sender.participantId === room._promotion.targetParticipantId` |
| `commit-promotion` | Selected promotion target | `sender.participantId === room._promotion.targetParticipantId` |
| `become-host` | Any connected participant | Token lookup only (v1 fallback) |
| `store-offer` | Anyone (creates room) | No auth needed |
| `fetch-offer` | Anyone with valid token | Token lookup |
| `submit-answer` | Anyone with valid token | Token lookup |

### ADR-S4: WS Origin check at upgrade time

**Context:** The `allowedOrigins` config exists (line 13 of ws-relay.js) but is only applied to HTTP CORS headers. The WebSocket `connection` event does not inspect the `Origin` header.

**Decision:** In the `wss.on('connection', ...)` handler, check `ws.upgradeReq?.headers?.origin` (or the `req` from the `connection` callback). Reject connections from origins not in `allowedOrigins`. In production (`NODE_ENV=production`), reject connections with no Origin header. In development, allow missing Origin.

**Consequence:** Config-only change. `APP_ORIGINS` env var already exists and will now apply to both HTTP and WS. No protocol changes needed.

### ADR-S5: Separate TTLs with room activity-based expiry

**Context:** The cleanup loop uses `room.created` for expiry (line 617), killing active rooms after 5 minutes. Additionally, all tokens share a single TTL.

**Decision:**
- **Offer TTL** (5 min): Short-lived, for new peer joins only
- **Room TTL** (30 min inactivity): Room expires if `now - room.lastActivityAt > ROOM_TTL` and no connected sockets
- **Active room**: Retained while any socket is connected (heartbeat-alive)
- **Pending approval TTL** (5 min): Peer waiting for host approval
- **Promotion TTL** (30s): Promotion offer awaiting commit
- **Token TTL** (5 min): Individual offer/promotion-offer tokens

Rooms with at least one active socket never expire (until all sockets disconnect + inactivity timeout). The cleanup interval checks both token expiry and room inactivity.

### ADR-S6: Token bucket rate limiting per IP

**Context:** Zero rate limiting anywhere. Maps are unbounded. No backpressure.

**Decision:** Implement lightweight in-memory rate limiting without external dependencies:
- **Max rooms per IP**: 10 (hard limit)
- **Max WS connections per IP**: 20 (hard limit)
- **Max offers per IP per minute**: 30
- **Max /turn-credentials requests per IP per minute**: 60
- **Max peers per room**: 50
- **Max outstanding offers per room**: 100
- **Max promotion offers per room**: 5

Use a simple sliding-window counter per IP with periodic cleanup. Exceeded limits return `{ type: 'error', code: 'RATE_LIMITED', message: '...' }`.

**Consequence:** No external dependency. The rate limiter is a ~80 line module at `server/rate-limiter.js`. Uses Maps with timestamp arrays. Cleaned up by the existing 60-second interval.

### ADR-S7: Time-limited TURN credentials via coturn auth-secret

**Context:** Coturn currently uses `lt-cred-mech` with static credentials. Credentials never rotate. The relay sends the same username/password to every client.

**Decision:** Switch coturn to `use-auth-secret` with a shared secret. The relay generates time-limited HMAC-SHA1 credentials (30-min TTL) per request to `/turn-credentials`. Only `/turn-credentials` returns TURN credentials; the WS protocol never exposes them.

**Coturn config change:** Replace `lt-cred-mech` with `use-auth-secret` + `static-auth-secret=<SECRET>`. Add `stale-nonce=600` for clock skew tolerance.

**Relay change:** Add HMAC-SHA1 credential generation using Node.js `crypto.createHmac('sha1', secret).update(timestamp).digest('base64')`. Username format: `<timestamp>:<username>`. Password: HMAC output.

### ADR-S8: Content Security Policy via meta tag

**Context:** No CSP header or meta tag in the deployed page. The app loads external scripts (marked.js CDN, goatcounter analytics).

**Decision:** Add a restrictive CSP via `<meta http-equiv="Content-Security-Policy">` in index.html. Allow scripts only from self, the cdn.jsdelivr.net (marked), and track.joverval.cl (goatcounter). Allow connections to self and wss://relay.joverval.cl. Block inline scripts (move any remaining inline handlers to external scripts).

**Consequence:** The `<script>` tags in index.html (lines 8-10) need `nonce` attributes or hashes. Goatcounter's inline script at line 10 may need a nonce. This is the most restrictive CSP that still works with the current external dependencies.

---

## 3. File Change Map

### New files to create

| File | Purpose | Sections |
|------|---------|----------|
| `server/relay-schemas.js` | Zod schemas for all relay message types with size limits | S1-F |
| `server/rate-limiter.js` | In-memory sliding-window rate limiter per IP | S8 |
| `server/auth.js` | HMAC-SHA1 TURN credential generation | S1-T |
| `.github/workflows/codeql.yml` | CodeQL analysis workflow | S9-CI |
| `.github/dependabot.yml` | Dependabot config for npm + Actions | S9-CI |
| `SECURITY.md` | Security reporting policy | S9-CI |
| `server/.env.example` | Relay env var template with placeholders | S9-CI |

### Modified files

| File | Changes | Sections |
|------|---------|----------|
| `server/ws-relay.js` | Major: Zod validation, participantId, authorization, WS Origin, TTL separation, rate limiting, time-limited TURN creds, privacy logging | S1-F, S3, S4-F, S5, S7, S8, S1-T, S10-P |
| `server/start-relay.sh` | Remove `TURN_USER:-turnuser` default; add `TURN_SECRET` env | S1-T, S9 |
| `server/start-coturn.sh` | Remove `ifconfig.me` call; use static IP or env var | S1-T |
| `server/coturn.conf` | `lt-cred-mech` → `use-auth-secret`; remove static user | S1-T |
| `src/shell/signaling-client.ts` | Enhanced runtime validation; Origin-aware connection | S1-F, S5 |
| `src/shared/types.ts` | Add `participantId` to message types | S4-F |
| `index.html` | Add CSP meta tag | S2-CSP |
| `package.json` | Add `zod` dependency | S1-F |
| `.github/workflows/test.yml` | Add `npm audit --audit-level=high` step; pin actions to SHAs; add secret scanning | S9-CI |
| `tests/unit/relay/relay-protocol.test.ts` | Add auth, origin, rate-limit, TTL, and schema test cases | S1-F, S3, S5, S7, S8 |

---

## 4. Section-by-Section Implementation Detail

### S7: Fix Room TTL (CRITICAL — one-line bug)

**Priority:** S0 (immediate, before anything else)
**Risk:** LOW — simple fix, test-covered
**Files:** `server/ws-relay.js` (line 617)

**Change:**
```js
// Before (line 617):
if (now - room.created > tokenTTL) {

// After:
if (now - room.lastActivityAt > tokenTTL) {
```

**Test:** Add timer-based test in relay-protocol.test.ts: create room, advance clock past tokenTTL, verify active room (with heartbeat) survives; advance clock past tokenTTL after disconnect, verify room is cleaned up.

**Also in this section:** Implement separate TTLs as specified in ADR-S5. Add `offerTTL`, `pendingApprovalTTL`, `promotionTTL`, `roomInactivityTTL` to the `createRelayServer` options. Offer tokens expire at offerTTL regardless of room state. Rooms with active sockets never expire.

---

### S1-F: Message Schemas with Zod (FOUNDATION)

**Priority:** S1 (must complete before S3, S4-F, S8)
**Risk:** MEDIUM — adds dependency, touches message routing
**Files:** `server/relay-schemas.js` (NEW), `server/ws-relay.js`, `package.json`

**New file: server/relay-schemas.js**
```js
import { z } from 'zod';

// Size limits
const MAX_SDP_SIZE = 65536;      // 64KB
const MAX_EMAIL_LENGTH = 254;
const MAX_CHAT_LENGTH = 4096;
const MAX_TOKEN_LENGTH = 256;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_OFFER_ID_LENGTH = 128;
const MAX_PARTICIPANTS_PER_ROOM = 50;
const MAX_OFFERS_PER_ROOM = 100;

// Base schemas
const emailSchema = z.string().min(1).max(MAX_EMAIL_LENGTH)
  .regex(/^[^\x00-\x1f\x7f<>()\\[\]{};:@",\s]+@[^\s@]+\.[^\s@]+$/,
    'Invalid email format');

const participantIdSchema = z.string().min(1).max(64);

// Incoming message schemas (discriminated union by type)
export const storeOfferSchema = z.object({
  type: z.literal('store-offer'),
  sdp: z.string().min(1).max(MAX_SDP_SIZE),
  offerId: z.string().min(1).max(MAX_OFFER_ID_LENGTH),
  hostEmail: emailSchema,
  requestId: z.string().optional(),
});

export const fetchOfferSchema = z.object({
  type: z.literal('fetch-offer'),
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  requestId: z.string().optional(),
});

// ... (all message types with their schemas)

export const incomingMessageSchema = z.discriminatedUnion('type', [
  storeOfferSchema,
  fetchOfferSchema,
  // ... all others
]);

export const OUTGOING_SCHEMAS = { /* typed response schemas */ };
```

**Changes to ws-relay.js:**
1. Import `incomingMessageSchema` from `./relay-schemas.js`
2. Replace `validateMessage(msg)` call with `incomingMessageSchema.safeParse(msg)`
3. On parse failure: `respond(ws, { type: 'error', code: 'INVALID_MESSAGE', message: error.issues.map(i => i.message).join('; ') }, msg.requestId)`
4. Add size check before parsing: `if (raw.byteLength > MAX_WS_PAYLOAD) { respond(ws, { type: 'error', code: 'PAYLOAD_TOO_LARGE' }, ...); return; }`
5. Enforce limits when adding to Maps (max participants, max offers per room)

**Changes to SignalingClient:**
- Add `MAX_PAYLOAD` constant in `validateMessage()`
- Add length checks for email, SDP string fields
- Reject oversized messages before parsing

---

### S4-F: Identity Validation with participantId (FOUNDATION)

**Priority:** S2 (must complete before S3)
**Risk:** MEDIUM — touches all participant lookups, token generation
**Files:** `server/ws-relay.js`, `server/relay-schemas.js`, `src/shared/types.ts`, `src/shell/session-controller.ts`

**Relay changes (server/ws-relay.js):**

1. **participantId generation:** When a new participant is added to a room, generate a stable participantId:
   ```js
   function genParticipantId() { return idGenerator(); }
   ```

2. **Member model:** Replace `room.members` structure from `{ email, ws, joinOrder }` to `{ participantId, email, ws, joinOrder }`. ParticipantId is the key in the members Map.

3. **Token binding:** `tokenRoom.set(token, { roomId, role, participantId })` — tokens now carry participantId.

4. **Email enforcement:**
   - Max 254 chars (enforced by Zod schema)
   - Reject control characters and HTML-like markup (enforced by Zod regex)
   - Normalize: trim + lowercase (existing `normalizeEmail`, keep it)

5. **Duplicate rejection:** When a new participant joins, check if their participantId (or email) already has an active WS in the room. If so, close the old connection or reject the new one.

6. **Sender lookup helper:**
   ```js
   function getSenderInfo(ws) {
     for (const [roomId, room] of rooms) {
       for (const [pid, member] of room.members) {
         if (member.ws === ws) return { room, participantId: pid, email: member.email };
       }
     }
     return null;
   }
   ```

**Client changes:**
- `shared/types.ts`: Add `participantId?: string` to `PeerRequestMessage`, `NewHostMessage`, etc.
- `session-controller.ts`: Store `participantId` when received from relay. Pass it in relevant callbacks.

---

### S3: Relay Authorization

**Priority:** S3 (depends on S1-F + S4-F)
**Risk:** MEDIUM — adds checks to 7 operations, needs careful testing
**Files:** `server/ws-relay.js`

**Implementation:** Add authorization guard before each privileged operation:

```js
function requireHost(ws, room, requestId) {
  const sender = getSenderInfo(ws);
  if (!sender || sender.room !== room) {
    respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not a room member' }, requestId);
    return false;
  }
  // Find host participant
  const hostMember = [...room.members.values()].find(m => m.role === 'host');
  if (sender.participantId !== hostMember?.participantId) {
    respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Host only' }, requestId);
    return false;
  }
  return true;
}

function requirePromotionTarget(ws, room, requestId) {
  const sender = getSenderInfo(ws);
  const promotion = room._promotion;
  if (!promotion) {
    respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'No promotion in progress' }, requestId);
    return false;
  }
  if (sender.participantId !== promotion.targetParticipantId) {
    respond(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not the promotion target' }, requestId);
    return false;
  }
  return true;
}
```

Insert into each case handler:
- `store-offer-next`: `if (!requireHost(ws, room, requestId)) return;`
- `host-approve`: `if (!requireHost(ws, room, requestId)) return;`
- `host-reject`: `if (!requireHost(ws, room, requestId)) return;`
- `promote-peer`: `if (!requireHost(ws, room, requestId)) return;`
- `store-promotion-offer`: `if (!requirePromotionTarget(ws, room, requestId)) return;`
- `commit-promotion`: `if (!requirePromotionTarget(ws, room, requestId)) return;`

**Auto failover authorization:** When `initiateAutoFailover()` elects a candidate, verify the candidate's WS is still open and belongs to the room. The commit comes from the elected candidate — use `requirePromotionTarget`-style check for the auto-failover `commit-promotion` path.

---

### S5: WebSocket Origin Checking

**Priority:** S4 (can run in parallel with S3, after S1-F)
**Risk:** LOW — config-driven, minimal code
**Files:** `server/ws-relay.js`

**Change in `wss.on('connection', ...)` handler:**

```js
wss.on('connection', (ws, req) => {
  // Origin check
  const origin = req.headers.origin || '';
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !origin) {
    ws.close(4001, 'Origin required');
    return;
  }

  if (origin && !allowedOrigins.includes(origin)) {
    console.warn(`[security] WS connection rejected — origin "${origin}" not in allowlist`);
    ws.close(4001, 'Origin not allowed');
    return;
  }

  // ... rest of connection handler
```

**Path-based WS serving:** Currently the WS server shares the HTTP server. For path isolation, mount WS on `/ws`:
```js
// In createRelayServer:
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/ws') {
    // Origin check here
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
```

**Client change:** `SignalingClient` uses `wss://relay.joverval.cl/ws` (path added to WS_URL).

---

### S8: Rate Limiting

**Priority:** S5 (depends on S1-F for typed schemas)
**Risk:** MEDIUM — needs careful tuning of limits
**Files:** `server/rate-limiter.js` (NEW), `server/ws-relay.js`

**New file: server/rate-limiter.js**

A lightweight sliding-window rate limiter. No external dependency.

```js
export class RateLimiter {
  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    this.counters = new Map(); // key -> [{timestamp, count}]
  }

  /** Returns true if allowed, false if rate limited. */
  check(key, limit) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entries = this.counters.get(key);
    if (!entries) { entries = []; this.counters.set(key, entries); }
    // Remove expired entries
    while (entries.length > 0 && entries[0].timestamp < cutoff) {
      entries.shift();
    }
    const current = entries.reduce((sum, e) => sum + e.count, 0);
    if (current >= limit) return false;
    // Add to last bucket or create new
    const last = entries[entries.length - 1];
    if (last && last.timestamp > now - 5000) { last.count++; }
    else { entries.push({ timestamp: now, count: 1 }); }
    return true;
  }

  /** Periodic cleanup of stale keys. */
  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, entries] of this.counters) {
      while (entries.length > 0 && entries[0].timestamp < cutoff) {
        entries.shift();
      }
      if (entries.length === 0) this.counters.delete(key);
    }
  }
}

export class IPTracker {
  constructor() {
    this.ipRooms = new Map();    // ip -> Set<roomId>
    this.ipSockets = new Map();  // ip -> Set<ws>
    this.roomPeers = new Map();  // roomId -> Set<participantId>
  }

  trackRoom(ip, roomId) { /* ... */ }
  untrackRoom(ip, roomId) { /* ... */ }
  trackSocket(ip, ws) { /* ... */ }
  untrackSocket(ip, ws) { /* ... */ }
  roomCount(ip) { return this.ipRooms.get(ip)?.size || 0; }
  socketCount(ip) { return this.ipSockets.get(ip)?.size || 0; }
  peerCount(roomId) { return this.roomPeers.get(roomId)?.size || 0; }
}
```

**Integration in ws-relay.js:**

1. Create instances at server startup: `const rateLimiter = new RateLimiter(); const ipTracker = new IPTracker();`
2. On `store-offer`: get IP from `ws._socket?.remoteAddress`, check `ipTracker.roomCount(ip) < MAX_ROOMS_PER_IP`
3. On WS connection: check `ipTracker.socketCount(ip) < MAX_SOCKETS_PER_IP`
4. On `submit-answer`: check `ipTracker.peerCount(roomId) < MAX_PEERS_PER_ROOM`
5. On `/turn-credentials` HTTP: check rate limit per IP
6. On new offer creation: check room's offer count
7. Cleanup on the existing 60s interval: `rateLimiter.cleanup()`

---

### S1-T: Time-Limited TURN Credentials

**Priority:** S6 (independent, can run anytime)
**Risk:** LOW — standard HMAC-SHA1, well-documented pattern
**Files:** `server/auth.js` (NEW), `server/ws-relay.js`, `server/coturn.conf`, `server/start-coturn.sh`, `server/start-relay.sh`

**New file: server/auth.js**
```js
import crypto from 'node:crypto';

export function generateTurnCredentials(secret, ttlSeconds = 1800, username = 'p2p') {
  const timestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const usernameStr = `${timestamp}:${username}`;
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(usernameStr);
  const password = hmac.digest('base64');
  return { username: usernameStr, password, ttl: ttlSeconds };
}
```

**Relay integration:**
- Read `TURN_SECRET` env var (required when TURN_ENABLED=1)
- In `/turn-credentials` handler: call `generateTurnCredentials(TURN_SECRET)`
- Return time-limited credentials in the response
- Remove static `TURN_USER`/`TURN_PASS` from credential response

**Coturn config changes:**
```
# Replace:
# lt-cred-mech
# With:
use-auth-secret
static-auth-secret=<SECRET>
stale-nonce=600
```

**Deployment config changes:**
- `start-relay.sh`: Remove `TURN_USER="${TURN_USER:-turnuser}"` default. Add `TURN_SECRET` requirement.
- `start-coturn.sh`: Remove `ifconfig.me` call. Use static `external-ip` config or pass via env var.

---

### S2-CSP: Content Security Policy

**Priority:** S7 (low priority, simple additive change)
**Risk:** LOW — meta tag, reversible
**Files:** `index.html`

**Change:** Add `<meta http-equiv="Content-Security-Policy" ...>` in `<head>`:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' https://cdn.jsdelivr.net https://track.joverval.cl;
  connect-src 'self' wss://relay.joverval.cl https://track.joverval.cl;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';
  media-src 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'none';
">
```

**Testing:** E2E tests verify the app still loads and functions. Check browser console for CSP violations. May need to adjust for goatcounter's inline script (add `'unsafe-inline'` to script-src or use nonce/hash).

---

### S9-CI: CI Security Hardening

**Priority:** S8 (independent, config-only)
**Risk:** LOW — additive CI configs
**Files:** `.github/workflows/codeql.yml` (NEW), `.github/dependabot.yml` (NEW), `SECURITY.md` (NEW), `.github/workflows/test.yml` (MODIFIED), `server/.env.example` (NEW)

**New file: .github/dependabot.yml**
```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

**New file: .github/workflows/codeql.yml**
Standard GitHub CodeQL workflow (JS/TS analysis on push+PR to master, plus scheduled weekly).

**New file: SECURITY.md**
```markdown
# Security Policy

## Reporting a Vulnerability

Do NOT open a public issue. Email [contact info] with details.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅ |

## Security Model

p2p-collab-files uses WebRTC for direct P2P communication...
```

**Modify .github/workflows/test.yml:**
1. Add `npm audit --audit-level=high` step in `check` job (after npm ci)
2. Pin actions to commit SHAs instead of `@v4`
3. Add secret scanning step: run `gitleaks detect --no-git` or use `trufflehog`

**New file: server/.env.example**
```
TURN_ENABLED=0
TURN_HOST=
TURN_SECRET=
APP_ORIGINS=https://joverval.cl,http://localhost:8082
PORT=8083
```

---

### S10-P: Privacy Logging

**Priority:** S9 (independent, simple changes)
**Risk:** LOW — log message changes only
**Files:** `server/ws-relay.js`

**Changes:**
1. Replace email in failover log messages with participantId:
   ```js
   // Before (line 189):
   console.log(`[failover] room ${room.roomId}: initiating auto promotion to ${candidate.email}`);
   // After:
   console.log(`[failover] room ${room.roomId}: initiating auto promotion to ${candidate.participantId}`);
   ```
2. Similarly replace emails in lines 593, 596 (grace period / failover logging)
3. Add a startup log confirming no SDP/file/token logging: `console.log('[relay] privacy: no SDP, token, or file content logging')`
4. Ensure all `console.error` calls that reference participant data use participantId, not email
5. Audit: grep for `console.log` and `console.error` containing email addresses — replace with participantId

---

## 5. Test Coverage Requirements

### New test files

| File | Covers | Type |
|------|--------|------|
| `tests/unit/relay/relay-auth.test.ts` | Authorization checks for 7 privileged operations | Unit |
| `tests/unit/relay/relay-schemas.test.ts` | Zod schema validation (valid + invalid payloads) | Unit |
| `tests/unit/relay/relay-rate-limit.test.ts` | Rate limiter (rooms/IP, sockets/IP, offers/min) | Unit |
| `tests/unit/relay/relay-origin.test.ts` | WS Origin checking (allowed, disallowed, missing) | Unit |
| `tests/unit/relay/relay-ttl.test.ts` | TTL separation with fake timers | Unit |
| `tests/e2e/core/security-csp.test.ts` | CSP header present, app functional | E2E |

### Test cases per section

**S1-F (Zod schemas):**
- Valid store-offer → accepted
- store-offer with missing sdp → rejected with typed error
- store-offer with oversized SDP (65KB+) → rejected
- Email with control character → rejected
- Email with HTML tags → rejected
- Email exceeding 254 chars → rejected
- Unknown message type → rejected
- Malformed JSON → rejected (not silently swallowed)

**S3 (Authorization):**
- Non-host sends store-offer-next → UNAUTHORIZED
- Non-host sends host-approve → UNAUTHORIZED
- Non-target sends store-promotion-offer → UNAUTHORIZED
- Non-target sends commit-promotion → UNAUTHORIZED
- Host sends store-offer-next → allowed
- Host sends host-approve → allowed
- Promotion target sends commit-promotion → allowed
- Disconnected sender → UNAUTHORIZED

**S5 (WS Origin):**
- Connection from allowed origin → accepted
- Connection from disallowed origin → rejected (4001)
- Connection with no Origin in production → rejected
- Connection with no Origin in dev → accepted
- HTTP CORS still works for allowed origins

**S7 (TTL):**
- Active room survives past tokenTTL (heartbeat-alive)
- Inactive room expires after roomInactivityTTL
- Offer token expires at offerTTL
- Pending approval token expires at pendingApprovalTTL
- Room with connected sockets never expires

**S8 (Rate Limiting):**
- 11th room from same IP → RATE_LIMITED
- 21st WS connection from same IP → rejected
- 51st peer in room → RATE_LIMITED
- Rate-limited /turn-credentials → 429 response
- Cleanup removes expired counters

---

## 6. Execution Order

```
Phase 1 (Quick Wins — no deps):
  S7  (Room TTL bug fix — one line)
  S5  (WS Origin — config-only change)
  ── test + ship ──

Phase 2 (Foundation):
  S1-F  (Zod schemas — needed by S3, S4, S8)
  ── test ──

Phase 3 (Build on Foundation — can parallelize):
  S4-F  (participantId — needed by S3)
    └─► S3  (Authorization checks)
  S8    (Rate limiting — uses Zod schemas)
  ── integration test ──

Phase 4 (Independent — can run anytime):
  S1-T  (Time-limited TURN credentials)
  S2-CSP (CSP header)
  S9-CI (Dependabot, CodeQL, SECURITY.md)
  S10-P (Privacy logging)
  ── final test suite ──
```

**Schedule estimate:** ~3-4 days total with testing
- Phase 1: 2-4 hours
- Phase 2: 4-6 hours
- Phase 3: 8-12 hours (most complex: authorization + rate limiting)
- Phase 4: 4-6 hours

---

## 7. Cross-Cutting Concerns

### Relay file size
`ws-relay.js` is already 678 lines. Adding authorization, rate limiting, and Zod validation will push it to ~900-1000 lines. To keep it maintainable:

1. Extract `rate-limiter.js` and `relay-schemas.js` as separate modules (already planned)
2. Extract authorization helpers into a `server/authz.js` module
3. Keep the message handler switch statement in `ws-relay.js` as the routing layer

### Client-side schema alignment
Since Zod schemas live on the server only, the client's `types.ts` must stay synchronized with the relay schemas. Add a comment at the top of both files referencing each other. CI should run a schema compatibility check (compare message type literals).

### Production deployment coordination
S1-T (time-limited TURN creds) requires coordinated deployment:
1. Update coturn.conf with `use-auth-secret` + set `TURN_SECRET` env var
2. Restart coturn
3. Deploy relay with `TURN_SECRET` set and updated /turn-credentials handler
4. Verify with a test client

Both old and new credential formats should work for a brief window during deployment. The relay generates time-limited creds; coturn accepts them with the shared secret. No downtime needed if coordinated correctly.

### Interaction with P0-P7 functional plan
The security plan has zero overlap with P0-P7 (functional correctness). Security changes touch `server/ws-relay.js`, `server/` configs, `index.html`, and CI configs. P0-P7 touches `src/shell/`, `src/features/`, and `src/shared/types.ts`. The only shared file is `src/shared/types.ts` (S4-F adds `participantId` fields). This should be additive and non-conflicting.

### Missing spec decisions (from validation report)
Seven missing acceptance criteria were identified. This plan makes the following decisions to close them:

1. **Unauthorized behavior:** Return `{ type: 'error', code: 'UNAUTHORIZED' }`. Never close the socket.
2. **Numeric limits:** Defined in ADR-S6 (Section 8 above).
3. **Rate limit behavior:** Hard reject with typed error. No soft delay.
4. **npm audit:** Enforced — `npm audit --audit-level=high` fails CI.
5. **XSS test payloads:** Formalized in test cases for S2 (existing DOMPurify coverage).
6. **participantId ↔ email mapping:** participantId is the primary key. Email is display metadata stored in the MemberSession. Client receives both.
7. **Invite URL logging:** Not a relay concern. No relay-side action needed.

---

## 8. Definition of Done

All sections are complete when:
- [ ] S7: `room.lastActivityAt` used for expiry. Active rooms survive past 5 min. Tests pass with fake timers.
- [ ] S1-F: Zod schemas validate all incoming messages. Size limits enforced. Invalid messages get typed errors.
- [ ] S4-F: participantId is the primary identity key. Email is display-only. Length/char enforcement active.
- [ ] S3: All 7 privileged operations require authorization. Unauthorized attempts get UNAUTHORIZED error. Tests cover every matrix entry.
- [ ] S5: WS connections from disallowed origins rejected. No-Origin connections rejected in production. Tests cover all origin scenarios.
- [ ] S8: Rate limits enforced on rooms/IP, sockets/IP, offers/min, peers/room. Exceeded limits return RATE_LIMITED error. Cleanup works.
- [ ] S1-T: Coturn uses `use-auth-secret`. Relay generates time-limited HMAC-SHA1 credentials. Static creds removed from relay response.
- [ ] S2-CSP: CSP meta tag in index.html. App loads without CSP violations in browser console.
- [ ] S9-CI: Dependabot config files exist. CodeQL workflow runs. `npm audit` fails CI on high severity. SECURITY.md exists.
- [ ] S10-P: No email addresses in relay console logs. Only participantId used. Grep audit clean.
- [ ] All new test files pass.
- [ ] Existing relay protocol tests still pass.
- [ ] Existing E2E tests still pass.
