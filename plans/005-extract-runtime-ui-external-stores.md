# Plan 005 — Extract framework-neutral runtime and UI external stores

> **Executor instructions:** Follow each step and verification command only after
> Plans 001 and 003 are `DONE`. Update the Plan 005 index row on completion. Keep
> one canonical state instance; if parity appears to require two stores, STOP.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/lib/stores frontend/src/lib/runtime-command frontend/src/lib frontend/package.json tests/frontend`
> Rebuild the importer/ownership inventory for changed files. A mismatch in store
> semantics or Runtime ownership is a STOP condition.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/001-lock-frontend-migration-contracts.md`, `plans/003-migrate-public-site-to-react-vite.md`
- **Category:** migration, tech debt, correctness
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue the sole `ai/react-frontend-migration` writer worktree. Before editing, inventory all importers of the stores named below and reconcile any drift since `5749e283d`. This plan refactors state ownership but must preserve the Svelte production behavior through a thin adapter. Do not create a second business implementation, synchronize state with polling, or mirror it through React effects.

The external-store core must be pure TypeScript. React will consume it with `useSyncExternalStore`; Svelte temporarily consumes the same core until Plan 011 deletes its adapter. This is a migration adapter around one canonical state object, not two production paths.

## Why this exists

At least 29 TypeScript files (11,291 LOC) directly import `svelte/store`, while 177 TypeScript files (27,004 LOC) are already framework-neutral. The lowest-risk rewrite first moves framework coupling out of the state layer, preserving inputs, snapshots, subscriptions, persistence, and error behavior before replacing views.

## Current evidence

- `frontend/src/lib/stores/runtimeQueryClient.ts` imports Svelte `get`/`writable` around a substantial query client.
- `frontend/src/lib/stores/runtimeStore.ts` owns runtimes, active selection, derived state, and local/session persistence.
- `frontend/src/lib/stores/appStateStore.ts` mixes app mode/view/navigation types with Svelte and browser checks.
- Settings, runtime loader/controller, command bus, tab/time/error/toast stores also embed Svelte subscriptions.
- Runtime state is live state, not an archive; historical reads belong to dedicated stores and must not be re-created in UI memory.

## Target external-store contract

```ts
interface ExternalStore<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: () => void): () => void;
}
```

Mutations are explicit named commands on a controller, not setters leaked through the store. `getSnapshot()` must return referentially stable immutable snapshots until a real transition occurs. Server snapshots are supplied only if needed by an actual non-browser test; the production app remains client-only.

## Scope

In scope:

- Runtime registry/selection/query state, UI navigation/app state, settings, time/tab state, loader/controller lifecycle, toast and error reporting.
- Pure reducers/transitions, framework-neutral controllers, external-store subscriptions, storage/I/O ports, Svelte adapter, React hook adapter.
- Characterization, parity, lifecycle, unsubscribe, persistence, and error tests.

Out of scope:

