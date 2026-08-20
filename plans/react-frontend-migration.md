# Program charter: split the frontend into reviewed React applications

> **Charter instructions:** This document is not an executable implementation
> plan. Do not change frontend, tooling, native, deployment, or Runtime code from
> this charter alone. It defines the controls that every later child plan must
> satisfy. React implementation remains blocked until the program-approval
> validator derives `APPROVED` from an append-only Gate B manifest whose subject
> blobs equal the current charter and D1–D8 decision bytes, the canonical
> baseline is green, and a self-contained numbered child plan exists for the
> proposed increment. If a STOP condition occurs, report the
> exact evidence and do not widen scope, weaken a guard, add a workaround, or
> silently remove behavior.
>
> **Planned repository state:** commit `3f50d93ba9`, 2026-08-20.
>
> **Drift check (run first):**
> `git diff --stat 3f50d93ba9..HEAD -- .gitignore AGENTS.md package.json bun.lock .github plans docs/fints.md docs/e2e-debug-protocol.md docs/platform-distribution-plan.md docs/mainnet-acceptance-gate.md frontend tests native scripts/build-runtime.sh scripts/deployment scripts/native core/api core/account core/config core/network core/protocol core/runtime core/storage core/types core/scripts/e2e core/scripts/release`
>
> If any listed path changed, stop and update the charter or the relevant child
> plan against live code. Each child plan must also compute the transitive import
> closure of its frontend files and include every imported `core/**` contract in
> its own drift set. A mismatch is a review checkpoint, not permission to guess.

## Status

- **Priority:** P1
- **Effort:** Large program; re-estimate after the site pilot
- **Risk:** HIGH for wallet, ops, persistence, PWA/native, and cutover work
- **Depends on:** valid Gate B approval manifest for the frozen charter/decision
  subject; green canonical `bun run check`; all accepted Work Package 0 child
  plans complete
- **Category:** migration, architecture, DX, testing, release engineering
- **Current status:** `BLOCKED — GATE A/GATE B AND GREEN BASELINE MISSING`

No React implementation, candidate root, application-build change, or source
extraction may begin while this status is blocked. The sole permitted actions
are independently reviewed Work Package 0 governance/baseline child plans after
a Gate A manifest derives `OWNER_RECORDED`; they may capture evidence, implement
review/scope/evidence enforcement, and create external blockers, but they may
not introduce React, alter canonical build output, or change product behavior.

## Governing evidence and rules

Every child-plan executor must read these files before acting:

- `docs/postmortems/2026-08-07-react-frontend-cutover.md` — failure evidence,
  earliest divergence, and mandatory do-over checkpoints;
- `docs/fints.md` — the single normative TypeScript and boundary-safety standard;
- `docs/e2e-debug-protocol.md` — failure classification and L1/L2/L3 behavior;
- `docs/platform-distribution-plan.md` — artifact identity and platform contract;
- `docs/mainnet-acceptance-gate.md` — immutable release-candidate loop, evidence,
  soak, canary, and rollback requirements;
- `AGENTS.md` — scope, verification, visual evidence, frozen-core, and workflow rules.

The charter adds migration controls but does not replace or weaken these files.

### Postmortem control traceability

| Prior failure | Preventive control | Executable owner before implementation/cutover |
|---|---|---|
| Product parity inferred from routes and retained tests | Exhaustive baseline inventory plus owner disposition for every item | baseline capture and capability-coverage tests |
| Tests narrowed to match incomplete React behavior | Hash-frozen baseline corpus run unchanged against Svelte and React | parity runner and baseline-integrity test |
| Author marked broad plans complete | One self-contained child plan per bounded increment; external final-SHA review | review-contract CI job |
| Runtime/protocol work entered the frontend branch | Complete path allowlist over committed and working-tree changes | migration-scope checker |
| Raw evidence disappeared or came from another SHA | Always-uploaded evidence manifest and final immutable evidence bundle | frontend-migration CI workflow |
| Error screenshots counted as success | Typed visual-state expectation plus assertion and reviewer score | evidence-manifest validator |
| Candidate accumulated behind known red gates | Green canonical baseline before React work; no milestone exceptions | root `bun run check` dependency |
| Atomic deployment risk deferred until cutover | Current-Svelte route and activation foundation must pass before any React root | route-runtime and activation-rollback tests |
| Native/rollback proof predated destructive cutover | Native, visual, rollback, and release evidence bound to cutover SHA | final evidence matrix |

## Program-plan decomposition

This charter must never be handed to an implementation agent as its task. Work
Package 0 itself may require multiple governance-only child plans to respect the
size limits. After Work Package 0, create one numbered child plan for each row
in “Review sequence.” Each child plan must:

- declare one stable immutable scope label (never an ambiguous `A`/`B` reply)
  and repeat its prohibited domains in every continuation/handoff;
- stamp its exact planned-at SHA and run a drift check over its explicit scope
  plus transitive frontend-to-`core/**` imports;
- name every file/symbol in scope and every file/domain out of scope;
- select one surface or tooling concern and at most one or two complete flows;
- include exact L0/L1/L2/L3 commands, expected output, screenshot states, and
  machine-checkable done criteria;
- identify its owner-approved scope record, immutable review URL, and dependency
  on previously accepted child plans;
- stop when any step needs an unspecified file, behavior decision, test change,
  or out-of-scope domain.

The charter's work packages are sequencing requirements for writing child plans,
not permission to implement their bullet lists directly.

## Owner-approved outcomes — gate authorization pending

The owner approved these outcomes through D1–D4 in
`plans/react-frontend-migration-decisions.md`. This records required scope; it
does not authorize implementation before the applicable gate validates:

1. Split the browser frontend into independently owned `site`, `docs`,
   `wallet`, and `ops` applications.
2. Rewrite every retained Svelte user interface in React 19, Vite 7, and strict
   TypeScript without changing routes, behavior, persisted data, or authority.
3. Make each application independently typecheckable, testable, buildable, and
   runnable so normal feedback is not blocked by unrelated repository gates.

The third outcome changes guard ownership and timing, not strictness. A local
surface command selects a smaller dependency graph; it never converts errors to
warnings or skips assertions that belong to that surface.

## Non-goals

- No Runtime, Runtime/Entity/Account transition, consensus, contract,
  financial-formula, market-maker, custody, transport, or protocol change.
- No product redesign, route rename, origin change, persistence migration,
  feature removal, or new product capability hidden inside the rewrite.
- No Next.js, server rendering, independent release trains, new state
  framework, compatibility selector, or simultaneous router migration.
- No mock financial success, fake Runtime, placeholder production panel, test
  skip, fallback implementation, swallowed error, or temporary workaround.
- No production activation without separate release authority after the final
  candidate has passed all release gates.

## Current state to verify before implementation

At the planned repository state:

- `frontend/src` contains 153 Svelte files and 79,232 Svelte LOC.
- `frontend/src` contains 210 TypeScript/TSX files and 39,292 LOC.
- `tests/frontend` contains 100 test files; `tests/e2e` plus `tests/sites`
  contain 44 Playwright specs.
- The Svelte source contains 519 unique static `data-testid` values. They are a
  deletion-warning inventory, not a requirement to preserve implementation
  names when behavior-level coverage replaces them.
- `frontend/package.json` owns one SvelteKit `dev`, `build`, and `check` path.
  Its check combines static generation, Svelte sync/typechecking, and a Vite
  build.
- Root `bun run check` also runs BrainVault, contract artifact, Runtime policy,
  frozen-core, frontend, and other repository checks. It is an integration
  gate, not an acceptable per-edit frontend loop.
