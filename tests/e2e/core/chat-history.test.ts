/**
 * E2E Test C: Chat history visibility — messages persist across panel open/close.
 *
 * Scenario:
 *   1. Host creates room
 *   2. Peer joins, host approves
 *   3. Both open chat panel
 *   4. Host sends message "Hello from host"
 *   5. Peer verifies message appears
 *   6. Peer sends message "Hello from peer"
 *   7. Host verifies message appears
 *   8. Both close chat panel, then reopen
 *   9. Both verify all 2 messages still present
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { SELECTOR_TIMEOUT } from '../helpers/test-constants';

test('chat history persists across panel open/close', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    getShareUrl,
    openChatPanel,
    sendChatMessage,
    getChatMessages,
    closeChatPanel,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room ──
  const host = await createHost('host@e2e.test');

  // ── 2. Peer joins, host approves ──
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');
  await approvePeer(host.page, 'peer@e2e.test');
  await waitForEditor(peer.page);

  // ── 3. Both open chat panel ──
  await openChatPanel(host.page);
  await openChatPanel(peer.page);

  // ── 4. Host sends message ──
  await sendChatMessage(host.page, 'Hello from host');

  // ── 5. Peer verifies message appears ──
  const peerMessages = await getChatMessages(peer.page);
  test.expect(peerMessages.some(m => m.includes('Hello from host'))).toBeTruthy();

  // ── 6. Peer sends message ──
  await sendChatMessage(peer.page, 'Hello from peer');

  // ── 7. Host verifies message appears ──
  const hostMessages = await getChatMessages(host.page);
  test.expect(hostMessages.some(m => m.includes('Hello from peer'))).toBeTruthy();

  // ── 8. Both close chat panel, then reopen ──
  await closeChatPanel(host.page);
  await closeChatPanel(peer.page);
  await openChatPanel(host.page);
  await openChatPanel(peer.page);

  // ── 9. Both verify all 2 messages still present ──
  const hostMessagesAfter = await getChatMessages(host.page);
  test.expect(hostMessagesAfter.length).toBeGreaterThanOrEqual(2);

  const peerMessagesAfter = await getChatMessages(peer.page);
  test.expect(peerMessagesAfter.length).toBeGreaterThanOrEqual(2);

  // ── Cleanup ──
  await cleanup();
});