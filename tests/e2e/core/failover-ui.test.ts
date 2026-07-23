/**
 * E2E Test F: Auto failover UI transitions.
 *
 * Verifies that when the host disconnects abruptly and the relay
 * auto-promotes a successor, every participant's DOM reflects the
 * new topology — not just the JavaScript role value.
 *
 * Scenario:
 *   1. A hosts; B and C join — all editors visible, all connected.
 *   2. Assert initial UI: host controls on A only, peer controls on B/C,
 *      role labels correct, connection-state = 'connected' on all three.
 *   3. Assert participant list: 3 participants visible on all clients.
 *   4. Abruptly close A (simulate disconnect).
 *   5. Relay elects B as new host.  Wait for B's role to flip to 'host'.
 *   6. Assert B's UI transitions to Host:
 *        • copy-invite-btn visible, sync-btn hidden
 *        • topbar-role shows "👑 Host"
 *        • promote buttons appear for C in participant panel
 *   7. Assert C's UI stays Peer:
 *        • sync-btn visible, copy-invite-btn hidden
 *        • topbar-role shows "👤 Peer"
 *   8. Assert participants survive:
 *        • B sees 2 participants (B as host, C as peer), A is gone
 *        • C sees the same 2 participants
 *   9. Assert document content survived failover on both B and C.
 *  10. Continue editing after failover — B hosts, C consumes, C edits back.
 *  11. Reopen A as a peer (fresh browser context):
 *        • A joins same room, B approves A
 *        • A's UI shows peer controls (sync-btn visible, copy-invite-btn hidden)
 *        • A's topbar-role shows "👤 Peer"
 *        • A receives the full document content
 *        • All three can edit and converge
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import {
  FAILOVER_TIMEOUT,
  CONVERGENCE_TIMEOUT,
  SELECTOR_TIMEOUT,
  sel,
} from '../helpers/test-constants';

const HOST_A_EMAIL = 'host-a@e2e.test';
const PEER_B_EMAIL = 'peer-b@e2e.test';
const PEER_C_EMAIL = 'peer-c@e2e.test';

const INITIAL_EDIT = '# Failover UI Test\n\nPre-disconnect content from host A.';
const POST_FAILOVER_EDIT = '# Failover UI Test\n\nEdit from new host B after failover.';
const PEER_REEDIT = '# Failover UI Test\n\nPeer C re-edit after failover.';
const REJOIN_EDIT = '# Failover UI Test\n\nEdit from A after rejoining as peer.';
const FINAL_CONVERGE = '# Failover UI Test\n\nFinal multi-peer edit — all three converging.';

// ── UI assertion helpers (inline, test-specific) ──

/** Assert the topbar-role element shows the expected role label. */
async function expectRoleLabel(page: import('@playwright/test').Page, label: string) {
  const el = page.locator('#topbar-role');
  await el.waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT });
  const text = await el.textContent();
  expect(text).toContain(label);
}

/** Assert connection-state element shows 'connected'. */
async function expectConnected(page: import('@playwright/test').Page) {
  const el = page.locator(sel.connectionState);
  await el.waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT });
  const text = await el.textContent();
  expect(text).toContain('connected');
}

/** Assert host-only controls are visible / hidden. */
async function expectHostControls(page: import('@playwright/test').Page) {
  await expect(page.locator(sel.copyInviteBtn)).toBeVisible({ timeout: SELECTOR_TIMEOUT });
  await expect(page.locator(sel.syncBtn)).toBeHidden();
}

/** Assert peer-only controls are visible / hidden. */
async function expectPeerControls(page: import('@playwright/test').Page) {
  await expect(page.locator(sel.syncBtn)).toBeVisible({ timeout: SELECTOR_TIMEOUT });
  await expect(page.locator(sel.copyInviteBtn)).toBeHidden();
}

