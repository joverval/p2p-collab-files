/**
 * E2E Test J: Active room lifetime — room stays alive over time.
 *
 * Scenario:
 *   1. Host creates room, peer joins and is approved
 *   2. Verify both see each other via chat (host sends, peer receives)
 *   3. Wait a short period (3 seconds) — room should remain active
 *   4. Send another chat message → verify delivered (room still alive after wait)
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONNECTION_TIMEOUT } from '../helpers/test-constants';

test('active room lifetime — chat persists across idle period', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    getShareUrl,
    waitForEditor,
    openChatPanel,
    sendChatMessage,
    getChatMessages,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room, peer joins and is approved ──
  const host = await createHost('host@e2e.test');

  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');

  await approvePeer(host.page, 'peer@e2e.test');
  await waitForEditor(peer.page);

  // ── 2. Verify both see each other: host sends chat, peer receives ──
  await openChatPanel(host.page);
  await sendChatMessage(host.page, 'Hello from host — room is up!');

  await openChatPanel(peer.page);
  const peerMessages = await getChatMessages(peer.page);
  test.expect(peerMessages.some(m => m.includes('Hello from host'))).toBeTruthy();

  // ── 3. Wait a short period — room should remain active ──
  await host.page.waitForTimeout(3000);

  // ── 4. Send another chat message → verify delivered (room still alive after wait) ──
  await sendChatMessage(host.page, 'Second message after idle — still connected?');

  const peerMessagesAfterIdle = await getChatMessages(peer.page);
  test.expect(peerMessagesAfterIdle.some(m => m.includes('Second message after idle'))).toBeTruthy();

  // ── Cleanup ──
  await cleanup();
});