- Historical evidence disagrees: the prepared-plan run reported Hardhat `HH19`
  after 26 BrainVault/Runtime tests, while the postmortem's later validation
  records contract-artifact failure `HH411`. Neither fingerprint is a current
  baseline. Work Package 0 must run `bun run check` once on the exact clean
  `MIGRATION_BASE_SHA`, retain its raw output, and assign any failure outside
  this migration; do not repair contract tooling in this task.
- `frontend/copy-static-files.js` combines contract artifacts, the BrainVault
  worker, scenarios, docs catalog, and `llms*` output. Generated inputs do not
  yet have surface-specific ownership.
- `frontend/vite.config.ts`, native packaging, deployment, and E2E tooling
  assume `frontend/build` and `frontend/static/runtime.js` are shared outputs.
- Browser state spans localStorage, IndexedDB, service workers, push wake,
  Capacitor, Runtime subscriptions, Dockview layout, Three.js render loops, and
  worker lifecycle. Framework replacement must preserve the existing owners.
- React and React DOM are already declared. The React Vite plugin and React
  TypeScript declarations are not declared and belong only in the foundation
  increment.

Before React code, Work Package 0 must turn these observations into executable
inventories. Live source wins if counts or paths have drifted. The red root gate
may be recorded and assigned during Work Package 0, but it must be green on the
accepted canonical SHA before any React implementation child plan begins.

## Owner-approved target ownership — gate authorization pending

This section records approved answers D2, D3, and D7. Work Package 0 must prove
the live inventory matches it before creating `frontend/config/surfaces.ts`.
Any difference requires a new charter/decision subject and owner review; an
executor must not replace or reinterpret the approved boundaries.

### Applications and routes

`frontend/config/surfaces.ts` becomes the single validated route-owner table:

