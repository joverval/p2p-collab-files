# Test Infrastructure Architecture — p2p-collab-files

> Design document for the robust pre-push test suite.
> Covers: file layout, refactor integration points, VITE_ICE_MODE wiring,
> __P2P_TEST__ gating, CI workflow, data-testid placement, relay factory, and E2E helpers.

---

## 1. File/Folder Layout

```
p2p-collab-files/
├── tests/
│   ├── unit/
│   │   ├── protocol/
│   │   │   └── message-envelope.test.ts          # Tests A.1–A.7 (envelope round-trips)
│   │   ├── sync/
│   │   │   └── document-sync.test.ts             # Tests B.1–B.10 (Yjs convergence)
│   │   ├── signaling/
│   │   │   └── signaling-client.test.ts          # Tests C.1–C.11 (fake WS)
│   │   ├── session/
│   │   │   └── session-controller.test.ts        # Tests D.1–D.10 (mock P2PRoom)
│   │   └── relay/
│   │       └── relay-protocol.test.ts            # Tests E.1–E.17 (ephemeral relay)
│   ├── integration/
│   │   └── session-relay-integration.test.ts     # Session ↔ real relay w/ fake WS
│   ├── e2e/
│   │   ├── helpers/
│   │   │   ├── e2e-helpers.ts                    # createHost, joinPeer, etc.
│   │   │   ├── test-constants.ts                 # URLs, credentials, timeouts
│   │   │   └── fixtures.ts                       # Shared test data (emails, markdown)
│   │   ├── core/
│   │   │   ├── host-peer-sync.test.ts            # TEST 1
│   │   │   ├── late-join-history.test.ts         # TEST 2
│   │   │   ├── concurrent-convergence.test.ts    # TEST 3
│   │   │   ├── host-promotion.test.ts            # TEST 4
│   │   │   ├── auto-failover.test.ts             # TEST 5
│   │   │   └── failed-promotion-rollback.test.ts # TEST 6
│   │   └── ice/
│   │       ├── stun-only-direct.test.ts           # TEST 7
│   │       ├── all-mode-prefer-direct.test.ts     # TEST 8
│   │       ├── forced-turn.test.ts                # TEST 9
│   │       └── direct-unavailable-fallback.test.ts# TEST 10
│   └── infra/
│       ├── docker-compose.turn.yml               # local coturn for CI
│       └── docker-compose.e2e.yml                # full E2E stack (optional)
├── vitest.config.ts                               # unit + integration config
├── playwright.config.ts                           # E2E config
├── .github/workflows/
│   └── test.yml                                  # CI workflow (replaces ci.yml)
└── src/
    └── test-api.ts                               # __P2P_TEST__ gating (new)
```

**Key design points:**
- Unit tests run in Vitest + jsdom; no browser needed.
- Integration tests use the real relay via `createRelayServer()` on ephemeral ports + fake WebSocket pairs.
- E2E tests use Playwright with Chromium, started against a Vite dev server + test relay.
- `tests/infra/` holds Docker Compose for coturn and optional full-stack local dev.

---

## 2. Refactor Integration Points

### 2.1 `document-sync.ts` → SyncQueue class (MANDATORY)

**Problem:** Module-level `pendingUpdates`, `pendingBytes`, and `flushTimer` prevent test isolation. Multiple `MarkdownFeature` instances in one test run would collide.

**Design:**

```typescript
// src/features/markdown/document-sync.ts (refactored)

export class SyncQueue {
  private pendingUpdates: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sendFn: (data: Uint8Array) => void;
  private readonly isConnected: () => boolean;

  // Configurable thresholds for testing
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

  /** Returns current queued byte count (for test assertions). */
  get queuedBytes(): number { return this.pendingBytes; }

  /** Returns current queued update count (for test assertions). */
  get queuedCount(): number { return this.pendingUpdates.length; }

  /** Clean up timers. Call during MarkdownFeature.destroy(). */
  destroy(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.pendingUpdates = [];
    this.pendingBytes = 0;
  }
}

// createDoc() remains unchanged, still exported for convenience
export function createDoc(): { ydoc: Y.Doc; ytext: Y.Text; undoManager: Y.UndoManager } {
  // … unchanged …
}
```

**Integration point in `markdown-feature.ts`:**
```typescript
export class MarkdownFeature {
  private syncQueue: SyncQueue | null = null;

  start(ctx: FeatureContext): void {
    // … existing setup …
    this.syncQueue = new SyncQueue(
      (data) => ctx.sendFeatureData(data),
      () => ctx.isConnected()
    );
    ydoc.on('update', (update, origin) => {
      if (origin === NETWORK_ORIGIN) return;
      if (ctx.isConnected()) this.syncQueue!.enqueue(update);
    });
  }

  destroy(): void {
    this.syncQueue?.destroy();   // ← NEW: clears timer, pending queue
    this.editorView?.destroy();
    this.ydoc?.destroy();
  }
}
```

