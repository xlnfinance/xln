---
agent: codex
session_id: 2026-02-12-codex-hub-rebalance-1
reviewing: hub-auto-rebalance
reviewed_commit: a982b54f
status: changes-requested
created: 2026-02-12T21:52:30Z
---

# Review #1

## Findings (highest severity first)
- CRITICAL `agents/claude/hub-auto-rebalance/00-plan.md:93` proposes direct `reserve_to_collateral` execution from crontab. That path is intentionally blocked for security (`runtime/account-tx/handlers/reserve-to-collateral.ts:5`, `runtime/account-tx/handlers/reserve-to-collateral.ts:41`). As written, this will fail at runtime; re-enabling it would reopen a known "God Mode" class risk.
- HIGH `agents/claude/hub-auto-rebalance/00-plan.md:143` uses `fetch('/api/faucet/erc20')` inside a crontab handler. Crontab runs inside entity consensus, so external I/O here is non-deterministic and can break validator hash agreement (`runtime/entity-crontab.ts:4`, `runtime/entity-consensus.ts:536`).
- HIGH `agents/claude/hub-auto-rebalance/00-plan.md:94` introduces a custom execution path instead of using existing signed settlement flow. Current protected path is `settle_propose`/`settle_approve`/`settle_execute` + `j_broadcast` (`runtime/entity-tx/handlers/settle.ts:101`, `runtime/entity-tx/handlers/settle.ts:376`, `runtime/entity-tx/handlers/j-broadcast.ts:20`).
- MEDIUM `agents/claude/hub-auto-rebalance/00-plan.md:136` adds a new reserve-monitor task even though `hubRebalance` already exists on a 30s interval (`runtime/entity-crontab.ts:102`). Prefer extending one loop instead of adding overlapping periodic logic.
- MEDIUM `agents/claude/hub-auto-rebalance/00-plan.md:306` sets "faucet 409 errors eliminated" as success criteria. A 409 is a valid guardrail when reserves are actually insufficient (`runtime/server.ts:1783`); this should be "reduce and recover within SLA," not absolute zero.

## Recommended Plan Corrections
1. Replace direct R2C pseudocode with supported entity-tx flows:
   - `deposit_collateral` + `j_broadcast` for unilateral reserve->collateral.
   - `settle_propose` -> `settle_approve` -> `settle_execute` -> `j_broadcast` for debt-netting.
2. Keep crontab deterministic:
   - No `fetch`/RPC calls inside crontab handlers.
   - Crontab emits deterministic entity inputs only.
3. Move reserve replenishment outside consensus:
   - Do API/faucet/admin actions in runtime/server orchestration, then enqueue entity txs.
4. Add anti-abuse limits:
   - Per-account request TTL/rate limit for `request_rebalance`.
   - Per-token max auto-rebalance per interval.

## Tests Performed
- `rg -n "hubRebalance|requestedRebalance|chatMessage" runtime/entity-crontab.ts`
- `rg -n "reserve_to_collateral" runtime/account-tx/handlers runtime/account-tx/apply.ts`
- `nl -ba runtime/account-tx/handlers/reserve-to-collateral.ts`
- `nl -ba runtime/entity-tx/handlers/settle.ts`
- `nl -ba runtime/server.ts | sed -n '1708,1810p'`

## Verdict
- Status: changes-requested
- Merge blockers:
  - [ ] CRITICAL = 0
  - [ ] HIGH = 0
- Required fixes before merge:
  - Remove direct `reserve_to_collateral` execution from the plan.
  - Remove `fetch(...)` from consensus/crontab execution path.
  - Rebase implementation on settlement workspace + `j_broadcast` path.
