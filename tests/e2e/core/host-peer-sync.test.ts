/**
 * E2E Test 1: Host + peer initial content and bidirectional edit sync.
 *
 * Scenario:
 *   1. Host opens page, enters email, creates room
 *   2. Host types initial Markdown BEFORE the peer joins
 *   3. Peer opens page in new context and joins via invite URL
 *   4. Host approves the peer
 *   5. Wait for peer's editor to become visible (connection established)
 *   6. Assert peer receives the complete initial document
 *   7. Host edits the document → assert peer receives the edit
 *   8. Peer edits the document → assert host receives the edit
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { INITIAL_CONTENT, HOST_EDIT, PEER_EDIT } from '../helpers/fixtures';

test('host + peer initial content and bidirectional edit sync', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room & types initial content ──
  const host = await createHost('host@e2e.test', { initialContent: INITIAL_CONTENT });

  // ── 2. Peer navigates to invite URL, enters email, and clicks Join ──
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');

  // ── 3. Host approves the peer ──
  await approvePeer(host.page, 'peer@e2e.test');

  // ── 4. Wait for the peer's editor to become visible (connection established) ──
  await waitForEditor(peer.page);

  // ── 5. Assert peer receives complete initial document (not blank!) ──
  await waitForText(peer.page, INITIAL_CONTENT);

  // ── 6. Host edits document → peer receives the edit ──
  await editDocument(host.page, HOST_EDIT);
  await waitForText(peer.page, HOST_EDIT);

  // ── 7. Peer edits document → host receives the edit ──
  await editDocument(peer.page, PEER_EDIT);
  await waitForText(host.page, PEER_EDIT);

  // ── Cleanup ──
  await cleanup();
});