**Testing benefit:** Each `SyncQueue` instance is isolated. Test B.9 (disconnected queue accumulates and flushes) and B.10 (destroy cleans up) become trivial — create a `SyncQueue`, inspect `.queuedBytes`/`.queuedCount`.

---

### 2.2 `signaling-client.ts` → Injectable WebSocket factory

**Problem:** `connect()` does `new WebSocket(WS_URL)` directly — impossible to substitute with a fake.

**Design:**

```typescript
// src/shell/signaling-client.ts

export type WsFactory = (url: string) => WebSocket;

const DEFAULT_WS_FACTORY: WsFactory = (url) => new WebSocket(url);

export class SignalingClient {
  private wsFactory: WsFactory;

  constructor(wsFactory: WsFactory = DEFAULT_WS_FACTORY) {
    this.wsFactory = wsFactory;
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.wsFactory(WS_URL);   // ← injection point
      const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
      s.onopen = () => { clearTimeout(timer); this.ws = s; this.connected = true; resolve(); };
      // … rest unchanged …
    });
  }
}
```

**Testing:** In Vitest unit tests, inject a `vi.fn()` mock or a `FakeWebSocket` class that implements the `WebSocket` interface in jsdom. No need for `vi.stubGlobal('WebSocket', …)`.

**Integration point in `SessionController`:**
```typescript
export class SessionController {
  private signaling: SignalingClient;

  constructor(signaling?: SignalingClient) {
    this.signaling = signaling ?? new SignalingClient();
    this.registerPermanentHandlers();
  }
}
```

---

### 2.3 `server/ws-relay.js` → `createRelayServer()` factory

**Problem:** `server.listen(PORT, …)` at the end of the file auto-starts. Tests need ephemeral ports and deterministic control.

**Design:**

```javascript
// server/ws-relay.js — refactored to export factory; NO auto-start

/**
 * @param {object} options
 * @param {number} [options.port=8083]          Port to listen on (0 = ephemeral).
 * @param {() => number} [options.clock]        Injectable clock (for fake timers).
 * @param {() => string} [options.idGenerator]  Injectable ID generator (for deterministic tests).
 * @param {object} [options.turnConfig]         TURN server config override.
 * @returns {{ server: http.Server, wss: WebSocketServer, start(port?: number): Promise<number>, stop(): Promise<void>, getState(): object }}
 */
export function createRelayServer(options = {}) {
  const {
    port = Number(process.env.PORT || 8083),
    clock = () => Date.now(),
    idGenerator = () => crypto.randomBytes(18).toString('base64url'),
    turnConfig = { /* … from env or defaults … */ }
  } = options;

  // … ALL current module-level logic moves inside this function,
  //     substituting options.clock() for Date.now()
  //     and options.idGenerator() for all genToken()/genRoomId() calls …

  return {
    server,   // http.Server (not listening yet)
    wss,      // WebSocketServer
    start(portOverride) {
      return new Promise((resolve, reject) => {
        const p = portOverride ?? port;
        server.listen(p, () => {
          const addr = server.address();
          if (!addr) return reject(new Error('Server failed to start'));
          resolve(typeof addr === 'string' ? p : addr.port);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        clearInterval(heartbeatInterval); // internal cleanup
        wss.close(() => server.close(() => resolve()));
      });
    },
    /** Expose internal state for test assertions. */
    getState() {
      return {
        rooms: new Map(rooms),
        tokenRoom: new Map(tokenRoom),
      };
    },
  };
}
```

**Auto-start entrypoint (separate file):**
```javascript
// server/start-relay.js
import { createRelayServer } from './ws-relay.js';
const relay = createRelayServer();
relay.start().then(port => console.log(`Relay v2.0 on :${port}`));
```

Update `package.json` script: `"relay": "node server/start-relay.js"`.

**Testing:** Integration tests call `createRelayServer({ port: 0, clock: fakeClock, idGenerator: predictableGen })`, get back the actual port from `start()`, and connect fake WebSocket clients to `ws://localhost:<port>`.

---

## 3. VITE_ICE_MODE Wiring

**Definition:** `VITE_ICE_MODE` takes one of three values:
| Value | Effect |
|---|---|
| `stun-only` | Strip all TURN servers; force `iceTransportPolicy: 'all'` |
| `all` (default) | No modification; all ICE servers as provided |
| `turn-only` | Force `iceTransportPolicy: 'relay'` |

**Code location:** `SignalingClient.fetchIceConfig()` — the single choke point for ICE configuration.

