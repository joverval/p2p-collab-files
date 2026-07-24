/**
 * E2E Test I: Active room lifetime >10 minutes.
 *
 * Scenario:
 *   1. Host creates room, peer joins and is approved
 *   2. Both see each other via chat (host sends, peer receives)
 *   3. Send a heartbeat chat message every ~30 seconds for 10 minutes
 *   4. After 10+ minutes, room still active — chat messages arrive
 *
 * Timeout: 720s (12 min) to accommodate the 10-min idle window + startup/cleanup.
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';

test('room survives 10+ minutes — chat heartbeat every 30s still delivers', async ({ browser }) => {
  test.setTimeout(720_000); // 12 minutes

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

  // 1. Host creates room, peer joins and is approved
  const host = await createHost('host@e2e.test');
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');
  await approvePeer(host.page, 'peer@e2e.test');
  await waitForEditor(peer.page);

  // 2. Initial chat verification — both sides functional
  await openChatPanel(host.page);
  await sendChatMessage(host.page, 'lifetime-test: start');
  await openChatPanel(peer.page);
  let peerMessages = await getChatMessages(peer.page);
  expect(peerMessages.some((m) => m.includes('lifetime-test: start'))).toBeTruthy();

  // 3. Heartbeat loop: send a chat message every ~30s for 10 minutes (20 rounds)
  const rounds = 20;
  const intervalMs = 30_000;

  for (let i = 1; i <= rounds; i++) {
    const msg = `lifetime-heartbeat:${i}`;
    await sendChatMessage(host.page, msg);

    // Verify peer received it (poll until found or timeout)
    await expect
      .poll(async () => {
        const msgs = await getChatMessages(peer.page);
        return msgs.some((m) => m.includes(msg));
      }, { timeout: 10_000, message: `Peer didn't receive heartbeat ${i}/${rounds}: "${msg}"` })
      .toBe(true);

    // Wait 30s before next heartbeat (skip sleep on last round)
    if (i < rounds) {
      await host.page.waitForTimeout(intervalMs);
    }
  }

  // 4. Final verification after 10+ minutes — room still alive
  await sendChatMessage(host.page, 'lifetime-test: end');
  peerMessages = await getChatMessages(peer.page);
  expect(peerMessages.some((m) => m.includes('lifetime-test: end'))).toBeTruthy();

  // 5. Peer can also send back
  await sendChatMessage(peer.page, 'lifetime-test: peer-ack');
  const hostMessages = await getChatMessages(host.page);
  expect(hostMessages.some((m) => m.includes('lifetime-test: peer-ack'))).toBeTruthy();

  await cleanup();
});
