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

  /** Get the CURRENT invite URL from the host page (not a stale snapshot). */
  getShareUrl(page: Page): Promise<string>;

  /** Wait for the host's share URL to change from a previously seen value.
   *  Ensures the store-offer-next relay call completed before reading. */
  waitForShareUrlChange(page: Page, previousUrl: string, timeout?: number): Promise<string>;

  approvePeer(hostPage: Page, email: string): Promise<void>;

  waitForEditor(page: Page): Promise<void>;

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

  // ── Chat helpers ──

  /** Open the chat panel. */
  openChatPanel(page: Page): Promise<void>;

  /** Send a chat message via the panel input. */
  sendChatMessage(page: Page, text: string): Promise<void>;

  /** Get all chat message text contents as an array of strings. */
  getChatMessages(page: Page): Promise<string[]>;

  /** Close the right panel. */
  closeChatPanel(page: Page): Promise<void>;

  // ── Participant helpers ──

  /** Get the participant email list from the UI. */
  getParticipantEmails(page: Page): Promise<string[]>;

  /** Get the participant count from the UI. */
  getParticipantCount(page: Page): Promise<number>;

  // ── Connection state helper ──

  /** Wait for connection state to reach a specific value. */
  waitForConnectionState(page: Page, state: string, timeout?: number): Promise<void>;
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

      // Wait for editor to be visible
      await page.waitForSelector(sel.editor, { timeout: SELECTOR_TIMEOUT });

      if (opts?.initialContent) {
        await page.click(sel.editor);
        await page.keyboard.type(opts.initialContent);
      }

      // Click copy-invite-btn to write shareUrl to clipboard, then read it
      await page.click(sel.copyInviteBtn);

      let shareUrl = '';
      try {
        shareUrl = await page.evaluate(() => navigator.clipboard.readText());
      } catch {
        // Clipboard may not be available; fall back to test API
      }

      if (!shareUrl) {
        shareUrl = await page.evaluate(
          () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
        );
      }

      if (!shareUrl) {
        throw new Error('Failed to obtain invite URL from clipboard or test API');
      }

      return { page, context, shareUrl };
    },

    async joinPeer(inviteUrl, email) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(inviteUrl);

      // Wait for the app to detect the URL hash and re-bind the button
      // (text changes from "Create Room" → "Join Room" when hash is present).
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-testid="create-room-btn"]') as HTMLButtonElement;
          return btn?.textContent?.trim() === 'Join Room';
        },
        { timeout: SELECTOR_TIMEOUT },
      );

      await page.fill(sel.emailInput, email);
      await page.click(sel.createRoomBtn);

      // Wait for email input to be disabled — signals peerAutoJoin was initiated.
      await page.waitForFunction(
        () => {
          const input = document.querySelector('[data-testid="email-input"]') as HTMLInputElement;
          return input?.disabled === true;
        },
        { timeout: SELECTOR_TIMEOUT },
      );

      // Do NOT wait for the editor here — it only becomes visible
      // after the host approves. The caller must wait for it after approving.
      return { page, context };
    },

    async getShareUrl(page) {
      return page.evaluate(
        () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
      );
    },

    async waitForShareUrlChange(page, previousUrl, timeout = 10000) {
      await page.waitForFunction(
        (oldUrl) => {
          const current = (window as any).__P2P_TEST__?.getShareUrl?.() ?? '';
          return current && current !== oldUrl;
        },
        previousUrl,
        { timeout },
      );
      return page.evaluate(
        () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
      );
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

    async waitForEditor(page) {
      await page.waitForSelector(sel.editor, {
        state: 'visible',
        timeout: CONNECTION_TIMEOUT,
      });
    },

    async editDocument(page, text) {
      await page.click(sel.editor);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(text, { delay: 5 });
    },

    async waitForText(page, expected, options) {
      await page.waitForFunction(
        (exp) => {
          const text = (window as any).__P2P_TEST__?.getText?.() ?? '';
          return text.includes(exp as string);
        },
        expected,
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

    async promotePeer(hostPage, _targetEmail) {
      // Open participants panel (data-panel="users" attribute on panel tab)
      await hostPage.click('[data-panel="users"]');

      // Find the first non-host participant (row without 'host' CSS class)
      // Participant rows show peerId (UUID), not email, so we match by
      // the presence of a promote button (only non-host rows have one).
      const promoteBtn = hostPage.locator(sel.promoteBtn).first();
      await promoteBtn.click();

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

    // ── Chat helpers ──

    async openChatPanel(page) {
      // Click the chat tab button (data-panel="chat")
      await page.click('[data-panel="chat"]');
      // Wait for chat log to appear
      await page.waitForSelector('#chat-log', { timeout: SELECTOR_TIMEOUT });
    },

    async sendChatMessage(page, text) {
      await page.fill('#chat-input', text);
      await page.click('#chat-send-btn');
      // Wait for the message to appear in the log
      await page.waitForFunction(
        (txt) => {
          const entries = document.querySelectorAll('#chat-log .log-entry');
          return Array.from(entries).some(e => e.textContent?.includes(txt as string));
        },
        text,
        { timeout: SELECTOR_TIMEOUT },
      );
    },

    async getChatMessages(page) {
      return page.evaluate(() => {
        const entries = document.querySelectorAll('#chat-log .log-entry');
        return Array.from(entries).map(e => e.textContent || '').filter(Boolean);
      });
    },

    async closeChatPanel(page) {
      // If panel is open, clicking the same tab closes it
      const isVisible = await page.isVisible('#right-panel:not(.panel-hidden)');
      if (isVisible) {
        await page.click('[data-panel="chat"]');
        await page.waitForSelector('#right-panel.panel-hidden', { timeout: SELECTOR_TIMEOUT });
      }
    },

    // ── Participant helpers ──

    async getParticipantEmails(page) {
      // Open users panel
      await page.click('[data-panel="users"]');
      await page.waitForSelector('[data-testid="participant-row"]', { timeout: SELECTOR_TIMEOUT });
      return page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="participant-row"]');
        return Array.from(rows).map(r => {
          // First span contains email, second span contains role
          const spans = r.querySelectorAll('span');
          return spans[0]?.textContent?.trim() || '';
        }).filter(Boolean);
      });
    },

    async getParticipantCount(page) {
      await page.click('[data-panel="users"]');
      await page.waitForSelector('[data-testid="participant-row"]', { timeout: SELECTOR_TIMEOUT });
      return page.evaluate(() => {
        return document.querySelectorAll('[data-testid="participant-row"]').length;
      });
    },

    // ── Connection state helper ──

    async waitForConnectionState(page, state, timeout = CONNECTION_TIMEOUT) {
      await page.waitForFunction(
        (expected) => {
          return (window as any).__P2P_TEST__?.getConnectionState() === expected;
        },
        state,
        { timeout },
      );
    },
  };
}