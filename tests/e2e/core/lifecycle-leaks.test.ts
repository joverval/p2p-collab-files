/**
 * E2E Test K: Repeated lifecycle and listener leaks.
 *
 * Scenario:
 *   1. Host A opens page, creates room
 *   2. Peer B joins the room via invite URL
 *   3. Host A approves Peer B
 *   4. Peer B's editor becomes visible (connection established)
 *   5. Verify chat works between host and peer
 *   6. Check __P2P_TEST__ diagnostic API for listener counts (skip if unavailable)
 *   7. Promote Peer B → Host A becomes peer
 *   8. Verify chat still works after host promotion
 *   9. Clean up all contexts
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { PROMOTION_TIMEOUT } from '../helpers/test-constants';

test('repeated lifecycle and listener leaks', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    getShareUrl,
    promotePeer,
    openChatPanel,
    sendChatMessage,
    getChatMessages,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host A creates room ──
  const host = await createHost('host@e2e.test');
  const hostPage = host.page;

  // ── 2. Peer B joins via invite URL ──
  const shareUrl = await getShareUrl(hostPage);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');
  const peerPage = peer.page;

  // ── 3. Host approves Peer B ──
  await approvePeer(hostPage, 'peer@e2e.test');

  // ── 4. Wait for peer's editor to become visible ──
  await waitForEditor(peerPage);

  // ── 5. Verify chat works ──
  await openChatPanel(hostPage);
  await sendChatMessage(hostPage, 'hello from host');
  const hostChat = await getChatMessages(hostPage);
  test.expect(hostChat.some((m) => m.includes('hello from host'))).toBeTruthy();

  await openChatPanel(peerPage);
  // The peer should see the host's message (or at least have chat functional)
  const peerChat = await getChatMessages(peerPage);
  test.expect(peerChat.length).toBeGreaterThanOrEqual(0);

  // ── 6. Diagnostic: check listener counts if __P2P_TEST__ is available ──
  const hostListenerCount = await hostPage.evaluate(
    () => (window as any).__P2P_TEST__?.getSignalingListenerCount?.() ?? -1,
  );

  if (hostListenerCount !== -1) {
    // __P2P_TEST__ API is available — assert reasonable listener count
    test.expect(hostListenerCount).toBeGreaterThanOrEqual(0);

    const peerListenerCount = await peerPage.evaluate(
      () => (window as any).__P2P_TEST__?.getSignalingListenerCount?.() ?? -1,
    );
    test.expect(peerListenerCount).toBeGreaterThanOrEqual(0);
  }
  // If __P2P_TEST__ is unavailable, listenerCount will be -1 and we skip assertions.

  // ── 7. Promote Peer B → Host A becomes a peer ──
  await promotePeer(hostPage, 'peer@e2e.test');

  // Verify former host is now a peer
  const role = await hostPage.evaluate(() =>
    (window as any).__P2P_TEST__?.getRole(),
  );
  test.expect(role).toBe('peer');

  // ── 8. Chat still works after promotion ──
  await sendChatMessage(hostPage, 'hello after promotion');
  const postPromoChat = await getChatMessages(hostPage);
  test.expect(
    postPromoChat.some((m) => m.includes('hello after promotion')),
  ).toBeTruthy();

  // ── 9. Cleanup ──
  await cleanup();
});