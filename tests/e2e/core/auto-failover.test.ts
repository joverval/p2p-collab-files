/**
 * E2E Test 5: Auto failover when host disconnects abruptly.
 *
 * Scenario:
 *   1. A hosts; B and C join
 *   2. All three edit
 *   3. Abruptly close A's browser context (simulate disconnect)
 *   4. Wait for relay to elect a deterministic candidate → new host
 *   5. Assert only that candidate becomes host, remaining peer reconnects
 *   6. Assert document state preserved
 *   7. Continue editing, assert convergence
 *   8. Verify no split brain (only one host among remaining peers)
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONVERGENCE_TIMEOUT, FAILOVER_TIMEOUT } from '../helpers/test-constants';

const HOST_A_EMAIL = 'host-a@e2e.test';
const PEER_B_EMAIL = 'peer-b@e2e.test';
const PEER_C_EMAIL = 'peer-c@e2e.test';

const INITIAL_EDIT = '# Failover Test\n\nPre-disconnect content.';
const POST_FAILOVER_EDIT = '# Failover Test\n\nEdit after failover from new host.';

test('auto failover when host disconnects abruptly', async ({ browser }) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    closeAbruptly,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. A hosts; B and C join ──
  const hostA = await createHost(HOST_A_EMAIL, { initialContent: INITIAL_EDIT });

  const shareUrlB = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrlB, PEER_B_EMAIL);
  await approvePeer(hostA.page, PEER_B_EMAIL);
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

  // ── 4. Abruptly close A's browser context ──
  await closeAbruptly(hostA.context);

  // ── 5. Wait for failover — exactly one peer becomes host ──
  // The relay should elect a deterministic candidate.
  // Wait until at least one peer reports 'host' role.
  const [newHost, remainingPeer] = await Promise.race([
    // Race: whichever peer becomes host first
    (async () => {
      await peerB.page.waitForFunction(
        () => (window as any).__P2P_TEST__?.getRole() === 'host',
        undefined,
        { timeout: FAILOVER_TIMEOUT },
      );
      return [peerB, peerC] as const;
    })(),
    (async () => {
      await peerC.page.waitForFunction(
        () => (window as any).__P2P_TEST__?.getRole() === 'host',
        undefined,
        { timeout: FAILOVER_TIMEOUT },
      );
      return [peerC, peerB] as const;
    })(),
  ]);

  // ── 6. Assert only one host (no split brain) ──
  const newHostRole = await newHost.page.evaluate(() => (window as any).__P2P_TEST__?.getRole());
  const remainingRole = await remainingPeer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );

  expect(newHostRole).toBe('host');
  expect(remainingRole).toBe('peer');

  // ── 7. Assert document preserved after failover ──
  await waitForText(newHost.page, INITIAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(remainingPeer.page, INITIAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ── 8. Continue editing, assert convergence ──
  await editDocument(newHost.page, POST_FAILOVER_EDIT);
  await waitForText(remainingPeer.page, POST_FAILOVER_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  const PEER_FOLLOWUP = '# Failover Test\n\nPeer re-edit after failover.';
  await editDocument(remainingPeer.page, PEER_FOLLOWUP);
  await waitForText(newHost.page, PEER_FOLLOWUP, { timeout: CONVERGENCE_TIMEOUT });

  // ── 9. Final convergence check ──
  const finalTextNewHost = await newHost.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  const finalTextRemaining = await remainingPeer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(finalTextNewHost).toBe(finalTextRemaining);
  expect(finalTextNewHost).toBe(PEER_FOLLOWUP);

  // ── Cleanup ──
  await cleanup();
});