| Application | Owned routes and outputs |
|---|---|
| `site` | `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, `/unicast`, `/market-cap` |
| `docs` | `/docs`, docs catalog/static content, `llms*` |
| `wallet` | `/app`, `/address`, `/address/**`, `/testnet` |
| `ops` | `/health`, `/qa`, `/qa/hlt`, `/runs`, `/scenarios`, `/ai`, `/ai/**`, `/embed` |
| edge/server | `/admin`, `/radapter`, `/resetdb`, `/api/**`, `/api/tower/**`, `/rpc`, `/rpc2`–`/rpc8`, `/relay`, `/runtime.js`, and existing proxy/static dispatch; never React pages |

Rules:

- Every browser route has exactly one application owner.
- Cross-application navigation uses same-origin links; applications do not
  import one another's entry points.
- `localhost:8080` remains the only public development entry point.
- Applications build independently but assemble into one versioned same-origin
  release. They do not acquire independent production versions.

### Exact route and asset contract required before roots

The approved surface table must add these fields for every route family:

- exact route matcher and owner;
- HTML entry and direct-load/deep-link fallback;
- fixed asset namespace and Vite `base` value;
- redirect status/target plus query and hash behavior;
- API/RPC/proxy exclusions that an application fallback must never shadow;
- development gateway port, HMR/WebSocket path, CSP, service worker, PWA, and
  native/deep-link consumer.

Mandatory contract tests must cover all table rows, including current `/admin`
308 behavior, `/radapter` query rejection and 307 behavior, `/resetdb`, dynamic
`/address/**` loads, `/ai/**`, `/api/tower/**`, `/rpc`, `/rpc2`–`/rpc8`,
`/relay`, `/runtime.js`, missing named assets, and unknown-path handling. No React
root may be created while an asset namespace, fallback, redirect, or proxy rule
is unresolved.

### Directory layout

Create under the existing `frontend` package and lockfile:

```text
frontend/
  apps/
    site/{index.html,src/,tsconfig.json,vite.config.ts}
    docs/{index.html,src/,tsconfig.json,vite.config.ts}
    wallet/{index.html,src/,tsconfig.json,vite.config.ts}
    ops/{index.html,src/,tsconfig.json,vite.config.ts}
  packages/
    browser/          # validated storage and browser lifecycle boundaries
    runtime-client/   # validated UI-facing Runtime/RPC projections and commands
    ui/               # tokens and React primitives with at least two consumers
  config/
    surfaces.ts       # route, output, input, and test ownership
    capabilities.ts   # user-flow acceptance ledger
    verification.ts   # affected-application graph and gate definitions
  scripts/
    check.ts          # scoped verification entry point
    prepare.ts        # surface-owned generated inputs
    build.ts          # one application or all applications
    dev-gateway.ts    # same-origin development routing and proxies
    assemble.ts       # validates and assembles release artifacts
    assets/           # one deterministic producer per asset family
  .artifacts/<application>/
  build/              # assembled canonical release only
```

Keep one `frontend/package.json` and one `frontend/bun.lock`. Independent
applications require separate roots, TypeScript projects, Vite configs, output
directories, and tests—not one dependency installation per application. The
four directories above are approved. Work Package 0 must stop if live evidence
cannot satisfy them; it must not replace the set without a new owner decision.

Vite 7 supports independent `root`, `base`, and `build.outDir` settings and
explicit HTML inputs. Each build writes only `.artifacts/<application>`.
`assemble.ts` alone may create `frontend/build`, after validating exact route
ownership, artifact identity, and collision-free asset prefixes.

### Shared-code rule

- Create a shared module only when at least two real migrated consumers exist.
- `packages/browser` owns validated storage access, listener lifecycle, worker
  lifecycle, service-worker integration, and immutable browser snapshots.
- `packages/runtime-client` owns UI-facing validation, subscriptions, queries,
  and commands. It contains no Runtime transition, consensus rule, financial
  formula, or alternate persistence writer.
- `packages/ui` owns design tokens and genuinely shared React primitives.
  Wallet-only financial components remain in `apps/wallet`.
- External mutable state exposes stable `subscribe` and `getSnapshot`
  functions; React consumes it with `useSyncExternalStore`.
- UI values representing credit, debt, balances, or capacity come from existing
  canonical Runtime projections and helpers such as `deriveDelta`; never
  recreate financial formulas in React.

## Capability and evidence contract

Work Package 0 first creates these immutable baseline inputs:

- `frontend/config/baseline-manifest.json` — reviewed base SHA plus content
  hashes for behavior tests, fixtures, route/redirect inventory, 519 static test
  IDs, registered panels/commands/controls, persistence keys and IndexedDB
  schemas, workers/service workers, PWA/native/deep-link entries, generated
  assets, localization keys, and release consumers;
- `frontend/scripts/capture-baseline.ts` — deterministic inventory producer that
  rejects an unclean source tree, missing owner, ambiguous registry, or dynamic
  item it cannot classify;
- `tests/frontend/tooling/frontend-baseline-integrity.test.ts` — proves the
  manifest matches the reviewed source and that every baseline item is assigned
  to exactly one capability or approved non-UI owner;
- `frontend/scripts/parity.ts` — runs the hash-frozen behavior corpus with the
  same fixtures and assertions against current Svelte and candidate React URLs.

The manifest is generated once from the approved `MIGRATION_BASE_SHA`. A change
to its hashes or inventory requires a new owner-reviewed baseline SHA; an
implementation PR must not regenerate it to make a failing parity check pass.

Then create `frontend/config/capabilities.ts`. Each entry must contain:

- stable capability ID;
- owning application and route;
- current source components/controllers;
- every owned baseline inventory ID, including panels, commands, controls,
  storage, workers, assets, locale keys, and native/PWA consumers;
- per-item disposition: `RETAIN_BEHAVIOR`, `REPLACE_IMPLEMENTATION`,
  `REMOVAL_REQUESTED`, `REMOVAL_APPROVED`, or `OUT_OF_SCOPE_WITH_OWNER`, with
  owner evidence for every value except the two preservation defaults;
- happy path, named failure states, loading/empty states, and persistence rules;
- hash-frozen existing unit/browser tests and fixtures;
- visual states, expected `happy|failure|loading|empty` classification, required
  assertions, and mobile/laptop/wide viewports;
- generated assets and browser/native consumers;
- candidate evidence status: `UNSTARTED`, `IMPLEMENTED`, `PROVEN`, `BLOCKED`,
  `REMOVAL_REQUESTED`, or `REMOVAL_APPROVED`;
- evidence command and immutable candidate SHA when proven;
- for `REMOVAL_APPROVED`, a current hash-bound GitHub decision record ID/URL,
  owner numeric `user.id`, reviewed SHA, and independent reviewer numeric
  `user.id`.

Validation tests and the CI review-contract job must fail when:

- any baseline route, redirect, test, fixture, test ID, registered panel,
  command, control, persistence entry, worker, service worker, native/PWA entry,
  generated asset, locale key, or release consumer has no exact owner;
- any baseline item has no explicit disposition or an out-of-scope/removal
  disposition lacks current hash-bound GitHub owner evidence;
- one route has multiple owners;
- a capability becomes `PROVEN` without an exact command and candidate SHA;
- a hash-frozen test/fixture changes or disappears in an implementation PR;
- a replacement test is used to retire baseline coverage before the unchanged
  baseline assertion has passed against React or the owner has explicitly
  approved a product change;
- `REMOVAL_APPROVED` lacks GitHub record/hash validation, comes from the
  implementation author, or refers to a SHA other than the final reviewed head;
- a happy screenshot lacks a success assertion, a failure screenshot is counted
  as happy evidence, or any required screenshot lacks an inspection score;
- an application is declared complete with an unproven owned capability.

Human authority remains in GitHub. Source stores only record IDs, numeric user
IDs, canonical payload hashes, and URLs needed for validation. The
`.github/workflows/frontend-migration.yml` review-contract job must resolve those
references through current GitHub metadata and
prove that every accepted increment had a human reviewer other than its author
and evidence from its final SHA.

### Immutable evidence contract

Every L1/L2/L3 CI run must produce
`frontend/.artifacts/evidence/<candidate-sha>/manifest.json` with:

- full commit SHA, base SHA, `git status --porcelain`, workflow/run/artifact IDs,
  exact commands, exit codes, duration, selected scope, and failure codes;
- baseline-manifest hash, test/fixture hashes, application artifact hashes,
  generated-input hashes, and assembled release identity;
- browser console/page/request/worker results and screenshot hashes with expected
  state, viewport, assertions, inspection score, and reviewer;
- native package/smoke results, rollback rehearsal identity, and links to raw logs.

The migration workflow uploads this manifest and its raw evidence on both
success and failure. It records the immutable artifact ID/URL in the pull
request check and keeps a committed summary containing hashes and URLs, never
secret-bearing raw logs. The final cutover publishes
`frontend-cutover-evidence-<cutover-sha>.tar.zst` plus its SHA-256 and build
attestation as an immutable GitHub Release asset owned by the repository's
release manifest. Ignored local `.logs/**` paths and expiring-only evidence are
insufficient for completion.

## Scoped verification architecture

### Levels

| Level | Use | May run | Must not run |
|---|---|---|---|
| L0 `local` | every edit | one TypeScript project, pure/unit tests, affected shared-package tests, changed-file policy | Vite build, generated assets, unrelated applications, Runtime/contract/native/broad E2E |
| L1 `slice` | one user-flow increment | L0, one app preparation/build, exact browser specs, screenshot and strict browser-health checks | unrelated applications, broad E2E, root `bun run check` |
| L2 `frontend` | shared boundary or application milestone | affected applications, route/import/storage/asset contracts, assembled frontend smoke | contract, consensus, market-maker, full release suites |
| L3 `repository/release` | process/tooling integration, app milestones, routing/native/deploy, cutover, release | existing `bun run check`, `bun run gate:ci`, and `bun run gate:release` as named below | no bypasses |

L0 and L1 must not transitively invoke L3. L3 failures remain failures.

### Commands to create

Run from repository root:

| Purpose | Command | Expected success |
|---|---|---|
| Capture reviewed baseline | `bun frontend/scripts/capture-baseline.ts --base-sha=<BASE_SHA>` | writes one deterministic manifest; rejects dirty or unclassified input |
| Verify baseline integrity | `bun test tests/frontend/tooling/frontend-baseline-integrity.test.ts` | every baseline item has exactly one owner; stored hashes match |
| Run frozen parity | `bun frontend/scripts/parity.ts --surface=wallet --current-url=<SVELTE_URL> --candidate-url=<REACT_URL>` | unchanged baseline tests/fixtures pass against both URLs |
| Explain selection | `bun frontend/scripts/check.ts --surface=wallet --level=local --explain` | prints selected steps and why; contains no broad gate |
| Local application | `bun frontend/scripts/check.ts --surface=site --level=local` | `FRONTEND_CHECK_OK surface=site level=local` |
| Exact user flow | `bun frontend/scripts/check.ts --surface=wallet --level=slice --spec=<exact-spec>` | only wallet preparation/build and named spec run |
| Changed scope | `bun frontend/scripts/check.ts --changed-from=<BASE_SHA> --level=local` | prints deterministic affected applications |
| Application milestone | `bun frontend/scripts/check.ts --surface=docs --level=frontend` | docs plus required cross-application contracts pass |
| Frontend integration | `bun frontend/scripts/check.ts --all --level=frontend` | every application in the approved surface manifest and all assembly contracts pass |
| Build one app | `bun frontend/scripts/build.ts --surface=ops` | only `.artifacts/ops` changes |
| Assemble | `bun frontend/scripts/assemble.ts` | one matching manifest per approved application; no missing/duplicate routes |
| Validate Gate A approval | `bun frontend/scripts/validate-program-approval.ts --gate=A --subject-commit="$SUBJECT_COMMIT"` | prints only `OWNER_RECORDED`; any subject/review/identity/history mismatch fails |
| Validate Gate B approval | `bun frontend/scripts/validate-program-approval.ts --gate=B --subject-commit="$SUBJECT_COMMIT"` | prints only `APPROVED`; any subject/foundation/evidence/review/identity/history mismatch fails |
| Check plan drift | `bun frontend/scripts/check-plan-drift.ts --plan=<CHILD_PLAN> --planned-at=<SHA>` | explicit scope and transitive import closure are unchanged |
| Check complete scope | `bun frontend/scripts/check-migration-scope.ts --base-sha=<BASE_SHA> --scope-manifest=<APPROVED_SCOPE_JSON> --require-clean` | `MIGRATION_SCOPE_OK`; no committed, staged, unstaged, or untracked path is outside the approved allowlist |
| Validate evidence | `bun frontend/scripts/validate-evidence.ts --manifest=<EVIDENCE_MANIFEST> --candidate-sha=<SHA>` | `FRONTEND_EVIDENCE_OK`; all hashes, classifications, review references, and raw-artifact links match |
| Exercise atomic activation | `bun frontend/scripts/activation-smoke.ts --candidate-manifest=<CURRENT_MANIFEST> --previous-manifest=<PREVIOUS_MANIFEST> --failure-matrix` | missing/corrupt/duplicate/mixed content is rejected; activation, rollback, and reactivation preserve one complete identity |
| Repository gate | `bun run check` | exit 0 on an unchanged milestone SHA |

`<BASE_SHA>` is mandatory and immutable. Reject missing/invalid arguments.
Every command prints selected inputs, steps, duration, and stable failure code.

### Scope and drift enforcement

Each child plan owns a reviewed JSON scope manifest under `plans/scopes/`. It
contains the child-plan ID, planned-at SHA, exact allowed paths, forbidden path
families, owner review reference, and reviewed head. Changing this manifest in
an implementation PR invalidates scope approval and blocks the PR until the
owner reviews the new final head.

`check-migration-scope.ts` must inspect all of these sets, not a filtered display:

1. committed paths from `<BASE_SHA>..HEAD`;
2. staged paths;
3. unstaged paths;
4. untracked, non-ignored paths;
5. submodule/worktree state when present.

It exits nonzero with `MIGRATION_SCOPE_VIOLATION` and the full offending path
list when any path is outside the approved allowlist. The cutover allowlist may
include only the charter's named frontend-coupled `core/scripts/**` guards; it
must reject every other `core/**`, all `jurisdictions/**`, `frozen-core.json`,
`.gitignore`, editor configuration, and unrelated cleanup.

`check-plan-drift.ts` must compare the child plan's planned-at SHA with live
source across its explicit scope, route/capability manifests, generated inputs,
native/deployment consumers, governing documents, and the transitive import
closure of affected frontend modules. A changed imported `core/**` contract is
a drift failure even when `core/**` is out of implementation scope.

### Affected-application graph

Encode and test these minimum rules in `frontend/config/verification.ts`:

| Changed path | Selected scope |
|---|---|
| `frontend/apps/<application>/**` | that application |
| `frontend/packages/ui/**` or `frontend/packages/browser/**` | every declared importing application |
| `frontend/packages/runtime-client/**` | wallet and ops |
| route table, assembly, development gateway, shared frontend config | every approved application |
| application-owned tests or assets | owning application |
| unknown `frontend/**` path | every approved application, fail-safe |
| `core/**`, `jurisdictions/**`, native, deployment, release tooling | never silently classified as frontend-only; explicit L3 ownership required |

Add `tests/frontend/tooling/frontend-check-scope.test.ts` to prove L0/L1 command
containment without launching external processes. It must reject `bun run
check`, contract sync, frozen-core, native packaging, broad Playwright, and
Runtime scenario commands inside local/slice plans.

### Generated-input ownership

Replace the all-purpose copy step incrementally with deterministic producers:

| Input family | Owner |
|---|---|
| docs catalog, docs-static, `llms*` | docs producer |
| public release/install/static content | site producer |
| Runtime browser bundle, BrainVault worker, contract browser artifacts | wallet; ops only when its capability map proves consumption |
| scenario catalog/media | ops producer |
| manifest, route map, asset hashes | assembly producer |

`prepare.ts --surface=<application>` invokes only declared producers. Missing
inputs fail with their exact producer command. Producers must be deterministic,
must never edit Runtime or contract source, and must not write another
application's artifact directory.

## Repository rules that apply to every increment

- Use Bun for repository and frontend commands. Do not introduce npm, pnpm, or
  Node-only orchestration when Bun can run the same project command.
- Keep frontend modules functional and declarative: pure transformations,
  immutable state, functions under 30 lines where practical, and handwritten
  files under 300 lines. Split by behavior before crossing the repository's
  file-size guard.
- The frontend is UI only. Runtime owns protocol, state transitions, financial
  formulas, and committed effects; React consumes validated projections and
  sends existing commands.
- Validate at boundaries, fail fast, and display errors. Do not use optional
  chaining to hide data that a validated UI state requires.
- Every visual increment requires strict browser-console/page/request checks
  and inspected screenshots at mobile, laptop, and wide-desktop viewports.
- Never restart, reset, hot-reload, or mutate the user's live durable Runtime.
  Browser tests use the repository's isolated E2E runner and isolated state.
- Preserve `localhost:8080` as the only public development entry point.
- Put documentation under `docs/**` or `plans/**`, never under `frontend/**`;
  new Markdown filenames are lowercase.

## Scope

### In scope

- `frontend/**` for application roots, UI/client packages, configuration,
  scoped checks, asset producers, build/assembly, and eventual Svelte removal.
- `tests/frontend/**`, `tests/e2e/**`, and `tests/sites/**` for ownership,
  behavior preservation, browser evidence, and tooling contracts.
- Root `package.json` and `.github/workflows/**` only for explicit frontend
  command entry points and independent frontend jobs.
- `AGENTS.md` and a frontend migration pull-request template only to codify the
  owner-approved iterative review and scoped-gate rules before React work.
- These frontend-coupled repository tooling files only, with preserving tests:
  - `core/scripts/checks/policy/check-frontend-file-size.ts`;
  - `core/scripts/checks/repository/check-unused-surface.ts`;
  - `core/scripts/release/run-release-gate.ts`.
- `scripts/deployment/**`, `scripts/native/**`, and `native/**` only during the
  reviewed integration work that changes artifact consumption.
- `docs/frontend/**` for generated execution evidence.

### Out of scope

- Every other `core/**` file; all `jurisdictions/**`; `frozen-core.json`;
  Runtime schemas/transitions; finance and consensus logic; contract artifacts;
  market-maker behavior; and unrelated security work.
- Route or feature removal, UX redesign, new product capability, origin/storage
  migration, server rendering, a new router/state framework, or independent
  production deployment.
- Unreviewed code import or a bulk framework conversion without capability-
  level evidence.

## Iterative pull-request and human-review protocol

This section applies only if D6 in the owner decision contract explicitly
approves a pull-request exception to the repository's direct-main workflow. The
immutable D6 decision must name the branch/review convention. Without it, stop;
the charter is not authority to edit `AGENTS.md`, create a branch, or open a PR.
The first approved change may contain only process, baseline, and evidence files
and must be accepted before React code.

For every increment:

1. Start from the latest accepted canonical state and record its base SHA.
2. Create one short-lived work branch using the repository-approved convention.
3. Add or update the scope/capability contract before substantial code.
4. Validate the child-plan scope manifest, then open a draft pull request before
   exceeding 200 changed handwritten LOC.
5. Wait for an explicit human `scope approved` decision.
6. Implement only the approved surface and one or two user flows.
7. Keep commands, screenshots, browser-health output, and diff metrics current.
8. Mark ready only after the applicable L0/L1/L2 evidence is green.
9. Upload and validate the final-head evidence manifest on both success and
   failure; a local ignored path is not evidence.
10. Resolve every blocking review comment through code/evidence or a recorded
   human decision.
11. Merge only after final human approval and the applicable gate. The agent
    never self-approves, self-merges, or enables auto-merge. Use only a
    fast-forward or merge commit that preserves the reviewed final-head commit
    as an ancestor; squash/rebase merge invalidates its SHA-bound evidence.
12. Delete the work branch after merge. Begin dependent work from the newly
    accepted state; do not copy an unreviewed diff forward.

Stacked pull requests require explicit human authorization. After a parent
merges, rebase each child and regenerate all evidence against its new SHA.

### Size limits

Each normal increment targets:

- one application or one tooling/shared concern;
- one or two complete user flows;
- no more than ten production components;
- no more than 20 changed files and 1,500 handwritten changed LOC;
- no unrelated cleanup, dependency upgrade, Runtime fix, or redesign.

Generated artifacts and lockfile churn are reported separately. They do not
permit more behavior. Split before more implementation when either limit is
exceeded.

### Required pull-request fields

- surface, capability IDs, routes/user flows, and base SHA;
- explicit in-scope and out-of-scope lists;
- production reachability and changed file/handwritten LOC counts;
- planned and actual L0/L1/L2/L3 commands;
- strict console/page/request result and required screenshots;
- persistence, route, asset, PWA/native, and test-deletion impact;
- reviewer decisions for scope, behavior, evidence, and merge readiness.

Add a tooling test that fails when required fields are absent. Human approval
must come from someone other than the author and must apply to the final head.
The frontend-migration workflow must validate the reviewer, review state,
reviewed SHA, owner-decision references, scope manifest, and evidence artifact;
presence of filled Markdown fields alone never satisfies the gate.

### Merge-gate matrix

| Change class | Required before merge |
|---|---|
| Baseline/process contract only | current frontend baseline, review-contract tests, and one root-check run; Work Package 0 may record a stable unrelated failure only when it creates a separate owned blocker and changes no implementation code |
| Verification, build, or asset tooling while production-unreachable | tooling tests, affected L0, frontend L2, and green `bun run check` on the final head |
| Candidate-only application slice proven unreachable from canonical production | owning L0, exact L1, screenshots/browser health, owning L2 |
| Shared package used by canonical Svelte or multiple React apps | affected L0/L1, frontend L2, `bun run check` |
| Application-completion milestone | all owned capabilities proven, application L2, all-frontend L2, `bun run check` |
| Routing, PWA, native, deployment, or canonical artifact path | affected L1, frontend L2, `bun run check`, applicable integrity gate |
| Final Svelte removal and cutover | all-frontend L2, `bun run check`, `bun run gate:ci`, `bun run gate:release` on one SHA |

Candidate-only deferred L3 is allowed only when automated tests prove canonical
dev/build/package/deploy cannot select the candidate. Any canonical source,
root command, routing, shared persistence, native, deployment, or guard change
uses the stricter class. The reviewer confirms classification.

If the full repository gate is already red for an unrelated reason, Work
Package 0 records one stable failure fingerprint and creates a separately owned
repair task. Do not fix it inside this migration and do not rerun it without a
relevant change. No verification/build tooling, React root, feature slice,
application milestone, canonical-path change, cutover, or release child plan may
start until the repair is accepted and `bun run check` is green on the canonical
SHA. This prevents candidate work from accumulating behind a known release
blocker.

## Review sequence

Each row is a mandatory human review boundary. Split a row when size limits
require it; never combine adjacent rows merely for speed. Rows after scoped
verification are proposed until D2 and D5 are approved; Work Package 0 must
replace, remove, or add rows to match those decisions and obtain a new charter
review before React work.

| Increment | Outcome and checkpoint |
|---|---|
| Process and baseline | Approve app boundaries, review rules, current route/test/storage/native inventory, and baseline failure fingerprints. No React code. |
| Ownership contracts | Approve route, capability, test, asset, and affected-application tables with validation tests. |
| Scoped verification | Demonstrate L0/L1 containment and stable failure output before feature work. |
| Current-Svelte route and activation foundation | Prove the approved route/asset table, versioned staging, manifest validation, atomic activation, and immediate rollback against the canonical Svelte artifact before any React root exists. |
| React roots | Every owner-approved minimal React/Vite/TypeScript root builds independently while remaining release-blocked and leaving canonical output unchanged. |
| Asset and build isolation | Deterministic producers, independent artifacts, and assembly contracts pass. |
| Site pilot | Migrate `/` and `/install`; review architecture, timing, behavior, and three viewports. Re-estimate before continuing. |
| Site completion | Migrate remaining site routes and prove site capability closure. |
| Docs completion | Migrate validated catalog consumer and reader; prove sanitization, navigation, URLs, and deterministic output. |
| Browser boundary | Extract validated storage/lifecycle ownership while Svelte remains canonical; prove cleanup and persistence. |
| Runtime-client boundary | Extract validated subscriptions, queries, and commands; prove no Runtime implementation or finance logic moved. |
| Wallet foundation | Boot, shell, identity, onboarding, recovery, settings, diagnostics, and persistence in small flow-level reviews. |
| Wallet finance | Assets, accounts, credit, collateral, debt, solvency, disputes, and history with canonical projections. |
| Wallet operations | Payments, receive, invoices, moves, lending, settlement, reload, reconnect, and failure states. |
| Wallet markets | Quotes, routing, limit/market orders, orderbook, open/cancel/fill, cross-J, and activity. |
| Ops core | Health, QA/HLT, evidence, runs, scenarios, AI, embed, and authority/error states. |
| Ops workspace | Dockview, Graph3D, Architect, Jurisdiction, Runtime I/O, console, solvency, Time Machine, worker/render teardown. |
| Integration | Same-origin gateway, artifact assembly, rollback, CSP, PWA, deep links, and native consumers in separate reviews. |
| Capability closure | Every capability proven or explicitly removed; every contributing review and final-SHA evidence verified. No source deletion. |
| Canonical cutover | Switch canonical commands and delete Svelte in one dedicated destructive change; run all L3 gates. |
| Production activation | Separate authorized operation using immutable prebuilt artifacts and immediate rollback. |

## Work packages

### Work Package 0 — Establish the baseline and review contract

1. Reconcile every owner answer into this charter, freeze the byte-exact charter
   and D1–D8 decision files at `SUBJECT_COMMIT`, obtain external Gate A owner and
   independent reviews naming that commit, and add the append-only Gate A
   manifest exactly as specified by the decision contract. Until the validator
   exists, a reviewer must manually confirm its Git blobs and review records;
   this authorizes only the Work Package 0 child plan.
2. Record `MIGRATION_BASE_SHA`, package versions, route files, redirects,
   generated inputs, test IDs, registered panels/commands/controls, locale keys,
   persisted keys and IndexedDB schemas, workers/service workers, native/PWA
   consumers, release assets, and existing frontend tests/fixtures.
3. Implement the deterministic baseline capture and integrity test. Human-review
   every item the producer cannot derive mechanically; unclassified items block.
4. Hash-freeze the existing behavior tests and fixtures and prove the parity
   runner executes the unchanged corpus against two supplied URLs.
5. Run the current frontend check after documented input preparation. Record
   command, duration, exit code, produced files, and stable failure fingerprint.
6. Run one representative browser flow for each approved application with
   strict browser health and mobile/laptop/wide screenshots classified as happy,
   failure, loading, or empty and backed by state assertions.
7. Run `bun run check` once. Classify every failure by owner; do not modify an
   unrelated owner in this migration.
8. Implement and adversarially test `validate-program-approval.ts`,
   `check-plan-drift.ts`, `check-migration-scope.ts`, `validate-evidence.ts`, and
   the reviewed scope manifest format without changing canonical frontend
   behavior/build output. Its first accepted run must retrospectively derive
   `OWNER_RECORDED` from the exact Gate A manifest that authorized this package.
9. Add `.github/workflows/frontend-migration.yml` to validate GitHub numeric
   owner/reviewer IDs and current record hashes and upload evidence on success
   and failure.
10. If the root gate is red, create a separate blocking repair task with its
   exact fingerprint. The migration remains blocked until that task lands and a
   new canonical SHA passes `bun run check`.
11. Create the process/evidence review: apply the owner-approved workflow only,
   add required fields, baseline manifest, scope manifest, evidence contract,
   always-upload workflow, and the human-readable capability inventory.
12. Obtain independent human approval for the baseline, route/asset contract,
   exhaustive capability ownership, frozen parity corpus, scope enforcement,
   verification ladder, and review cadence.
13. Freeze the accepted Work Package 0 result as `FOUNDATION_COMMIT`, publish its
   immutable evidence manifest, obtain external Gate B owner and independent
   reviews naming both subject and foundation commits, then add the append-only
   Gate B manifest in a governance-only activation commit. The validator must
   derive `APPROVED` before any later child plan starts.

**Verify:** `bun frontend/scripts/capture-baseline.ts --base-sha="$MIGRATION_BASE_SHA"`
produces the reviewed hash; `bun test
tests/frontend/tooling/frontend-baseline-integrity.test.ts
tests/frontend/tooling/frontend-migration-scope.test.ts
tests/frontend/tooling/frontend-plan-drift.test.ts
tests/frontend/tooling/frontend-program-approval.test.ts
tests/frontend/tooling/frontend-review-contract.test.ts
tests/frontend/tooling/frontend-evidence-manifest.test.ts` passes; the parity
runner proves the unchanged corpus can target both URLs; every inventory item
has exactly one owner; adversarial fixtures prove self-referential/mutated
approval manifests, edited/deleted owner comments, ordinary comments posing as
reviews, wrong repository/pull/record/user ID, owner-author-reviewer collisions,
wrong review state or commit binding, wrong subject/blob/timestamp/foundation,
unbound release/rollback operator IDs, scope, drift, and evidence records fail;
Gate A derives `OWNER_RECORDED` and Gate B derives `APPROVED`; `git diff --check`
exits 0. Record the root-check result, but do not unblock React work unless
`bun run check` exits 0 on the accepted canonical SHA.

**STOP:** an owner answer/review reference is missing, an approval manifest was
edited instead of added under a new subject, subject blobs differ from current
bytes, the validator cannot prove the external record and identity separation,
an inventory item is unclassified, a baseline hash changes during
implementation, an owner is
ambiguous, a representative flow is unexplained/red, an input has no
deterministic producer, the split is disputed, the root gate remains red when
React work is proposed, or no independent reviewer is available.

### Work Package 1 — Implement ownership and scoped verification

1. Add `surfaces.ts`, `capabilities.ts`, and `verification.ts` with pure
   validation tests.
2. Implement `check.ts --surface --level --spec --changed-from --explain`.
3. Extend unsafe-type and frontend file-size checks to explicit React roots
   without deleting current Svelte coverage.
4. Add command-containment, affected-application, argument-validation, and
   stable-output tests.
5. Prove five warm L0 runs per application and record p50/p95, selected steps,
   cache hits, and cross-application invocations (expected zero).

**Verify:** exhaustive baseline ownership and immutable approval validation pass;
the scope checker rejects committed, staged, unstaged, and untracked violations;
the drift checker catches a changed imported `core/**` contract; evidence
validation rejects wrong-SHA, missing, expired-only, or misclassified evidence;
L0 runs no build/generation/L3 command; L1 runs only one application build and
exact specs; unknown frontend paths select all frontend applications but never
the full repository.

**STOP:** local checks need Runtime/contract/native work, selection depends on
mutable timestamps, or any existing guard is removed/weakened.

### Work Package 2 — Prove current-Svelte routing and atomic activation

Use separate reviewed child plans for the route contract and deployment change
if their combined diff would cross any size limit. No React dependency, root,
artifact, or product-behavior change is allowed in this package.

1. Materialize the owner-approved route/asset/redirect/development-gateway
   contract for the current Svelte frontend and existing edge/server owners.
2. Add runtime contract tests for every route row, including direct loads,
   unknown paths, fixed asset namespaces, API/RPC/proxy exclusions, `/admin`,
   `/radapter`, HMR/WebSocket, CSP, service worker, and native/deep-link rules.
3. Replace the current in-place frontend deployment path with versioned staging,
   exact manifest/hash validation, one atomic activation pointer, and immediate
   whole-release rollback. Preserve one canonical production path.
4. Implement `frontend/scripts/activation-smoke.ts` against a previous and a
   candidate current-Svelte manifest. Inject missing, corrupt, duplicate, and
   mixed-identity content; prove rejection before activation, rollback, and
   reactivation without compiling.
5. Exercise approved same-origin routes, persistence/storage ownership, browser
   health, service-worker behavior, and rollback against the current Svelte
   artifact at all required viewports.
6. Publish and independently review immutable same-SHA evidence before any
   React-root child plan may be written.

**Verify:** route-runtime and activation-rollback tooling tests pass; current
Svelte behavior and artifact bytes remain unchanged except for the reviewed
release manifest/activation envelope; `bun run check` and the applicable
`bun run gate:release` pass on the unchanged candidate SHA; failure injection
never makes partial or mixed content reachable; rollback restores the previous
complete release and its routes immediately.

**STOP:** any route row is unresolved, the current frontend cannot stage and
roll back atomically, a deployment step compiles on production, storage/origin
changes, mixed identities can be served, or the work needs React, Runtime,
protocol, or product changes.

### Work Package 3 — Create release-blocked React roots and isolated builds

Do not write or execute a React-root child plan until Work Package 2 has been
independently accepted on a green canonical SHA.

1. Add only the compatible React Vite plugin and React type declarations.
2. Create every owner-approved minimal root with an independent TypeScript and
   Vite config.
3. Add a test proving canonical dev/build/package/deploy cannot select any
   candidate root or artifact.
4. Extract deterministic asset producers one owner family at a time, preserving
   current output bytes or recording an explicitly reviewed format change.
5. Implement one-app preparation/build and artifact manifests.
6. Implement assembly validation without changing the canonical build path.

**Verify:** every app builds independently; another app's artifact mtime/hash
does not change; two producer runs hash equally; canonical Svelte output and
entry points are unchanged.

**STOP:** output paths overlap, production can select candidate code, generated
output is nondeterministic, or a producer requires source changes outside scope.

### Work Package 4 — Use site as the architecture pilot

1. Migrate `/` and `/install` as the first complete slice.
2. Run the same behavior assertions against current and candidate servers,
   including interactions, accessibility, route metadata, and baseline test-ID
   coverage.
3. Inspect 393×852, 1280×800, and 1600×1000 screenshots plus console, page,
   request, and accessibility health.
4. Measure L0/L1 time, bundle imports, component size, and cleanup behavior.
5. Stop for architecture review and re-estimate the program.
6. Only after approval, migrate `/rcpan`, `/unicast`, `/releases`, `/reviews`,
   and `/market-cap` in one- or two-route increments.

**Verify:** all site capabilities are `PROVEN`; site imports no wallet, ops,
Runtime implementation, native, or private docs code; other artifacts remain
unchanged.

**STOP:** the pilot requires conditional test expectations, imports another
app, loses live `/market-cap` behavior, exceeds the approved time budget, or
reveals that the target architecture should change.

### Work Package 5 — Migrate docs

1. Define and validate the catalog consumer schema separately from UI.
2. Migrate reader, navigation, anchors, nested images, archives, loading/error
   behavior, broken-document handling, and sanitization.
3. Keep catalog/static/`llms*` generation deterministic and docs-owned.
4. Prove site checks do not regenerate docs output.

**Verify:** docs L0/L1/L2 pass; two catalog builds hash identically; existing
URLs work; traversal, malformed input, and unsafe content fail visibly; docs
imports no Runtime, wallet, native, or ops code.

**STOP:** sanitization weakens, generation uses wall-clock/random state, or a
current URL disappears without explicit approval.

### Work Package 6 — Establish browser and Runtime-client boundaries

1. Inventory Svelte store/controller subscriptions, RPC commands, validation,
   storage writers, workers, and teardown.
2. Move only framework-neutral behavior already used by a live consumer into
   `packages/browser` and `packages/runtime-client`.
3. Update Svelte to consume each extracted canonical module before React uses
   it; never create parallel writers or command implementations.
4. Expose validated immutable snapshots and deterministic disposal.
5. Add subscription, authority, validation, reconnect, storage, start/dispose,
   and error-propagation tests.

**Verify:** packages import neither React nor Svelte nor Runtime implementation
internals; affected Svelte flows remain green; wallet and ops L0/L2 pass.

**STOP:** extraction changes Runtime behavior, moves a financial formula,
creates a second writer, weakens validation, or cannot dispose deterministically.

### Work Package 7 — Migrate wallet by complete user flow

Migrate in this order, with human review after every one or two flows:

1. wallet pilot: boot/error boundary, shell, navigation, lifecycle, and exactly
   one real BrainVault create/reload/unlock flow; show the old/new state machine
   and raw evidence while every other wallet capability remains `UNSTARTED` or
   `BLOCKED` in the ledger;
2. remaining BrainVault/mnemonic create/import/unlock/lock/reload and Runtime
   selection flows;
3. onboarding, formation, recovery, towers, and push wake;
4. settings, diagnostics, Time Machine, themes, and persisted preferences;
5. assets and external/reserve/account projections;
6. accounts, ownership, configuration, allowances, credit, collateral, debt,
   solvency, disputes, and account history;
7. payments, receive, invoices/QR, moves, lending, settlement, reload,
   reconnect, activity, and named failures;
8. quotes, routes, limit/market orders, orderbook, open/cancel/fill, cross-J,
   completion/failure, and market activity/history.

For every slice, select capability IDs first, implement complete success and
failure behavior, run exact unit/browser tests, inspect three viewports, and
prove financial success from committed Runtime/receipt state rather than UI
text or visibility.

**Verify:** wallet L0/L1 passes per slice; group milestones run wallet L2; all
wallet capabilities are `PROVEN`; secrets are absent from evidence; current and
candidate behavior tests use the same assertions.

**STOP:** any test is weakened/skipped, a fake success or alternate formula is
proposed, Runtime authority is unclear, a secret enters evidence, or a slice
exceeds the size limit.

### Work Package 8 — Migrate ops by complete operator flow

Migrate and review separately:

1. `/health`, Runtime/bootstrap/adapter status, authority and error states;
2. `/qa`, `/qa/hlt`, evidence, trends, protected media, and run ledger;
3. `/runs`, `/scenarios`, playback, `/ai`, chat/media/error behavior;
4. `/embed` and postMessage origin/shape validation;
5. Dockview layout/persistence/disposal;
6. Graph3D render, selection, settings, performance, hidden-state behavior, and
   teardown;
7. Architect, Jurisdiction, Runtime I/O, console, solvency, Time Machine,
   workers, canvases, and remaining operator controls.

**Verify:** ops L0/L1 passes per slice; milestones run ops L2; real data backs
operator views; hidden panels have zero render loop; disposal restores listener,
worker, canvas, and React-root counts; all ops capabilities are `PROVEN`.

**STOP:** a control becomes a static/raw-JSON placeholder, public users gain an
operator capability, mock data substitutes real data, endpoint authority is
unclear, or performance changes without before/after metrics.

### Work Package 9 — Integrate routing, assembly, PWA, and native consumers

Review gateway, assembly/rollback, PWA/CSP, and native packaging separately:

1. Implement the same-origin development gateway at `localhost:8080` while
   preserving API/RPC/relay ownership and behavior.
2. Assemble exact app artifacts into one release identity and reject missing,
   corrupt, duplicate, or mixed-identity content.
3. Preserve storage origin, manifest scope, service workers, start URL, deep
   links, CSP, push wake, route mode, and offline behavior.
4. Make mobile, desktop, and extension packaging consume the explicit wallet
   artifact plus approved shared assets.
5. Extend the Work Package 2 `activation-smoke.ts` contract to the approved
   multi-application assembly and every platform consumer without weakening its
   missing/corrupt/duplicate/mixed-identity rejection cases.
6. Exercise activation, failure injection, rollback, and reactivation locally
   and in the platform CI matrix, retaining evidence manifests for every case.

**Verify:** all frontend L2 checks pass; every route and proxy works from the
assembled preview; all packages report one SHA/version; rollback restores the
last complete artifact; approved redirect/query/deep-link/HMR/proxy semantics
pass; PWA/native/security tests pass; the activation smoke rejects missing,
corrupt, duplicate, and mixed-identity content.

**STOP:** origin or storage ownership changes, React implements an edge
endpoint, native needs a fallback build, or mixed artifacts can be served.

### Work Package 10 — Close capabilities and cut over atomically

Use two separate human approvals:

1. **Capability closure:** prove every capability or record an explicit removal
   decision; audit deleted/renamed tests and unexplained test-ID changes; verify
   every accepted increment's final-SHA tests and human approval. Delete no
   source in this step.
2. Freeze one candidate SHA and run all-frontend L2. Obtain explicit
   authorization for destructive cutover.
   The cutover child plan overrides ordinary draft-PR timing: obtain scope and
   pre-deletion approval before editing, then do not open the cutover PR until
   every command below is green on the clean, unchanged cutover SHA.
3. **Canonical cutover:** switch canonical dev/build/check/package/deploy paths
   to the owner-approved application system in one change.
4. Retarget the three allowed frontend-coupled repository guards while
   preserving their remaining semantics and timeouts.
5. Delete Svelte source, configuration, dependencies, and candidate-only
   blocking logic. Leave no framework selector or parallel production path.
6. Freeze the cutover SHA. From this point, any source/evidence fix creates a new
   SHA and restarts this step. Run the following on the unchanged cutover SHA;
   platform-specific native commands run in CI jobs that all report that SHA:

```bash
git status --porcelain=v1
bun frontend/scripts/check-plan-drift.ts --plan=<CUTOVER_CHILD_PLAN> --planned-at=<PLANNED_AT_SHA>
bun frontend/scripts/check-migration-scope.ts --base-sha="$MIGRATION_BASE_SHA" --scope-manifest=<CUTOVER_SCOPE_JSON> --require-clean
bun test tests/frontend/tooling/frontend-baseline-integrity.test.ts
bun frontend/scripts/check.ts --all --level=frontend
rg --files frontend -g '*.svelte'
rg -n 'svelte|SvelteKit|@sveltejs|lucide-svelte|\.svelte' frontend/package.json frontend/bun.lock frontend/apps frontend/packages frontend/scripts tests package.json
bun run check
bun run security:audit-pack
bun run gate:ci
bun run gate:release
bun run test:e2e:full
bun run test:watchtower:smoke
bun run native:package
bun frontend/scripts/activation-smoke.ts --candidate-manifest=<CUTOVER_MANIFEST> --previous-manifest=<PREVIOUS_MANIFEST> --failure-matrix
bun frontend/scripts/validate-evidence.ts --manifest=<CUTOVER_EVIDENCE_MANIFEST> --candidate-sha=<CUTOVER_SHA>
```

`git status --porcelain=v1` must print nothing before evidence collection. The
Svelte searches have an expected no-match result and the child plan must wrap
that expectation in a test/command that exits 0 only when no retired source or
dependency remains.

**Verify:** frontend and frozen-parity checks pass; Svelte searches are empty;
the scope checker accepts only the reviewed allowlist, including at most the
three allowed `core/scripts/**` tooling files and no other `core/**`,
`jurisdictions/**`, `frozen-core.json`, `.gitignore`, or unrelated path; all L3,
native-package, browser/F12, three-viewport, activation, failure-injection, and
rollback evidence refers to the same cutover SHA and validates successfully.

**STOP:** a capability is incomplete, a compatibility path remains, evidence
comes from another SHA, a guard is red/skipped, scope diff is wider than allowed,
or destructive authorization is absent.

### Work Package 11 — Production activation is separate

Do not execute without explicit release authority. Confirm immutable artifact
hashes, release identity, backup, rollback operator, and smoke plan. Revalidate
Gate B immediately before action and require the authenticated initiating
GitHub numeric user ID to equal `releaseOperatorGithubUserId`; the rollback
entry point similarly accepts only the release or
`rollbackOperatorGithubUserId`. Record that numeric actor ID in the immutable
release evidence. Deploy prebuilt artifacts, activate atomically, run
route/storage/browser smoke, and roll back immediately on any mismatch. Never
compile on production.

Production activation follows `docs/mainnet-acceptance-gate.md`, not a shorter
migration-specific substitute. Freeze the exact release candidate and record a
clean source tree; run the required source/security/release gates, full browser
and F12 drill, native artifact verification, applicable soak, capped topology
canary, production health, and rollback drill on that same candidate/topology.
At minimum the release child plan must include the current canonical commands:

```bash
bun run check
bun run security:audit-pack
bun run gate:release
bun run test:e2e:full
bun run test:watchtower:smoke
bun run soak:capped-testnet
bun run gate:capped-testnet
```

If repository release policy changes before activation, the live acceptance
document wins and the release child plan must be regenerated and re-approved.

**Verify:** one reviewed release identity serves every approved application;
all required evidence is attached and current; the approved route, storage,
PWA/native, browser/F12, soak, topology, and production-health checks pass; a
same-topology rollback drill restores the prior complete release immediately.

**STOP:** release authority is absent, artifact hashes differ from the reviewed
candidate, backup/rollback ownership is unclear, or any smoke check fails.

## Test plan

Add tooling tests first:

- `tests/frontend/tooling/frontend-baseline-integrity.test.ts`;
- `tests/frontend/tooling/frontend-route-ownership.test.ts`;
- `tests/frontend/tooling/frontend-capability-coverage.test.ts`;
- `tests/frontend/tooling/frontend-frozen-parity.test.ts`;
- `tests/frontend/tooling/frontend-check-scope.test.ts`;
- `tests/frontend/tooling/frontend-migration-scope.test.ts`;
- `tests/frontend/tooling/frontend-plan-drift.test.ts`;
- `tests/frontend/tooling/frontend-program-approval.test.ts`;
- `tests/frontend/tooling/frontend-input-ownership.test.ts`;
- `tests/frontend/tooling/frontend-build-isolation.test.ts`;
- `tests/frontend/tooling/frontend-assembly.test.ts`;
- `tests/frontend/tooling/frontend-review-contract.test.ts`;
- `tests/frontend/tooling/frontend-evidence-manifest.test.ts`;
- `tests/frontend/tooling/frontend-route-runtime-contract.test.ts`;
- `tests/frontend/tooling/frontend-activation-rollback.test.ts`.

Hash-freeze existing pure/unit tests under `tests/frontend`, browser specs, and
their behavior fixtures in the baseline manifest. Existing browser specs remain
behavior contracts and receive application ownership; do not edit, copy, or
weaken them for React. Selector adapters or additive React coverage require a
separate reviewed test-only change, while the unchanged baseline corpus remains
the parity oracle until capability closure. Use the existing isolated
Playwright runner for exact specs and real state. Every visual flow includes
screenshot-driven evidence at 393×852, 1280×800, and 1600×1000 with strict
console, page, request, and worker health, typed expected state, success/failure
assertions, inspection score, and immutable evidence hash.

For each local/slice command record five warm runs after the verification
foundation and site pilot: p50/p95 duration, selected steps, cache hits, flake
count, generated producers, and unexpected applications/gates (expected zero).

## Done criteria

All must hold:

- [ ] Gate B derives `APPROVED` from validated external review, byte-identical
      current charter/decision blobs, an append-only manifest, and the accepted
      Work Package 0 foundation/evidence commit without self-reference.
- [ ] Work was executed only through accepted numbered child plans with reviewed
      scope manifests and final-head approval.
- [ ] The canonical baseline was green before React implementation began.
- [ ] The current Svelte artifact passed the approved route contract, atomic
      activation, failure-injection, and immediate-rollback foundation before
      any React root was created.
- [ ] Every baseline inventory item has exactly one capability/non-UI owner and
      the baseline manifest/test corpus hashes never changed to fit React.
- [ ] Every owner-approved application has an independent
      React/Vite/TypeScript root and every browser route has exactly one owner.
- [ ] Each application independently typechecks, unit-tests, builds, and runs
      targeted browser tests without building/checking unrelated applications.
- [ ] L0/L1 containment tests prove no transitive L3 command.
- [ ] Shared-package changes select every declared consumer and no unrelated
      repository family.
- [ ] Generated inputs have one deterministic owner/producer and no build
      relies on unexplained ignored leftovers.
- [ ] Every capability is `PROVEN` or has explicit human removal approval.
- [ ] Existing behavior tests are preserved or replaced by named behavior-level
      coverage only after unchanged baseline parity or explicit owner-approved
      product change; none are narrowed to fit React.
- [ ] No frontend code implements Runtime, protocol, consensus, or financial
      logic and no second storage/command writer exists.
- [ ] Same-origin routes, proxies, storage, CSP, PWA, deep links, native
      packages, activation, and rollback are proven.
- [ ] No Svelte source, dependency, config, selector, or parallel production
      frontend remains after the authorized cutover.
- [ ] Every increment has recorded human scope and final approval from someone
      other than its author, based on its final SHA, and CI validated the review
      metadata rather than only the presence of filled fields.
- [ ] Complete scope and drift checkers pass over committed, staged, unstaged,
      untracked, imported-core, governing-doc, native, and deployment inputs.
- [ ] Success and failure evidence manifests are uploaded and validated; final
      cutover evidence has a durable immutable bundle rather than local/expiring-only logs.
- [ ] `bun run check`, `bun run gate:ci`, and `bun run gate:release` pass on the
      same immutable cutover SHA.
- [ ] Native packages, browser/F12 drills, all required viewport screenshots,
      activation failure injection, and rollback rehearsal are proven on that
      same cutover SHA.
- [ ] Production activation was separately authorized.

## Global STOP conditions

Stop and report instead of improvising if:

- Gate A/Gate B approval is missing, self-approved, mutable, postdated, attached
  to different subject/foundation bytes, or cannot be derived by the validator;
- no accepted child plan and reviewed scope manifest exist for the increment;
- work does not start from a clean canonical state;
- route/application ownership or product behavior is ambiguous;
- a human scope reviewer is unavailable;
- an increment exceeds the approved surface/flow/size boundary;
- a dependent increment starts before its prerequisite is accepted;
- the root baseline is red when any React implementation is proposed;
- a baseline inventory/test/fixture hash changes to accommodate candidate code;
- a scoped command invokes an unrelated application or L3 family;
- a missing input has no deterministic producer;
- correct behavior appears to require an out-of-scope file or domain;
- a route, capability, failure state, persisted value, native behavior, or test
  would disappear without explicit approval;
- a mock, stub, fallback, skip, compatibility selector, or silent workaround is
  proposed;
- a financial success claim rests only on UI visibility or text;
- a secret appears in logs, screenshots, storage, or test artifacts;
- approval or evidence cannot be validated against immutable review/artifact metadata;
- the exact targeted failure remains after two focused attempts;
- Svelte deletion is proposed before capability closure and destructive
  authorization;
- any required broad gate is red at an application milestone or cutover;
- native, visual, activation, rollback, or release evidence comes from a SHA
  other than the frozen cutover candidate.

## Maintenance notes

- New product work during migration must receive route/capability/test ownership
  in both current and candidate paths before it can merge.
- When a shared package gains or loses a consumer, update the affected-
  application graph and its tests in the same change.
- When a generated input changes, update its owner, producer, cache key,
  determinism test, and consuming manifests together.
- Reviewers should scrutinize command expansion, deleted tests, app imports,
  storage writers, asset producers, financial assertions, lifecycle cleanup,
  and any completion claim based only on route reachability.
- A change to the owner decision contract, route/asset contract, baseline
  manifest, frozen corpus, or child-plan scope invalidates downstream evidence
  until a new final head is independently reviewed.
- Keep each Vite app independently callable through supported `root`, `base`,
  `build.outDir`, and explicit HTML-input configuration; do not rebuild a hidden
  monolith behind one command.
