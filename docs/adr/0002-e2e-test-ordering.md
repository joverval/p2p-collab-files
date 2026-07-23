# ADR-0002: E2E Test Ordering — Chat, Participants, and Connection First

**Status:** Proposed
**Date:** 2026-07-23
**Deciders:** Strata (architect)

## Context

Seven E2E tests are missing from the release-gate suite: C (chat history), D (participant list), H (connection state), I (STUN/TURN routes, 4 sub-scenarios), J (room lifetime), K (lifecycle leaks), L (file open once).

These tests have dependencies:
- C, D, H, K need new `__P2P_TEST__` diagnostics (getChatMessages, getStateVector, getSignalingListenerCount).
- I needs coturn in CI (already configured via docker-compose.turn.yml).
- J needs a configurable relay TTL to be testable in reasonable time.
- L needs file input support in Playwright (page.setInputFiles).

The question: in what order should these be implemented?

## Decision

**Phase 1 (chat, participants):** E2E tests C and D first. They need the least new infrastructure: chat panel helpers and participant list selectors. These are the most user-visible features and catch regressions early.

**Phase 2 (connection state, lifecycle leaks):** E2E tests H and K. They need the `__P2P_TEST__` diagnostics to be completed first (getStateVector, getSignalingListenerCount).

**Phase 3 (room lifetime, file open):** E2E tests J and L. J needs relay TTL configuration. L needs file input.

**Phase 4 (ICE routes):** E2E tests I.1 through I.4. These are the most infrastructure-heavy (coturn, network-level blocking) and the least likely to catch regressions in the core P2P logic.

## Consequences

**Positive:**
- Fastest return on investment: chat and participant tests are small, self-contained, and validate the most user-facing features.
- Diagnose blockers early: Phase 2 forces the `__P2P_TEST__` gaps to be fixed, which unblocks all subsequent E2E tests.
- ICE tests are deferred: they are the most flaky and infrastructure-dependent. Running them last avoids blocking the core test suite.

**Negative:**
- ICE tests remain untested until Phase 4. If a regression breaks TURN fallback, it won't be caught until late.
- Phase ordering adds a sequential dependency: Phase 2 can't start until Phase 1's helper additions are done.

**Neutral:**
- The dependency graph is a DAG. Phase 1 and unit tests can run in parallel. Only Phases 2-4 are sequential.

## Alternatives Considered

**All E2E tests in parallel:** Rejected. The `__P2P_TEST__` diagnostics are incomplete. Starting all E2E tests simultaneously would produce 7 failing tests that all fail for the same reason (missing diagnostics), wasting effort.

**ICE tests first:** Rejected. ICE tests are the most infrastructure-dependent and least likely to fail. Starting with them would delay validating core features.