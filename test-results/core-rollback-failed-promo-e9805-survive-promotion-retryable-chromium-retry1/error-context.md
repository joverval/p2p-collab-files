# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: core/rollback.test.ts >> failed promotion rollback — data channels survive, promotion retryable
- Location: tests/e2e/core/rollback.test.ts:32:1

# Error details

```
TimeoutError: page.waitForSelector: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('[data-testid="copy-invite-btn"]') to be visible
    24 × locator resolved to hidden <button id="copy-invite-btn" class="handshake-btn" data-testid="copy-invite-btn">📋 Copy invite</button>

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]:
      - generic [ref=e4]: Untitled.md
      - button "📂" [ref=e6] [cursor=pointer]
      - textbox "your@email.com" [disabled] [ref=e7]: host-a@e2e.test
      - button "Create Room" [active] [ref=e8] [cursor=pointer]
    - generic [ref=e9]:
      - button "ℹ️" [ref=e10] [cursor=pointer]
      - button "👤 1" [ref=e11] [cursor=pointer]
      - button "💬" [ref=e12] [cursor=pointer]
  - generic [ref=e13]:
    - generic:
      - generic:
        - generic: Panel
        - button "✕"
```

# Test source

```ts
  16  |  *   closeAbruptly(context)            → void
  17  |  *   cleanup()                         → void
  18  |  */
  19  | 
  20  | import { type Page, type BrowserContext, type Browser } from '@playwright/test';
  21  | import {
  22  |   BASE_URL,
  23  |   sel,
  24  |   CONVERGENCE_TIMEOUT,
  25  |   CONNECTION_TIMEOUT,
  26  |   PROMOTION_TIMEOUT,
  27  |   SELECTOR_TIMEOUT,
  28  | } from './test-constants';
  29  | 
  30  | export interface E2EHelpers {
  31  |   createHost(
  32  |     email: string,
  33  |     opts?: { initialContent?: string },
  34  |   ): Promise<{ page: Page; context: BrowserContext; shareUrl: string }>;
  35  | 
  36  |   joinPeer(
  37  |     inviteUrl: string,
  38  |     email: string,
  39  |   ): Promise<{ page: Page; context: BrowserContext }>;
  40  | 
  41  |   /** Get the CURRENT invite URL from the host page (not a stale snapshot). */
  42  |   getShareUrl(page: Page): Promise<string>;
  43  | 
  44  |   /** Wait for the host's share URL to change from a previously seen value.
  45  |    *  Ensures the store-offer-next relay call completed before reading. */
  46  |   waitForShareUrlChange(page: Page, previousUrl: string, timeout?: number): Promise<string>;
  47  | 
  48  |   approvePeer(hostPage: Page, email: string): Promise<void>;
  49  | 
  50  |   waitForEditor(page: Page): Promise<void>;
  51  | 
  52  |   editDocument(page: Page, text: string): Promise<void>;
  53  | 
  54  |   waitForText(
  55  |     page: Page,
  56  |     expected: string,
  57  |     options?: { timeout?: number },
  58  |   ): Promise<void>;
  59  | 
  60  |   expectAllTexts(pages: Page[], expected: string): Promise<void>;
  61  | 
  62  |   getRoute(page: Page): Promise<string>;
  63  | 
  64  |   promotePeer(hostPage: Page, targetEmail: string): Promise<void>;
  65  | 
  66  |   closeAbruptly(context: BrowserContext): Promise<void>;
  67  | 
  68  |   cleanup(): Promise<void>;
  69  | 
  70  |   // ── Chat helpers ──
  71  | 
  72  |   /** Open the chat panel. */
  73  |   openChatPanel(page: Page): Promise<void>;
  74  | 
  75  |   /** Send a chat message via the panel input. */
  76  |   sendChatMessage(page: Page, text: string): Promise<void>;
  77  | 
  78  |   /** Get all chat message text contents as an array of strings. */
  79  |   getChatMessages(page: Page): Promise<string[]>;
  80  | 
  81  |   /** Close the right panel. */
  82  |   closeChatPanel(page: Page): Promise<void>;
  83  | 
  84  |   // ── Participant helpers ──
  85  | 
  86  |   /** Get the participant email list from the UI. */
  87  |   getParticipantEmails(page: Page): Promise<string[]>;
  88  | 
  89  |   /** Get the participant count from the UI. */
  90  |   getParticipantCount(page: Page): Promise<number>;
  91  | 
  92  |   // ── Connection state helper ──
  93  | 
  94  |   /** Wait for connection state to reach a specific value. */
  95  |   waitForConnectionState(page: Page, state: string, timeout?: number): Promise<void>;
  96  | }
  97  | 
  98  | /**
  99  |  * Creates E2E helpers bound to a Playwright browser and base URL.
  100 |  * Tracks all created contexts for cleanup.
  101 |  */
  102 | export function createE2EHelpers(browser: Browser, baseUrl: string = BASE_URL): E2EHelpers {
  103 |   const contexts: BrowserContext[] = [];
  104 | 
  105 |   return {
  106 |     async createHost(email, opts) {
  107 |       const context = await browser.newContext();
  108 |       contexts.push(context);
  109 |       const page = await context.newPage();
  110 |       await page.goto(baseUrl);
  111 | 
  112 |       await page.fill(sel.emailInput, email);
  113 |       await page.click(sel.createRoomBtn);
  114 | 
  115 |       // Wait for invitation UI to appear
> 116 |       await page.waitForSelector(sel.copyInviteBtn, { timeout: SELECTOR_TIMEOUT });
      |                  ^ TimeoutError: page.waitForSelector: Timeout 10000ms exceeded.
  117 | 
  118 |       // Wait for editor to be visible
  119 |       await page.waitForSelector(sel.editor, { timeout: SELECTOR_TIMEOUT });
  120 | 
  121 |       if (opts?.initialContent) {
  122 |         await page.click(sel.editor);
  123 |         await page.keyboard.type(opts.initialContent);
  124 |       }
  125 | 
  126 |       // Click copy-invite-btn to write shareUrl to clipboard, then read it
  127 |       await page.click(sel.copyInviteBtn);
  128 | 
  129 |       let shareUrl = '';
  130 |       try {
  131 |         shareUrl = await page.evaluate(() => navigator.clipboard.readText());
  132 |       } catch {
  133 |         // Clipboard may not be available; fall back to test API
  134 |       }
  135 | 
  136 |       if (!shareUrl) {
  137 |         shareUrl = await page.evaluate(
  138 |           () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
  139 |         );
  140 |       }
  141 | 
  142 |       if (!shareUrl) {
  143 |         throw new Error('Failed to obtain invite URL from clipboard or test API');
  144 |       }
  145 | 
  146 |       return { page, context, shareUrl };
  147 |     },
  148 | 
  149 |     async joinPeer(inviteUrl, email) {
  150 |       const context = await browser.newContext();
  151 |       contexts.push(context);
  152 |       const page = await context.newPage();
  153 |       await page.goto(inviteUrl);
  154 | 
  155 |       // Wait for the app to detect the URL hash and re-bind the button
  156 |       // (text changes from "Create Room" → "Join Room" when hash is present).
  157 |       await page.waitForFunction(
  158 |         () => {
  159 |           const btn = document.querySelector('[data-testid="create-room-btn"]') as HTMLButtonElement;
  160 |           return btn?.textContent?.trim() === 'Join Room';
  161 |         },
  162 |         { timeout: SELECTOR_TIMEOUT },
  163 |       );
  164 | 
  165 |       await page.fill(sel.emailInput, email);
  166 |       await page.click(sel.createRoomBtn);
  167 | 
  168 |       // Wait for email input to be disabled — signals peerAutoJoin was initiated.
  169 |       await page.waitForFunction(
  170 |         () => {
  171 |           const input = document.querySelector('[data-testid="email-input"]') as HTMLInputElement;
  172 |           return input?.disabled === true;
  173 |         },
  174 |         { timeout: SELECTOR_TIMEOUT },
  175 |       );
  176 | 
  177 |       // Do NOT wait for the editor here — it only becomes visible
  178 |       // after the host approves. The caller must wait for it after approving.
  179 |       return { page, context };
  180 |     },
  181 | 
  182 |     async getShareUrl(page) {
  183 |       return page.evaluate(
  184 |         () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
  185 |       );
  186 |     },
  187 | 
  188 |     async waitForShareUrlChange(page, previousUrl, timeout = 10000) {
  189 |       await page.waitForFunction(
  190 |         (oldUrl) => {
  191 |           const current = (window as any).__P2P_TEST__?.getShareUrl?.() ?? '';
  192 |           return current && current !== oldUrl;
  193 |         },
  194 |         previousUrl,
  195 |         { timeout },
  196 |       );
  197 |       return page.evaluate(
  198 |         () => ((window as any).__P2P_TEST__?.getShareUrl?.() ?? '') as string,
  199 |       );
  200 |     },
  201 | 
  202 |     async approvePeer(hostPage, email) {
  203 |       await hostPage.waitForSelector(sel.approvalToast, { timeout: SELECTOR_TIMEOUT });
  204 | 
  205 |       const toastText = await hostPage.textContent(sel.approvalToast);
  206 |       if (!toastText?.includes(email)) {
  207 |         throw new Error(
  208 |           `Toast is for wrong email. Expected ${email}, got: ${toastText}`,
  209 |         );
  210 |       }
  211 | 
  212 |       await hostPage.click(sel.toastApprove);
  213 |       await hostPage.waitForSelector(sel.approvalToast, {
  214 |         state: 'hidden',
  215 |         timeout: 5000,
  216 |       });
```