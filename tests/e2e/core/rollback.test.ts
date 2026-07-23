/**
 * E2E Test G: Failed promotion rollback (enhanced).
 *
 * Scenario:
 *   1. A hosts; B joins, both edit and sync
 *   2. Verify data channels are connected for both peers
 *   3. Inject failure before promotion commit (relay HTTP → 500)
 *   4. Attempt promotion → assert it fails (A remains host, B remains peer)
 *   5. Verify data channels remain usable after rollback
 *   6. Verify document editing continues both ways
 *   7. Remove failure injection, retry promotion → verify it succeeds
 *   8. Verify data channels work after successful promotion
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import {
  CONVERGENCE_TIMEOUT,
  PROMOTION_TIMEOUT,
  CONNECTION_TIMEOUT,
  SELECTOR_TIMEOUT,
  RELAY_URL,
} from '../helpers/test-constants';

const HOST_A_EMAIL = 'host-a@e2e.test';
const PEER_B_EMAIL = 'peer-b@e2e.test';

const INITIAL_EDIT = '# Rollback Test\n\nPre-promotion content.';
const POST_ROLLBACK_EDIT = '# Rollback Test\n\nHost edit after rollback.';
const PEER_POST_ROLLBACK = '# Rollback Test\n\nPeer edit after rollback.';
const POST_SUCCESS_EDIT = '# Rollback Test\n\nEdit after successful promotion.';

test('failed promotion rollback — data channels survive, promotion retryable', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    waitForConnectionState,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ═══════════════════════════════════════════════════════════════
  // 1. Setup — A hosts, B joins, both connected and synced
  // ═══════════════════════════════════════════════════════════════

  const hostA = await createHost(HOST_A_EMAIL, { initialContent: INITIAL_EDIT });
  const shareUrl = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrl, PEER_B_EMAIL);
  await approvePeer(hostA.page, PEER_B_EMAIL);
  await waitForEditor(peerB.page);

  // ── 1.1 Verify initial sync ──
  await editDocument(hostA.page, INITIAL_EDIT);
  await waitForText(peerB.page, INITIAL_EDIT);

  // ═══════════════════════════════════════════════════════════════
  // 2. Verify data channels are connected
  // ═══════════════════════════════════════════════════════════════

  await waitForConnectionState(hostA.page, 'connected', CONNECTION_TIMEOUT);
  await waitForConnectionState(peerB.page, 'connected', CONNECTION_TIMEOUT);

  const hostConnState = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getConnectionState() ?? 'unknown',
  );
  const peerConnState = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getConnectionState() ?? 'unknown',
  );
  expect(hostConnState).toBe('connected');
  expect(peerConnState).toBe('connected');

  // ═══════════════════════════════════════════════════════════════
  // 3. Verify initial roles
  // ═══════════════════════════════════════════════════════════════

  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // ═══════════════════════════════════════════════════════════════
  // 4. Inject failure before promotion commit
  // ═══════════════════════════════════════════════════════════════

  const relayHttpOrigin = RELAY_URL.replace(/^ws/, 'http');

  let promoteIntercepted = false;
  const interceptHandler = async (route: any) => {
    promoteIntercepted = true;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated promotion failure' }),
    });
  };

  await hostA.page.route(
    (url: URL) => url.origin === relayHttpOrigin && url.pathname.includes('promote'),
    interceptHandler,
  );

  // ═══════════════════════════════════════════════════════════════
  // 5. Attempt promotion
  // ═══════════════════════════════════════════════════════════════

  await hostA.page.click('[data-panel="users"]');

  const participantRow = hostA.page.locator('[data-testid="participant-row"]', {
    hasText: PEER_B_EMAIL,
  });
  await participantRow.locator('[data-testid="promote-btn"]').click();

  // Wait for the HTTP request to be intercepted
  await hostA.page.waitForTimeout(2000);
  expect(promoteIntercepted).toBe(true);

  // ═══════════════════════════════════════════════════════════════
  // 6. A remains host, B remains peer (rollback)
  // ═══════════════════════════════════════════════════════════════

  const roleA = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  const roleB = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  expect(roleA).toBe('host');
  expect(roleB).toBe('peer');

  // ═══════════════════════════════════════════════════════════════
  // 7. Data channels remain usable after rollback
  // ═══════════════════════════════════════════════════════════════

  // 7.1 Connection state is still connected
  const hostStateAfter = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getConnectionState() ?? 'unknown',
  );
  const peerStateAfter = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getConnectionState() ?? 'unknown',
  );
  expect(hostStateAfter).toBe('connected');
  expect(peerStateAfter).toBe('connected');

  // 7.2 Document text preserved on both sides
  const hostText = await hostA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  const peerText = await peerB.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(hostText).toBe(INITIAL_EDIT);
  expect(peerText).toBe(INITIAL_EDIT);

  // ═══════════════════════════════════════════════════════════════
  // 8. Editing continues both ways after rollback
  // ═══════════════════════════════════════════════════════════════

  // Host edits → peer receives
  await editDocument(hostA.page, POST_ROLLBACK_EDIT);
  await waitForText(peerB.page, POST_ROLLBACK_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // Peer edits → host receives
  await editDocument(peerB.page, PEER_POST_ROLLBACK);
  await waitForText(hostA.page, PEER_POST_ROLLBACK, { timeout: CONVERGENCE_TIMEOUT });

  // ═══════════════════════════════════════════════════════════════
  // 9. Promotion controls are available again (retryable)
  // ═══════════════════════════════════════════════════════════════

  await hostA.page.click('[data-panel="users"]');
  const promoteBtnAfter = hostA.page
    .locator('[data-testid="participant-row"]', { hasText: PEER_B_EMAIL })
    .locator('[data-testid="promote-btn"]');
  const promoteBtnVisible = await promoteBtnAfter.isVisible();
  expect(promoteBtnVisible).toBe(true);

  // ═══════════════════════════════════════════════════════════════
  // 10. Remove failure injection, retry promotion → verify success
  // ═══════════════════════════════════════════════════════════════

  await hostA.page.unroute(
    (url: URL) => url.origin === relayHttpOrigin && url.pathname.includes('promote'),
  );

  // Re-open participants panel and promote
  await hostA.page.click('[data-panel="users"]');
  await hostA.page
    .locator('[data-testid="participant-row"]', { hasText: PEER_B_EMAIL })
    .locator('[data-testid="promote-btn"]')
    .click();

  // ═══════════════════════════════════════════════════════════════
  // 11. Verify promotion succeeded — A becomes peer, B becomes host
  // ═══════════════════════════════════════════════════════════════

  // Former host A must now be 'peer'
  await hostA.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'peer',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );
  expect(await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('peer');

  // B must now be 'host'
  await peerB.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'host',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );
  expect(await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole())).toBe('host');

  // ═══════════════════════════════════════════════════════════════
  // 12. Data channels still work after successful promotion
  // ═══════════════════════════════════════════════════════════════

  await waitForConnectionState(hostA.page, 'connected', CONNECTION_TIMEOUT);
  await waitForConnectionState(peerB.page, 'connected', CONNECTION_TIMEOUT);

  // Edit from old host (now peer) → new host receives
  await editDocument(hostA.page, POST_SUCCESS_EDIT);
  await waitForText(peerB.page, POST_SUCCESS_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ═══════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════

  await cleanup();
});