```typescript
// src/shell/signaling-client.ts — fetchIceConfig() extension

async fetchIceConfig(): Promise<RTCConfiguration> {
  // … existing fetch-or-fallback logic producing `config` …

  // ── Apply VITE_ICE_MODE override ──
  const iceMode = import.meta.env.VITE_ICE_MODE || 'all';

  if (iceMode === 'stun-only') {
    config.iceServers = (config.iceServers || [])
      .map(server => ({
        ...server,
        urls: Array.isArray(server.urls)
          ? server.urls.filter(u => typeof u === 'string' && u.startsWith('stun:'))
          : (typeof server.urls === 'string' && server.urls.startsWith('stun:') ? server.urls : [])
      }))
      .filter(server => {
        const urls = server.urls;
        return Array.isArray(urls) ? urls.length > 0 : urls !== '';
      });
    config.iceTransportPolicy = 'all';
  } else if (iceMode === 'turn-only') {
    config.iceTransportPolicy = 'relay';
    // Keep TURN servers; browser will ignore STUN candidates automatically
  }

  return config;
}
```

**Why not in vite.config.ts?** The ICE mode is a runtime decision — for E2E tests we want to run the same build with different env vars. A Vite `define` would bake it at build time. Using `import.meta.env.VITE_ICE_MODE` lets tests pass it at server start.

**How tests control it:**
- **Vitest unit tests:** Set in `vitest.config.ts` → `env: { VITE_ICE_MODE: 'stun-only' }`
- **Playwright E2E tests:** Start Vite dev server with env: `VITE_ICE_MODE=all vite` or `VITE_ICE_MODE=turn-only vite`

---

## 4. `window.__P2P_TEST__` Gating

### Decision: Use `VITE_P2P_TEST_API` environment variable

**Why not `MODE === 'test'` alone:** Playwright E2E tests run against a Vite dev server, not through Vitest. `import.meta.env.MODE` is `'development'` during `vite dev`. We need a mechanism that works in **both** contexts:
- Vitest (MODE = 'test') → expose
- Vite dev server with env var → expose

**Design:**
```typescript
// src/shared/test-api.ts (NEW FILE)

import type { CollaborationFeature } from './types';
import type { Participant } from '../shell/participants/participants-controller';

export interface P2PTestAPI {
  getText(): string;
  getYStateVector(): Uint8Array;
  getParticipants(): Participant[];
  getRole(): 'host' | 'peer';
  getConnectionState(): string;
  getConnectionRoute(): Promise<{ kind: string; local?: string; remote?: string } | null>;
  getRoomId(): string;
  /** Trigger a simulated disorderly disconnect (close WS without cleanup). */
  simulateAbruptClose(): void;
}

export function maybeExposeTestAPI(deps: {
  feature: CollaborationFeature & { text?: { toString(): string }; doc?: any };
  session: {              // subset of SessionController, for type safety
    parseRoomFromUrl(): string | null;
    isHost?: boolean;     // derived from onRoleChanged
    connectionState: string;
    roomId: string;
    roomRef?: { close(): void } | null;
    close(): void;
    getParticipants?: () => Participant[];
  };
}): void {
  // Gate: expose only when explicitly enabled
  const enabled =
    typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.VITE_P2P_TEST_API === 'true';

  if (!enabled) return;

  (window as any).__P2P_TEST__ = {
    getText: () => deps.feature.text?.toString() ?? '',
    getYStateVector: () => {
      // Deferred import of Yjs to avoid bundling in test gating file
      const doc = deps.feature.doc;
      if (!doc) return new Uint8Array();
      // Use Y.encodeStateVector via dynamic access
      return (doc.constructor as any).encodeStateVector?.(doc) ?? new Uint8Array();
    },
    getParticipants: () => deps.session.getParticipants?.() ?? [],
    getRole: () => deps.session.isHost ? 'host' : 'peer',
    getConnectionState: () => deps.session.connectionState,
    getConnectionRoute: async () => {
      try { return await deps.session.roomRef?.getConnectionRoute?.() ?? null; }
      catch { return null; }
    },
    getRoomId: () => deps.session.roomId,
    simulateAbruptClose: () => {
      deps.session.roomRef?.close();
      deps.session.close();
    },
  } satisfies P2PTestAPI;
}
```

**Integration in `app.ts`:**
```typescript
// At the end of createApplication(), after all wiring:
import { maybeExposeTestAPI } from './shared/test-api';
maybeExposeTestAPI({ feature, session });
```

**Usage in Playwright E2E tests:**
```bash
# Start vite with:
VITE_P2P_TEST_API=true VITE_ICE_MODE=all npx vite --port 8082
```

Then in test:
```typescript
const text = await page.evaluate(() => (window as any).__P2P_TEST__.getText());
const stateVector = await page.evaluate(() => {
  const sv = (window as any).__P2P_TEST__.getYStateVector();
  return Array.from(sv);  // serialize for transfer
});
```

