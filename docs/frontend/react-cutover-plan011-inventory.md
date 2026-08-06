# React cutover Plan 011 inventory

This document records the implementation and stabilization checkpoint for the atomic React/Vite/TypeScript cutover. It is not production activation evidence. On 5 August 2026 the owner authorized all listed Runtime/Entity/Account work. The canonical React surfaces and authorized protocol fixes are implemented. The unchanged-candidate production soundcheck now passes with isolated loopback listeners; activation still requires the CI, release, and browser-console gates described below.

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
- Frontend/deployment L1 is green: 633 tests pass across 118 files with 2,767 expectations, including the real HTTP release-health tests run with loopback listener access. The CI-discovered native/watchtower regressions have a separate narrow result of 7 pass and 0 fail on commit `68160cf0b`.
- Commit `68b807b112f4` has strict browser evidence for the public site (1 target), docs and nested image assets (5), wallet onboarding/recovery/accounts/payment routes (5), ops health/QA/runs plus Dockview/3D suspension and scenario preview (4), payment smoke (1), AHB (1), and multiroute load (1). Every captured iPhone, laptop, and wide-desktop screenshot was inspected; the passing browser-health gates reported no unexpected console, page, request, or response failures.
- The complete flow batch on that commit passed 8 targets, failed 1 rebalance target, and cancelled 1 after the Account failure. The empty swap/history target separately passed in 8.8 seconds; the live swap target failed during market-maker Runtime startup before Playwright.
- Native mobile iOS/Android sync, desktop smoke, and extension packaging passed on commit `68b807b112f4` with manifest version `0.1.31-68b807b112f4`. `bun run check` passed there and again on `da3f1fe87`, with frozen core unchanged.
- On commit `da3f1fe87`, both `bun run gate:ci` and `bun run gate:release` passed frontend types, source checks, and release-integrity tests, then stopped at runtime core tests with 476 pass and 8 fail. The corrected native/watchtower tests passed inside both gates; those eight Runtime/Entity failures were the scope subsequently authorized and resolved below.
- Commit `38c64c60d` restores the seven canonical protocol fixtures and fixes external cross-j trust-boundary admission before local target lookup. Commit `5a29190b5` makes the rebalance browser assertion wait for durable cycle evidence instead of sampling an in-flight settlement frontier.
- Checkpoint `2fab8468a` makes source intent durable through its Account, partitions exact cross-j opening cohorts below the encrypted transport budget, preserves atomic sibling reservation, and classifies a simultaneous Account proposal as deterministic deferral instead of a security incident. The focused protocol batch passes 87 tests with 796 expectations.
- `bun run check` passes on `2fab8468a`: frozen core is unchanged, Runtime TypeScript and all source invariants pass, the cross-j test file is 2,968/3,000 lines, and all four React/Vite/TypeScript production surfaces build.
- The current stabilization candidate makes RPC replica attachment authority explicit, avoids duplicate market-maker jurisdiction import, publishes startup phase changes synchronously, uses a monotonic storage deadline clock, and accepts only canonical `0/1` zero-progress cancellation evidence.
- Consecutive expired-order sweeps now detect their deterministic fixed point inside one Entity frame. A real Account/Entity regression verifies the transition, one Account admission, final route state, and every signed event; the 110-hook regression completes in 70–78 ms instead of the observed 28–53 second quadratic replay.
- Reliable-delivery recovery now parks incomplete restored atomic cohorts without spinning the Runtime, and a partial exact ACK receipt retains the complete atomic sibling cohort until every reliable sibling is receipted. Duplicate reapplication remains idempotent and regenerates the missing receipt.
- Market-maker startup begins its idempotent commit loop before registration and peer startup. Cross-quote maintenance advances one deterministic directional wave per pass, bounding Account transition size while the existing backlog fence prevents the opposite direction from entering the same bilateral frame.
- The soundcheck-only snapshot cadence is twelve frames, leaving restore margin without changing the production default. Clone attachment resolves exactly one committed predeployed replica and fails loudly on missing or ambiguous stack identity instead of synthesizing deployment authority.
- The unchanged candidate production soundcheck passes fresh, clone, and hydrate modes in `.logs/bootstrap-soundcheck/2026-08-06T13-14-21-597Z`. Stable readiness completed in 293,214 ms, 92,810 ms, and 88,288 ms respectively; all three modes produced canonical bootstrap hash `1489ea17f5a70952930b4cd8e4452a12d3a8067690d2b2abe2e8f39ba6ac1e89`.
- Current source checks pass with frozen core unchanged. The focused reliable-delivery suites pass 46 tests with 306 expectations, and targeted market-maker startup wiring passes 2 tests with 235 expectations; the regressions are included in the release-gate core list.

## Authorized CI core resolution

The eight runtime-core failures reproduced independently and were resolved only after explicit owner authorization. Seven fixtures now carry the mandatory canonical evidence; the Runtime fix preserves the same fail-fast trust boundary while checking it before local target lookup.

| Test | Classification | Implemented resolution |
|---|---|---|
| `cross-j source fill ack routes book removal to canonical sibling owner` | Fixture omits the mandatory exact fill numerator/denominator | Bind its 100/65,535 partial-fill evidence before cancelling the remainder |
| `cross-j book-owner fill ack routes admitted remote order to source hub` | Fixture gives source and target progress the same hub | Build distinct source/target hub topology before asserting routing |
| `cross-j local fill ack stays on the local source offer when an admission key collides` | Fill notice has coarse and amount evidence but no exact ratio | Bind exact cumulative ratio evidence consistent with the claimed amounts |
| `entity validator signs only the secondary hash manifest emitted by local replay` | The purported honest proposal has no proposer signature | Add the canonical proposer frame signature at manifest index zero |
| `crontab resends a restored pending frame without persisting transport routing` | Persisted pending frame uses an arbitrary, noncanonical state hash | Construct the pending frame through the canonical Account frame hash path |
| `cross-j fill notice waits for source offer instead of looping fatal errors` | Fixture reaches the intended capacity branch with invalid coarse-only fill evidence | Add exact fill ratio evidence, then retain the capacity assertion |
| `disputeStart treats pending cross_pull_close as foldable dispute evidence` | Close-proof route has explicit fill evidence without an exact ratio | Bind the existing quarter-fill claim to exact `1/4` evidence |
| `cross-j system entity txs reject every raw ingress outside certified runtimeOutput` | Real Runtime admission-order regression | Run the external cross-j trust-boundary check before local target lookup and retain the same fail-fast code |

## Release completion sequence

- Run `bun run gate:ci` and then `bun run gate:release` with isolated loopback-listener permission on the unchanged candidate. The release gate must include clone/hydrate, payment/user-flow, rebalance, market-maker cross-chain swap, native mobile/desktop/extension, and strict browser-console/screenshot evidence.
- Inspect the resulting wallet and ops screenshots at iPhone, laptop, and wide-desktop viewports, plus trace/video, Runtime WAL, structural incidents, and WebSocket-size evidence. No live `:8080` Runtime may be stopped, reset, or reused for that verification.
- Do not push, merge, tag, or activate production unless every required gate passes on one unchanged candidate and the resulting evidence has been reviewed.
