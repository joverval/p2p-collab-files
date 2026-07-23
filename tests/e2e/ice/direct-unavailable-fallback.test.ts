/**
 * E2E Test I.4: Direct unavailable, TURN fallback.
 *
 * Scenario:
 *   1. App is built with VITE_ICE_MODE=all
 *   2. Host creates room, peer joins, host approves
 *   3. If connection succeeds via relay (direct not available), fallback worked
 *   4. getRoute should return a valid route string
 *
 * Note: Without blocking STUN at the network level, this test can't force
 * a TURN fallback. It verifies connection succeeds even when mixed ICE
 * candidates are available (the 'all' mode coverage).
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONNECTION_TIMEOUT } from '../helpers/test-constants';

test('direct-unavailable-fallback — connection succeeds with all ICE modes', async ({
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

  // ── 4. Wait for peer's editor — connection should succeed with available ICE config ──
  await waitForEditor(peer.page);

  // ── 5. Verify route exists (connection established regardless of path) ──
  const hostRoute = await getRoute(host.page);
  test.expect(hostRoute).toBeTruthy();

  // ── Cleanup ──
  await cleanup();
});