**Security:** The gating ensures `__P2P_TEST__` is **never** exposed in production builds. Production `vite build` runs without `VITE_P2P_TEST_API`, and `import.meta.env.VITE_P2P_TEST_API` evaluates to `undefined` → gating fails → no exposure.

---

## 5. CI Workflow Design

### File: `.github/workflows/test.yml`

```yaml
name: Test Suite
on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: 20

jobs:
  # ── Job 1: Static analysis + build ──
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with: { path: app }
      - uses: actions/checkout@v4
        with:
          repository: joverval/p2p-collab
          path: lib
      - uses: actions/setup-node@v4
        with: { node-version: ${{ env.NODE_VERSION }}

      - name: Install & build library
        working-directory: lib
        run: npm ci && npx tsup --no-dts

      - name: Install app
        working-directory: app
        run: npm ci

      - name: TypeCheck
        working-directory: app
        run: npx tsc --noEmit

      - name: Build app
        working-directory: app
        run: npx vite build

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: app/dist/

  # ── Job 2: Unit + integration tests (Vitest) ──
  unit:
    needs: [check]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with: { path: app }
      - uses: actions/checkout@v4
        with: { repository: joverval/p2p-collab, path: lib }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ env.NODE_VERSION }}
      - name: Build lib
        working-directory: lib
        run: npm ci && npx tsup --no-dts
      - name: Install & test
        working-directory: app
        run: |
          npm ci
          npx vitest run --coverage --reporter=default --reporter=junit --outputFile.junit=test-results/unit.xml
      - name: Upload coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: app/coverage/
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: unit-results
          path: app/test-results/

  # ── Job 3: E2E — direct/STUN path ──
  e2e-direct:
    needs: [check]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with: { path: app }
      - uses: actions/checkout@v4
        with: { repository: joverval/p2p-collab, path: lib }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ env.NODE_VERSION }}
      - name: Build lib
        working-directory: lib
        run: npm ci && npx tsup --no-dts
      - name: Install app
        working-directory: app
        run: npm ci
      - name: Install Playwright
        working-directory: app
        run: npx playwright install chromium --with-deps
      - name: Run E2E (direct)
        working-directory: app
        env:
          VITE_ICE_MODE: stun-only
          VITE_P2P_TEST_API: 'true'
        run: |
          npx start-server-and-test \
            "node server/start-relay.js & VITE_P2P_TEST_API=true VITE_ICE_MODE=stun-only npx vite --port 8082" \
            "http://localhost:8082" \
            "npx playwright test --grep '@direct'"
      - name: Upload artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-direct-failure
          path: |
            app/test-results/
            app/playwright-report/

  # ── Job 4: E2E — TURN path ──
  e2e-turn:
    needs: [check]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      coturn:
        image: coturn/coturn:4.6
        ports:
          - 3478:3478
          - 3478:3478/udp
        env:
          TURN_USER: testuser
          TURN_PASS: testpass
          TURN_REALM: localhost
        options: >-
          --network=host
    steps:
      - uses: actions/checkout@v4
        with: { path: app }
      - uses: actions/checkout@v4
        with: { repository: joverval/p2p-collab, path: lib }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ env.NODE_VERSION }}
      # … similar to e2e-direct but with VITE_ICE_MODE=turn-only …
```

