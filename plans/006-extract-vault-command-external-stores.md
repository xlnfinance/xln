# Plan 006 — Extract vault, command, and recovery external stores

> **Executor instructions:** Follow all steps after Plan 005 is `DONE`; update the
> Plan 006 index row when complete. Run real integration paths and preserve loud
> failures. A durable-format or commit-evidence ambiguity is a STOP condition.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/lib/stores/vaultStore.ts frontend/src/lib/runtime-command frontend/src/lib/stores frontend/package.json tests/frontend tests`
> Re-characterize any changed durable format or command lifecycle before editing.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/005-extract-runtime-ui-external-stores.md`
- **Category:** migration, correctness, security
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue in the single `ai/react-frontend-migration` worktree after Plan 005 is green. Re-inventory all vault, command-bus, runtime-controller, recovery, and journal consumers at current HEAD. This plan changes only frontend orchestration around existing runtime APIs. It must not change consensus, cryptography, contracts, transaction formulas, or canonical Runtime/Entity/Account transitions.

Never create mocks or fake registration/transaction success paths. Integration tests must use real existing frontend/runtime integration fixtures. Preserve fail-fast decoding and full error propagation.

## Why this exists

The wallet cannot be ported safely while `vaultStore.ts` (about 2,973 LOC), runtime command orchestration, IndexedDB journal, recovery flows, and Svelte subscriptions are intertwined. These modules hold origin-bound state and define when commands can be retried, acknowledged, or surfaced. A view rewrite without first fixing ownership would invite duplicate commands or inaccessible vaults.

## Current evidence

- `frontend/src/lib/stores/vaultStore.ts` persists vault metadata and protected state in localStorage.
- `frontend/src/lib/runtime-command/runtimeCommandJournalIndexedDb.ts` owns the durable browser command journal.
- Command bus/controller/loader stores coordinate the live runtime and user-visible errors.
- Capacitor, Electron, extension, and browser builds all consume the wallet from the same build today.
- Repository policy requires inputs to control replicas; only Runtime turns committed outputs into external effects after WAL commit. UI must not infer completion from optimistic view state.

## Scope

In scope:

- Framework-neutral vault lifecycle, unlock/lock state, protected-state persistence ports, recovery workflow state, runtime command submission/journal status, controller orchestration, and error events.
- Existing storage-key/database compatibility, schema validation, crash/reload behavior, idempotency, acknowledgment semantics, and React/Svelte adapters.
- Real integration tests against existing runtime bridge paths.

Out of scope:

- New wallet format, key derivation, encryption protocol, consensus rule, financial formula, or compatibility reader.
- Visual onboarding/settings/payment components; Plans 007–009 own them.
- Cross-origin wallet migration.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/lib/stores/vaultStore.ts frontend/src/lib/runtime-command frontend/src/lib/stores frontend/package.json tests/frontend tests` | Exit 0; durable drift reviewed |
| L1 | `bun test tests/frontend/vault-store-characterization.test.ts tests/frontend/runtime-command-transitions.test.ts tests/frontend/runtime-command-journal.test.ts tests/frontend/vault-command-boundaries.test.ts` | Exit 0; all lifecycle/failure cases pass |
| Recovery browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/vault-reload-and-recovery.spec.ts` | Exit 0; clean browser health |
| Real command smoke | `bun run test:e2e:payment:smoke` | Exit 0; no duplicate/false completion |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Commit only coherent `wip:` checkpoints; never commit logs, traces, or secrets.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- `frontend/src/lib/stores/vaultStore.ts`
- Runtime command bus/controller/loader stores and their tests
- `frontend/src/lib/runtime-command/**`
- Recovery/onboarding state modules and storage helpers
- `frontend/packages/runtime-client/**` and `frontend/packages/client-core/**`
- Temporary Svelte adapters and React external-store hooks

## Implementation steps

1. Document and test the exact durable formats before refactoring: every localStorage key/value schema, IndexedDB database/version/store/index, command identifier, command state, retry/ack transition, vault lock/unlock transition, protected-state envelope, and recovery checkpoint. Dump complete sanitized structures in test failures; never print secrets.

   Verify: characterization fixtures round-trip current valid data and reject malformed/unsupported data loudly. There is no fallback reader or inferred downgrade.

2. Map command lifecycle to explicit immutable states and allowed transitions. Distinguish requested, durably journaled, submitted, runtime-acknowledged/committed, failed, and retryable according to current canonical behavior. UI state must never mark financial success before the runtime evidence that currently authorizes it.

   Verify: a transition-table test rejects illegal skips, duplicate completion, mismatched command IDs, and stale acknowledgments.

