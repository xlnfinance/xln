# Plan 010 — Migrate operator and developer surfaces to React

> **Executor instructions:** Follow all steps after Plans 005 and 009 are `DONE`;
> update the Plan 010 index row when complete. Preserve endpoint/capability ownership
> and explicit resource teardown. Do not expose ops controls through public UI.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/routes frontend/src/lib/components frontend/src/lib/stores frontend/static tests`
> Rebuild the route/panel/capability inventory for changed files. An authority or
> endpoint-ownership mismatch is a STOP condition.

## Status

- **Execution:** DONE — independent release-blocked ops artifact; L1/build/strict browser evidence green
- **Priority:** P2
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/005-extract-runtime-ui-external-stores.md`, `plans/009-migrate-wallet-swap-history.md`
- **Category:** migration, performance
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue the one `ai/react-frontend-migration` writer worktree. Re-inventory `/health`, `/qa`, `/runs`, `/scenarios`, `/ai`, and `/embed`. Keep `/admin` as the existing edge redirect to `/health`, and keep `/rpc`, `/rpc2`, and `/resetdb` as runtime/edge endpoints. Do not weaken production checks, expose operator controls publicly, or add fake scenario/runtime data.

## Why ops is a separate surface

The operator/developer UI contains the largest visual components—`Graph3DPanel`, `ArchitectPanel`, Dockview layouts, QA/scenario tooling—and different audience/security/bundle needs from the wallet. It should build separately so public and wallet users do not download diagnostics or 3D/editor dependencies.

## Current evidence

- `Graph3DPanel.svelte` is about 2,818 LOC; `ArchitectPanel.svelte` about 2,767 LOC; several other panels are similarly large.
- The current app uses vanilla `DockviewComponent`; React can keep that API and mount React roots into panels without adding another Dockview package.
- The public top bar previously exposed a delta visualizer; Plan 001 removes it or relocates it here using canonical `deriveDelta`.
- `/health`, `/qa`, `/runs`, `/scenarios`, `/ai`, `/admin`, and embeds currently share global Svelte layout behavior.

## Scope

In scope:

- Complete React migrations for health/QA/runs/scenarios/AI and `/embed`; the current embed is a runtime-free scenario/trail workspace.
- Dockview workspace/panel lifecycle, graph/3D/architect views, runtime inspection, scenario tooling, and canonical delta visualization if retained.
- Auth/capability gating already present, lazy loading, worker/asset ownership, accessibility, responsive behavior, screenshots, and performance metrics.

Out of scope:

