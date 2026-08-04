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
- Frontend unit boundary: 593 tests pass. The only failing test cannot start `Bun.serve({ port: 0 })` because this execution sandbox rejects local listeners before assertions run.
- Deployment/release/integrity: 46 assertions pass for surface ownership, manifest validation, route isolation, atomic activation/rollback, audit registry, Foundation Hanko, and frozen-core behavior. Two HTTP health tests are blocked by the same sandbox listener restriction.
- Prior strict browser evidence covers site, docs, wallet shell/onboarding, health/QA/runs, Dockview/3D, and embed at iPhone, laptop, and wide-desktop viewports. The final scenario-to-wallet preview patch has L1/type/build evidence but still requires its post-patch browser rerun.
- Native wallet sync and desktop/extension/mobile package checks passed earlier in this migration worktree. Final unchanged-candidate parity and build-identity evidence is still required.

## Remaining release blockers

- Run the final scenario/wallet preview browser assertion and the complete fresh/prior-profile route matrix where local listeners are permitted.
- Run `bun run check`, `bun run gate:ci`, and `bun run gate:release` on one unchanged candidate with `bun` available to nested package scripts.
- Run the required payment/user-flow and final native/browser parity gates, inspect F12 console/network/storage and screenshots, then review exact status/diff.
- Do not mark Plan 011 done, create a non-WIP release commit, push, merge, tag, or activate production before those gates pass.
