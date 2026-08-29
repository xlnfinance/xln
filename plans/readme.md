# React frontend migration — start here

The React frontend migration is active and may start from the current branch.
These documents are working implementation guidance, not approval gates:

- [Migration work plan](react-frontend-migration.md)
- [Technical decisions](react-frontend-migration-decisions.md)

## Goal

Deliver these outcomes together:

1. Split the browser frontend into independently owned `site`, `docs`, `wallet`,
   and `ops` applications.
2. Rewrite retained Svelte UI in React, Vite, and strict TypeScript without
   intentionally changing product behavior.
3. Give each application fast, independent checks and build outputs while
   retaining repository and release checks at integration boundaries.

## Start now

Begin with the first ready work packages in the migration plan. Work does not
depend on Gate A/Gate B manifests, immutable approval records, a clean global
baseline, separate child plans, PR metadata, external reviewers, or a green
repository-wide check.

Use the current application and its tests as the behavior reference. Inventory
routes, capabilities, storage, workers, generated inputs, PWA/native consumers,
and browser tests as each surface is touched. An incomplete inventory is work
to finish, not a reason to block unrelated scaffolding or migration slices.

## Working agreement

- Keep changes inside the frontend migration scope.
- Prefer small, reviewable increments, but split or combine them when that makes
  the implementation safer or clearer.
- Run the narrowest useful checks for the changed surface. Record unrelated
  failures and continue frontend-only work.
- Do not weaken, skip, or delete an existing assertion to make React pass.
- Keep Svelte canonical while candidate React applications are incomplete.
- Treat canonical cutover, Svelte deletion, and production activation as
  separately authorized integration/release operations.

## Current status

| Artifact | Status | Next action |
|---|---|---|
| [Migration work plan](react-frontend-migration.md) | `READY` | Start baseline discovery, scoped tooling, and application scaffolding. |
| [Technical decisions](react-frontend-migration-decisions.md) | `ACTIVE` | Use the recorded application, route, build, and coexistence decisions. |
| Frontend implementation | `READY TO START` | Execute the first non-overlapping work packages and keep this plan current. |

Only stop for a decision when the work would change product behavior, cross
into Runtime/consensus/contracts/financial logic, remove a retained capability,
or activate production.
