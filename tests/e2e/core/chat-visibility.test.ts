/**
 * E2E Test C-ext: Chat visibility — history persistence, sender labels, XSS safety.
 *
 * Scenario:
 *   1. Host creates room, peer joins and is approved
 *   2. Both exchange messages with panel open
 *   3. Both close panel, receive more messages while closed
 *   4. Both reopen — full history visible immediately
 *   5. Sender labels appear exactly once per message
 *   6. Malicious markup renders as text, not DOM elements
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { SELECTOR_TIMEOUT } from '../helpers/test-constants';

test('chat visibility: history, sender labels, and XSS safety', async ({ browser }) => {
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

  // ═══════════════════════════════════════════════════
  // SETUP — host creates room, peer joins
  // ═══════════════════════════════════════════════════
  const host = await createHost('host@e2e.test');
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');
  await approvePeer(host.page, 'peer@e2e.test');
  await waitForEditor(peer.page);

  // ═══════════════════════════════════════════════════
  // 1.  EXCHANGE MESSAGES WITH PANEL OPEN
  // ═══════════════════════════════════════════════════
  await openChatPanel(host.page);
  await openChatPanel(peer.page);

  await sendChatMessage(host.page, 'Hello from host');
  await sendChatMessage(peer.page, 'Hello from peer');

  // Verify bidirectional exchange
  let peerMsgs = await getChatMessages(peer.page);
  expect(peerMsgs.some(m => m.includes('Hello from host'))).toBeTruthy();

  let hostMsgs = await getChatMessages(host.page);
  expect(hostMsgs.some(m => m.includes('Hello from peer'))).toBeTruthy();

  // ═══════════════════════════════════════════════════
  // 2.  CLOSE PANELS
  // ═══════════════════════════════════════════════════
  await closeChatPanel(host.page);
  await closeChatPanel(peer.page);

  // ═══════════════════════════════════════════════════
  // 3.  RECEIVE MESSAGES WHILE PANEL CLOSED
  // ═══════════════════════════════════════════════════
  // Host sends while peer's panel is closed
  await openChatPanel(host.page);
  await sendChatMessage(host.page, 'Msg-while-peer-closed');
  await closeChatPanel(host.page);

  // Peer sends while host's panel is closed
  await openChatPanel(peer.page);
  await sendChatMessage(peer.page, 'Msg-while-host-closed');
  await closeChatPanel(peer.page);

  // Allow time for P2P message propagation
  await host.page.waitForTimeout(1500);

  // ═══════════════════════════════════════════════════
  // 4.  REOPEN — FULL HISTORY VISIBLE IMMEDIATELY
  // ═══════════════════════════════════════════════════
  await openChatPanel(host.page);
  await openChatPanel(peer.page);

  // Both should see all 4 messages (2 original + 2 received while closed)
  hostMsgs = await getChatMessages(host.page);
  peerMsgs = await getChatMessages(peer.page);

  expect(hostMsgs.length).toBeGreaterThanOrEqual(4);
  expect(peerMsgs.length).toBeGreaterThanOrEqual(4);

  // Verify the messages received while panel was closed are visible
  expect(
    hostMsgs.some(m => m.includes('Msg-while-host-closed')),
  ).toBeTruthy();
  expect(
    peerMsgs.some(m => m.includes('Msg-while-peer-closed')),
  ).toBeTruthy();

  // Verify original messages are still present (history persisted)
  expect(hostMsgs.some(m => m.includes('Hello from host'))).toBeTruthy();
  expect(hostMsgs.some(m => m.includes('Hello from peer'))).toBeTruthy();

  // ═══════════════════════════════════════════════════
  // 5.  SENDER LABELS APPEAR ONCE PER MESSAGE
  // ═══════════════════════════════════════════════════
  // Each .log-entry div has exactly one sender-role class (host|peer|system)
  const hostLabelCounts: number[] = await host.page.evaluate(() => {
    const entries = document.querySelectorAll('#chat-log .log-entry');
    return Array.from(entries).map(el => {
      const senderClasses = ['host', 'peer', 'system'].filter(
        c => el.classList.contains(c),
      );
      return senderClasses.length;
    });
  });
  expect(hostLabelCounts.length).toBeGreaterThan(0);
  hostLabelCounts.forEach(count => expect(count).toBe(1));

  const peerLabelCounts: number[] = await peer.page.evaluate(() => {
    const entries = document.querySelectorAll('#chat-log .log-entry');
    return Array.from(entries).map(el => {
      const senderClasses = ['host', 'peer', 'system'].filter(
        c => el.classList.contains(c),
      );
      return senderClasses.length;
    });
  });
  expect(peerLabelCounts.length).toBeGreaterThan(0);
  peerLabelCounts.forEach(count => expect(count).toBe(1));

  // ═══════════════════════════════════════════════════
  // 6.  MALICIOUS MARKUP RENDERS AS TEXT
  // ═══════════════════════════════════════════════════
  const xssPayload = '<img src=x onerror=alert(1)>';
  await sendChatMessage(host.page, xssPayload);

  // Verify the literal payload appears as text on both sides
  const hostMsgsFinal = await getChatMessages(host.page);
  expect(
    hostMsgsFinal.some(m => m.includes(xssPayload)),
  ).toBeTruthy();

  // Wait for peer to receive the XSS payload
  await peer.page.waitForFunction(
    (payload) => {
      const entries = document.querySelectorAll('#chat-log .log-entry');
      return Array.from(entries).some(e =>
        e.textContent?.includes(payload as string),
      );
    },
    xssPayload,
    { timeout: SELECTOR_TIMEOUT },
  );

  const peerMsgsFinal = await getChatMessages(peer.page);
  expect(
    peerMsgsFinal.some(m => m.includes(xssPayload)),
  ).toBeTruthy();

  // Verify no <img> element was created in either chat log
  const hostHasImg = await host.page.evaluate(
    () => document.querySelector('#chat-log img') !== null,
  );
  expect(hostHasImg).toBe(false);

  const peerHasImg = await peer.page.evaluate(
    () => document.querySelector('#chat-log img') !== null,
  );
  expect(peerHasImg).toBe(false);

  // Verify innerHTML does NOT contain a raw <img tag (must be escaped)
  const hostInnerHasImg = await host.page.evaluate(() => {
    const log = document.querySelector('#chat-log');
    return log?.innerHTML.includes('<img ') ?? false;
  });
  expect(hostInnerHasImg).toBe(false);

  const peerInnerHasImg = await peer.page.evaluate(() => {
    const log = document.querySelector('#chat-log');
    return log?.innerHTML.includes('<img ') ?? false;
  });
  expect(peerInnerHasImg).toBe(false);

  // ═══════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════
  await cleanup();
});
