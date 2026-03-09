# Code Cleanup Plan

Last review: 2026-03-09

This plan is intentionally strict. Only items with very high confidence should be removed immediately. Everything else stays documented until there is proof.

## Removed With Proof

1. [tests/utils/playwright-helpers.ts](/Users/egor/xln/tests/utils/playwright-helpers.ts)
Reason:
- no imports
- no string references from `tests`, `frontend`, or `runtime`

## Runtime: Safe Readability Work

These are safe now because they do not change behavior:

1. Keep the current top-level split and document it.
Target:
- [runtime/README.md](/Users/egor/xln/runtime/README.md)

2. Keep `relay`, `routing`, `orderbook`, `networking`, `orchestrator`, `scripts`, `account-tx`, `entity-tx` as the canonical buckets.

3. Do not move core consensus files yet.
Blocked files:
- [runtime/account-consensus.ts](/Users/egor/xln/runtime/account-consensus.ts)
- [runtime/account-tx/apply.ts](/Users/egor/xln/runtime/account-tx/apply.ts)
- [runtime/entity-consensus.ts](/Users/egor/xln/runtime/entity-consensus.ts)
- [runtime/entity-tx/apply.ts](/Users/egor/xln/runtime/entity-tx/apply.ts)
- [runtime/types.ts](/Users/egor/xln/runtime/types.ts)

Reason:
- these files are already dirty in the worktree
- moving them now would mix structural churn with live behavior work

## Runtime: Candidates To Revisit After Consensus Files Settle

1. Move relay root files under `runtime/relay/`
Candidates:
- `runtime/relay-router.ts`
- `runtime/relay-store.ts`

Why later:
- low conceptual risk, but import churn is broad
- better done after the hot runtime files are stable

2. Split persistence/replay internals out of `runtime/runtime.ts`
Target shape:
- `runtime/persistence/replay.ts`
- `runtime/persistence/snapshot-store.ts`
- `runtime/persistence/wal.ts`

Why later:
- good direction, but not a 99% confidence no-risk change today

## Frontend: Safe Readability Work

1. Keep `components`, `stores`, `utils`, `view`, `network3d`, `types` and document their boundaries.
Target:
- [frontend/src/lib/README.md](/Users/egor/xln/frontend/src/lib/README.md)

2. Prefer consolidating logic before deleting UI files.
Immediate direction:
- payment flow helpers out of [PaymentPanel.svelte](/Users/egor/xln/frontend/src/lib/components/Entity/PaymentPanel.svelte)
- selector refresh logic centralized instead of duplicated across entity inputs/selectors

## Frontend: High-Confidence Dead-Code Candidates Needing One More Proof Pass

These look unreferenced by import search, but I am not deleting them yet because route-level or dynamic usage still needs one more check.

1. [frontend/src/lib/vr/VRHammer.ts](/Users/egor/xln/frontend/src/lib/vr/VRHammer.ts)
Current evidence:
- no direct import references found
- [Graph3DPanel.svelte](/Users/egor/xln/frontend/src/lib/view/panels/Graph3DPanel.svelte) defines a local `VRHammer` class instead

2. [frontend/src/lib/vr/VRController.ts](/Users/egor/xln/frontend/src/lib/vr/VRController.ts)
Current evidence:
- no direct import references found
- [Graph3DPanel.svelte](/Users/egor/xln/frontend/src/lib/view/panels/Graph3DPanel.svelte) uses local VR controller setup instead

3. [frontend/src/lib/components/Embed/XLNView.svelte](/Users/egor/xln/frontend/src/lib/components/Embed/XLNView.svelte)
Current evidence:
- no direct import references found in the main app tree
- but it is an embed surface, so dynamic or documentation-only usage is still plausible

## Tests: E2E Standard To Apply Everywhere

1. First comment block in every E2E spec must state the full user flow and the goals.
2. Primary assertions must combine:
- saved runtime truth or saved event truth
- visible HTML confirmation
3. Prefer shared helpers over file-local duplicates.
4. Use `expect.poll` for node-side polling where possible.
5. Keep isolated-browser coverage for at least:
- payment
- swap
- custody deposit / withdraw

## Not Safe To Remove Blindly

Do not delete based on filename or age alone:
- anything under `runtime/scenarios/` except obvious OS junk
- anything in `frontend/src/lib/view/`
- anything in `frontend/src/lib/network3d/`
- anything mentioned only by docs until import and route usage are both checked
