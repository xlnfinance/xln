# React cutover Plan 011 inventory

This document records the implementation checkpoint for the atomic React/Vite/TypeScript cutover. It is not production activation evidence: Plan 011 remains in progress until the unchanged candidate passes every browser, native, CI, and release gate.

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
- Frontend/deployment L1 is green: 633 tests pass across 118 files with 2,767 expectations, including the real HTTP release-health tests run with loopback listener access.
- Strict browser evidence covers public site, docs and nested image assets, wallet onboarding/recovery/accounts/payment routes, swap empty/history, ops health/QA/runs, Dockview/3D suspension, embed commands, and scenario-to-wallet preview. Every captured iPhone, laptop, and wide-desktop screenshot was inspected; the tested browser-health gates reported no unexpected console, page, request, or response failures.
- The final graph/scenario batch passed 3 isolated targets in 35.6 seconds. Account/onboarding/recovery passed 5 targets in 49.3 seconds, docs passed 5 targets in 27.3 seconds, and the static public-site gate passed 3 targets in 42.8 seconds.
- Native wallet sync and desktop/extension/mobile package checks passed earlier in this migration worktree. They still require one exact-final-commit rerun after this evidence update.

## Remaining release blockers

- The live swap target cannot start its market-maker stack because Runtime rejects the atomic pair with `RUNTIME_CROSS_J_ATOMIC_PAIR_REPLICA_COLLISION` in `runtime/runtime/entity-input-atomic.ts`. This is below the frontend boundary and requires explicit owner authorization before any protocol edit.
- The rebalance user-flow target reaches the Account recovery path and then fails with `ACCOUNT_PEER_FRAME_STALE_SETTLEMENT_SEAL` / `SETTLEMENT_SEAL_NONCE_MISMATCH`, leaving the bilateral pair pending across adjacent frames. This is an Account consensus invariant and requires explicit owner authorization before any protocol edit.
- Rerun payment/user-flow, native mobile/desktop/extension, `bun run check`, `bun run gate:ci`, and `bun run gate:release` on the exact final commit. The protocol failures above remain release blockers even if every frontend-only target is green.
- Review exact status/diff and retain the final candidate hashes, F12 browser-health evidence, and screenshots required by the distribution plan.
- Do not mark Plan 011 done, create a non-WIP release commit, push, merge, tag, or activate production before those gates pass.