- Changing runtime endpoint behavior or security model.
- Moving edge endpoints into React.
- Public exposure of operator controls, new admin capabilities, or production protocol changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/routes frontend/src/lib/components frontend/src/lib/stores frontend/static tests` | Exit 0; capability/panel drift reviewed |
| L1 | `bun test tests/frontend/ops-route-capabilities.test.ts tests/frontend/dockview-react-lifecycle.test.tsx tests/frontend/ops-import-boundaries.test.ts tests/frontend/ops-delta-adapter.test.ts` | Exit 0; boundary/lifecycle cases pass |
| Ops browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/ops-health-qa.spec.ts` | Exit 0; clean browser health |
| Graph browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/ops-dockview-graph.spec.ts` | Exit 0; lifecycle/performance assertions pass |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Checkpoint coherent route/panel groups using `wip:` commits.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- Current route pages for all ops paths and embed modes
- Dockview workspace/panel registry and Svelte mount/unmount integration
- `Graph3DPanel.svelte`, `ArchitectPanel.svelte`, QA/scenario/run/health/AI/admin components
- Worker/static scenario assets and runtime debug adapters
- New `frontend/apps/ops/**` and focused unit/Playwright specs

## Implementation steps

1. Inventory routes, capabilities, data sources, workers/assets, panel IDs, serialized layouts, and `/embed` scenario/trail modes. Classify every route/panel as production operator, developer-only, test-only, or unused. Delete unused code only after import/route/layout-state proof; do not migrate dead panels. Keep `/radapter` in the edge route contract as the existing query-rejecting redirect, not an ops page.

   Verify: each reachable route/panel has one owner, one gating policy, and one data source. `/rpc*` and `/resetdb` remain outside the app manifest.

2. Build the React ops root with explicit capability/error states and no public-site or wallet navigation inheritance. Reuse Plan 005 runtime external stores through ops React adapters, but do not import vault secret APIs unless a specific existing operator action truly requires them.

   Verify: import and bundle tests show 3D/editor/scenario/admin code absent from site/docs/wallet artifacts.

3. Migrate health, QA, runs, and scenarios before visual editors. Preserve deterministic scenario inputs, full error/JSON dump behavior, route parameters, refresh/poll policy, and explicit connection state. Ambient timers remain controller/environment concerns, not deterministic reducers.

   Verify: real scenario/run data renders; malformed/unavailable data fails visibly; no mock fallback exists.

4. Migrate AI and `/embed` surfaces with their existing capability and environment checks. Validate `postMessage` origin/payload contracts for embeds. Preserve `/admin` as the edge redirect to `/health`; do not invent a standalone admin page.

   Verify: unauthorized/wrong-origin/malformed messages are rejected, while valid same-origin integration works in a focused browser test.

5. Keep vanilla `DockviewComponent`. Replace each Svelte `mount` with a React `createRoot` created when Dockview instantiates a panel; retain roots in an explicit registry and call `root.unmount()` on panel disposal/workspace teardown. Do not mount a second root into the same host.

   Verify: open/close/reopen/layout-restore tests show no duplicate listeners, roots, canvases, workers, or stale panel state.

6. Decompose graph/3D/architect panels into pure data adapters, controller/resource lifecycle, and view components. Use requestAnimationFrame/render-loop resources with explicit start/stop ownership outside deterministic state. Measure frame rate, main-thread tasks, memory, and bundle size before optimizing.

   Verify: idle hidden/closed panels consume no render loop; representative graph interaction remains usable at all target viewports; teardown returns listeners/workers/canvases to baseline.

7. If retaining the delta visualizer, use only `xlnFunctions.deriveDelta` or the canonical framework-neutral adapter from Plan 001. Add historical-exposure cases and display the result as operator diagnostics. Do not re-create the formula in graph/view code.

   Verify: the no-manual-delta guard scans the ops source and canonical parity tests pass.

8. Configure an independent lazy-loaded ops artifact at `frontend/build/ops`. Large 3D/editor/scenario chunks load only on the owning route/panel. Integrate into the unified manifest without activation.

   Verify: route-level bundle reports show site/docs/wallet contain none of these chunks; ops cold-load and panel-load budgets are recorded with actual bytes/timing.

9. Add screenshot and interaction E2E for every key operator route/panel at iPhone where supported, laptop, and wide desktop/Mac Studio. For desktop-oriented tools, mobile may intentionally show a tested accessible unsupported-layout message only if current product policy allows it; do not silently break.

   Verify: inspect every screenshot, F12 console, worker lifecycle, and performance capture.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/ops-route-capabilities.test.ts
bun test tests/frontend/dockview-react-lifecycle.test.tsx
bun test tests/frontend/ops-import-boundaries.test.ts
bun test tests/frontend/ops-delta-adapter.test.ts
```

L2 targeted browser:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/ops-health-qa.spec.ts
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/ops-dockview-graph.spec.ts
```

Add focused specs for runs/scenarios/AI/admin/embed as required. Inspect screenshots and F12 performance/console evidence.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [x] All reachable operator/developer routes and panels have complete React implementations or are deleted with reachability proof.
- [x] Ops builds separately and its heavy dependencies do not enter public/docs/wallet artifacts.
- [x] Dockview/React roots, workers, canvases, listeners, and render loops have explicit leak-free lifecycle.
- [x] Endpoint ownership and capability boundaries are unchanged and tested.
- [x] No manual financial formula or mock scenario/runtime path exists.
- [x] Artifact remains release-blocked; `bun run check` passes; `wip:` checkpoint only.
- [x] `git status --short` is reviewed and the Plan 010 index row is updated.

## Stop conditions

- Any ambiguity about admin/AI/embed authority or endpoint behavior requires owner review.
- Any need to expose operator code to public navigation is a boundary failure; stop and revisit the route inventory.
- Do not optimize 3D/graph behavior without baseline metrics and a verified bottleneck.

## Suggested toolkit

- Use `vercel-react-best-practices` for lazy loading/render review.
- Use `vercel-composition-patterns` for panel APIs and `web-design-guidelines` for accessibility if available.
