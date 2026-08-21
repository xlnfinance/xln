# React frontend migration program — start here

This directory contains a blocked program charter and its owner-decision
contract. The charter is not an executable implementation plan:

- [Migration program charter](react-frontend-migration.md)
- [Owner decision contract](react-frontend-migration-decisions.md)

Do not change frontend or migration-tooling code from the charter alone. After
an append-only Gate A manifest for the frozen charter/decision subject is
independently verified and derives `OWNER_RECORDED`, write and accept a
self-contained Work Package 0 child plan. Every later human-reviewed increment
requires its own numbered child plan.

## Owner-approved goal — gate authorization pending

Deliver all three outcomes together:

1. Split the browser frontend into independently owned `site`, `docs`, `wallet`, and `ops` applications.
2. Rewrite the retained Svelte UI in React, Vite, and strict TypeScript without changing product behavior.
3. Give each application fast, independently runnable checks while retaining strict repository and release gates at integration boundaries.

The owner confirmed these outcomes in D1–D8 on 2026-08-20. That decision does
not authorize implementation: Work Package 0 requires a valid Gate A manifest,
and React work requires Gate B plus the other documented prerequisites. The
migration is incomplete if any approved outcome is missing.

## Start conditions

Before Work Package 0:

- Read `AGENTS.md` and the complete migration plan.
- Start from a clean canonical repository state and record its immutable SHA.
- Confirm the recorded D1–D8 answers and reconciled charter are byte-final, then
  freeze both files at `SUBJECT_COMMIT` before requesting current hash-bound
  GitHub owner and independent-review records.
- Add the Gate A manifest only after those external records name the frozen
  subject; do not write a SHA or approval status into the reviewed subject.
- Confirm the application boundaries, route ownership, and non-goals with the human reviewer.
- Do not import an implementation from another source. Reconstruct behavior from the live application, tests, and reviewed capability contract.

Before any React implementation, `bun run check` must be green on the accepted
canonical SHA. A known red baseline may be inventoried in Work Package 0, but it
must have a separate owner/task and be fixed before a React child plan starts.

## Execution rule

Work is a serial chain of bounded, human-reviewed child plans:

- One self-contained numbered plan per increment, written after its prerequisites land.
- One surface or tooling concern and one or two user flows per increment.
- Human scope approval before substantial implementation.
- Narrow and targeted evidence before broader gates.
- Human code, behavior, and evidence approval before merge.
- No dependent increment begins until its prerequisite is accepted.

The only increments permitted while the charter remains blocked are separately
reviewed Work Package 0 governance/baseline child plans authorized by valid Gate
A evidence. React feature migration starts only after Gate B approval, a green
baseline, capability inventory, frozen parity oracle, scoped-verification
foundation, and current-Svelte atomic activation/rollback foundation are
reviewed and accepted.

## Verification rule

- **L0 local:** changed app and directly affected shared packages only.
- **L1 slice:** L0 plus one app build and exact browser scenarios for the changed flow.
- **L2 frontend:** affected applications plus cross-app route, asset, storage, and assembly contracts.
- **L3 repository/release:** existing strict repository, CI, and release gates at named milestones and final cutover.

No level may turn a failure into a warning. Scoped checks avoid unrelated work by selecting a smaller dependency graph, not by skipping assertions.

## Non-negotiable boundaries

- Svelte remains canonical until every owner-approved React application has complete capability evidence.
- No Runtime, consensus, contract, financial-formula, market-maker, persistence-schema, or unrelated security changes.
- No route, user flow, failure state, persistence behavior, native behavior, or test may disappear without explicit human approval.
- No mock financial success, placeholder production panel, compatibility selector, hidden fallback, test skip, or silent workaround.
- Production activation is separate from implementation and requires explicit release authority.

## Current status

| Artifact | Status | First action |
|---|---|---|
| [Migration program charter](react-frontend-migration.md) | `BLOCKED FOR REACT IMPLEMENTATION` | Freeze the confirmed subject, obtain Gate A, execute accepted Work Package 0 child plans, and repair/green the canonical baseline. |
| [Owner decision contract](react-frontend-migration-decisions.md) | `OWNER DECISIONS RECORDED — NO VALID GATE A MANIFEST` | Freeze the subject commit/blob IDs, obtain the exact GitHub records, then add the separate Gate A manifest. |
| Work Package 0 child plans | `NOT WRITTEN` | Write only after Gate A derives `OWNER_RECORDED`; they may capture a red baseline and implement review/scope/evidence enforcement, but no React or product behavior. |

Approval state is derived from append-only manifests and external review, never
from this table. Work Package 0 must implement
`validate-program-approval.ts`; until then, Gate A requires independent manual
verification and its first accepted validator run must confirm the same record.
All program roles use GitHub REST numeric `user.id` values as authority. GitHub
logins are display-only. Confirmed D8 freezes owner ID `174693`; confirmed D6
requires subject-PR author ID `966176`, which must still be derived from the
actual PR record. Independent-review IDs come from their GitHub reviews, and
the Gate A reviewer is deliberately selected only when the byte-final subject
PR is ready. That reviewer must be an active human GitHub `User` distinct from
IDs `174693` and `966176`. Release/rollback IDs are chosen and owner-bound only
at Gate B.

Status values: `NOT WRITTEN`, `TODO`, `IN PROGRESS`, `DONE`,
`OWNER_RECORDED — WORK PACKAGE 0 ONLY`, `APPROVED`, or `BLOCKED — exact reason`.

## Stop before coding if

- The desired application split differs from `site`, `docs`, `wallet`, and `ops`.
- No valid Gate A manifest derives `OWNER_RECORDED` for Work Package 0, or no
  valid Gate B manifest derives `APPROVED` for any later child plan.
- No self-contained child plan exists for the proposed increment.
- Current routes, behavior tests, generated inputs, storage owners, or native/PWA consumers cannot be assigned exactly once.
- The baseline frontend or a representative user flow is red for an unexplained reason.
- `bun run check` is red when React implementation is proposed.
- The requested change requires an out-of-scope domain or a weaker guard.
- No human reviewer is available for the first scope checkpoint.
