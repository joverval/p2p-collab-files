/**
 * E2E Test E: Manual promotion UI — host/peer control visibility.
 *
 * Scenario:
 *   1. A hosts room, B and C join
 *   2. All three edit and converge
 *   3. A promotes B — B shows Host UI, A shows Peer UI
 *   4. All participant lists reflect B as host
 *   5. Edit + converge across all three after promotion
 *   6. B promotes C — C shows Host UI, B shows Peer UI
 *   7. All participant lists reflect C as host
 *   8. Edit + converge after chained promotion
 *
 * Control visibility contracts (from applyRoleState):
 *   Host: open-file-btn visible, copy-invite-btn visible, sync-btn hidden,
 *         promote-btn visible in participants panel for non-host peers
 *   Peer: open-file-btn hidden, copy-invite-btn hidden, sync-btn visible,
 *         promote-btn NOT visible in participants panel
 *   Both: save-file-btn enabled, topbar-role reflects current role
 */
import { test, expect } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import {
  CONVERGENCE_TIMEOUT,
  PROMOTION_TIMEOUT,
  SELECTOR_TIMEOUT,
} from '../helpers/test-constants';

const A_EMAIL = 'host-a@e2e.test';
const B_EMAIL = 'host-b@e2e.test';
const C_EMAIL = 'peer-c@e2e.test';

const PRE_PROMOTION = '# Promotion UI Test\n\nContent before first promotion.';
const POST_PROMOTION_AB = '# Promotion UI Test\n\nEdit after A promoted B.';
const POST_PROMOTION_BC = '# Promotion UI Test\n\nEdit after B promoted C.';

// ── DOM control check helpers ──

type VisibilityCheck = {
  /** CSS selector for the element */
  selector: string;
  /** Is the element expected to be visible (not display:none)? */
  visible: boolean;
  /** Is the element expected to be enabled (not disabled)? Only for buttons/inputs. */
  enabled?: boolean;
};

async function assertControlVisibility(page: any, checks: VisibilityCheck[]) {
  for (const { selector, visible, enabled } of checks) {
    const el = page.locator(selector);

    if (visible) {
      await expect(el, `${selector} should be visible`).toBeVisible({ timeout: SELECTOR_TIMEOUT });
    } else {
      // Element either absent or hidden via display:none
      const count = await el.count();
      if (count > 0) {
        await expect(el, `${selector} should be hidden`).toBeHidden({ timeout: SELECTOR_TIMEOUT });
      }
      // If count === 0, that's also fine — element doesn't exist in DOM
    }

    if (enabled !== undefined) {
      const actuallyEnabled = !(await el.isDisabled());
      expect(actuallyEnabled, `${selector} enabled=${enabled}`).toBe(enabled);
    }
  }
}

/** Check that a page sees a specific participant as host in the participants panel. */
async function assertParticipantIsHost(
  page: any,
  hostEmail: string,
  peerEmails: string[],
) {
  // Open users panel
  await page.click('[data-panel="users"]');
  await page.waitForSelector('[data-testid="participant-row"]', { timeout: SELECTOR_TIMEOUT });

  // The host row has CSS class "host"
  const hostRow = page.locator('[data-testid="participant-row"].host');
  await expect(hostRow).toHaveCount(1, { timeout: SELECTOR_TIMEOUT });

  const hostRowText = await hostRow.textContent();
  expect(hostRowText).toContain(hostEmail);
  expect(hostRowText).toContain('Host');

  // Peer rows should NOT have the "host" class
  for (const peerEmail of peerEmails) {
    const peerRow = page.locator('[data-testid="participant-row"]', {
      hasText: peerEmail,
    });
    await expect(peerRow).toBeVisible({ timeout: SELECTOR_TIMEOUT });
    const hasHostClass = await peerRow.evaluate((el: Element) =>
      el.classList.contains('host'),
    );
    expect(hasHostClass, `${peerEmail} should not have .host class`).toBe(false);
  }
}

