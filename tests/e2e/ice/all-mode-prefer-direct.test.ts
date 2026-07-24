/**
 * E2E Test H.2: ALL mode, prefer direct.
 *
 * Scenario:
 *   1. Host opens page, enters email, creates room
 *   2. Peer opens page in new context and joins via invite URL
 *   3. Host approves the peer
 *   4. Wait for peer's editor to become visible (connection established)
 *   5. Poll for route label; verify "Direct P2P" (localhost: direct P2P preferred)
 *
 * Note: VITE_ICE_MODE=all is the default. On localhost with STUN available,
 * direct P2P should be selected over TURN relay.
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

test('all-mode selects direct — route label is "Direct P2P", not TURN', async ({ browser }) => {
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

  // 5. Poll until route label appears, verify direct P2P selected
  await test.expect
    .poll(() => getRoute(host.page), { timeout: 15_000, message: 'host route label never appeared' })
    .toBe('Direct P2P');

  await test.expect
    .poll(() => getRoute(peer.page), { timeout: 15_000, message: 'peer route label never appeared' })
    .toBe('Direct P2P');

  await cleanup();
});
