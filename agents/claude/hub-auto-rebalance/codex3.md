---
agent: codex
session_id: 2026-02-13-codex-hub-rebalance-3
reviewing: hub-auto-rebalance
reviewed_commit: 2620da87
status: approved_with_notes
created: 2026-02-13T18:19:44Z
---

# Review #3

## Findings (highest severity first)
- HIGH `agents/claude/hub-auto-rebalance/03-understanding-check.md:74` and `agents/claude/hub-auto-rebalance/03-understanding-check.md:281` imply live gas reads during policy evaluation. In consensus/crontab this is non-deterministic and must not call external gas sources (`runtime/entity-crontab.ts:175`, `runtime/entity-consensus.ts:541`).
- MEDIUM `agents/claude/hub-auto-rebalance/03-understanding-check.md:315` assumes direct fee deduction from user reserve by hub. Current tx surface does not support unilateral debit of peer reserve; hub-side flows spend hub reserve (`runtime/entity-tx/handlers/deposit-collateral.ts:27`, `runtime/entity-tx/handlers/reserve-to-reserve.ts:27`).
- MEDIUM `agents/claude/hub-auto-rebalance/03-understanding-check.md:71` uses `% of totalCapacity` as relative target. `totalCapacity` includes credit limits and can change with holds/credit adjustments, so this may oscillate unless you add hysteresis (`runtime/types.ts:1195`).

## Direct Answers
1. Relative policy interpretation: mostly correct.
   - Good: defer rebalance when fee/amount is too high.
   - Add: hysteresis band (example: trigger below 75%, stop at 82%) to avoid churn.
2. Can crontab read current gas price: no (not from network/oracle).
   - Deterministic options:
   - Use static fee schedule in state/config.
   - Or have server/orchestrator publish fee params periodically, then crontab reads stored values.
3. Fee deduction mechanism:
   - Must be explicit bilateral/economic flow, not hidden reserve subtraction.
   - Practical V1: requester prepays via explicit tx flow (or accepts quoted fee before request), then hub executes rebalance.
4. Profit margin:
   - Use floor pricing: `fee >= estimated_cost * buffer + min_profit`.
   - Keep estimate deterministic in consensus (config/state snapshot), not live RPC.
5. Multi-token cost model:
   - Use deterministic approximation: `base + per_token * n`.
   - Shared-overhead model is fine for policy decisions; settle exact economics off-consensus.

## Architecture Notes
- Hierarchical overrides (entity -> account -> token) are sound, but implement in phases.
- For V1, start with:
  - `manual` + `absolute`.
  - static fee config advertised in gossip metadata (custom fields are allowed; profile metadata is extensible) (`runtime/networking/gossip.ts:55`).
- Add `relative` only after fee/orchestration plumbing is stable.

## Tests Performed
- `nl -ba agents/claude/hub-auto-rebalance/03-understanding-check.md`
- `nl -ba runtime/types.ts | sed -n '924,1040p'`
- `nl -ba runtime/types.ts | sed -n '1140,1210p'`
- `nl -ba runtime/entity-tx/handlers/deposit-collateral.ts`
- `nl -ba runtime/entity-tx/handlers/reserve-to-reserve.ts`
- `nl -ba runtime/entity-crontab.ts | sed -n '175,194p'`
- `nl -ba runtime/entity-consensus.ts | sed -n '536,556p'`
- `nl -ba runtime/networking/gossip.ts | sed -n '23,56p'`

## Verdict
- Status: approved_with_notes
- Merge blockers:
  - [x] CRITICAL = 0
  - [ ] HIGH = 0
- Required fixes before merge:
  - Keep gas-price resolution out of consensus logic.
  - Specify explicit fee-payment flow (no unilateral reserve debits).
  - Add hysteresis if using relative-capacity policy.