### Vitest Configuration (`vitest.config.ts`):

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // All tests (unit + integration), excluding E2E
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/vite-env.d.ts', 'src/main.ts'],
      thresholds: {
        // Decision 6: start at 70% for both categories
        'src/shell/protocol/': { statements: 70, branches: 70, functions: 70, lines: 70 },
        'src/shell/': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
      reporter: ['text', 'lcov', 'json-summary'],
    },
    env: {
      VITE_P2P_TEST_API: 'true',  // enable __P2P_TEST__ in unit tests
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      'simple-peer': path.resolve(__dirname, 'vendor/simple-peer.js'),
      '@joverval/p2p-collab': path.resolve(__dirname, '../p2p-collab/dist/index.js'),
    },
  },
});
```

### Playwright Configuration (`playwright.config.ts`):

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,           // E2E tests share relay state
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,                     // Single worker to avoid port conflicts
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/e2e.xml' }],
  ],
  use: {
    baseURL: 'http://localhost:8082',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'node server/start-relay.js',
      port: 8083,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `VITE_P2P_TEST_API=true VITE_ICE_MODE=${process.env.VITE_ICE_MODE || 'all'} npx vite --port 8082`,
      port: 8082,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

---

## 6. `data-testid` Placement

14 elements from the spec. Here's what goes where, with the current DOM context:

| # | Element | `data-testid` | Current Element | Where to Add |
|---|---|---|---|---|
| 1 | Email input | `email-input` | `<input id="email-input">` | `index.html` (attrs) |
| 2 | Create/Join button | `create-room-btn` | `<button id="create-room-btn">` | `index.html` |
| 3 | Invite button | `copy-invite-btn` | `<button id="copy-invite-btn">` | `index.html` |
| 4 | Approval toast | `approval-toast` | `<div id="toast">` | `index.html` |
| 5 | Approve button | `toast-approve` | `<button id="toast-approve">` | `index.html` |
| 6 | Reject button | `toast-reject` | `<button id="toast-reject">` | `index.html` |
| 7 | Editor | `editor` | `<div id="editor">` | `index.html` |
| 8 | Participant rows | `participant-row` | Dynamic `div.user-panel-item` | `participants-controller.ts` `render()` |
| 9 | Promote buttons | `promote-btn` | Dynamic `button.promote-btn` | `participants-controller.ts` `render()` |
| 10 | Connection route | `connection-route` | **NEW** — hidden span in topbar | `index.html` + `app.ts` update |
| 11 | Connection state | `connection-state` | **NEW** — hidden span in topbar | `index.html` + `app.ts` update |
| 12 | Filename | `filename` | `<span id="topbar-filename">` | `index.html` |
| 13 | Sync status | `sync-status` | **NEW** — hidden span | `index.html` + `markdown-feature.ts` update |
| 14 | Sync button | `sync-btn` | `<button id="sync-btn">` | `index.html` |

**Implementation approach:**

For elements that already have `id` attributes, add `data-testid` alongside (don't replace the `id` — `id` serves JS logic, `data-testid` serves tests):

```html
<!-- index.html — additions -->
<input id="email-input" data-testid="email-input" class="compact-input" placeholder="your@email.com">
<button id="create-room-btn" data-testid="create-room-btn">Create Room</button>
<button id="copy-invite-btn" data-testid="copy-invite-btn" class="handshake-btn" style="display:none;">📋 Copy invite</button>
<div id="toast" data-testid="approval-toast" style="display:none;">
<button id="toast-approve" data-testid="toast-approve">Approve</button>
<button id="toast-reject" data-testid="toast-reject" class="reject-btn">Reject</button>
<div id="editor" data-testid="editor"></div>
<span id="topbar-filename" data-testid="filename" contenteditable="true">Untitled.md</span>
<button id="sync-btn" data-testid="sync-btn" disabled style="display:none;">🔄 Sync from Host</button>

<!-- NEW: hidden diagnostic elements -->
<span id="connection-route" data-testid="connection-route" style="display:none;"></span>
<span id="connection-state" data-testid="connection-state" style="display:none;"></span>
<span id="sync-status" data-testid="sync-status" style="display:none;"></span>
```

**Dynamic elements** in `participants-controller.ts`:
```typescript
// Each participant row
const div = el('div', { class: 'user-panel-item', 'data-testid': 'participant-row' }, [/* … */]);

// Each promote button
div.appendChild(el('button', { class: 'promote-btn', 'data-testid': 'promote-btn' }, ['👑 Promote']));
```

**Updating hidden diagnostics** in `app.ts`:
```typescript
session.onConnected = (route) => {
  chat.addLog('system', `📡 Connected — ${route}`);
  setTextContent('connection-route', route);
  ensureEditorVisible();
};

// Helper
function setTextContent(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
```

---

## 7. Relay Factory API

### `createRelayServer(options)` — full API contract

```typescript
// Conceptual TypeScript interface (actual implementation is JS)

interface RelayServerOptions {
  port?: number;                          // default: process.env.PORT || 8083, 0 for ephemeral
  clock?: () => number;                   // default: () => Date.now()
  idGenerator?: () => string;             // default: crypto.randomBytes(18).toString('base64url')
  allowedOrigins?: string[];              // default: from APP_ORIGINS env
  tokenTTL?: number;                      // default: 5 * 60 * 1000
  gracePeriod?: number;                   // default: 10_000
  candidateTimeout?: number;              // default: 30_000
  heartbeatInterval?: number;             // default: 30_000
  pongTimeout?: number;                   // default: 60_000
  turnConfig?: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    pass: string;
  };
}

interface RelayServer {
  server: import('http').Server;           // HTTP server (not yet listening)
  wss: import('ws').WebSocketServer;       // WebSocket server on the HTTP server

  /** Start the server, returns the actual port (useful for port: 0). */
  start(port?: number): Promise<number>;

  /** Gracefully stop the relay: close all WS connections, close the HTTP server. */
  stop(): Promise<void>;

  /** Test diagnostic: snapshot internal room/token state. */
  getState(): {
    rooms: Map<string, RoomState>;
    tokenRoom: Map<string, { roomId: string; role: string }>;
  };
}
```

### Usage examples

**Vitest integration test:**
```typescript
import { createRelayServer } from '../../server/ws-relay.js';
import { afterEach, beforeEach, test, expect } from 'vitest';

let relay: Awaited<ReturnType<typeof createRelayServer>>;
let port: number;

