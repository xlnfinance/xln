---
agent: codex
session_id: 2026-02-12-codex-hub-rebalance-2
reviewing: hub-auto-rebalance
reviewed_commit: 44407e40
status: changes-requested
created: 2026-02-12T22:39:25Z
---

# Review #2

## Findings (highest severity first)
- CRITICAL `agents/claude/hub-auto-rebalance/02-final-plan.md:94` and `agents/claude/hub-auto-rebalance/02-final-plan.md:147` reintroduce async gas-price reads inside crontab handlers. This is the same determinism break class as `fetch()` in consensus and can cause proposer/validator divergence (`runtime/entity-crontab.ts:4`, `runtime/entity-consensus.ts:541`).
- HIGH `agents/claude/hub-auto-rebalance/02-final-plan.md:163` uses `entityTx.type = 'updateConfig'`, but this tx type does not exist in the current union/handlers (`runtime/types.ts:480`, `runtime/entity-tx/apply.ts:1064`). As written, it will be unhandled and have no effect.
- HIGH `agents/claude/hub-auto-rebalance/02-final-plan.md:238` relies on request timestamps for batch windowing, but `requestedRebalance` only stores amount (`Map<number, bigint>`) with no `requestedAt` (`runtime/types.ts:1057`, `runtime/account-tx/handlers/request-rebalance.ts:15`).
- HIGH `agents/claude/hub-auto-rebalance/02-final-plan.md:486` claims user reserves are debited for fees in V1 while V1 also skips cooperative pull/C2R (`agents/claude/hub-auto-rebalance/02-final-plan.md:417`). Current hub-side txs spend hub reserves only (`runtime/entity-tx/handlers/deposit-collateral.ts:27`, `runtime/entity-tx/handlers/reserve-to-reserve.ts:27`), so fee-debit economics are not implementable in this scope.
- MEDIUM `agents/claude/hub-auto-rebalance/02-final-plan.md:223` lowers interval to 10s but doesn’t account for `pendingBroadcast` lock. After `j_broadcast`, new batch additions are blocked until J confirmation (`runtime/entity-tx/handlers/j-broadcast.ts:96`, `runtime/j-batch.ts:342`), so naive every-10s execution can repeatedly fail.

## Required Scope Correction for Approval
1. Keep V1 deterministic: no live gas reads in crontab; use static fee config or state already present in replica.
2. Drop `updateConfig` from V1 unless you first add a real tx type + handler.
3. Add explicit state for batching metadata (e.g., request timestamp) or remove age-window logic.
4. Decide one economic model for V1:
   - A) Hub-funded rebalance (no user fee debit), or
   - B) Full cooperative fee collection flow (requires additional bilateral steps).
5. Add `pendingBroadcast` guard in rebalance task before adding new jBatch ops.

## Tests Performed
- `nl -ba agents/claude/hub-auto-rebalance/02-final-plan.md`
- `nl -ba runtime/types.ts | sed -n '470,770p'`
- `nl -ba runtime/types.ts | sed -n '1028,1078p'`
- `nl -ba runtime/account-tx/handlers/request-rebalance.ts`
- `nl -ba runtime/entity-tx/apply.ts | sed -n '1028,1080p'`
- `nl -ba runtime/entity-tx/handlers/deposit-collateral.ts`
- `nl -ba runtime/entity-tx/handlers/reserve-to-reserve.ts`
- `nl -ba runtime/entity-tx/handlers/j-broadcast.ts | sed -n '1,180p'`
- `nl -ba runtime/j-batch.ts | sed -n '320,390p'`

## Verdict
- Status: changes-requested
- Merge blockers:
  - [ ] CRITICAL = 0
  - [ ] HIGH = 0
- Required fixes before merge:
  - Remove non-deterministic gas reads from consensus path.
  - Align plan to existing tx surface (or explicitly add missing tx types first).
  - Resolve V1 fee model contradiction and batching data-model gaps.
