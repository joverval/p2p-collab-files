/**
 * Shared constants for E2E tests.
 *
 * All timeouts, URLs, and test credentials live here so tests
 * can import them without duplicating magic values.
 */

/** Base URL for the app under test (matches playwright.config.ts baseURL). */
export const BASE_URL = process.env.BASE_URL || 'http://localhost:8082';

/** Relay WebSocket URL (matches playwright.config.ts webServer port 8083). */
export const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8083';

/** TURN server credentials for E2E tests that use coturn. */
export const TURN_CONFIG = {
  host: process.env.TURN_HOST || 'localhost',
  port: Number(process.env.TURN_PORT) || 3478,
  user: process.env.TURN_USER || 'testuser',
  pass: process.env.TURN_PASS || 'testpass',
  realm: process.env.TURN_REALM || 'localhost',
};

// ── Timeouts (milliseconds) ──

/** How long to wait for a page to load and render the editor. */
export const PAGE_LOAD_TIMEOUT = 15000;

/** How long to wait for a selector to appear after an action. */
export const SELECTOR_TIMEOUT = 10000;

/** How long to wait for cross-peer text convergence. */
export const CONVERGENCE_TIMEOUT = 15000;

/** How long to wait for ICE/connection negotiation. */
export const CONNECTION_TIMEOUT = 20000;

/** How long to wait for host promotion to complete. */
export const PROMOTION_TIMEOUT = 20000;

/** How long to wait for auto-failover after host disconnect. */
export const FAILOVER_TIMEOUT = 25000;

/** Polling interval for waitForFunction / expect.poll. */
export const POLL_INTERVAL = 200;

// ── Test credentials ──

/** Default host email used across tests. */
export const HOST_EMAIL = 'host@test.com';

/** Default peer email used across tests. */
export const PEER_EMAIL = 'peer@test.com';

/** Secondary peer email for multi-peer tests. */
export const PEER2_EMAIL = 'peer2@test.com';

// ── ICE mode env values ──

export const ICE_MODE = {
  STUN_ONLY: 'stun-only',
  ALL: 'all',
  TURN_ONLY: 'turn-only',
} as const;

// ── data-testid selectors ──

/** CSS selector builders for data-testid attributes. */
export const sel = {
  emailInput: '[data-testid="email-input"]',
  createRoomBtn: '[data-testid="create-room-btn"]',
  copyInviteBtn: '[data-testid="copy-invite-btn"]',
  approvalToast: '[data-testid="approval-toast"]',
  toastApprove: '[data-testid="approve-btn"]',
  toastReject: '[data-testid="reject-btn"]',
  editor: '[data-testid="editor"]',
  participantRow: '[data-testid="participant-row"]',
  promoteBtn: '[data-testid="promote-btn"]',
  connectionRoute: '[data-testid="connection-route"]',
  connectionState: '[data-testid="connection-state"]',
  filename: '[data-testid="filename"]',
  syncStatus: '[data-testid="sync-status"]',
  syncBtn: '[data-testid="sync-btn"]',
} as const;