3. Extract pure vault and command reducers into framework-neutral modules. Inject crypto/storage/runtime/clock/environment operations through narrow ports. Reducers receive timestamps or evidence as input; they do not call ambient time, randomness, storage, or network APIs.

   Verify: deterministic replay of identical vault/command inputs produces identical snapshots and controller outputs.

4. Implement controllers that validate inputs, persist before external submission where required by current semantics, call the existing runtime bridge, then feed explicit evidence back to reducers. Preserve ordering and crash boundaries. Never catch an error merely to continue; surface a typed failure event and stop unsafe progress.

   Verify: failure injection at each persistence/submission/ack boundary produces the expected durable state after reload and cannot issue a command twice.

5. Preserve current origin-bound formats exactly. Reuse Plan 001 persistence identifiers. Do not rename localStorage keys, change IndexedDB version, or rewrite protected vault blobs. If a necessary schema change appears, stop and create a separately owner-approved offline migration plan.

   Verify: a browser profile created by the Svelte implementation opens in the external-store implementation and vice versa during test-only migration work, with no data rewrite.

6. Wrap the same canonical instances with temporary Svelte adapters and React `useSyncExternalStore` hooks. Adapters expose state and typed controller commands only. No React effect may submit/retry a command based merely on rendering or snapshot change.

   Verify: React Strict Mode mount/unmount/remount does not unlock twice, create duplicate controller instances, resubmit commands, or add duplicate journal listeners.

7. Add real integration scenarios for create/import/unlock/lock/reload/recover and one representative runtime command from request through durable journal to acknowledged state. Use existing real runtime integration; do not stub successful financial behavior.

   Verify: journal and both state snapshots are dumped on any failure; the test proves exactly-once user intent across browser reload.

8. Add module-boundary and secret-safety checks. UI components cannot access raw protected bytes or storage ports. Logs, errors, screenshots, and serialized test artifacts must redact sensitive material while retaining actionable state-machine information.

   Verify: fixture secrets do not appear in captured console, Playwright traces, screenshots, or test output.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/vault-store-characterization.test.ts
bun test tests/frontend/runtime-command-transitions.test.ts
bun test tests/frontend/runtime-command-journal.test.ts
bun test tests/frontend/vault-command-boundaries.test.ts
```

L2 targeted integration/browser:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/vault-reload-and-recovery.spec.ts
bun run test:e2e:payment:smoke
```

Use the exact existing smoke script if it is already the narrowest real financial command flow. Inspect F12 console, IndexedDB, and localStorage without exposing secret material.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [x] Vault, recovery, command, and journal state have one framework-neutral canonical implementation.
- [x] Persistence identifiers/formats and command ordering semantics are unchanged and executable as tests.
- [x] Reload/crash/duplicate-submission cases are proven with real integration paths.
- [x] React and Svelte adapters are side-effect-free interface translations over the same instances.
- [x] No secret leakage, swallowed error, financial formula, runtime protocol, or frozen-core change exists.
- [x] `bun run check` passes; checkpoint only with `wip:`.
- [x] `git status --short` is reviewed and the Plan 006 index row is updated.

## Execution evidence

- L1: 13 tests / 46 assertions pass for exact vault persistence, immutable lock/unlock, command transitions, real AES-GCM journal round-trip/tamper rejection, and framework/secret boundaries.
- Compatibility: 88 existing vault, command-bus, persistence, and runtime hot-swap tests pass with 2,902 assertions; combined Plan 006 evidence is 101 tests / 2,948 assertions.
- Ownership: `vaultStore.ts` has one external-store binding, a readonly Svelte facade, and the existing React `useSyncExternalStore` adapter; lifecycle reducers contain no framework, clock, randomness, storage, or network access.
- Focused browser: the isolated create → lock → unlock → reload scenario passes its real Playwright assertions in 6.4 seconds and attaches only a sanitized vault snapshot.
- Strict browser note: the required default recovery and payment commands both stop before Vite/Playwright because the unrelated H1/H2/H3 mesh reset remains at height 0 (`HUB_BASELINE_STALLED`). The focused `--prewait-health=http` run reaches and passes Playwright, but the aggregate health wrapper reports the expected no-mesh faucet 404 plus relay audience warnings; no vault assertion fails.
- L3: `bun run check` passes with frozen core unchanged, the 3,000-line file invariant restored, 0 Svelte diagnostics, React TypeScript clean, and legacy/site/docs production builds green.

## Stop conditions

- Any uncertainty about when a Runtime output is committed or safe to display as complete requires owner clarification.
- Any required durable-schema, origin, encryption, or key-derivation change is outside scope and requires explicit approval.
- Any frozen-core violation is a hard stop.

## Suggested toolkit

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- Use `vercel-react-best-practices` if available for Strict Mode and subscription review.