beforeEach(async () => {
  relay = createRelayServer({ port: 0 });
  port = await relay.start();
});

afterEach(async () => {
  await relay.stop();
});

test('store-offer creates room', async () => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  // … send store-offer, assert response …
  const state = relay.getState();
  expect(state.rooms.size).toBe(1);
});
```

**Deterministic IDs for reproducible tests:**
```typescript
let idCounter = 0;
const relay = createRelayServer({
  port: 0,
  idGenerator: () => `test-${idCounter++}`,
});
```

**Fake clock for timer-based tests (auto-failover, expiry):**
```typescript
import { FakeTimers } from '@sinonjs/fake-timers';

const clock = FakeTimers.install();
const relay = createRelayServer({ port: 0, clock: () => clock.now });

test('auto-failover after grace period', async () => {
  // … connect host + peer, close host WS …
  clock.tick(11_000); // advance past GRACE_PERIOD
  // … assert peer receives promotion-request …
});
```

---

## 8. E2E Helper API

### File: `tests/e2e/helpers/e2e-helpers.ts`

```typescript
import { Page, BrowserContext, Browser } from '@playwright/test';

export interface E2EHelpers {
  /** Create a room as host. Returns page, context, and the share URL. */
  createHost(email: string, opts?: { initialContent?: string }): Promise<{
    page: Page;
    context: BrowserContext;
    shareUrl: string;
  }>;

  /** Join an existing room as a peer. Assumes inviteUrl navigates to the app. */
  joinPeer(inviteUrl: string, email: string): Promise<{
    page: Page;
    context: BrowserContext;
  }>;

  /** Host approves a pending peer by email. */
  approvePeer(hostPage: Page, email: string): Promise<void>;

  /** Edit document content by replacing the entire editor text. */
  editDocument(page: Page, text: string): Promise<void>;

  /** Wait until the editor contains `expected` text. */
  waitForText(page: Page, expected: string, options?: { timeout?: number }): Promise<void>;

  /** Assert all pages have converged to the same text. */
  expectAllTexts(pages: Page[], expected: string): Promise<void>;

  /** Get the connection route as reported by the app. */
  getRoute(page: Page): Promise<string>;

  /** Host promotes a peer to host. */
  promotePeer(hostPage: Page, targetEmail: string): Promise<void>;

  /** Simulate a disorderly browser close (no cleanup). */
  closeAbruptly(context: BrowserContext): Promise<void>;

  /** Clean up all contexts opened by this helper. */
  cleanup(): Promise<void>;
}

/**
 * Factory: creates E2E helpers bound to a browser and base URL.
 * Tracks created contexts for cleanup.
 */
export function createE2EHelpers(browser: Browser, baseUrl: string): E2EHelpers {
  const contexts: BrowserContext[] = [];

  return {
    async createHost(email, opts) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(baseUrl);

      await page.fill('[data-testid="email-input"]', email);
      await page.click('[data-testid="create-room-btn"]');

      // Wait for invitation UI to appear
      await page.waitForSelector('[data-testid="copy-invite-btn"]', { timeout: 10000 });

      // Get share URL from clipboard
      const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
      // Fallback: get it from the invite button's click handler
      // (which copies to clipboard) — or expose via __P2P_TEST__
      const fallbackUrl = await page.evaluate(() =>
        (window as any).__P2P_TEST__?.getRoomId?.()
          ? `${window.location.origin}/#${(window as any).__P2P_TEST__.getRoomId()}`
          : ''
      );

      const finalUrl = shareUrl || fallbackUrl;

      // Wait for editor to be visible
      await page.waitForSelector('[data-testid="editor"]', { timeout: 10000 });

      if (opts?.initialContent) {
        await page.click('[data-testid="editor"]');
        await page.keyboard.type(opts.initialContent);
      }

      return { page, context, shareUrl: finalUrl };
    },

    async joinPeer(inviteUrl, email) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(inviteUrl);

      await page.fill('[data-testid="email-input"]', email);
      await page.click('[data-testid="create-room-btn"]'); // becomes "Join Room"

      await page.waitForSelector('[data-testid="editor"]', { timeout: 15000 });
      return { page, context };
    },

    async approvePeer(hostPage, email) {
      // Wait for approval toast to appear
      await hostPage.waitForSelector('[data-testid="approval-toast"]', { timeout: 10000 });
      // Verify it's for the right email
      const toastText = await hostPage.textContent('[data-testid="approval-toast"]');
      if (!toastText?.includes(email)) {
        throw new Error(`Toast is for wrong email. Expected ${email}, got: ${toastText}`);
      }
      await hostPage.click('[data-testid="toast-approve"]');
      await hostPage.waitForSelector('[data-testid="approval-toast"]', {
        state: 'hidden',
        timeout: 5000,
      });
    },

    async editDocument(page, text) {
      await page.click('[data-testid="editor"]');
      // Select all and replace
      await page.keyboard.press('Control+a');
      await page.keyboard.type(text, { delay: 5 }); // small delay for realistic typing
    },

    async waitForText(page, expected, options) {
      await page.waitForFunction(
        ([testid, exp]) => {
          const el = document.querySelector(`[data-testid="${testid}"]`);
          return el?.textContent?.includes(exp as string) ?? false;
        },
        ['editor', expected],
        { timeout: options?.timeout ?? 10000 }
      );
    },

    async expectAllTexts(pages, expected) {
      const texts = await Promise.all(
        pages.map(p => p.evaluate(() =>
          (window as any).__P2P_TEST__?.getText() ?? ''
        ))
      );
      const allMatch = texts.every(t => t === expected);
      if (!allMatch) {
        throw new Error(
          `Texts do not converge. Expected: "${expected}". Got: ${JSON.stringify(texts)}`
        );
      }
    },

    async getRoute(page) {
      return page.evaluate(() =>
        document.querySelector('[data-testid="connection-route"]')?.textContent ?? ''
      );
    },

    async promotePeer(hostPage, targetEmail) {
      // Open participants panel
      await hostPage.click('[data-panel="users"]');
      // Find the row for targetEmail and click its promote button
      const row = hostPage.locator('[data-testid="participant-row"]', {
        hasText: targetEmail,
      });
      await row.locator('[data-testid="promote-btn"]').click();
      // Wait for promotion to complete (host role changes, reconnection)
      await hostPage.waitForFunction(
        () => (window as any).__P2P_TEST__?.getRole() === 'peer',
        null,
        { timeout: 20000 }
      );
    },

    async closeAbruptly(context) {
      // Close without any cleanup — simulates browser crash
      await context.close();
      contexts.splice(contexts.indexOf(context), 1);
    },

    async cleanup() {
      for (const ctx of contexts.splice(0)) {
        try { await ctx.close(); } catch { /* already closed */ }
      }
    },
  };
}
```

### Usage in a test:

```typescript
// tests/e2e/core/host-peer-sync.test.ts
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

