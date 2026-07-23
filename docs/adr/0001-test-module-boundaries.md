# ADR-0001: Test Module Boundaries — Chat, Participants, and Security as Independent Test Modules

**Status:** Proposed
**Date:** 2026-07-23
**Deciders:** Strata (architect)

## Context

The release-gate test suite needs 55 new unit tests and 7 new E2E tests. The existing test structure has 5 unit test files (envelope, sync, signaling, session, relay) with 77 tests. Three entire test categories are missing: chat (8 spec items), participants/role (10 spec items), and security (7 spec items). Relay authorization tests are minimal (8 of 23 spec items covered).

The question is: where should these new tests go? Options:

1. **Merge into existing files** — add chat tests to session-controller.test.ts, participant tests to session-controller.test.ts, security tests to a catch-all file.
2. **New module-level files** — one new test file per source module under `tests/unit/<module>/<module>.test.ts`.
3. **Hybrid** — new files for new modules, inline additions for small gaps in existing modules.

## Decision

**Option 3: Hybrid approach.**

- Chat, participants, and security each get their own test file in a dedicated subdirectory: `tests/unit/chat/`, `tests/unit/participants/`, `tests/unit/security/`.
- Relay authorization tests get a separate file: `tests/unit/relay/relay-authorization.test.ts`, split from the existing `relay-protocol.test.ts` which covers protocol correctness (8 tests).
- Small additions (1-2 tests) to existing modules (signaling, sync) go inline in their existing test files.

## Consequences

**Positive:**
- Module boundaries in tests mirror module boundaries in source. A developer fixing a bug in `ChatController` knows to look in `tests/unit/chat/`.
- New contributors can onboard per-module: read the source, find the matching test file.
- The relay split separates "does the protocol work" from "does the authorization work," which are different failure modes and different test setups.

**Negative:**
- More test files to maintain. Going from 5 to 9 unit test files.
- Security tests are split across two concerns: sanitization (ChatController output) and spoofing (SessionController message gating). The spoofing tests (3.7.6–3.7.7) may end up in `session-controller.test.ts` or a new `session-security.test.ts`.

**Neutral:**
- No change to vitest.config.ts: the glob `tests/unit/**/*.test.ts` already matches all new files.

## Alternatives Considered

**Merge everything into session-controller.test.ts:** Rejected. SessionController is already 467 lines of tests. Adding 25+ chat/participant/security tests would make it unmanageable and violate single responsibility.

**One security test file for everything:** Considered but rejected. Sanitization tests (textContent safety) and spoofing tests (message prefix gating) operate on different source modules (ChatController vs SessionController) and require different test fixtures. Splitting them by source module is cleaner.
