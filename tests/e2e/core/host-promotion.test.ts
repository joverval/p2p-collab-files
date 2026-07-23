/**
 * E2E Test 4: Manual host promotion (single and chained).
 *
 * Scenario:
 *   1. A hosts; B and C join
 *   2. All three edit the document
 *   3. A promotes B → assert only B becomes host, A and C reconnect to B
 *   4. Assert document preserved across promotion
 *   5. Edit from all three after promotion, assert convergence
 *   6. Promote B → C (second/chained promotion) → repeat assertions
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONVERGENCE_TIMEOUT, PROMOTION_TIMEOUT } from '../helpers/test-constants';

const HOST_A_EMAIL = 'host-a@e2e.test';
const HOST_B_EMAIL = 'host-b@e2e.test';
const PEER_C_EMAIL = 'peer-c@e2e.test';

const INITIAL_EDIT = '# Promotion Test\n\nInitial edit from host A.';
const HOST_B_EDIT = '# Promotion Test\n\nEdit from new host B.';
const PEER_C_EDIT = '# Promotion Test\n\nEdit from peer C after promotion.';
const FINAL_EDIT = '# Promotion Test\n\nFinal edit — chained promotion works.';

test('manual host promotion (single and chained)', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    expectAllTexts,
    promotePeer,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. A hosts; B and C join ──
  const hostA = await createHost(HOST_A_EMAIL, { initialContent: INITIAL_EDIT });

  const shareUrlB = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrlB, HOST_B_EMAIL);
  await approvePeer(hostA.page, HOST_B_EMAIL);
  await waitForEditor(peerB.page);

  const shareUrlC = await getShareUrl(hostA.page);
  const peerC = await joinPeer(shareUrlC, PEER_C_EMAIL);
  await approvePeer(hostA.page, PEER_C_EMAIL);
  await waitForEditor(peerC.page);

  // ── 2. All three edit ──
  await editDocument(hostA.page, INITIAL_EDIT);
  await waitForText(peerB.page, INITIAL_EDIT);
  await waitForText(peerC.page, INITIAL_EDIT);

  // ── 3. Assert initial roles ──
  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');
  expect(await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // ── 4. A promotes B ──
  await promotePeer(hostA.page, HOST_B_EMAIL);

  // ── 5. Assert only B becomes host, A and C are peers ──
  // After promotion, A (former host) must be 'peer'
  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // B is now the host
  await peerB.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'host',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');

  // C remains a peer
  expect(await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // ── 6. Assert document preserved across promotion ──
  await expectAllTexts(
    [hostA.page, peerB.page, peerC.page],
    INITIAL_EDIT,
  );

  // ── 7. Edit from all three after promotion, assert convergence ──
  await editDocument(hostA.page, HOST_B_EDIT);
  await waitForText(peerB.page, HOST_B_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerC.page, HOST_B_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  await editDocument(peerB.page, PEER_C_EDIT);
  await waitForText(hostA.page, PEER_C_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerC.page, PEER_C_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  await editDocument(peerC.page, FINAL_EDIT);
  await waitForText(hostA.page, FINAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerB.page, FINAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ── 8. Promote B → C (chained second promotion) ──
  await promotePeer(peerB.page, PEER_C_EMAIL);

  // ── 9. Assert roles after chained promotion ──
  // B (former host) must be 'peer'
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // C is now the host
  await peerC.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'host',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );
  expect(await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');

  // A remains a peer
  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // ── 10. Assert document preserved across second promotion ──
  await expectAllTexts(
    [hostA.page, peerB.page, peerC.page],
    FINAL_EDIT,
  );

  // ── 11. Edit after second promotion, assert convergence ──
  const POST_CHAIN_EDIT = '# Promotion Test\n\nPost-chain-edit from all peers.';
  await editDocument(peerC.page, POST_CHAIN_EDIT);
  await waitForText(hostA.page, POST_CHAIN_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerB.page, POST_CHAIN_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  await editDocument(hostA.page, '# Done\n\nAll promotions successful.');
  await waitForText(peerB.page, '# Done\n\nAll promotions successful.', { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerC.page, '# Done\n\nAll promotions successful.', { timeout: CONVERGENCE_TIMEOUT });

  // ── Cleanup ──
  await cleanup();
});
