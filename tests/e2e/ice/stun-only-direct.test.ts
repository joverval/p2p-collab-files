/**
 * E2E Test H.1: STUN-only, direct connection route label.
 *
 * Scenario:
 *   1. Host opens page, enters email, creates room
 *   2. Peer opens page in new context and joins via invite URL
 *   3. Host approves the peer
 *   4. Wait for peer's editor to become visible (connection established)
 *   5. Poll for route label; verify "Direct P2P" on both sides
 *
 * Note: ICE_MODE is set via VITE_ICE_MODE env var at build time, not test runtime.
 * This test assumes the app was built with VITE_ICE_MODE=stun-only.
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

test('STUN-only reports direct — route label is "Direct P2P"', async ({ browser }) => {
  const { createHost, joinPeer, approvePeer, waitForEditor, getRoute, getShareUrl, cleanup } =
    createE2EHelpers(browser);

  // 1. Host creates room
  const host = await createHost('host@e2e.test');

  // 2. Peer joins via invite URL
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');

  // 3. Host approves the peer
  await approvePeer(host.page, 'peer@e2e.test');

  // 4. Wait for peer's editor (connection established)
  await waitForEditor(peer.page);

  // 5. Poll until route label appears (set asynchronously after connection)
  //    Then verify it reports "Direct P2P" on both sides
  await test.expect
    .poll(() => getRoute(host.page), { timeout: 15_000, message: 'host route label never appeared' })
    .toBe('Direct P2P');

  await test.expect
    .poll(() => getRoute(peer.page), { timeout: 15_000, message: 'peer route label never appeared' })
    .toBe('Direct P2P');

  await cleanup();
});