- Vault secrets, command journal, recovery, transaction construction; Plan 006 owns them.
- View migration.
- Runtime protocol or deterministic state-machine edits.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Import inventory | `rg -n "from ['\"]svelte/store['\"]|from ['\"]react['\"]" frontend/src/lib/stores frontend/packages` | Reviewed, with framework imports only in adapters |
| L1 | `bun test tests/frontend/external-store.test.ts tests/frontend/runtime-store-characterization.test.ts tests/frontend/runtime-query-client.test.ts tests/frontend/store-framework-boundaries.test.ts` | Exit 0; parity/boundary cases pass |
| Wallet browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/e2e-ui-screenshots.spec.ts` | Exit 0; clean browser health |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Checkpoint coherent store groups, using `wip:` while the React cutover is incomplete.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- `frontend/src/lib/stores/runtimeQueryClient.ts`
- `frontend/src/lib/stores/runtimeStore.ts`
- `frontend/src/lib/stores/appStateStore.ts`
- Settings, runtime loader/controller, command bus, tab/time/toast/error store modules and all importers
- New `frontend/packages/runtime-client/**` and `frontend/packages/client-core/**`
- Temporary Svelte adapters and new React `useSyncExternalStore` hooks
- Focused frontend store tests

## Implementation steps

1. Produce an importer graph and state-ownership table before moving code. For each store record snapshot shape, mutation API, derived values, initialization order, I/O side effects, persistence keys, subscription cleanup, and error policy. Identify circular imports and consumers that mutate state directly.

   Verify: every exported store symbol has an owner and at least one characterized consumer or is deleted as unused.

2. Add characterization tests around current behavior. Cover initial snapshot, runtime addition/removal, active selection, selection after removal, settings load/save, app navigation, query invalidation, duplicate initialization, subscription order, unsubscribe, storage corruption, and runtime loader failure.

   Verify: tests run against current Svelte-backed behavior before extraction and assert exact snapshots/events, not implementation internals.

3. Implement a small framework-neutral external-store primitive with immutable state, referentially stable snapshots, synchronous notification after successful transitions, and explicit reentrancy policy. Reducers remain pure; I/O is injected through typed ports and performed by controllers only after validation.

   Verify: primitive tests cover no-op transitions, nested notification policy, listener removal during notification, thrown listener behavior, and teardown without swallowing errors.

4. Migrate one low-risk store at a time, starting with app/navigation, settings, tab/time, and toast/error, then runtime registry/selection and query client. Preserve public operation names where they represent product behavior, but eliminate Svelte types from the core. Keep functions under repository size/complexity limits.

   Verify after each store: the characterization suite passes through both the external-store core and the Svelte adapter.

5. Isolate environment effects: browser storage, location/navigation, clocks, native detection, runtime worker/controller, and logging become explicit ports. Deterministic state transitions receive values as inputs; do not call `Date.now()`, timers, or random functions inside reducers.

   Verify: pure transition tests replay identical inputs twice and produce deeply identical snapshots/events.

6. Add a thin Svelte `readable`/`writable` compatibility adapter that subscribes to the single external-store instance. It may translate framework interfaces only; it must not own state, persistence, derivations, or business rules.

   Verify: mutation through the canonical controller updates both direct external-store consumers and current Svelte views exactly once.

7. Add React hooks that call `useSyncExternalStore(store.subscribe, store.getSnapshot)` directly. Selector hooks may be added only with stable equality semantics and tests. Never copy snapshots into component state with `useEffect`.

   Verify: a React test proves no missed update, no duplicate subscription under Strict Mode, stable no-op renders, and cleanup on unmount.

8. Add import-boundary checks: `runtime-client` and `client-core` cannot import Svelte/React; React adapters cannot import Svelte; Svelte adapters cannot import React; site/docs cannot import the runtime client.

   Verify: the dependency check fails on fixture violations.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/external-store.test.ts
bun test tests/frontend/runtime-store-characterization.test.ts
bun test tests/frontend/runtime-query-client.test.ts
bun test tests/frontend/store-framework-boundaries.test.ts
```

L2 targeted flow:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/e2e-ui-screenshots.spec.ts
```

Limit the browser run to entry/runtime-selection states if the runner supports a focused title filter. Inspect F12 console for duplicate initialization, leaked subscriptions, and worker/controller errors.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [ ] Target stores have one framework-neutral source of truth and pure transitions.
- [ ] Current Svelte views and React test consumers subscribe to the same instances.
- [ ] Snapshot, mutation, persistence, initialization, teardown, and error semantics match characterization evidence.
- [ ] Framework-boundary tests prevent state logic from drifting back into adapters.
- [ ] No runtime protocol or frozen-core file changed.
- [ ] `bun run check` passes; checkpoint only with `wip:`.
- [ ] `git status --short` is reviewed and the Plan 005 index row is updated.

## Stop conditions

- If a store’s behavior depends on unclear Runtime/Entity/Account ownership, stop and ask the owner before changing it.
- If parity seems to require two stores or event replay between Svelte and React, stop; redesign around one external source of truth.
- If tests expose swallowed initialization/persistence errors, preserve loud failure and resolve the root cause rather than adding defaults.

## Suggested toolkit

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [Add React to an existing project](https://react.dev/learn/add-react-to-an-existing-project)
- Use `vercel-react-best-practices` if available for subscription and render review.
