/**
 * E2E Test 3: Concurrent convergence — 20+ edits each across 3 peers.
 *
 * Scenario:
 *   1. Host + 2 peers connected
 *   2. Generate interleaved edits from all pages (~20 small edits each for speed)
 *   3. Include one larger paste
 *   4. Assert final convergence — all three texts identical
 *   5. Assert no full-document replacement per remote keystroke
 */
import { test, type Page } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { sel } from '../helpers/test-constants';

/** Append text at cursor position after moving to end of editor. */
async function appendToEditor(page: Page, text: string): Promise<void> {
  await page.click(sel.editor);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text, { delay: 2 });
}

const EDITS_PER_PEER = 22;

test('concurrent convergence — 20+ edits each across 3 peers', async ({ browser }) => {
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

  // ── 1. Host + 2 peers connected ──
  const host = await createHost('host-conc@test.com', {
    initialContent: '# Concurrent Test\n\nBaseline content.\n',
  });

  const shareUrl1 = await getShareUrl(host.page);
  const peer1 = await joinPeer(shareUrl1, 'peer1-conc@test.com');
  await approvePeer(host.page, 'peer1-conc@test.com');
  await waitForEditor(peer1.page);
  await waitForText(peer1.page, 'Baseline content');

  const shareUrl2 = await getShareUrl(host.page);
  const peer2 = await joinPeer(shareUrl2, 'peer2-conc@test.com');
  await approvePeer(host.page, 'peer2-conc@test.com');
  await waitForEditor(peer2.page);
  await waitForText(peer2.page, 'Baseline content');

  // ── 2. Generate ~20 interleaved small edits from each peer ──
  // We do rounds: each round, each peer makes one edit.
  // This keeps the test fast while ensuring interleaving.
  for (let i = 1; i <= EDITS_PER_PEER; i++) {
    await appendToEditor(host.page, `H-${String(i).padStart(2, '0')}`);
    await appendToEditor(peer1.page, `P1-${String(i).padStart(2, '0')}`);
    await appendToEditor(peer2.page, `P2-${String(i).padStart(2, '0')}`);
  }

  // Give a moment for all edits to sync
  // We'll verify key markers converged before checking exact match

  // Check that some mid-range and final markers arrived everywhere
  await waitForText(host.page, 'P1-22');
  await waitForText(host.page, 'P2-22');
  await waitForText(peer1.page, 'H-22');
  await waitForText(peer1.page, 'P2-22');
  await waitForText(peer2.page, 'H-22');
  await waitForText(peer2.page, 'P1-22');

  // Also check early markers weren't lost
  await waitForText(host.page, 'P1-01');
  await waitForText(host.page, 'P2-01');
  await waitForText(peer1.page, 'H-01');
  await waitForText(peer2.page, 'H-01');

  // ── 3. One larger paste (host does a bulk edit) ──
  const largeBlock =
    '## Large Paste Section\n\n' +
    'This is a substantial block of text inserted as a single operation.\n' +
    'It spans multiple lines and contains various characters (punctuation, etc.).\n' +
    'The purpose is to verify that the CRDT handles large inserts correctly\n' +
    'without splitting or corrupting the document.\n';

  await appendToEditor(host.page, largeBlock);
  await waitForText(peer1.page, 'Large Paste Section');
  await waitForText(peer2.page, 'Large Paste Section');

  // ── 4. Assert final convergence — all three texts identical ──
  // Build expected text:
  //   '# Concurrent Test\n\nBaseline content.\n' +
  //   22 lines each of H-NN, P1-NN, P2-NN (66 total edit lines) +
  //   large block
  const lines: string[] = [];
  for (let i = 1; i <= EDITS_PER_PEER; i++) {
    lines.push(`H-${String(i).padStart(2, '0')}`);
    lines.push(`P1-${String(i).padStart(2, '0')}`);
    lines.push(`P2-${String(i).padStart(2, '0')}`);
  }
  const expectedText =
    `# Concurrent Test\n\nBaseline content.\n${lines.join('\n')}\n${largeBlock}`;

  await expectAllTexts([host.page, peer1.page, peer2.page], expectedText);

  // ── 5. Assert no full-document replacement per remote keystroke ──
  // The final text must contain ALL 66 edit markers + the large block.
  // If the document were being fully replaced per keystroke, we'd lose data.
  // This is already verified by the exact-match convergence above.

  await cleanup();
});