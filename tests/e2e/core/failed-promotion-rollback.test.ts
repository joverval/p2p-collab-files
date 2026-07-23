/**
 * E2E Test 6: Failed promotion rollback.
 *
 * Scenario:
 *   1. A hosts; B joins
 *   2. Inject failure during promotion (intercept relay HTTP request and return error)
 *   3. Trigger promotion → assert it fails (A remains host)
 *   4. Assert existing connections remain active
 *   5. Assert document editing continues
 *   6. Assert promotion controls are available again
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONVERGENCE_TIMEOUT, PROMOTION_TIMEOUT, RELAY_URL } from '../helpers/test-constants';

const HOST_A_EMAIL = 'host-a@e2e.test';
const PEER_B_EMAIL = 'peer-b@e2e.test';

const INITIAL_EDIT = '# Rollback Test\n\nPre-promotion content.';
const POST_FAIL_EDIT = '# Rollback Test\n\nEdit after failed promotion.';

test('failed promotion rollback — host remains, connections stay active', async ({ browser }) => {
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

  // ── 1. A hosts; B joins ──
  const hostA = await createHost(HOST_A_EMAIL, { initialContent: INITIAL_EDIT });

  const shareUrl = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrl, PEER_B_EMAIL);
  await approvePeer(hostA.page, PEER_B_EMAIL);
  await waitForEditor(peerB.page);

  // ── 2. Edit and verify sync ──
  await editDocument(hostA.page, INITIAL_EDIT);
  await waitForText(peerB.page, INITIAL_EDIT);

  // ── 3. Assert initial roles ──
  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // ── 4. Inject failure: intercept relay HTTP requests for promote-peer ──
  // Derive the HTTP origin from the WS relay URL (e.g., ws://localhost:8083 → http://localhost:8083)
  const relayHttpOrigin = RELAY_URL.replace(/^ws/, 'http');

  let promoteIntercepted = false;
  await hostA.page.route(
    (url) => url.origin === relayHttpOrigin && url.pathname.includes('promote'),
    async (route) => {
      promoteIntercepted = true;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'simulated promotion failure' }),
      });
    },
  );

  // ── 5. Open participants panel and attempt promotion ──
  await hostA.page.click('[data-panel="users"]');

  // Find the row for PEER_B_EMAIL and click its promote button
  const row = hostA.page.locator('[data-testid="participant-row"]', {
    hasText: PEER_B_EMAIL,
  });
  await row.locator('[data-testid="promote-btn"]').click();

  // ── 6. Assert that the interception fired ──
  // We need to wait a moment for the request to be made
  await hostA.page.waitForTimeout(2000);
  expect(promoteIntercepted).toBe(true);

  // ── 7. Assert A remains host (promotion failed and rolled back) ──
  // The role should NOT have changed to 'peer' — A should still be 'host'
  const roleAfterAttempt = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  expect(roleAfterAttempt).toBe('host');

  // B should still be a peer
  const peerRole = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  expect(peerRole).toBe('peer');

  // ── 8. Assert existing connections remain active ──
  // Both peers should still be able to see the document
  const hostText = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  const peerText = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(hostText).toBe(INITIAL_EDIT);
  expect(peerText).toBe(INITIAL_EDIT);

  // ── 9. Assert document editing continues after failed promotion ──
  await editDocument(hostA.page, POST_FAIL_EDIT);
  await waitForText(peerB.page, POST_FAIL_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  const PEER_EDIT = '# Rollback Test\n\nPeer edit after rollback.';
  await editDocument(peerB.page, PEER_EDIT);
  await waitForText(hostA.page, PEER_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ── 10. Assert promotion controls are available again ──
  // The participants panel should still be accessible and show the promote button
  await hostA.page.click('[data-panel="users"]');
  const promoteBtnVisible = await hostA.page
    .locator('[data-testid="participant-row"]', { hasText: PEER_B_EMAIL })
    .locator('[data-testid="promote-btn"]')
    .isVisible();
  expect(promoteBtnVisible).toBe(true);

  // ── Cleanup ──
  await cleanup();
});
