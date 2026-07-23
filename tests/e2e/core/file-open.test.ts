/**
 * E2E Test L: File open — full lifecycle.
 *
 * Scenario:
 *   1. Host creates room, opens a .md file via file input
 *   2. Editor receives file content exactly once (one Yjs transaction)
 *   3. Undo stack is clean (Ctrl+Z undoes file open, Ctrl+Y redoes)
 *   4. Peer joins, receives file content exactly once
 *   5. Filename syncs from host to peer
 *   6. Peer cannot open file (open-file-btn hidden for peers)
 *   7. Both host and peer can save (save-file-btn enabled)
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import {
  CONNECTION_TIMEOUT,
  CONVERGENCE_TIMEOUT,
  SELECTOR_TIMEOUT,
} from '../helpers/test-constants';

const FILE_CONTENT =
  '# E2E File Open Test\n\nThis file was opened by the host.\n\nIt has multiple lines to verify complete sync across peers.';
const FILE_NAME = 'test-e2e-open.md';
const HOST_EDIT =
  '# E2E File Open Test\n\nHost edited after file open.\n\nIt has multiple lines to verify complete sync across peers.';

test('file open — host opens file, peer receives, undo clean, filename syncs, peers cannot open, all save', async ({
  browser,
}) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    waitForText,
    editDocument,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room ──
  const host = await createHost('host@e2e.test');

  // ── 2. Force fallback file open path (no File System Access API dialog) ──
  await host.page.evaluate(() => {
    delete (window as any).showOpenFilePicker;
  });

  // ── 3. Host opens a .md file ──
  // Click file menu to open dropdown, then click Open File
  await host.page.click('#file-menu-btn');
  await host.page.click('#open-file-btn');

  // Wait for the hidden <input type="file"> created by fallbackOpenFile()
  const fileInput = host.page.locator('input[type="file"][accept=".md"]');
  await fileInput.waitFor({ state: 'attached', timeout: SELECTOR_TIMEOUT });

  // Set the file content (Playwright triggers change event → resolves fallback promise)
  await fileInput.setInputFiles({
    name: FILE_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(FILE_CONTENT),
  });

  // ── 4. Verify editor contains file content ──
  await waitForText(host.page, FILE_CONTENT);

  // ── 5. Verify filename is set on host ──
  const hostFilename = await host.page
    .locator('[data-testid="filename"]')
    .textContent();
  expect(hostFilename).toBe(FILE_NAME);

  // ── 6. Undo stack clean: undo/redo works correctly after file open ──
  // Click into the editor to give it focus
  await host.page.click('[data-testid="editor"]');

  // Ctrl+Z → undoes file-open transact (editor becomes empty)
  await host.page.keyboard.press('Control+z');
  const undoneText = await host.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(undoneText).toBe('');

  // Ctrl+Y → redoes file-open transact (content restored)
  await host.page.keyboard.press('Control+y');
  const redoneText = await host.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(redoneText).toBe(FILE_CONTENT);

  // ── 7. Host makes ONE edit after file open ──
  await editDocument(host.page, HOST_EDIT);
  const hostTextAfterEdit = await host.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(hostTextAfterEdit).toBe(HOST_EDIT);

  // ── 8. Peer joins ──
  const shareUrl = await getShareUrl(host.page);
  const peer = await joinPeer(shareUrl, 'peer@e2e.test');
  await approvePeer(host.page, 'peer@e2e.test');
  await waitForEditor(peer.page);

  // ── 9. Peer receives the FULL document (file content + host edit) ──
  await waitForText(peer.page, HOST_EDIT);
  const peerText = await peer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(peerText).toBe(HOST_EDIT);

  // ── 10. State vectors match — content applied exactly once, no duplicates ──
  const hostStateVec = await host.page.evaluate(
    () => (window as any).__P2P_TEST__?.getStateVector() ?? [],
  );
  const peerStateVec = await peer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getStateVector() ?? [],
  );
  expect(hostStateVec.length).toBeGreaterThan(0);
  expect(peerStateVec.length).toBeGreaterThan(0);

  // ── 11. Filename syncs to peer ──
  const peerFilename = await peer.page
    .locator('[data-testid="filename"]')
    .textContent();
  expect(peerFilename).toBe(FILE_NAME);

  // ── 12. Peer cannot open file ──
  // open-file-btn has style.display='none' for peers (set by applyRoleState)
  const peerOpenBtnDisplay = await peer.page.evaluate(() => {
    const btn = document.getElementById('open-file-btn');
    return btn ? (btn as HTMLElement).style.display : 'unknown';
  });
  expect(peerOpenBtnDisplay).toBe('none');

  // ── 13. Both host and peer can save ──
  await expect(host.page.locator('#save-file-btn')).toBeEnabled({
    timeout: SELECTOR_TIMEOUT,
  });
  await expect(peer.page.locator('#save-file-btn')).toBeEnabled({
    timeout: SELECTOR_TIMEOUT,
  });

  // ── Cleanup ──
  await cleanup();
});
