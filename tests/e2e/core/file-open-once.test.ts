/**
 * E2E Test: File open exactly once — no duplicate editor instances.
 *
 * Scenario:
 *   1. Host opens page, enters email, creates room
 *   2. Verify the editor is visible (waitForEditor)
 *   3. Check __P2P_TEST__ diagnostics availability via page.evaluate
 *   4. If available, verify state vector is non-null (document is initialized)
 *   5. Verify the editor [data-testid="editor"] is visible and contains DOM content
 *   6. Assert only ONE editor instance exists (not duplicated)
 */
import { test } from '@playwright/test';
import { createE2EHelpers } from '../helpers/e2e-helpers';
import { CONNECTION_TIMEOUT, SELECTOR_TIMEOUT } from '../helpers/test-constants';

test('file open exactly once — no duplicate editor instances', async ({ browser }) => {
  const {
    createHost,
    waitForEditor,
    cleanup,
  } = createE2EHelpers(browser);

  // ── 1. Host creates room ──
  const host = await createHost('host@e2e.test');

  // ── 2. Verify editor is visible ──
  await waitForEditor(host.page);

  // ── 3. Check __P2P_TEST__ diagnostics availability ──
  const diagnosticsAvailable = await host.page.evaluate(
    () => ((window as any).__P2P_TEST__?.getStateVector?.() ?? null) !== null,
  );

  if (diagnosticsAvailable) {
    // ── 4. Verify state vector is non-null (document is initialized) ──
    const stateVector = await host.page.evaluate(
      () => (window as any).__P2P_TEST__?.getStateVector?.() ?? null,
    );
    if (stateVector === null) {
      throw new Error('Expected state vector to be non-null after room creation');
    }
  }

  // ── 5. Verify the editor is visible and contains DOM content ──
  const editor = host.page.locator('[data-testid="editor"]');
  await editor.waitFor({ state: 'visible', timeout: CONNECTION_TIMEOUT });

  const editorContent = await editor.innerHTML();
  if (editorContent.length === 0) {
    throw new Error('Expected editor to contain DOM content, but it was empty');
  }

  // ── 6. Assert exactly ONE editor instance exists (not duplicated) ──
  const editorCount = await host.page.locator('[data-testid="editor"]').count();
  if (editorCount !== 1) {
    throw new Error(
      `Expected exactly 1 editor instance, but found ${editorCount}`,
    );
  }

  // ── Cleanup ──
  await cleanup();
});