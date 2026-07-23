/**
 * E2E helper factory — composable primitives for Playwright tests.
 *
 * Every test gets a clean set of helpers via createE2EHelpers(browser, baseUrl).
 * The factory tracks all opened BrowserContexts and cleans them up in cleanup().
 *
 * API (per architecture section 7 / E2E Helper API):
 *   createHost(email, opts?)          → { page, context, shareUrl }
 *   joinPeer(inviteUrl, email)        → { page, context }
 *   approvePeer(hostPage, email)      → void
 *   editDocument(page, text)          → void
 *   waitForText(page, expected, opts?) → void
 *   expectAllTexts(pages, expected)   → void
 *   getRoute(page)                    → string
 *   promotePeer(hostPage, targetEmail) → void
 *   closeAbruptly(context)            → void
 *   cleanup()                         → void
 */

import { type Page, type BrowserContext, type Browser } from '@playwright/test';
import {
  BASE_URL,
  sel,
  CONVERGENCE_TIMEOUT,
  CONNECTION_TIMEOUT,
  PROMOTION_TIMEOUT,
  SELECTOR_TIMEOUT,
} from './test-constants';

export interface E2EHelpers {
  createHost(
    email: string,
    opts?: { initialContent?: string },
  ): Promise<{ page: Page; context: BrowserContext; shareUrl: string }>;

  joinPeer(
    inviteUrl: string,
    email: string,
  ): Promise<{ page: Page; context: BrowserContext }>;

  approvePeer(hostPage: Page, email: string): Promise<void>;

  editDocument(page: Page, text: string): Promise<void>;

  waitForText(
    page: Page,
    expected: string,
    options?: { timeout?: number },
  ): Promise<void>;

  expectAllTexts(pages: Page[], expected: string): Promise<void>;

  getRoute(page: Page): Promise<string>;

  promotePeer(hostPage: Page, targetEmail: string): Promise<void>;

  closeAbruptly(context: BrowserContext): Promise<void>;

  cleanup(): Promise<void>;
}

/**
 * Creates E2E helpers bound to a Playwright browser and base URL.
 * Tracks all created contexts for cleanup.
 */
export function createE2EHelpers(browser: Browser, baseUrl: string = BASE_URL): E2EHelpers {
  const contexts: BrowserContext[] = [];

  return {
    async createHost(email, opts) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(baseUrl);

      await page.fill(sel.emailInput, email);
      await page.click(sel.createRoomBtn);

      // Wait for invitation UI to appear
      await page.waitForSelector(sel.copyInviteBtn, { timeout: SELECTOR_TIMEOUT });

      // Try clipboard first, then fall back to __P2P_TEST__ API
      let shareUrl = '';
      try {
        shareUrl = await page.evaluate(() => navigator.clipboard.readText());
      } catch {
        // Clipboard may not be available; fall back
      }

      if (!shareUrl) {
        shareUrl = await page.evaluate(
          () =>
            ((window as any).__P2P_TEST__?.getRoomId?.()
              ? `${window.location.origin}/#${(window as any).__P2P_TEST__.getRoomId()}`
              : '') as string,
        );
      }

      // Wait for editor to be visible
      await page.waitForSelector(sel.editor, { timeout: SELECTOR_TIMEOUT });

      if (opts?.initialContent) {
        await page.click(sel.editor);
        await page.keyboard.type(opts.initialContent);
      }

      return { page, context, shareUrl };
    },

    async joinPeer(inviteUrl, email) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(inviteUrl);

      await page.fill(sel.emailInput, email);
      await page.click(sel.createRoomBtn);

      await page.waitForSelector(sel.editor, { timeout: CONNECTION_TIMEOUT });
      return { page, context };
    },

    async approvePeer(hostPage, email) {
      await hostPage.waitForSelector(sel.approvalToast, { timeout: SELECTOR_TIMEOUT });

      const toastText = await hostPage.textContent(sel.approvalToast);
      if (!toastText?.includes(email)) {
        throw new Error(
          `Toast is for wrong email. Expected ${email}, got: ${toastText}`,
        );
      }

      await hostPage.click(sel.toastApprove);
      await hostPage.waitForSelector(sel.approvalToast, {
        state: 'hidden',
        timeout: 5000,
      });
    },

    async editDocument(page, text) {
      await page.click(sel.editor);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(text, { delay: 5 });
    },

    async waitForText(page, expected, options) {
      await page.waitForFunction(
        ([testid, exp]) => {
          const el = document.querySelector(`[data-testid="${testid}"]`);
          return el?.textContent?.includes(exp as string) ?? false;
        },
        ['editor', expected],
        { timeout: options?.timeout ?? CONVERGENCE_TIMEOUT },
      );
    },

    async expectAllTexts(pages, expected) {
      const texts = await Promise.all(
        pages.map(
          (p) => p.evaluate(() => (window as any).__P2P_TEST__?.getText() ?? '') as Promise<string>,
        ),
      );

      const allMatch = texts.every((t) => t === expected);
      if (!allMatch) {
        throw new Error(
          `Texts do not converge. Expected: "${expected}". Got: ${JSON.stringify(texts)}`,
        );
      }
    },

    async getRoute(page) {
      return page.evaluate(
        () =>
          document.querySelector('[data-testid="connection-route"]')?.textContent ?? '',
      );
    },

    async promotePeer(hostPage, targetEmail) {
      // Open participants panel (data-panel="users" attribute on panel tab)
      await hostPage.click('[data-panel="users"]');

      // Find the row for targetEmail and click its promote button
      const row = hostPage.locator(sel.participantRow, {
        hasText: targetEmail,
      });
      await row.locator(sel.promoteBtn).click();

      // Wait for promotion to complete (former host becomes peer)
      await hostPage.waitForFunction(
        () => (window as any).__P2P_TEST__?.getRole() === 'peer',
        undefined,
        { timeout: PROMOTION_TIMEOUT },
      );
    },

    async closeAbruptly(context) {
      await context.close();
      contexts.splice(contexts.indexOf(context), 1);
    },

    async cleanup() {
      for (const ctx of contexts.splice(0)) {
        try {
          await ctx.close();
        } catch {
          // already closed
        }
      }
    },
  };
}