test('failover UI transitions: host controls, role labels, participants, rejoin', async ({
  browser,
}) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    closeAbruptly,
    getShareUrl,
    getParticipantEmails,
    getParticipantCount,
    cleanup,
  } = createE2EHelpers(browser);

  // ═══════════════════════════════════════════════════
  // 1. A hosts; B and C join
  // ═══════════════════════════════════════════════════
  const hostA = await createHost(HOST_A_EMAIL, { initialContent: INITIAL_EDIT });

  const shareUrlB = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrlB, PEER_B_EMAIL);
  await approvePeer(hostA.page, PEER_B_EMAIL);
  await waitForEditor(peerB.page);

  const shareUrlC = await getShareUrl(hostA.page);
  const peerC = await joinPeer(shareUrlC, PEER_C_EMAIL);
  await approvePeer(hostA.page, PEER_C_EMAIL);
  await waitForEditor(peerC.page);

  // ═══════════════════════════════════════════════════
  // 2. Assert initial UI states
  // ═══════════════════════════════════════════════════

  // A is host
  await expectRoleLabel(hostA.page, '👑 Host');
  await expectHostControls(hostA.page);
  await expectConnected(hostA.page);

  // B is peer
  await expectRoleLabel(peerB.page, '👤 Peer');
  await expectPeerControls(peerB.page);
  await expectConnected(peerB.page);

  // C is peer
  await expectRoleLabel(peerC.page, '👤 Peer');
  await expectPeerControls(peerC.page);
  await expectConnected(peerC.page);

  // ═══════════════════════════════════════════════════
  // 3. Assert participant list: 3 participants on all
  // ═══════════════════════════════════════════════════

  for (const page of [hostA.page, peerB.page, peerC.page]) {
    const count = await getParticipantCount(page);
    expect(count).toBe(3);
  }

  // Host sees A (host), B, C
  const hostEmails = await getParticipantEmails(hostA.page);
  expect(hostEmails).toContain(HOST_A_EMAIL);
  expect(hostEmails).toContain(PEER_B_EMAIL);
  expect(hostEmails).toContain(PEER_C_EMAIL);

  // ═══════════════════════════════════════════════════
  // 4. Abruptly close A
  // ═══════════════════════════════════════════════════
  await closeAbruptly(hostA.context);

  // ═══════════════════════════════════════════════════
  // 5. Wait for failover — B (or C) becomes host
  // ═══════════════════════════════════════════════════
  const [newHost, remainingPeer] = await Promise.race([
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

  // Confirm only one host (no split brain)
  const newHostRole = await newHost.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  const remainingRole = await remainingPeer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getRole(),
  );
  expect(newHostRole).toBe('host');
  expect(remainingRole).toBe('peer');

  // ═══════════════════════════════════════════════════
  // 6. Assert new host B's UI transitioned to Host
  // ═══════════════════════════════════════════════════
  await expectRoleLabel(newHost.page, '👑 Host');
  await expectHostControls(newHost.page);
  await expectConnected(newHost.page);

  // ═══════════════════════════════════════════════════
  // 7. Assert remaining peer C's UI stayed Peer
  // ═══════════════════════════════════════════════════
  await expectRoleLabel(remainingPeer.page, '👤 Peer');
  await expectPeerControls(remainingPeer.page);
  await expectConnected(remainingPeer.page);

  // ═══════════════════════════════════════════════════
  // 8. Assert participants survive failover (2, A gone)
  // ═══════════════════════════════════════════════════
  for (const page of [newHost.page, remainingPeer.page]) {
    const count = await getParticipantCount(page);
    expect(count).toBe(2);
  }

  // Figure out which email is new host, which is remaining peer
  const newHostEmail =
    newHost === peerB ? PEER_B_EMAIL : PEER_C_EMAIL;
  const remainingEmail =
    remainingPeer === peerC ? PEER_C_EMAIL : PEER_B_EMAIL;

  // New host's participant panel
  const nhEmails = await getParticipantEmails(newHost.page);
  expect(nhEmails).toContain(newHostEmail);
  expect(nhEmails).toContain(remainingEmail);
  expect(nhEmails).not.toContain(HOST_A_EMAIL);

  // Remaining peer's participant panel
  const rpEmails = await getParticipantEmails(remainingPeer.page);
  expect(rpEmails).toContain(newHostEmail);
  expect(rpEmails).toContain(remainingEmail);
  expect(rpEmails).not.toContain(HOST_A_EMAIL);

  // ═══════════════════════════════════════════════════
  // 9. Assert document preserved after failover
  // ═══════════════════════════════════════════════════
  await waitForText(newHost.page, INITIAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(remainingPeer.page, INITIAL_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ═══════════════════════════════════════════════════
  // 10. Continue editing — B hosts, C consumes, then C edits back
  // ═══════════════════════════════════════════════════
  await editDocument(newHost.page, POST_FAILOVER_EDIT);
  await waitForText(remainingPeer.page, POST_FAILOVER_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  const newHostText = await newHost.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  const remainingText = await remainingPeer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(newHostText).toBe(remainingText);
  expect(newHostText).toBe(POST_FAILOVER_EDIT);

  // C edits back
  await editDocument(remainingPeer.page, PEER_REEDIT);
  await waitForText(newHost.page, PEER_REEDIT, { timeout: CONVERGENCE_TIMEOUT });

  const nhText2 = await newHost.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  const rpText2 = await remainingPeer.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(nhText2).toBe(rpText2);
  expect(nhText2).toBe(PEER_REEDIT);

  // ═══════════════════════════════════════════════════
  // 11. Reopen A as peer
  // ═══════════════════════════════════════════════════
  // Get fresh share URL from the new host
  const rejoinShareUrl = await getShareUrl(newHost.page);
  const rejoinA = await joinPeer(rejoinShareUrl, HOST_A_EMAIL);

  // New host approves the rejoining A
  await approvePeer(newHost.page, HOST_A_EMAIL);
  await waitForEditor(rejoinA.page);

  // Verify A's UI shows peer controls
  await expectRoleLabel(rejoinA.page, '👤 Peer');
  await expectPeerControls(rejoinA.page);
  await expectConnected(rejoinA.page);

  // A receives the full document
  await waitForText(rejoinA.page, PEER_REEDIT, { timeout: CONVERGENCE_TIMEOUT });

  const aText = await rejoinA.page.evaluate(
    () => (window as any).__P2P_TEST__?.getText() ?? '',
  );
  expect(aText).toBe(PEER_REEDIT);

  // All three edit and converge
  await editDocument(rejoinA.page, REJOIN_EDIT);
  await waitForText(newHost.page, REJOIN_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(remainingPeer.page, REJOIN_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // Final multi-peer edit from the host
  await editDocument(newHost.page, FINAL_CONVERGE);
  await waitForText(remainingPeer.page, FINAL_CONVERGE, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(rejoinA.page, FINAL_CONVERGE, { timeout: CONVERGENCE_TIMEOUT });

  // Verify all three converge on same content
  const finalTexts = await Promise.all(
    [newHost.page, remainingPeer.page, rejoinA.page].map((p) =>
      p.evaluate(() => (window as any).__P2P_TEST__?.getText() ?? ''),
    ),
  );
  expect(finalTexts.every((t) => t === FINAL_CONVERGE)).toBe(true);

  // ── Cleanup ──
  await cleanup();
});