# React frontend migration work plan

**Status:** `IN PROGRESS — SITE/DOCS COMPLETE; WALLET TESTNET, PWA INPUTS, AND CLIENT BOUNDARIES IMPLEMENTED`

This is the executable work plan for splitting the Svelte frontend into React
applications. It is intentionally lightweight and should be updated as live
code, tests, and migration evidence refine the sequence.

Implementation does not wait for Gate A/Gate B, approval manifests, immutable
review records, child plans, a clean global baseline, or a green root gate.
Those retired governance prerequisites are not part of this plan.

## Outcomes

1. Create independently owned `site`, `docs`, `wallet`, and `ops` applications.
2. Rewrite retained UI in React 19, Vite 7, and strict TypeScript without an
   intentional product-behavior change.
3. Make each application independently checkable, testable, buildable, and
   runnable.
4. Assemble the application outputs into one same-origin release and preserve
   an atomic rollback path.

## Scope

### In scope

- `frontend/**` application roots, UI/client packages, configuration, checks,
  assets, build/assembly, and eventual Svelte removal;
- `tests/frontend/**`, `tests/e2e/**`, and `tests/sites/**` for behavior and
  frontend tooling coverage;
- root package scripts and CI entries needed to expose frontend commands;
- frontend artifact consumers in `native/**`, deployment scripts, and release
  tooling when integration reaches those consumers;
- planning and frontend documentation needed to keep the migration executable.

### Out of scope

- Runtime, Entity/Account transitions, consensus, financial formulas, custody,
  contracts, market-maker behavior, and persistence-schema changes;
- product redesign, route renaming, origin/storage migration, feature removal,
  SSR, a new router/state framework, or independent production releases;
- unrelated cleanup and weakening or skipping tests to fit the candidate.

If a slice unexpectedly needs an out-of-scope change, isolate that dependency
and continue other frontend work. Ask before crossing the boundary.

## Technical direction

The active decisions live in
[`react-frontend-migration-decisions.md`](react-frontend-migration-decisions.md).
The target package shape is:

```text
frontend/
  apps/
    site/{index.html,src/,tsconfig.json,vite.config.ts}
    docs/{index.html,src/,tsconfig.json,vite.config.ts}
    wallet/{index.html,src/,tsconfig.json,vite.config.ts}
    ops/{index.html,src/,tsconfig.json,vite.config.ts}
  packages/
    browser/
    runtime-client/
    ui/
  config/
    surfaces.ts
    capabilities.ts
    verification.ts
  scripts/
    check.ts
    prepare.ts
    build.ts
    dev-gateway.ts
    assemble.ts
    assets/
  .artifacts/<application>/
  build/
```

Keep one `frontend/package.json` and lockfile. Each app gets its own Vite root,
TypeScript project, output directory, and tests. `assemble.ts` alone produces
the canonical `frontend/build` from validated application artifacts.

### Shared modules

- `packages/browser` owns validated storage access, browser/worker lifecycle,
  service-worker integration, and external-store snapshots.
- `packages/runtime-client` owns UI-facing validation, subscriptions, queries,
  and commands. It must not implement Runtime transitions or financial rules.
- `packages/ui` owns design tokens and primitives with real shared consumers.
- Wallet-only finance components stay in the wallet app.
- External mutable state exposes stable subscription/snapshot APIs for
  `useSyncExternalStore`.

## Route ownership

Encode the route table in `frontend/config/surfaces.ts`:

| Application | Routes and outputs |
|---|---|
| `site` | `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, `/unicast`, `/market-cap` |
| `docs` | `/docs`, docs catalog/static content, `llms*` |
| `wallet` | `/app`, `/address`, `/address/**`, `/testnet` |
| `ops` | `/health`, `/qa`, `/qa/hlt`, `/runs`, `/scenarios`, `/ai`, `/ai/**`, `/embed` |
| edge/server | `/admin`, `/radapter`, `/resetdb`, `/api/**`, `/api/tower/**`, `/rpc*`, `/relay`, `/runtime.js`, static dispatch |

Applications use same-origin links and do not import one another's entry points.
The gateway keeps `localhost:8080` as the public development origin and routes
to independent app servers and existing API/Runtime services.

## Working method

- Work packages express useful sequencing, not approval gates. Start any ready,
  non-overlapping package and run independent work in parallel when practical.
- Prefer complete vertical slices over bulk file conversion. A slice should
  leave the candidate runnable and should preserve its named behavior.
- Capture ownership and tests as the relevant code is touched; do not wait for
  a perfect global inventory before scaffolding or migrating an independent
  route.
- Extract shared modules when a second real consumer appears or when doing so
  first clearly reduces migration risk.
- Keep candidate artifacts separate from canonical Svelte output until cutover.
- Update package status, discoveries, and changed assumptions in this file.

Suggested size targets are one surface or shared concern and one or two flows,
but maintainers may split or combine increments based on cohesion. File count,
LOC, missing PR fields, and missing external review are not stop conditions.

## Verification

Use the narrowest useful evidence for each change:

| Level | When | Evidence |
|---|---|---|
| local | normal edit | affected TypeScript project, unit tests, or policy check |
| slice | user-flow change | local checks, one app build, exact browser scenario |
| frontend | shared boundary or app milestone | affected apps plus route, asset, storage, and assembly contracts |
| repository/release | integration, cutover, release | existing repository, CI, native, and release gates as applicable |

Rules:

- Do not turn failures into warnings or hide them with skips.
- An unrelated root-gate failure is recorded and assigned separately; it does
  not block frontend-only implementation.
- Run `bun run check` when integration wiring changes and before a merge or
  completion claim that depends on repository-wide health, not before every
  frontend edit.
- Run browser console/page/request checks and relevant viewport screenshots for
  visible behavior changes. They are unnecessary for non-visual scaffolding.
- Use isolated test state; do not restart or mutate the user's durable Runtime.

The scoped command interface should converge on:

```bash
bun frontend/scripts/check.ts --surface=site --level=local
bun frontend/scripts/check.ts --surface=wallet --level=slice --spec=<spec>
bun frontend/scripts/check.ts --changed-from=<sha> --level=local
bun frontend/scripts/check.ts --surface=docs --level=frontend
bun frontend/scripts/check.ts --all --level=frontend
bun frontend/scripts/build.ts --surface=ops
bun frontend/scripts/assemble.ts
```

These commands are deliverables, not prerequisites for starting the migration.
Use existing direct commands until their replacements exist.

## Capability tracking

Create `frontend/config/capabilities.ts` incrementally. Each capability should
eventually identify:

- application, route, current source, and retained behavior;
- happy, failure, loading, and empty states where applicable;
- storage, worker, service-worker, asset, PWA, and native consumers;
- existing and replacement tests;
- migration and verification status.

Use simple statuses such as `unstarted`, `in_progress`, `implemented`,
`verified`, and `blocked`. A blocked capability prevents its application from
being declared complete, but does not block unrelated capabilities.

Capture a baseline inventory from live source and tests, including routes,
registered panels/commands, persisted keys and IndexedDB schemas, workers,
generated assets, localization keys, native/PWA entries, and release consumers.
The inventory may evolve when discoveries are corrected; review meaningful
behavior changes rather than treating metadata hashes as authorization.

## Generated inputs

Replace the all-purpose copy step incrementally:

| Input family | Producer/owner |
|---|---|
| docs catalog, docs-static, `llms*` | docs |
| public release/install/static content | site |
| wallet PWA icons, manifest, push-wake worker, route mode | wallet |
| Runtime browser bundle, BrainVault worker, contract browser artifacts | wallet; ops only if consumed |
| scenario catalog/media | ops |
| route map, artifact hashes, release manifest | assembly |

Producers must be deterministic, must not edit backend or contract source, and
must write only their declared artifact directories.

## Work packages

Packages may overlap when ownership and files do not conflict. Dependencies
describe technical order only.

### WP0 — Discover the live baseline

**Status:** `IN PROGRESS — ROUTE, CAPABILITY, AND GENERATED-INPUT OWNERSHIP SEEDED`

- Inventory routes, edge exclusions, static assets, generated inputs, storage,
  workers, native/PWA consumers, tests, and major capability registries.
- Measure current frontend counts and commands; treat old plan counts only as
  hints.
- Record existing narrow and root check results without attempting unrelated
  backend repairs.
- Add route/capability configuration as soon as enough live data is known.

**Done:** touched areas have clear owners and known behavior references; open
questions are recorded without blocking unrelated work.

### WP1 — Add scoped tooling and React roots

**Status:** `DONE — FOUR ISOLATED ROOTS AND LOCAL CHECK/BUILD COMMANDS VERIFIED`

- Add the React/Vite/TypeScript configuration needed by the four app roots.
- Create independent minimal roots and separate `.artifacts/<application>`
  outputs while leaving canonical Svelte commands/output unchanged.
- Implement per-surface check, prepare, and build entry points.
- Add affected-application selection and tests that prove a local app command
  does not invoke unrelated applications or broad repository gates.

**Done:** all four minimal roots can be checked and built independently and
candidate output cannot overwrite `frontend/build`.

### WP2 — Establish routing, assets, and assembly

**Status:** `IN PROGRESS — DOCS, WALLET PWA/BROWSER, AND OPS CATALOG INPUTS ASSEMBLED`

- Materialize the route/asset table and edge exclusions.
- Implement the same-origin development gateway and per-app HMR paths.
- Split generated-input producers and add collision checks.
- Assemble validated app artifacts into a versioned candidate release.
- Capture current redirect, deep-link, missing-asset, CSP, proxy, and fallback
  behavior as focused tests while touching those paths.

**Done:** development routing and candidate assembly cover the four apps without
shadowing edge/API routes or changing canonical production selection.

### WP3 — Migrate site

**Status:** `COMPLETE — ALL SEVEN SITE ROUTES IMPLEMENTED`

- Use `/` and `/install` as the architecture pilot.
- Migrate `/rcpan`, `/unicast`, `/releases`, `/reviews`, and `/market-cap`.
- Preserve live data, links, assets, responsive states, and failure behavior.
- Refine shared UI conventions based on real second consumers.

**Pilot evidence:** the React site candidate now resolves `/`, `/install`,
`/rcpan`, `/unicast`, `/releases`, `/reviews`, and `/market-cap` with
route-specific metadata, preserves the wallet-open marker and version-pinned
local launcher, publishes all five install channels, and keeps unknown paths at
the explicit pending-route boundary without changing canonical Svelte
production selection. `/rcpan` consumes the existing deterministic microscope
timeline and settlement model rather than reproducing account or financial
logic. `/unicast` preserves the canonical 100-participant device mix, paused
1–1,000 TPS control, capacity thresholds, broadcast degradation, constant
one-TPS settlement claim, and responsive comparison while making node placement
deterministic. `/releases` keeps the Foundation trust anchor and Hanko policy
unchanged, verifies all 22 canonical manifest entries and source snapshots
before rendering any chart metric, and shares one strict decoder, signature
binding, chart model, and sanitized Markdown loader with the canonical Svelte
route. `/reviews` preserves the canonical five-prompt, four-model response
matrix through one shared Svelte/React content source and keeps prompt changes
synchronized across all four responses. `/market-cap` shares its strict relay
response decoder, request builder, integer-tick formatting, and ranking presets
with Svelte while preserving all five rankings, seven filters, direction,
250ms search debounce, stale/no-price labels, abort-safe loading, and fail-loud
retry behavior without adding estimates. Sixty-five focused tooling tests,
three canonical market-cap invariant tests, thirteen Foundation Hanko tests,
all four application builds, loading/success/failure/jurisdiction states, route
interactions, reduced-motion behavior, exact document widths, and 390×844,
1366×900, and 1920×1080 screenshots are green. The normal market flow has zero
console errors or warnings; the injected failure flow emits only its expected
HTTP 503 before recovering. The four-app candidate assembles as
`sha256-420fba14d39f37003d5ebef852baf83dd1ca1044ab5337a489d77906aa2f3d67`
with 351 files. The site-only typecheck still reaches unrelated core unused
import, `.ts` extension, and proof-builder type blockers, and the legacy Svelte
workspace check reports 30 existing errors in 16 unrelated files; the route
build and focused source checks are green. The required root gate passes all 26
BrainVault checks before the existing contract-sync environment stops at
Hardhat `HH19` under unsupported Node 25.

**Done:** every site route is served by the site candidate and its relevant
behavior/browser checks pass.

### WP4 — Migrate docs

**Status:** `IMPLEMENTED — CATALOG, READER, SEARCH, AND GENERATED INPUTS GREEN`

- Move the docs catalog/static producer to docs ownership.
- Migrate navigation, reader, deep links, anchors, search, and sanitization.
- Preserve deterministic `llms*` and catalog output.

The React docs app now owns `/docs` and consumes the same strict manifest
decoder, search/filter model, link and image resolution, heading extraction,
and sanitized Markdown renderer as the canonical Svelte reader. It preserves
the 102 live / 34 archive catalog, three reading paths, featured documents,
direct document URLs, internal Markdown navigation, catalog-owned HTML assets,
browser history, anchors, raw-source links, visible loading/failure states, and
fail-loud retry. The docs
producer publishes 294 deterministic files; the catalog manifest is
`sha256-8754e6fc6b1224a080a8a1d8248ef6398b3f908584713880190a71f1d88d811d`
and `llms.txt` is
`sha256-174223c25cb65b065dbe0a6055e84f77cbd7c6f4e535ea8058f716caeec20122`.
Seventy tooling tests (462 assertions), the focused sanitization/diagnostic checks, the docs
typecheck, all four app builds, and same-origin browser flows are green. Browser
evidence covers search, empty results, live/archive scope, deep links, 76px
anchor landing, back navigation, injected catalog failure and retry, and
malicious Markdown rejection at 390×844, 1366×900, and 1920×1080 with exact
document widths. Normal flows have zero console errors or warnings; the
injected failure emits only its expected HTTP 503 before recovery. The
four-app candidate assembles as
`sha256-795c0b047b60b813a17bcf4ce229c985b5d0b68d7a9d61ca7cd5e72c3a7ce924`
with 351 files. The legacy Svelte workspace still reports 30 existing errors
and one warning in 16 unrelated files, with no docs diagnostics. The required
root gate passes all 26 BrainVault checks before the existing contract-sync
environment stops at Hardhat `HH19` under unsupported Node 25.

**Done:** docs builds independently and current public docs URLs and content
behavior pass focused checks.

### WP5 — Establish browser and Runtime-client boundaries

**Status:** `IN PROGRESS — RESET, REQUEST, SESSION, HANDLE, BOOT, TAB-OWNERSHIP, SELECTION, ACTIVATION, QUERY, OBSERVER, CATCH-UP, VIEW-SELECTION, VIEW-REFRESH, VIEW-STATE, VIEW-PROJECTIONS, VIEW-LOADER, VIEW-PUBLICATION, AND VIEW-MODEL BOUNDARIES SHARED`

- Extract validated storage, subscriptions, listener cleanup, workers, and
  service-worker integration into `packages/browser`.
- Extract UI-facing Runtime/RPC projections and commands into
  `packages/runtime-client`.
- Move no transition, consensus, persistence, or financial formula into the
  frontend. Use canonical helpers such as `deriveDelta`.
- Keep APIs usable by Svelte during coexistence when that makes extraction
  safer; migrate React consumers incrementally.

**Done:** shared boundaries have real consumers, focused lifecycle/persistence
tests, and no duplicate writer or financial implementation.

The first `packages/browser` slice now owns explicit reset confirmation,
single-flight execution, cross-tab hard-reset publication, the settle window,
IndexedDB/cache/service-worker/storage deletion, and redirect ordering. The
canonical Svelte wallet and the React `/testnet` route consume that boundary;
Runtime suspension remains injected by the Svelte adapter and no Runtime or
financial logic moved into the package. Six focused reset tests cover durable
deletion, blocked deletion, lifecycle ordering, duplicate execution,
confirmation, cross-tab publication, and the existing hash-reset integration.

The first `packages/runtime-client` slice now owns framework-neutral WebSocket
URL normalization, remote Runtime hash decoding, forbidden query detection,
import-parameter removal, capability-role validation, and the pure consent
decision. The canonical Svelte wallet remains the live adapter for
history replacement, RuntimeController activation, and recovery imports; no
Runtime state or transition logic moved into the package. Seven direct boundary
tests cover URL normalization, authenticated and stored-authority links,
missing capability prompts, query rejection before authority resolution,
import stripping, and consent. The wallet local check covers 425 files with
zero unsafe-type findings.

The next `packages/browser` slice now owns validated Runtime adapter session
selection: durable mode, endpoint, and access metadata; tab-confined capability
authority; embedded-mode cleanup; rollback snapshots; and per-tab remote-link
acceptance. Canonical Svelte boot, import, connection, selection, and restored
authority paths delegate storage mutations to this framework-neutral boundary,
while the saved Runtime registry remains in its existing Svelte adapter. Eight
direct tests cover validation-before-mutation, authority confinement and
restoration, stale cleanup, embedded selection, rollback, acceptance failure,
and canonical-consumer wiring. The wallet local check covers 425 files with
zero unsafe-type findings.

The next `packages/runtime-client` slice now owns the pure Runtime handle
projection: normalized selected and pending identity, adapter/config identity,
endpoint, permissions, connection status, height, authenticated access,
command readiness, and current-config comparison. The canonical Svelte store
still owns adapter creation, connection, disconnection, subscriptions, and
publication; it delegates handle construction and identity comparison to the
framework-neutral boundary. Seven direct tests cover embedded defaults, remote
admin and inspect projections, height bounds, stable fallback identity,
explicit Runtime identity matching, canonical WebSocket matching, and thin
Svelte wiring. The wallet local check covers 426 files with zero unsafe-type
findings.

The next `packages/browser` slice now owns the injected wallet boot lifecycle:
settings and tab initialization, remote-preference branching, pre-Runtime local
vault restore, Runtime initialization, post-Runtime local vault rebind, render
settlement, time-store activation, and cancellation checks at every boundary.
The canonical Svelte app supplies the stores, Runtime initializer, current
Runtime mode, render tick, and generation/active-tab guard; no Svelte store or
Runtime implementation moved into the package. Eleven direct tests cover local
and remote order, a local boot that resolves remote, cancellation before work
and after every asynchronous phase, failure propagation, and thin Svelte
wiring. The wallet local check covers 427 files with zero unsafe-type findings.

The next `packages/browser` slice now owns active-tab Runtime coordination:
exclusive Web Lock acquisition, a non-evicting availability probe,
BroadcastChannel and storage reset handling, per-tab standby state,
quiesce-before-release takeover, same-document adoption, and deterministic
listener/channel cleanup. The canonical Svelte module only publishes controller
state and preserves its existing imports. Eight direct tests cover standby,
acquisition/release, denied probes, takeover ordering, hard reset, malformed
storage evidence, reset publication, and thin Svelte wiring. The wallet local
check covers 429 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns one-writer Runtime selection
coordination: monotonic leases, queued serialization, immediate stale-intent
invalidation, superseded queued-intent elision, active-lease validation, and
queue recovery after failure. The canonical Svelte Runtime store still owns
adapter switching, session persistence, rollback, target verification, and
store publication; it delegates only concurrency control to the shared
boundary. Five direct tests cover serialization, latest-intent behavior, lease
invalidation, forged/expired lease rejection, failure recovery, and thin Svelte
wiring. The wallet local check covers 430 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns injected Runtime adapter
activation. Remote activation persists the session before switching, publishes
pending identity, avoids reconnecting an already-current target, restores the
session and pending identity on switch failure, asserts the selected target,
and reaffirms the session after success. Embedded activation publishes pending
identity before switching, avoids reconnecting a current registered target,
restores pending identity on failure, and persists embedded mode only after
success. The canonical Svelte store supplies browser storage, controller state,
adapter switching, and target comparison. Eleven direct tests cover both modes,
ordering, reconnect elision, unavailable persistence, rollback, mismatch,
unregistered targets, endpoint validation, and thin Svelte wiring. The wallet
local check covers 431 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns the framework-neutral
RuntimeView query, pagination, historical-height, committed-height tracking,
live-command assertion, and history-scan default model. The canonical Svelte
store still owns the live RuntimeView state, core projection types, adapter
reads, race guards, catch-up scheduling, and store publication. Eleven direct
tests cover identity normalization, page derivation and navigation, height and
query selection, frame matching, committed-height tracking, live assertions,
history defaults, and thin Svelte wiring. The wallet local check covers 432
files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns injected Runtime projection
reads, stable query identity, Runtime- and height-scoped caching, lagging live
response handling, historical pinning, bounded eviction, path construction,
and request validation. The canonical Svelte adapter still owns concrete core
result types, active adapter/height/Runtime resolution, cache invalidation
subscriptions, debug-surface publication, and reactive query stores. Ten direct
tests cover stable keys, live invalidation, lagging responses, historical reads,
Runtime partitioning, validated paths, uncached receipt/recovery reads, missing
adapters, eviction, and thin Svelte wiring. The wallet local check covers 433
files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns the framework-neutral Runtime
query observer: stable external-store snapshots, latest-read publication,
loading and error state, injected height/adapter subscriptions, refresh
recovery, and deterministic teardown. The canonical Svelte adapter still owns
Runtime source wiring and adapts the observer to Svelte immediate subscriptions;
the existing Gossip and Solvency panels keep their public store API. Ten direct
tests cover initial/success state, stale success and failure suppression,
current errors, recovery, both source notifications, subscriber cleanup,
snapshot identity, destruction, and thin Svelte wiring. The wallet local check
covers 434 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns framework-neutral RuntimeView
committed-height catch-up: pending-height coalescing, single-flight refresh,
lagging-frame retry, bounded exponential backoff, loud timeout publication,
refresh-error reporting, reset, and teardown. The canonical Svelte store still
owns Runtime source subscriptions, projection reads, timer construction, and
live store publication; it injects those effects into the coordinator. Ten
direct tests cover retry delays, ignored heights, initial-frame queuing,
in-flight coalescing, newer targets, timeout, read failures, reset, destruction,
and thin Svelte wiring. The wallet local check covers 435 files with zero
unsafe-type findings.

The next `packages/runtime-client` slice now owns framework-neutral RuntimeView
selection state: stable snapshots and subscriptions, normalized Entity/page/
historical-height updates, monotonic revisions, navigation reset, complete
selection matching, and generation-aware publication guards. The canonical
Svelte adapter exposes the same Entity and page values as derived readable
stores and still owns query refresh invalidation and live RuntimeView
publication. Ten direct tests cover defaults, Entity normalization, same-Entity
pagination, page normalization, historical height, navigation reset, ABA
selection, publication identity, subscriptions, and thin Svelte wiring. The
wallet local check covers 436 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns framework-neutral RuntimeView
refresh leases: monotonic latest-read generations, exact Runtime identity and
mode matching, complete selection matching, explicit invalidation, and
selection invalidation before subscriber notification. The canonical Svelte
adapter still owns typed projection reads, RuntimeView result construction,
page metadata, catch-up scheduling, and live store publication. Ten direct
tests cover target capture, latest-read precedence, explicit invalidation,
Runtime identity and mode changes, complete and ABA selection changes,
subscriber ordering, Runtime ABA invalidation, and thin Svelte wiring. The
wallet local check covers 437 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns deterministic RuntimeView
snapshot transitions: empty, loading, disconnected, successful, and failed
states; live committed-height resolution; historical-height pinning; Entity
identity normalization; selection clearing; and monotonic live-height advance.
The canonical Svelte adapter still owns concrete typed reads, writable
publication, page metadata, Runtime subscriptions, and catch-up effects. Ten
direct tests cover live and historical empty states, retained loading data,
disconnection, live and historical success, error normalization, height
selection, committed-height advance, and thin Svelte wiring. The wallet local
check covers 438 files with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns detached RuntimeView
projection reads: normalized and verified Entity projections, bounded Entity
page limits, Account identity validation, swap-history bounds and cursors, and
live or historical selection scoping. The canonical Svelte adapter still owns
the concrete typed query client, active RuntimeView store, and public wrapper
API. Ten direct tests cover missing, live, historical, summary/core, mismatched,
and absent Entity evidence; Account validation and scoping; swap-history
pagination; and thin Svelte wiring. The wallet local check covers 439 files
with zero unsafe-type findings.

The next `packages/runtime-client` slice now owns injected RuntimeView load
outcomes: disconnected short-circuiting, concurrent head and frame reads,
exact historical-frame validation, tagged success and error results, and
latest-handle error capture during a Runtime switch. The canonical Svelte
adapter still owns refresh leases, loading and writable publication, page
metadata, subscriptions, and catch-up effects. Ten direct tests cover
disconnection, read concurrency, live and historical success, exact-height
rejection, head and frame failures, Runtime-switch handle semantics, and thin
Svelte wiring. The wallet local check covers 440 files with zero unsafe-type
findings.

The next `packages/runtime-client` slice now owns framework-neutral RuntimeView
publication coordination: refresh-lease capture, selected-height query pinning,
loading-before-read ordering, latest-wins suppression, and tagged success or
unavailable outcome routing. The canonical Svelte adapter still owns concrete
typed reads, writable stores, page metadata, subscriptions, and catch-up
effects through injected callbacks. Ten direct tests cover live, historical,
disconnected, error, invalidated, target-changed, and overlapping refreshes;
per-caller results; and thin Svelte wiring. The wallet local check covers 441
files with zero unsafe-type findings.

### WP6 — Migrate wallet by flow

**Status:** `IN PROGRESS — TESTNET LAUNCHER, DISPOSABLE IDENTITIES, SHELL STATE, DEPLOY-VERSION, RUNTIME BOOTSTRAP, CONSENT, IDENTITY-ENTRY, RECOVERY-REHEARSAL, RECOVERY-CHOICE, RUNTIME-OPENING, RECOVERY-DISCOVERY, NODE-MNEMONIC-REVEAL, RUNTIME-PREFERENCE, NODE-BRAINVAULT-VALIDATION, BROWSER-BRAINVAULT-WORKER-VALIDATION, BROWSER-BRAINVAULT-WORKER-SCHEDULING, BROWSER-BRAINVAULT-WORKER-RESILIENCE, AND BROWSER-BRAINVAULT-FINALIZATION COORDINATION IMPLEMENTED`

Migrate coherent flows in roughly this order:

1. boot, shell, identity, onboarding, recovery, settings, diagnostics;
2. assets, accounts, credit, collateral, debt, solvency, disputes, history;
3. payments, receive, invoices, moves, lending, settlement, reconnect, failures;
4. quotes, routing, orders, orderbook, cancel/fill, cross-j, and activity.

Preserve canonical Runtime projections and persisted state. A flow is complete
when success and important failure states pass focused tests; incomplete later
flows do not block earlier wallet slices.

The React wallet now owns `/testnet` while `/app` and `/address` remain explicit
pending routes. It preserves the wallet, custody, health, docs, GitHub, and
social destinations; the five session-randomized disposable Brain Vault entry
links; destructive confirmation; successful reset-to-`/app`; and a visible,
retriable failure when durable deletion is blocked. Eighteen focused tests (141
assertions), strict wallet/tooling typechecks across 422 files with zero unsafe
type findings, and the wallet production build are green. The broader batch
passed 80/82 tests in the sandbox; the two localhost-binding gateway cases then
passed 5/5 outside it. The wallet artifact is 202.40 kB JavaScript / 64.17 kB
gzip and 6.45 kB CSS / 2.02 kB gzip. Browser
evidence covers cancellation, success, and blocked-database failure at 390×844,
1366×900, and 1920×1080; normal flows have zero console errors or warnings, and
the injected failure emits only the expected blocked-deletion error. The
four-app candidate assembles as
`sha256-74038d2cade7da80c14faea3596707d788a701f77ad4789b9429b2ed4742d71b`
with 351 files. The required root gate passes all 26 BrainVault checks before
the existing contract-sync environment stops at Hardhat `HH19` under
unsupported Node 25.

The next wallet slice now owns framework-neutral shell phase derivation for
remote Runtime consent, inactive-tab standby, scenario preview, lock-test
readiness, initialization errors, Runtime loading, and ready content. The
canonical Svelte `/app` shell consumes the shared precedence without changing
its effects, UI, or route ownership; a future React shell can consume the same
snapshot decision without mirrored effect state. Eleven direct tests cover all
phases and precedence edges, 47 affected shell/lifecycle/capability tests pass
with 278 expectations, both wallet and canonical Svelte production builds pass,
and the wallet local check covers 442 files with zero unsafe-type findings.

The next wallet slice now owns one-shot Runtime bootstrap ordering: local
pairing, remote import, consent evaluation, accepted-request persistence, URL
cleanup, and stop-on-failure semantics. The same coordinator handles initial
mount and later hash import changes while the Svelte shell retains concrete
pairing/import implementations, loading/error publication, and pending-consent
UI state. Eight direct tests cover explicit-input detection, exact effect
ordering, consent and accepted paths, pairing/import/persistence failures, and
thin Svelte wiring. The direct and existing remote-import suites pass 43 tests
with 171 expectations. The broader affected request/session/boot/security/
capability batch passes 103 tests with 469 expectations, both wallet and
canonical Svelte production builds pass, and the wallet local check covers 443
files with zero unsafe-type findings.

The next wallet slice now owns framework-neutral recovery-candidate choice:
selected-id lookup with first-candidate fallback, single-pass peer-backup
counting, immutable file-candidate replacement ordered by Runtime height then
creation time, and backup-before-local-before-fresh continuation precedence.
The canonical Svelte flow retains recovery discovery, file parsing, discovery
status persistence, local unlock, backup restore, and fresh Runtime creation.
Eight direct tests plus the affected identity, rehearsal, import, workspace,
and capability suites pass 80 tests with 572 expectations; both wallet and
canonical Svelte production builds pass, and the wallet local check covers 447
files with zero unsafe-type findings. This covers selection, empty results,
deduplication, ordering, stable ties, continuation, immutability, and thin
wiring.

The next wallet slice now owns framework-neutral Runtime opening plans:
explicit local unlock precedence, default existing-Runtime lookup, forced-fresh
and recovery-candidate creation, fallback labels, interoperability mnemonic
normalization, device-passphrase presence, onboarding policy, and recovery
restore flags. Local Runtime lookup remains short-circuited for explicit
local, fresh, and backup actions. The canonical Svelte event flow retains
vault reads and mutations, active signer publication, sensitive cleanup,
navigation, diagnostics, and failure handling. Eight direct tests plus the
affected recovery, vault protection, creation-lock, shell, bootstrap, consent,
import, workspace, and capability suites pass 134 tests with 757 expectations;
both wallet and canonical Svelte production builds pass, and the wallet local
check covers 448 files with zero unsafe-type findings.

The next wallet slice now owns generation-safe recovery discovery
coordination: each request receives a new generation, only the latest success
or failure is accepted, and reset or unmount explicitly invalidates outstanding
work. Stale successes and failures return cancelled without clearing the
newest request's loading state. The canonical Svelte event flow retains seed
and Runtime preconditions, concrete tower and peer discovery sources, local
Runtime lookup, candidate and failure publication, phase changes, and status
persistence. Six direct tests plus the affected identity, rehearsal, opening,
import, workspace, vault, shell, and capability suites pass 140 tests with 782
expectations. The broader recovery batch passes 167 of 169 tests with 913
expectations; its two failures are pre-existing stale source-shape assertions
for the preserved-corrupt-storage diagnostic and the recovery-failure wrapper.
Both wallet and canonical Svelte production builds pass, and the wallet local
check covers 449 files with zero unsafe-type findings.

The next wallet slice now owns generation-safe node mnemonic reveal
coordination: only the latest overlapping success or failure is accepted,
reset invalidates outstanding work, and captured phase, derivation-result, and
adapter ownership must still match after the async reveal. A cancelled latest
generation clears its own loading state, while an older cancelled generation
cannot clear a newer request's loading state. The canonical Svelte event flow
retains the cheap connection and node-ready guards, concrete admin adapter
call, secret mnemonic publication, loading state, and user-visible errors.
Seven direct tests plus the affected identity, recovery, import, workspace,
capability, worker, and native-custody suites pass 99 tests with 649
expectations. Both wallet and canonical Svelte production builds pass, and the
wallet local check covers 450 files with zero unsafe-type findings.

The next wallet slice now owns deterministic Runtime preference policy: exact
auth-scheme decoding with dark fallback, ten-minute/day/forever unlock-duration
resolution, and positive-integer BrainVault worker-cap parsing plus the
existing floor/minimum serialization policy. The canonical Svelte event flow
retains concrete localStorage reads and writes, initialization timing, reactive
state publication, and the existing scalar storage keys; no wallet secret,
Runtime state, or browser storage handle enters the shared boundary. Six direct
tests plus the affected identity, recovery, opening, import, workspace,
capability, worker, and native-custody suites pass 121 tests with 726
expectations. Both wallet and canonical Svelte production builds pass, and the
wallet local check covers 451 files with zero unsafe-type findings.

The next wallet slice now owns deterministic node BrainVault validation:
connected-remote and admin-access gating, inclusive progress bounds for the
expected shard count, exact result spec/shard matching, and the existing 70/30
shard-time smoothing. The canonical Svelte event flow retains adapter lookup,
the concrete derivation call and passphrase, abort ownership, progress and
receipt publication, cleanup, and user-visible failure effects. Eight direct
tests plus the affected identity, recovery, opening, import, workspace,
capability, worker, native-custody, and remote-reconnect suites pass 130 tests
with 800 expectations. Both wallet and canonical Svelte production builds
pass, and the wallet local check covers 452 files with zero unsafe-type
findings.

The next wallet slice now owns fail-closed browser BrainVault worker protocol
validation: message-envelope classification, exact readiness spec matching,
probe and shard timing normalization, worker-error normalization, and shard
index, active-worker ownership, result-length, and duplicate checks. The
canonical Svelte event flow retains Worker creation and handlers, watchdog
timers, retry and dispatch state, result byte decoding, secret inputs, cleanup,
diagnostics, and UI publication. Nine direct tests plus the affected identity,
recovery, opening, import, workspace, capability, worker, native-custody,
node-validation, and remote-reconnect suites pass 139 tests with 831
expectations. Both wallet and canonical Svelte production builds pass, and the
wallet local check covers 453 files with zero unsafe-type findings.

The next wallet slice now owns deterministic browser BrainVault worker
scheduling decisions: pending-work detection, completed-shard retry
suppression, three-attempt retry queuing and exact terminal failure, retry-first
dispatch with completed-head cleanup, fresh-shard cursor advancement, and
cap-aware worker drain/add decisions. The canonical Svelte event flow retains
retry-map and queue mutation, Worker creation and draining, watchdogs,
postMessage payloads and secret input, diagnostics, and UI publication. Nine
direct tests plus the affected validation, identity, recovery, opening, import,
workspace, capability, worker, native-custody, node-validation, and
remote-reconnect suites pass 148 tests with 860 expectations. Both wallet and
canonical Svelte production builds pass, and the wallet local check covers 454
files with zero unsafe-type findings.

The next wallet slice now owns deterministic browser BrainVault worker sizing
and resilience policy: conservative CPU/RAM/WebKit caps, persisted lower caps,
Wasm-memory failure recognition, halved fallback caps, five-to-ten-minute shard
watchdogs, live memory-pressure reduction, four-attempt initialization retry
eligibility, and exact terminal initialization copy. The previous Svelte-only
worker helper is removed. The canonical Svelte event flow retains timers,
Worker teardown and recreation, cap persistence, diagnostics, phase/error
publication, postMessage, and secret input. Eight direct resilience tests plus
the migrated sizing test and affected scheduling, validation, identity,
recovery, opening, import, workspace, capability, native-custody,
node-validation, and remote-reconnect suites pass 156 tests with 883
expectations. Both wallet and canonical Svelte production builds pass, and the
wallet local check covers 454 files with zero unsafe-type findings.

The next wallet slice now owns deterministic browser BrainVault finalization
policy: completion-trigger ownership, exact ascending shard membership,
current-run atomic commit eligibility, and canonical recovery labels. The
canonical Svelte event flow retains shard bytes, Worker termination, every
cryptographic await, derived-secret publication, zeroization, recovery
persistence, navigation, and user-visible state. Ordered-set failures now pass
through the existing finalizer cleanup so collected shards are zeroized before
the error returns. Nine direct finalization tests plus the affected onboarding,
workspace, capability, worker, native-custody, and remote-reconnect suites pass
195 tests with 1110 expectations across 23 files. Both wallet and canonical
Svelte production builds pass, and the wallet local check covers 455 files with
zero unsafe-type findings.

The next wallet slice now owns remote Runtime consent decisions and effect
ordering: capability selection and validation, accepted-request persistence,
URL cleanup, activation, and embedded cancellation. The canonical Svelte
shell retains concrete storage, session, history, UI-state, and Runtime boot
effects through injected callbacks; its event handlers now delegate without
mirroring the policy. Nine direct tests cover existing and pasted capabilities,
invalid input, stop-on-failure boundaries, embedded cancellation, and thin
Svelte wiring. The direct, bootstrap, capability, and focused legacy consent
checks pass 25 tests with 216 expectations. The broader affected batch passes
128 of 129 tests with 980 expectations; its sole failure is the pre-existing
outdated `xlnEnvironment` source-shape assertion. Both wallet and canonical
Svelte production builds pass, and the wallet local check covers 444 files with
zero unsafe-type findings.

The next wallet slice now owns the canonical identity-entry modes and their
deterministic interaction policy: Brain Vault and mnemonic are the only
choices, mode changes are input-phase and rehearsal guarded, the departing
mode's sensitive field is cleared, password visibility is reset, and Home,
End, and wrapping arrow navigation resolve without DOM access. The canonical
Svelte view retains field publication, focus, and derivation effects; no
BrainVault derivation or cryptographic logic moved into the boundary. Eleven
direct tests plus the existing wallet-entry surface tests cover the complete
selection and keyboard matrix. The direct, surface, and capability checks pass
19 tests with 178 expectations. The broader affected identity, recovery-import,
workspace, and capability batch passes 65 tests with 529 expectations. Both
wallet and canonical Svelte production builds pass, and the wallet local check
covers 445 files with zero unsafe-type findings.

The next wallet slice now owns the mnemonic recovery-rehearsal transition
policy: an unrequested rehearsal is skipped, a requested rehearsal captures a
normalized public address, a mismatch remains active with an explicit retry
error, a match clears the rehearsal, and cancellation/reset returns canonical
idle state. The canonical Svelte event flow retains seed and derived-material
cleanup, phase/error publication, field mutation, and all derivation and
cryptographic effects. Seven direct tests plus the existing identity-entry and
wallet-entry surface suites cover skip, begin, mismatch, case-insensitive
match, option changes during an active rehearsal, reset, and thin wiring. The
direct, identity-entry, surface, and capability checks pass 26 tests with 197
expectations. The broader affected identity, recovery-import, workspace, and
capability batch passes 72 tests with 548 expectations. Both wallet and
canonical Svelte production builds pass, and the wallet local check covers 446
files with zero unsafe-type findings.

The next wallet slice now owns validated deploy-version payload decoding,
storage, action selection, initial persistence, post-boot refresh, ephemeral
testnet reset coordination, explicit unavailable outcomes, and fail-closed
persistent-data recovery decisions. The canonical Svelte `/app` shell still
owns the concrete no-cache fetch, diagnostic publication, loading/error stores,
and destructive reset implementation through injected dependencies. Eleven
direct tests cover payload aliases and rejection, all policy branches, fetch
and validation failure, storage/reset propagation, refresh persistence, and
thin Svelte wiring. Eighty affected boot/import/security/capability tests pass
with 384 expectations, both wallet and canonical Svelte production builds pass,
and the wallet local check covers 442 files with zero unsafe-type findings.

### WP7 — Migrate ops by flow

**Status:** `READY AFTER OPS ROOT AND REQUIRED BOUNDARIES`

- Migrate health, QA/HLT, evidence, runs, scenarios, AI, embed, and their
  authority/error states.
- Migrate Dockview, Graph3D, Architect, Jurisdiction, Runtime I/O, console,
  solvency, Time Machine, and render/worker teardown.
- Preserve real controls and data; do not replace working operator functions
  with static placeholders.

**Done:** ops routes and operator flows pass focused checks with correct cleanup
and authority behavior.

### WP8 — Integrate PWA, native, deployment, and rollback

**Status:** `IN PROGRESS — WALLET PWA INPUT OWNERSHIP ASSEMBLED`

- Point PWA/native/deployment consumers at the assembled candidate artifact.
- Preserve service-worker scope, storage origin, CSP, deep links, and packaging.
- Exercise corrupt, missing, duplicate, and mixed-artifact rejection.
- Prove atomic activation and immediate whole-release rollback in an isolated
  environment while Svelte remains canonical in production.

The wallet now owns one deterministic `wallet-pwa-static` input containing the
touch icon, both Android icons, manifest, push-wake service worker, and route
mode bootstrap. Exact asset routes keep those files with the wallet surface;
the React wallet entry consumes its icons, manifest, and route mode without
embedding executable code. Focused ownership, copy, assembly, CSP, and gateway
tests pass, and the four-app candidate assembles as
`sha256-5b0e12e67cc85c3bdbf3617a1e00be106622fb1cc778f7c61108d7811154c566`
with 353 files. This captures inputs only: canonical Svelte activation,
service-worker registration, native packaging, deployment, and cutover remain
unchanged.

**Done:** all consumers use one candidate release identity and isolated smoke
tests can activate, reject invalid candidates, and roll back.

### WP9 — Close parity and prepare cutover

**Status:** `WAITING FOR APPLICATION COMPLETION`

- Confirm all retained routes and capabilities have React owners and tests.
- Run all-frontend checks and representative browser flows at required
  viewports.
- Resolve genuine parity gaps; do not narrow baseline assertions.
- Produce a cutover checklist covering canonical commands, artifact consumers,
  Svelte dependencies/source, rollback, and release evidence.

**Done:** the four React apps form a complete candidate and no known retained
capability depends on Svelte.

### WP10 — Authorized canonical cutover

**Status:** `OWNER AUTHORIZATION REQUIRED`

- Freeze the chosen candidate and obtain explicit destructive cutover approval.
- Switch canonical dev/build/check/package/deploy paths atomically.
- Delete retired Svelte source, configuration, dependencies, and candidate-only
  coexistence wiring; leave no production framework selector.
- Run all-frontend, repository, CI, release, browser, native, activation, and
  rollback checks applicable to the cutover.

**Done:** canonical commands use one complete React release, Svelte is absent,
and the same candidate passes cutover and rollback evidence.

### WP11 — Production activation

**Status:** `SEPARATE RELEASE OPERATION`

Use explicit release authority, immutable prebuilt artifacts, current release
policy, backup/rollback ownership, production smoke, and immediate rollback on
any mismatch. Never compile on production.

## Done criteria

- [x] Four independent React/Vite/TypeScript application roots exist.
- [ ] Every retained browser route and capability has one application owner.
- [ ] Each app checks, tests, builds, and runs targeted browser flows without
      building unrelated apps.
- [ ] Shared packages preserve storage/lifecycle and Runtime-client boundaries.
- [ ] Generated inputs have deterministic producers and collision-free outputs.
- [ ] Same-origin routing, redirects, proxies, assets, CSP, storage, PWA, deep
      links, native consumers, activation, and rollback are proven.
- [ ] Existing behavior tests were preserved or replaced with equivalent
      behavior coverage, not weakened to fit React.
- [ ] No Runtime, protocol, consensus, financial, or alternate persistence logic
      was introduced into frontend code.
- [ ] Authorized cutover removes Svelte and leaves one canonical production path.
- [ ] Production activation is separately authorized.

## Current next actions

1. Restore the canonical Runtime browser build in a Runtime-authorized change,
   then promote `wallet-runtime-bundle` from deferred input. The current build
   fails because `core/runtime/frame/assertions.ts` imports the non-exported
   `computeFrameHash` from `core/account/consensus/index.ts`; this does not block
   the other wallet or ops input families.
2. Continue WP5/WP6 with the wallet boot, shell, canonical Brain Vault and
   mnemonic identity choices, onboarding, recovery, settings, and diagnostics;
   keep Runtime projections in shared client adapters and do not move
   transition logic into the frontend. Remote link decoding and consent are
   ready in `packages/runtime-client`, and adapter session storage is ready in
   `packages/browser`; wallet boot sequencing, active-tab Runtime ownership,
   Runtime selection concurrency, adapter activation, and Runtime handle
   projection are shared; cached Runtime projection reads plus the RuntimeView
   query, pagination, height model, committed-height catch-up, and RuntimeView
   selection snapshots, refresh leases, snapshot transitions, detached
   projections, injected loading outcomes, and latest-wins publication
   coordination are also shared. Wallet shell phase precedence is shared while
   validated deploy-version persistence, reset, and recovery decisions are
   injected through a shared browser coordinator; one-shot Runtime pairing,
   import, consent, persistence, and URL cleanup ordering are shared as well.
   Remote consent validation, accepted-request persistence, activation, and
   embedded cancellation ordering are shared through injected browser effects.
   Canonical Brain Vault/mnemonic identity-mode selection, sensitive-field
   clearing, and keyboard navigation decisions are also shared without moving
   derivation or cryptographic effects.
   Mnemonic recovery-rehearsal skip, begin, mismatch, match, cancel, and reset
   decisions are shared while sensitive cleanup and derivation remain with the
   concrete wallet event flow.
   Recovery candidate selection, peer counting, immutable file-candidate merge
   ordering, and backup/local/fresh continuation are shared while discovery,
   storage, and Runtime effects remain concrete.
   Runtime local-unlock and creation plans, input normalization, onboarding
   flags, and recovery-restore intent are shared while vault mutation,
   sensitive cleanup, navigation, diagnostics, and failure handling remain
   concrete.
   Recovery discovery generation ownership, stale-result suppression, error
   normalization, and reset/unmount invalidation are shared while concrete
   discovery sources and UI, vault, and persistence effects remain concrete.
   Node mnemonic reveal generation ownership, captured-context validation,
   stale-result suppression, and error normalization are shared while adapter
   access, secret publication, loading, and error effects remain concrete.
   Runtime auth-scheme, unlock-duration, and worker-cap preference policy is
   shared while concrete localStorage access and reactive publication remain
   in the canonical Svelte event flow.
   Node BrainVault access, progress, result, and timing validation are shared
   while adapter calls, abort ownership, passphrase input, and result
   publication remain concrete.
   Browser BrainVault worker message, readiness, timing, failure, and shard
   completion validation are shared while Worker lifecycle, watchdogs,
   dispatch, result-byte decoding, secret input, and publication remain
   concrete.
   Browser BrainVault retry, next-shard dispatch, and worker-scaling decisions
   are shared while retry state mutation, Worker creation and draining,
   watchdogs, postMessage, secret input, diagnostics, and publication remain
   concrete.
   Browser BrainVault worker sizing, watchdog, memory-reduction,
   initialization-retry, and terminal-error decisions are shared while timers,
   Worker teardown and recreation, cap persistence, diagnostics, postMessage,
   secret input, and publication remain concrete.
   Browser BrainVault completion triggering, exact shard membership, current-run
   atomic commit, and recovery-label decisions are shared while shard bytes,
   cryptography, zeroization, persistence, navigation, and UI publication
   remain concrete.
   The existing Svelte shell retains concrete lifecycle effects. Latest-read
   Runtime query subscriptions expose stable external-store snapshots while
   concrete source wiring, core result typing, and live RuntimeView publication
   remain with the canonical Svelte adapter until a complete React consumer
   exists.
3. Wire PWA/native consumers to the assembled candidate after the React
   `/app` boot flow exists; wallet static/PWA input ownership is ready and does
   not require production activation.
4. Attach scenario media only when scenario-specific browser-safe artifacts are
   checked in. The generated catalog currently records an empty media inventory
   and never publishes the 46 TypeScript scenario files.