test.describe('Host + one peer', () => {
  let h: ReturnType<typeof createE2EHelpers>;

  test.beforeEach(async ({ browser, baseURL }) => {
    h = createE2EHelpers(browser, baseURL!);
  });

  test.afterEach(async () => {
    await h.cleanup();
  });

  test('host + one peer, initial content and updates', async () => {
    // Step 1–3: Host creates room with initial content
    const host = await h.createHost('host@test.com', {
      initialContent: '# Hello World\n\nInitial content.',
    });

    // Step 4: Peer joins
    const peer = await h.joinPeer(host.shareUrl, 'peer@test.com');
    await h.approvePeer(host.page, 'peer@test.com');

    // Step 5: Peer automatically receives initial document
    await h.expectAllTexts(
      [host.page, peer.page],
      '# Hello World\n\nInitial content.'
    );

    // Step 6–7: Host edits → peer receives
    await h.editDocument(host.page, '# Hello World\n\nHost edited this line.');
    await h.waitForText(peer.page, 'Host edited this line.');

    // Step 8–9: Peer edits → host receives
    await h.editDocument(peer.page, '# Hello World\n\nPeer edited this line.');
    await h.waitForText(host.page, 'Peer edited this line.');

    // Step 10: State vectors converge
    await h.expectAllTexts(
      [host.page, peer.page],
      '# Hello World\n\nPeer edited this line.'
    );
  });
});
```

---

## 9. Recommendations on All 6 Pending Decisions

### Decision 1 — Test 10 fallback strategy
**Recommendation: Standard ICE `'all'` + Playwright route blocking.**

**Rationale:** The two-attempt lazy fallback adds complexity to the signaling protocol (extra offer/answer round-trip, state machine in SessionController). Standard ICE `'all'` is browser-native, handles fallback automatically, and is what production uses. For testing, Playwright's `page.route()` can block direct candidate STUN responses at the network level, forcing the browser to select the TURN relay candidate. This is simpler, more realistic, and doesn't require protocol changes.

**Implementation sketch:**
```typescript
test('fallback to TURN when direct blocked', async ({ page }) => {
  // Block UDP to STUN ports to force TURN
  await page.route('**/*', (route, request) => {
    // Only allow WebSocket (signaling) and TURN traffic
    if (request.url().startsWith('stun:')) route.abort();
    else route.continue();
  });
  // … rest of test …
});
```

### Decision 2 — Fake WebSocket approach
**Recommendation: Dependency Injection via `wsFactory`.**

**Rationale:** `vi.stubGlobal` is a global side effect that leaks between test files and is fragile with parallel execution. DI is standard practice, zero overhead in production (default parameter), and makes the dependency explicit in the type signature. Every major JS testing guide recommends DI over global mocking for critical infrastructure.

### Decision 3 — Sync queue refactoring
**Recommendation: Mandatory — convert to `SyncQueue` class.**

**Rationale:** The current module-level state is blocking 4 tests (B.9 disconnected-queue, B.10 destroy-cleanup) and would cause flaky tests when multiple `MarkdownFeature` instances are created in the same process. The refactor is localized (~40 lines changed), backward-compatible (the class encapsulates the same logic), and unlocks test isolation. No reason to defer.

### Decision 4 — coturn in CI
**Recommendation: Docker Compose (GitHub Actions service container).**

**Rationale:**
- The project already has `coturn.conf` — Docker Compose wraps it naturally.
- GitHub Actions natively supports `services:` with Docker images.
- `coturn/coturn:4.6` is an official image, maintained and widely used.
- Node.js TURN packages (`node-turn`, `turn-js`) are unmaintained (last updates 2017–2020) and don't implement the full RFC 5766 protocol (especially TCP TURN, which Chrome requires).
- Docker Compose also works on developer machines for local TURN testing.

Add `tests/infra/docker-compose.turn.yml`:
```yaml
services:
  coturn:
    image: coturn/coturn:4.6
    network_mode: host
    environment:
      - TURN_USER=testuser
      - TURN_PASS=testpass
      - TURN_REALM=localhost
    command: |
      --log-file=stdout
      --no-cli
      --lt-cred-mech
      --realm=localhost
      --user=testuser:testpass
      --no-tls
      --no-dtls
      --listening-port=3478
      --min-port=49152
      --max-port=49160
