/**
 * E2E Test D: Participant list consistency.
 *
 * Scenario:
 *   1. Host creates room → sees self as the only participant
 *   2. Host verifies participant count is 1
 *   3. Peer A joins via invite URL, host approves
 *   4. Host verifies: 2 participants, emails include both host and peer A
 *   5. Peer A verifies: 2 participants visible in their UI
 *   6. Peer B joins via a fresh share URL, host approves
 *   7. All three participants verify: 3 participants visible
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { TEST_EMAILS } from '../helpers/fixtures';

test('participant list stays consistent as peers join', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    getShareUrl,
    getParticipantEmails,
    getParticipantCount,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room ──
  const host = await createHost(TEST_EMAILS.host);

  // ── 2. Host verifies participant count is 1 ──
  let count = await getParticipantCount(host.page);
  test.expect(count).toBe(1);

  // ── 3. Peer A joins, host approves ──
  let shareUrl = await getShareUrl(host.page);
  const peerA = await joinPeer(shareUrl, TEST_EMAILS.peer);
  await approvePeer(host.page, TEST_EMAILS.peer);
  await waitForEditor(peerA.page);

  // ── 4. Host verifies: 2 participants, emails include both ──
  count = await getParticipantCount(host.page);
  test.expect(count).toBe(2);

  let hostEmails = await getParticipantEmails(host.page);
  test.expect(hostEmails).toContain(TEST_EMAILS.host);
  test.expect(hostEmails).toContain(TEST_EMAILS.peer);

  // ── 5. Peer A verifies: 2 participants ──
  count = await getParticipantCount(peerA.page);
  test.expect(count).toBe(2);

  // ── 6. Peer B joins via a fresh share URL, host approves ──
  shareUrl = await getShareUrl(host.page);
  const peerB = await joinPeer(shareUrl, TEST_EMAILS.peer2);
  await approvePeer(host.page, TEST_EMAILS.peer2);
  await waitForEditor(peerB.page);

  // ── 7. All participants verify: 3 participants ──
  for (const page of [host.page, peerA.page, peerB.page]) {
    count = await getParticipantCount(page);
    test.expect(count).toBe(3);
  }

  // ── Cleanup ──
  await cleanup();
});