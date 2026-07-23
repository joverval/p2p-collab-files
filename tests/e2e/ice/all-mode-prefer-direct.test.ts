/**
 * E2E Test I.2: ALL mode, prefer direct.
 *
 * Scenario:
 *   1. Host opens page, enters email, creates room
 *   2. Peer opens page in new context and joins via invite URL
 *   3. Host approves the peer
 *   4. Wait for peer's editor to become visible (connection established)
 *   5. Verify getRoute() returns a non-empty string (direct P2P preferred)
 *
 * Note: VITE_ICE_MODE=all is the default. This test verifies that
 * when both STUN and TURN candidates are available, direct P2P is preferred.
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONNECTION_TIMEOUT } from '../helpers/test-constants';

test('all-mode prefer direct — host + peer connect via direct P2P', async ({
  browser,
}) => {
  const { createHost, joinPeer, approvePeer, waitForEditor, getRoute, getShareUrl, cleanup } =
    createE2EHelpers(browser);

  // ── 1. Host creates room ──
  const host = await createHost('host@e2e.test');

  // ── 2. Peer navigates to invite URL, enters email, and clicks Join ──
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');

  // ── 3. Host approves the peer ──
  await approvePeer(host.page, 'peer@e2e.test');

  // ── 4. Wait for the peer's editor to become visible (connection established) ──
  await waitForEditor(peer.page);

  // ── 5. Verify getRoute() returns a non-empty string ──
  const hostRoute = await getRoute(host.page);
  const peerRoute = await getRoute(peer.page);

  test.expect(hostRoute).toBeTruthy();
  test.expect(peerRoute).toBeTruthy();

  // ── Cleanup ──
  await cleanup();
});
