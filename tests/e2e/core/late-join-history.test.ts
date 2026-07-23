/**
 * E2E Test 2: Late-join history — Peer 2 receives full edit history.
 *
 * Scenario:
 *   1. Host creates room with initial text
 *   2. Peer 1 joins and is approved
 *   3. Peer 1 edits several sections (appending)
 *   4. Host edits after Peer 1
 *   5. Peer 2 joins later
 *   6. Assert Peer 2 immediately receives: original host text, Peer 1 edits, later host edits
 *   7. Peer 2 edits → host and Peer 1 receive it
 *   8. Each participant does another distinct edit
 *   9. Assert all three final texts match
 */
import { test, type Page } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { sel } from '../helpers/test-constants';

/** Append text at cursor position after moving to end of editor. */
async function appendToEditor(page: Page, text: string): Promise<void> {
  await page.click(sel.editor);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text, { delay: 3 });
}

test('late join history — peer 2 receives full edit history', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    waitForText,
    expectAllTexts,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room with initial text ──
  const host = await createHost('host-late@test.com', {
    initialContent: '# Late Join Test\n\nSection 1: Original host text.',
  });

  // ── 2. Peer 1 joins and is approved ──
  const shareUrl1 = await getShareUrl(host.page);
  const peer1 = await joinPeer(shareUrl1, 'peer1-late@test.com');
  await approvePeer(host.page, 'peer1-late@test.com');
  await waitForEditor(peer1.page);
  await waitForText(peer1.page, 'Original host text');

  // ── 3. Peer 1 appends edits ──
  await appendToEditor(peer1.page, 'Peer1-Section-A: first contribution.');
  await waitForText(host.page, 'Peer1-Section-A');
  await appendToEditor(peer1.page, 'Peer1-Section-B: additional notes.');
  await waitForText(host.page, 'Peer1-Section-B');

  // ── 4. Host appends edits ──
  await appendToEditor(host.page, 'Host-Edit: follow-up revision.');
  await waitForText(peer1.page, 'Host-Edit');

  // ── 5. Peer 2 joins LATER ──
  const shareUrl2 = await getShareUrl(host.page);
  const peer2 = await joinPeer(shareUrl2, 'peer2-late@test.com');
  await approvePeer(host.page, 'peer2-late@test.com');
  await waitForEditor(peer2.page);

  // ── 6. Assert Peer 2 immediately receives full history ──
  await waitForText(peer2.page, 'Original host text');
  await waitForText(peer2.page, 'Peer1-Section-A');
  await waitForText(peer2.page, 'Peer1-Section-B');
  await waitForText(peer2.page, 'Host-Edit');

  // ── 7. Peer 2 edits → host and Peer 1 receive it ──
  await appendToEditor(peer2.page, 'Peer2-Late: catching up.');
  await waitForText(host.page, 'Peer2-Late');
  await waitForText(peer1.page, 'Peer2-Late');

  // ── 8. Each participant does another distinct edit ──
  await appendToEditor(host.page, 'Final-Host: closing remark.');
  await waitForText(peer1.page, 'Final-Host');
  await waitForText(peer2.page, 'Final-Host');

  await appendToEditor(peer1.page, 'Final-Peer1: signature.');
  await waitForText(host.page, 'Final-Peer1');
  await waitForText(peer2.page, 'Final-Peer1');

  await appendToEditor(peer2.page, 'Final-Peer2: done.');
  await waitForText(host.page, 'Final-Peer2');
  await waitForText(peer1.page, 'Final-Peer2');

  // ── 9. Assert all three final texts match ──
  const expectedFinal =
    '# Late Join Test\n\nSection 1: Original host text.\n' +
    'Peer1-Section-A: first contribution.\n' +
    'Peer1-Section-B: additional notes.\n' +
    'Host-Edit: follow-up revision.\n' +
    'Peer2-Late: catching up.\n' +
    'Final-Host: closing remark.\n' +
    'Final-Peer1: signature.\n' +
    'Final-Peer2: done.';
  await expectAllTexts([host.page, peer1.page, peer2.page], expectedFinal);

  await cleanup();
});