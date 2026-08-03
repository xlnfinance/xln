# Plan 001 — Lock frontend migration contracts

> **Executor instructions:** Follow the steps in order and run every verification
> command before continuing. Update Plan 001 to `DONE` in `plans/README.md` when
> complete. If a STOP condition occurs, report it without improvising.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/routes frontend/src/lib/stores frontend/src/lib/components/site frontend/src/lib/components/Tools frontend/static frontend/package.json tests runtime/scripts/check-no-manual-delta-math.ts`
> Any relevant drift requires re-reading the live symbols named below; a semantic
> mismatch is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** HIGH
- **Depends on:** none
- **Category:** migration, tests, correctness
- **Planned at:** commit `5749e283d`, 2026-08-03
- **Execution:** BLOCKED — both isolated E2E attempts stopped before Playwright
  (`pw=0`) because the fresh-stack hub baseline stalled for `H1`, `H2`, and
  `H3`. L1, the full repository gate, and headed static-preview browser QA are
  green.

## Executor instructions

Work from a clean `ai/react-frontend-migration-contracts` branch in a writer-owned worktree. Before editing, compare `git rev-parse HEAD` with the audited commit and re-check every referenced file if it differs. Do not edit runtime protocol/source, `jurisdictions`, `frozen-core.json`, or any frozen file; the only authorized `runtime/` change is the audit guard `runtime/scripts/check-no-manual-delta-math.ts`. If a frozen-core violation appears, stop and report old/new hashes.

This plan establishes testable behavior and removes one duplicate financial display formula. It does not add React, change production routing, or create placeholders.

## Why this exists

The existing frontend couples all routes through one Svelte layout and relies on implicit contracts that a rewrite could silently break: exact URLs, storage keys, push scope, native redirects, browser errors, test IDs, and screenshot states. There is also a public delta visualizer with hand-written accounting math that differs from the canonical runtime calculation. Porting it would preserve a known semantic defect.

## Current evidence

- `frontend/src/routes/+layout.svelte` imports the site top bar, toast UI, mascot, global styles, and native-shell initialization for every route.
- `frontend/src/routes/+layout.ts` globally sets `prerender = true` and `ssr = false`.
- `frontend/src/app.html` mixes analytics, Capacitor root redirect to `/app`, and route mode.
- `frontend/src/lib/components/site/Topbar.svelte` exposes `Tools/DeltaVisualizer.svelte` on the public surface.
- `frontend/src/lib/components/Tools/DeltaVisualizer.svelte` locally caps credit windows, while `runtime/account/utils.ts` deliberately preserves historical drawn exposure. `frontend/src/lib/stores/xlnStore.ts` already exposes the canonical `deriveDelta` function.
- `frontend/package.json` has a `test:landing` script targeting a missing `frontend/tests/landing.spec.ts`.

## Scope

In scope:

- A machine-readable route/surface ownership manifest and a generated artifact contract.
- Persistence, PWA, native-redirect, and browser-health contract tests.
- Stable visual baselines at iPhone, laptop, and wide desktop sizes for site, docs, and wallet entry states.
- Removal of the public delta tool or relocation to ops with canonical runtime `deriveDelta`; extension of the manual-delta guard to cover its owning path.

Out of scope:

- React/Vite application code.
- New financial formulas or changes to canonical Runtime/Entity/Account behavior.
- Deployment topology changes; those belong to Plan 002.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/routes frontend/src/lib/stores frontend/src/lib/components/site frontend/src/lib/components/Tools frontend/static frontend/package.json tests runtime/scripts/check-no-manual-delta-math.ts` | Exit 0; reviewed before edits |
| L1 contracts | `bun test tests/frontend/route-surface-contract.test.ts tests/frontend/persistence-contract.test.ts tests/frontend/delta-visualizer.test.ts` | Exit 0; all cases pass |
| Landing browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/landing-site.spec.ts` | Exit 0; no browser-health failures |
| Docs browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/docs-site.spec.ts` | Exit 0; no browser-health failures |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: `ai/react-frontend-migration-contracts`; exactly one writer owns its worktree.
- Commit logical units with the repository’s conventional style, for example `test(frontend): lock migration contracts`.
- Do not push, merge, or open a PR unless the operator explicitly requests it.

## Files to inspect and likely change