```

### Decision 5 — Test-only code gating
**Recommendation: `VITE_P2P_TEST_API` env var (not `MODE === 'test'` alone).**

**Rationale:** The spec says "MODE==='test'" but this only works for Vitest. Playwright E2E tests run against the Vite dev server where `MODE` is `'development'`. Using `import.meta.env.VITE_P2P_TEST_API === 'true'` works in both contexts:
- Vitest: set via `vitest.config.ts` → `env: { VITE_P2P_TEST_API: 'true' }`
- Playwright: set via CLI env when starting Vite

Gate: `if (import.meta.env.VITE_P2P_TEST_API !== 'true') return;`

This is a Vite-standard pattern — all `VITE_*` env vars are statically replaced at build time. In production builds where `VITE_P2P_TEST_API` is unset, the entire `maybeExposeTestAPI` block is tree-shaken.

### Decision 6 — Coverage gates
**Recommendation: 70% initially for both protocol and session. Raise to 85%/80% after stabilization.**

**Rationale:** The codebase currently has zero test coverage. Setting 85/80 from day one would block PRs with small, well-tested changes that happen to touch uncovered adjacent code. Start at 70% — this is high enough to ensure meaningful coverage of critical paths (protocol envelope, signaling client, sync queue, session state machine) but achievable. After 2–3 sprints of test growth, raise to 85% protocol / 80% session. The Vitest `thresholds` config supports per-directory targets.

**Deferred gates:**
```
Phase 1 (now):      70% protocol, 70% session
Phase 2 (stabilize): 85% protocol, 80% session  
Phase 3 (mature):    90% protocol, 85% session
```

---

## 10. Package.json Scripts

Per the spec:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:all": "npm run typecheck && npm run test:unit && npm run build && npm run test:e2e",
    "check": "npm run test:all",
    "relay": "node server/start-relay.js"
  }
}
```

New devDependencies:
```bash
npm install -D vitest @vitest/coverage-v8 jsdom @playwright/test start-server-and-test
```

---

## 11. Summary of Architectural Decisions

| Area | Decision | Key Rationale |
|---|---|---|
| **Sync queue** | `SyncQueue` class (mandatory) | Enables test isolation for B.9/B.10 |
| **WebSocket** | DI via `wsFactory` parameter | Clean, standard, no global stubs |
| **Relay** | `createRelayServer()` factory with `port:0` | Ephemeral ports, injectable clock/IDs |
| **ICE mode** | Hook in `SignalingClient.fetchIceConfig()` | Single choke point, env-var driven |
| **Test API gating** | `VITE_P2P_TEST_API` env var | Works in Vitest + Playwright |
| **data-testid** | Add to 14 elements, 3 new hidden diagnostics | Stable selectors, no CSS class coupling |
| **E2E helpers** | Factory returning `createHost`, `joinPeer`, etc. | Composable, cleanup-tracked, no sleeps |
| **CI** | 4 parallel jobs (check, unit, e2e-direct, e2e-turn) | Cancels superseded commits, uploads traces |
| **TURN in CI** | GitHub Actions service container (coturn Docker) | Production-grade, official image |
| **Coverage** | 70% initial, escalate later | Achievable, not a blocker |
| **Test 10 fallback** | Standard ICE `'all'` + Playwright blocking | No protocol changes, realistic |
