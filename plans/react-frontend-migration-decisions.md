# React frontend migration — technical decisions

**Status:** `ACTIVE`

This file records the technical direction for the migration. The decisions are
sufficient to begin implementation. They do not require Gate A/Gate B
manifests, hash-bound GitHub records, independent approval metadata, or a
separate governance implementation before frontend work starts.

If live code exposes a missing detail, use the least disruptive behavior-
preserving choice and update this document. Ask the owner only when the choice
would change product behavior, remove a capability, cross a protected backend
boundary, or affect production activation.

## D1 — Product parity

Preserve reachable behavior during the rewrite. Existing behavior tests and
the running Svelte application are the reference.

- Replacement coverage may be added at any time.
- Do not weaken or skip an existing assertion merely to fit React.
- Implementation-specific tests may be retired after equivalent behavior is
  covered.
- A deliberate behavior or feature removal is a product decision outside this
  refactor.

## D2 — Application boundaries

Use four same-origin browser applications:

| Owner | Route families |
|---|---|
| `site` | `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, `/unicast`, `/market-cap` |
| `docs` | `/docs` plus docs catalog, static docs, and `llms*` assets |
| `wallet` | `/app`, `/address`, `/address/**`, `/testnet` |
| `ops` | `/health`, `/qa`, `/qa/hlt`, `/runs`, `/scenarios`, `/ai`, `/ai/**`, `/embed` |
| edge/server | `/admin`, `/radapter`, `/resetdb`, `/api/**`, `/api/tower/**`, `/rpc`, `/rpc2`–`/rpc8`, `/relay`, `/runtime.js`, named static assets, and unknown-path dispatch |

Add newly discovered routes to the closest existing owner when ownership is
unambiguous. Record ambiguous or product-changing cases for owner review while
continuing unaffected work.

## D3 — Build and deployment shape

Each application has an independent TypeScript project, Vite root, check,
build output, artifact manifest, and targeted tests. Production remains one
versioned same-origin release assembled from the four outputs, with whole-
release rollback.

Independent production versions and partial production rollout are not part of
this migration.

## D4 — Migration coexistence

Svelte remains the canonical frontend until the React applications are ready
for an authorized cutover. React artifacts may coexist in separate candidate
directories and may be served by development/test tooling.

Do not add a production traffic split, compatibility reader/writer, or hidden
fallback between framework implementations.

## D5 — Capabilities

Retain the existing capability groups:

- Runtime discovery and attachment;
- recovery tower onboarding, recovery, and push wake;
- Time Machine, storage inspection, and diagnostics;
- Graph3D, Architect, Jurisdiction, Runtime I/O, console, and Dockview layout;
- command palette, localization, theme, mascot, AI, QA, and HLT surfaces;
- native deep links, offline/PWA behavior, and mobile, desktop, and extension packaging;
- payment, receive, invoice, move, lending, settlement, market, and dispute flows.

Track capability migration as implementation work. An incomplete capability
blocks only declaring its application complete or performing cutover; it does
not block scaffolding or other independent slices.

## D6 — Working branch and review flow

Continue on the current `codex/react-frontend-*` branch. Use ordinary commits
and reviewable increments. A separate branch, child plan, draft PR, immutable
review SHA, external reviewer, or approval manifest is not required before
editing or continuing the migration.

The maintainer may split work into additional branches or PRs when useful, but
that is a delivery choice rather than an implementation gate.

## D7 — Route, asset, and development contract

Use fixed, collision-free asset namespaces:

| Family | HTML/artifact owner | Asset namespace and fixed assets | Direct-load behavior |
|---|---|---|---|
| site routes | `site/index.html` | `assets/site` | exact site route returns site HTML |
| docs routes | `docs/index.html` | `assets/docs`, `/docs-catalog/**`, `/llms*.txt` | `/docs` returns docs HTML |
| wallet routes | `wallet/index.html` | `assets/wallet`, `/contracts/**`, `/brainvault-worker.js`, `/hash-wasm-*.js`, `/push-wake-sw.js`, `/route-mode.js` | wallet routes return wallet HTML |
| ops routes | `ops/index.html` | `assets/ops`, `/scenarios/**`, `/comparative-results.json` | ops routes return ops HTML |
| shared assembly | no SPA owner | `/runtime.js`, manifest, icons, install/media, release manifest | exact named assets only |

Preserve current redirect, edge, and proxy behavior:

- `/admin` remains a 308 redirect to `/health`.
- queryless `/radapter` remains a 307 redirect to `/app`; its forbidden query
  behavior remains edge-owned.
- `/resetdb`, APIs, RPCs, relay, and `/runtime.js` remain edge/server-owned and
  must be matched before SPA fallbacks.
- `localhost:8080` remains the public development origin. Internal ports are
  site `8081`, Runtime/API `8082`, docs `8083`, wallet `8084`, and ops `8085`.
- Preserve current CSP, storage origin, service-worker scope, PWA behavior,
  `xln://` deep links, and native consumers.

Exact baseline edge behavior should be captured as route tests while the
gateway and assembly work is implemented. Missing tests do not block unrelated
React application work.

## D8 — Production activation

Production activation is outside ordinary refactoring authority. It requires
explicit owner authorization, a fixed prebuilt candidate, applicable release
checks, backup/rollback readiness, and immediate whole-release rollback on a
smoke-test mismatch. Never compile on production.

These requirements apply to activation, not to candidate implementation,
scaffolding, local development, or frontend-only verification.