| Area | Files |
|---|---|
| Route contract | `frontend/src/routes/**`, a new non-runtime contract module under `frontend/src/lib/build/` or `frontend/scripts/` |
| Storage contract | `frontend/src/lib/stores/vaultStore.ts`, `frontend/src/lib/runtime-command/runtimeCommandJournalIndexedDb.ts`, `frontend/src/lib/pushWakeRegistration.ts` |
| PWA/native | `frontend/static/site.webmanifest`, `frontend/static/push-wake-sw.js`, `frontend/src/app.html`, `capacitor.config.ts` |
| Delta tool | `frontend/src/lib/components/site/Topbar.svelte`, `frontend/src/lib/components/Tools/DeltaVisualizer.svelte`, `runtime/scripts/check-no-manual-delta-math.ts` |
| Browser tests | `tests/docs-site.spec.ts`, `tests/install-site.spec.ts`, `tests/e2e-ui-screenshots.spec.ts`, new landing/contract specs |

## Implementation steps

1. Inventory every current page and endpoint into one typed, immutable manifest. For each entry record the URL pattern, future surface owner (`site`, `docs`, `wallet`, `ops`, or `edge`), output-relative entry, native inclusion, PWA inclusion, and fallback policy. Include all currently shipped routes; do not invent aliases.

   Verify: a focused unit test asserts uniqueness, no overlapping exact routes, and expected ownership for `/`, `/docs`, `/app`, `/address/[entityId]`, `/health`, `/embed`, `/radapter`, `/rpc`, and `/resetdb`.

2. Add a pure contract module for browser-persistent identifiers. Record the existing localStorage keys, IndexedDB database/store/version, manifest `start_url`/`scope`, push service-worker path/scope, push-open URL, and Capacitor root redirect. Tests must compare these values to current behavior; do not rename or migrate data in this plan.

   Verify: a fresh and pre-populated browser profile can load `/app` without clearing or rewriting existing persisted state. Any decode failure remains loud.

3. Replace the missing landing test target with a real Playwright spec. Cover `/`, its primary navigation, absence of runtime-heavy wallet initialization, and clean browser console/network. Add screenshot assertions at iPhone, laptop, and wide desktop viewports. Bring the docs visual suite to the same three-view matrix; use `tests/install-site.spec.ts` as the repository model.

   Verify: run each new/changed spec through the isolated runner and inspect every screenshot for clipping, layout shifts, accidental wallet chrome, missing content, and console exceptions.

4. Remove `DeltaVisualizer` from the public top bar. If the tool has demonstrated operator value, relocate it under the ops surface and replace all local math with the canonical `xlnFunctions.deriveDelta` adapter. If it has no current callers beyond the menu, delete it. Extend `check-no-manual-delta-math.ts` so future frontend tools cannot reintroduce manual credit-window arithmetic.

   Verify: unit cases compare the UI adapter against canonical `deriveDelta`, including a case where historical drawn exposure exceeds the current credit limit. There must be no second delta implementation.

5. Add a contract-report command that prints the route ownership table, persistent identifiers, and expected output roots as deterministic JSON using the repository safe serializer where BigInt could appear. This report becomes Plan 011’s pre/post-cutover parity input.

   Verify: two consecutive runs at the same commit are byte-identical.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/route-surface-contract.test.ts
bun test tests/frontend/persistence-contract.test.ts
bun test tests/frontend/delta-visualizer.test.ts
```

Use the actual filenames created by the implementation; keep each test focused on one contract.

L2 targeted browser:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/landing-site.spec.ts
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/docs-site.spec.ts
```

Open browser F12 on `/`, `/docs`, and `/app`; verify no errors and inspect the three viewport screenshots.

L3 broad gate:

```bash
bun run check
```

Run the broad gate once on the unchanged completion candidate. Show the command output when handing off.

## Done criteria

- [ ] Every current route and edge endpoint has exactly one future owner.
- [ ] Persistent identifiers and same-origin assumptions are executable tests, not prose only.
- [ ] Landing and docs have clean-console visual coverage at all three required viewport classes.
- [ ] No public route imports the delta tool, and no manual financial delta formula remains in frontend tooling.
- [ ] `bun run check` passes with no frozen-core violation.
- [ ] `git status --short` contains only reviewed in-scope changes, and the Plan 001 index row is updated.

## Stop conditions

- Any proposed storage-key or origin change requires an explicit migration design and owner approval.
- Any uncertainty about canonical Account delta semantics requires stopping and asking the owner.
- Any frozen-file change is a hard stop; never approve or bypass it.

## Maintenance note

The route and persistence contract must remain framework-neutral. Plans 003–011 may consume it, but must not fork it into per-framework copies.