test('manual promotion UI — host/peer control visibility transfers correctly', async ({
  browser,
}) => {
  const {
    createHost,
    joinPeer,
    approvePeer,
    waitForEditor,
    editDocument,
    waitForText,
    promotePeer,
    getShareUrl,
    cleanup,
  } = createE2EHelpers(browser);

  // ═══════════════════════════════════════════════════
  // 1. A hosts room, B and C join
  // ═══════════════════════════════════════════════════
  const hostA = await createHost(A_EMAIL, { initialContent: PRE_PROMOTION });

  const shareUrlB = await getShareUrl(hostA.page);
  const peerB = await joinPeer(shareUrlB, B_EMAIL);
  await approvePeer(hostA.page, B_EMAIL);
  await waitForEditor(peerB.page);

  const shareUrlC = await getShareUrl(hostA.page);
  const peerC = await joinPeer(shareUrlC, C_EMAIL);
  await approvePeer(hostA.page, C_EMAIL);
  await waitForEditor(peerC.page);

  // ═══════════════════════════════════════════════════
  // 2. All three edit and converge
  // ═══════════════════════════════════════════════════
  await editDocument(hostA.page, PRE_PROMOTION);
  await waitForText(peerB.page, PRE_PROMOTION);
  await waitForText(peerC.page, PRE_PROMOTION);

  // ═══════════════════════════════════════════════════
  // 3. Assert initial roles
  // ═══════════════════════════════════════════════════
  expect(
    await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('host');
  expect(
    await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer');
  expect(
    await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer');

  // ═══════════════════════════════════════════════════
  // 3a. Assert initial control visibility — A has host UI, B and C have peer UI
  // ═══════════════════════════════════════════════════
  // A (host): host controls visible, peer controls hidden
  await assertControlVisibility(hostA.page, [
    { selector: '#open-file-btn', visible: true, enabled: true },
    { selector: '#copy-invite-btn', visible: true },
    { selector: '#manual-answer-btn', visible: true },
    { selector: '#sync-btn', visible: false },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await hostA.page.locator('#topbar-role').textContent(),
  ).toBe('👑 Host');

  // B (peer): host controls hidden, peer controls visible
  await assertControlVisibility(peerB.page, [
    { selector: '#open-file-btn', visible: false },
    { selector: '#copy-invite-btn', visible: false },
    { selector: '#manual-answer-btn', visible: false },
    { selector: '#sync-btn', visible: true },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await peerB.page.locator('#topbar-role').textContent(),
  ).toBe('👤 Peer');

  // ═══════════════════════════════════════════════════
  // 4. Assert initial participant list shows A as host
  // ═══════════════════════════════════════════════════
  await assertParticipantIsHost(hostA.page, A_EMAIL, [B_EMAIL, C_EMAIL]);
  await assertParticipantIsHost(peerB.page, A_EMAIL, [B_EMAIL, C_EMAIL]);
  await assertParticipantIsHost(peerC.page, A_EMAIL, [B_EMAIL, C_EMAIL]);

  // ═══════════════════════════════════════════════════
  // 5. A promotes B
  // ═══════════════════════════════════════════════════
  await promotePeer(hostA.page, B_EMAIL);

  // Wait for B to become host
  await peerB.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'host',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );

  // Verify roles after promotion
  expect(
    await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer'); // A was demoted
  expect(
    await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('host'); // B was promoted
  expect(
    await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer'); // C unchanged

  // ═══════════════════════════════════════════════════
  // 6. B shows Host UI (file, invite, approve, promote)
  // ═══════════════════════════════════════════════════
  await assertControlVisibility(peerB.page, [
    { selector: '#open-file-btn', visible: true, enabled: true },
    { selector: '#copy-invite-btn', visible: true },
    { selector: '#manual-answer-btn', visible: true },
    { selector: '#sync-btn', visible: false },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await peerB.page.locator('#topbar-role').textContent(),
  ).toBe('👑 Host');

  // B, as host, should see promote buttons for peer C in the participants panel
  await peerB.page.click('[data-panel="users"]');
  await peerB.page.waitForSelector('[data-testid="participant-row"]', {
    timeout: SELECTOR_TIMEOUT,
  });
  const promoteBtnOnB = peerB.page.locator('[data-testid="promote-btn"]');
  await expect(promoteBtnOnB).toHaveCount(1, { timeout: SELECTOR_TIMEOUT }); // only C is promotable

  // ═══════════════════════════════════════════════════
  // 7. A shows Peer UI (no open/promote/approve, can save)
  // ═══════════════════════════════════════════════════
  await assertControlVisibility(hostA.page, [
    { selector: '#open-file-btn', visible: false },
    { selector: '#copy-invite-btn', visible: false },
    { selector: '#manual-answer-btn', visible: false },
    { selector: '#sync-btn', visible: true },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await hostA.page.locator('#topbar-role').textContent(),
  ).toBe('👤 Peer');

  // A, as peer, should NOT see any promote button in participants panel
  await hostA.page.click('[data-panel="users"]');
  await hostA.page.waitForSelector('[data-testid="participant-row"]', {
    timeout: SELECTOR_TIMEOUT,
  });
  const promoteBtnOnA = hostA.page.locator('[data-testid="promote-btn"]');
  await expect(promoteBtnOnA).toHaveCount(0);

  // C (still peer) should not see promote buttons either
  await peerC.page.click('[data-panel="users"]');
  await peerC.page.waitForSelector('[data-testid="participant-row"]', {
    timeout: SELECTOR_TIMEOUT,
  });
  const promoteBtnOnC = peerC.page.locator('[data-testid="promote-btn"]');
  await expect(promoteBtnOnC).toHaveCount(0);

  // ═══════════════════════════════════════════════════
  // 8. All participant lists show B as host
  // ═══════════════════════════════════════════════════
  await assertParticipantIsHost(hostA.page, B_EMAIL, [A_EMAIL, C_EMAIL]);
  await assertParticipantIsHost(peerB.page, B_EMAIL, [A_EMAIL, C_EMAIL]);
  await assertParticipantIsHost(peerC.page, B_EMAIL, [A_EMAIL, C_EMAIL]);

  // ═══════════════════════════════════════════════════
  // 9. Edit + converge across all three after promotion
  // ═══════════════════════════════════════════════════
  await editDocument(hostA.page, POST_PROMOTION_AB);
  await waitForText(peerB.page, POST_PROMOTION_AB, {
    timeout: CONVERGENCE_TIMEOUT,
  });
  await waitForText(peerC.page, POST_PROMOTION_AB, {
    timeout: CONVERGENCE_TIMEOUT,
  });

  // B (new host) can also edit and have it converge to peers
  const B_EDIT = '# Promotion UI Test\n\nEdit from new host B.';
  await editDocument(peerB.page, B_EDIT);
  await waitForText(hostA.page, B_EDIT, { timeout: CONVERGENCE_TIMEOUT });
  await waitForText(peerC.page, B_EDIT, { timeout: CONVERGENCE_TIMEOUT });

  // ═══════════════════════════════════════════════════
  // 10. Repeat: B promotes C (chained promotion)
  // ═══════════════════════════════════════════════════
  await promotePeer(peerB.page, C_EMAIL);

  // Wait for C to become host
  await peerC.page.waitForFunction(
    () => (window as any).__P2P_TEST__?.getRole() === 'host',
    undefined,
    { timeout: PROMOTION_TIMEOUT },
  );

  // Verify roles after chained promotion
  expect(
    await hostA.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer'); // A still peer
  expect(
    await peerB.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('peer'); // B demoted
  expect(
    await peerC.page.evaluate(() => (window as any).__P2P_TEST__?.getRole()),
  ).toBe('host'); // C promoted

  // ═══════════════════════════════════════════════════
  // 11. C shows Host UI
  // ═══════════════════════════════════════════════════
  await assertControlVisibility(peerC.page, [
    { selector: '#open-file-btn', visible: true, enabled: true },
    { selector: '#copy-invite-btn', visible: true },
    { selector: '#manual-answer-btn', visible: true },
    { selector: '#sync-btn', visible: false },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await peerC.page.locator('#topbar-role').textContent(),
  ).toBe('👑 Host');

  // ═══════════════════════════════════════════════════
  // 12. B shows Peer UI (demoted)
  // ═══════════════════════════════════════════════════
  await assertControlVisibility(peerB.page, [
    { selector: '#open-file-btn', visible: false },
    { selector: '#copy-invite-btn', visible: false },
    { selector: '#manual-answer-btn', visible: false },
    { selector: '#sync-btn', visible: true },
    { selector: '#save-file-btn', visible: true, enabled: true },
  ]);
  expect(
    await peerB.page.locator('#topbar-role').textContent(),
  ).toBe('👤 Peer');

  // ═══════════════════════════════════════════════════
  // 13. All participant lists show C as host
  // ═══════════════════════════════════════════════════
  await assertParticipantIsHost(hostA.page, C_EMAIL, [A_EMAIL, B_EMAIL]);
  await assertParticipantIsHost(peerB.page, C_EMAIL, [A_EMAIL, B_EMAIL]);
  await assertParticipantIsHost(peerC.page, C_EMAIL, [A_EMAIL, B_EMAIL]);

  // ═══════════════════════════════════════════════════
  // 14. Edit + converge after chained promotion
  // ═══════════════════════════════════════════════════
  await editDocument(peerC.page, POST_PROMOTION_BC);
  await waitForText(hostA.page, POST_PROMOTION_BC, {
    timeout: CONVERGENCE_TIMEOUT,
  });
  await waitForText(peerB.page, POST_PROMOTION_BC, {
    timeout: CONVERGENCE_TIMEOUT,
  });

  // ── Cleanup ──
  await cleanup();
});
