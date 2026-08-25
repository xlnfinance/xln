# React frontend migration work plan

**Status:** `IN PROGRESS — TOOLING, ASSEMBLY, SITE, AND DOCS IMPLEMENTED`

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

**Status:** `IN PROGRESS — DOCS, WALLET, AND OPS CATALOG INPUTS ASSEMBLED`

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

**Status:** `READY WHEN FIRST CONSUMER NEEDS IT`

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

### WP6 — Migrate wallet by flow

**Status:** `READY AFTER WALLET ROOT AND REQUIRED BOUNDARIES`

Migrate coherent flows in roughly this order:

1. boot, shell, identity, onboarding, recovery, settings, diagnostics;
2. assets, accounts, credit, collateral, debt, solvency, disputes, history;
3. payments, receive, invoices, moves, lending, settlement, reconnect, failures;
4. quotes, routing, orders, orderbook, cancel/fill, cross-j, and activity.

Preserve canonical Runtime projections and persisted state. A flow is complete
when success and important failure states pass focused tests; incomplete later
flows do not block earlier wallet slices.

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

**Status:** `READY AFTER RELEVANT APP ARTIFACTS`

- Point PWA/native/deployment consumers at the assembled candidate artifact.
- Preserve service-worker scope, storage origin, CSP, deep links, and packaging.
- Exercise corrupt, missing, duplicate, and mixed-artifact rejection.
- Prove atomic activation and immediate whole-release rollback in an isolated
  environment while Svelte remains canonical in production.

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
2. Begin WP5/WP6 together with the wallet boot, shell, identity, onboarding,
   recovery, settings, and diagnostics boundary; keep Runtime projections in
   shared client adapters and do not move transition logic into the frontend.
3. Capture the remaining wallet-owned static/PWA inputs before the first wallet
   flow migrates.
4. Attach scenario media only when scenario-specific browser-safe artifacts are
   checked in. The generated catalog currently records an empty media inventory
   and never publishes the 46 TypeScript scenario files.
