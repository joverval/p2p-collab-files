# ADR-0003: Security Tests — Unit Tests Over E2E for Sanitization

**Status:** Proposed
**Date:** 2026-07-23
**Deciders:** Strata (architect)

## Context

The spec requires 7 security tests (Section 3.7):
1. Chat `<img onerror>` does not execute
2. Markdown `<script>` removed
3. `javascript:` link removed
4. Unsafe SVG removed
5. Very long chat/email rejected
6. Control-message spoof from peer rejected
7. Room-state spoof from peer rejected

Tests 1-5 are about text output safety. Tests 6-7 are about message protocol gating.

The question: should these be unit tests (vitest + jsdom), E2E tests (Playwright), or both?

## Decision

**Unit tests for sanitization (1-5), unit tests for spoofing (6-7). No E2E duplication.**

Rationale:

**Sanitization (1-5):** ChatController._createEntry() uses `textContent` exclusively. This is a property of the code, not the browser. A unit test that creates a ChatController, calls `addLog('<img src=x onerror=alert(1)>')`, and asserts `textContent` contains the literal string (no execution) is deterministic and fast. An E2E test would add no additional coverage because the browser's `textContent` behavior is identical to jsdom's.

**Spoofing (6-7):** SessionController's `setupRoomHandlers` and `peerAutoJoin` gate control messages by prefix (`[SYNC]`, `[ROOM]`, etc.). These are string-prefix checks, not DOM behavior. A unit test that injects a spoofed message and asserts the callback is not invoked is sufficient. An E2E test would require a real WebSocket connection and is fragile.

## Consequences

**Positive:**
- Fast feedback: all 7 security tests run in <100ms in vitest.
- No fragile browser interaction: HTML injection tests don't need page.evaluate or event listeners.
- Deterministic: no timing-dependent XSS detection.

**Negative:**
- Does not test the actual browser's HTML parser behavior for edge cases (e.g., obscure XSS vectors that jsdom might parse differently). If jsdom's `textContent` differs from Chrome's, a false negative is possible.
- Spoofing tests require mocking SessionController's callbacks, which couples the test to the callback interface.

**Neutral:**
- No E2E security tests exist today, so this is purely additive.

## Alternatives Considered

**E2E tests for sanitization:** Rejected. `page.evaluate(() => document.querySelector('#chat-log').innerHTML)` would read back innerHTML, but `textContent` doesn't populate innerHTML -- the test wouldn't verify the right thing. To verify non-execution of JS, you'd need to monitor `window.onerror` events, which is flaky and slow.

**Both unit and E2E:** Rejected. Overkill for textContent-based safety. The defense is at the code level, not the browser level.