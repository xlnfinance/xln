# React cutover Plan 011 inventory

This document records the implementation checkpoint for the atomic React/Vite/TypeScript cutover. It is not production activation evidence: Plan 011 is blocked until the owner authorizes the protocol work identified by the unchanged-candidate browser and CI gates.

## Canonical surface ownership

| Surface | Canonical routes | Build root | Entry owner |
|---|---|---|---|
| Site | `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, `/unicast` | `frontend/build/site` | `frontend/apps/site` |
| Docs | `/docs`, docs catalog resources, `llms*` | `frontend/build/docs` | `frontend/apps/docs` |
| Wallet | `/app`, `/address/**`, `/testnet` | `frontend/build/wallet` | `frontend/apps/wallet` |
| Ops | `/health`, `/qa`, `/runs`, `/scenarios`, `/ai/**`, `/embed` | `frontend/build/ops` | `frontend/apps/ops` |

The four roots are independently built, but `frontend-surface-build.ts` requires the exact set and release packaging binds them to one manifest and build identity. Unknown, missing, duplicate, mixed, or unsafe roots fail loudly. Nginx routes each path to one manifest owner and does not cross-fallback between applications.

`/rpc`, `/rpc2`, and `/resetdb` remain runtime/edge endpoints. `/admin` remains the edge redirect to `/health`, and `/radapter` remains the query-rejecting edge redirect to `/app`. React does not own these server capabilities.

## Canonical build and development path

- `frontend/vite.config.ts` is the only frontend Vite configuration and derives every input from the route contract.
- `frontend/scripts/build-surfaces.ts` builds `site`, `docs`, `wallet`, and `ops` into exact release roots; no framework or legacy selector remains.
- `frontend/copy-static-files.js` is the deterministic shared/static producer. Docs catalog generation remains independently callable and is consumed by the docs build.
- Default development and static browser runners use the same route contract and the React artifacts. Nested runners use the exact invoking Bun executable instead of an ambient executable lookup.

## Persistence, PWA, and native ownership

The storage schema and origin remain unchanged: `xln-vaults`, `xln-vault-keys-v1`, and `xln-runtime-command-journal-v1` still belong to the wallet on the existing origin. No compatibility reader or data rewrite was added.

The root-scoped manifest and push service worker remain wallet-owned. The PWA starts at `/app`; push wake opens `/app`; native root redirects to `/app`. Capacitor, desktop, extension, and mobile packaging consume the manifest-bound wallet surface through `.native-wallet-build`, not the complete public web release.

## Retired implementation proof

The cutover deletes the Svelte routes, components, layouts, compiler configuration, generated types, Svelte store adapter, dependencies, compiler-specific tests, compatibility build scripts, and obsolete migration notes. At this checkpoint:

- `rg --files frontend -g '*.svelte'` returns no files.
- `rg -n "svelte|SvelteKit|@sveltejs|\\.svelte" frontend/package.json frontend/bun.lock frontend/apps frontend/packages frontend/scripts tests package.json` returns no active references.
- React is the single frontend implementation path. There is no legacy flag, dual build, fallback route, or retained Svelte artifact.

## Scenario handoff boundary

The ops scenario player exposes deterministic playback controls and opens a wallet preview URL carrying validated scenario and frame identifiers. The wallet parses that input before boot and renders a write-disabled preview surface; it does not create a vault, start a Runtime, route a command, or persist scenario state. Invalid or partial preview input falls back to normal wallet boot.

## Verification checkpoint

- React TypeScript and the canonical four-surface production build pass. The latest build emits all four roots; wallet and health/Three.js chunks retain known size warnings for later optimization, not correctness failures.
- Frontend/deployment L1 is green: 633 tests pass across 118 files with 2,767 expectations, including the real HTTP release-health tests run with loopback listener access. The CI-discovered native/watchtower regressions have a separate narrow result of 7 pass and 0 fail on commit `0c22c2356`.
- Commit `68b807b112f4` has strict browser evidence for the public site (1 target), docs and nested image assets (5), wallet onboarding/recovery/accounts/payment routes (5), ops health/QA/runs plus Dockview/3D suspension and scenario preview (4), payment smoke (1), AHB (1), and multiroute load (1). Every captured iPhone, laptop, and wide-desktop screenshot was inspected; the passing browser-health gates reported no unexpected console, page, request, or response failures.
- The complete flow batch on that commit passed 8 targets, failed 1 rebalance target, and cancelled 1 after the Account failure. The empty swap/history target separately passed in 8.8 seconds; the live swap target failed during market-maker Runtime startup before Playwright.
- Native mobile iOS/Android sync, desktop smoke, and extension packaging passed on commit `68b807b112f4` with manifest version `0.1.31-68b807b112f4`. `bun run check` also passed on that exact commit with frozen core unchanged.
- `bun run gate:ci` stopped at runtime core tests with 473 pass and 11 fail. Three migration-owned failures were fixed and passed narrowly in `0c22c2356`; the remaining eight failures touch Runtime/Entity/Account semantics and require owner authority before implementation.

## Remaining release blockers

- The live swap market-maker stack repeatedly rejects sibling legs with `CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH`, then emits 2.15 MB direct WebSocket messages above the 1 MB limit and crashes incident persistence with `DEBUG_EVENT_TOO_LARGE:bytes=149034:max=65536`. This is Runtime/network protocol scope and requires explicit owner authorization.
- The rebalance flow reaches Account recovery and fails with `SETTLEMENT_SEAL_NONCE_MISMATCH:28:29:j=0:next=29:local=28:peer=24`, leaving the bilateral pair at committed height 30 with height 31 pending. This is an Account consensus invariant and requires explicit owner authorization.
- The CI core batch also has eight protocol-owned regressions, including cross-j exact-ratio/admission fixtures, validator secondary-hash evidence, and restored frame resend behavior. These must be localized L1-first under owner-authorized Runtime/Entity/Account work.
- After those fixes, rerun the affected L1 tests, payment/user-flow and swap L2, native mobile/desktop/extension, `bun run check`, `bun run gate:ci`, and `bun run gate:release` on one unchanged final candidate.
- Do not mark Plan 011 done, create a non-WIP release commit, push, merge, tag, or activate production before those gates pass.
