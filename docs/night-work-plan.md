# Current xln execution handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

## Current SHA

- `main`: `62af9959b` (2026-10-27).
- Public testnet `xln.finance` (private chains 31337/31338) still serves `e4abb8c14`:
  [rollout evidence](evidence/public-testnet-e4abb8c1-20261024.json). Not redeployed since.
- Uncommitted work from other agents may be present in other checkouts; preserve it.

## Last green command

- `bun run gate:release` on `31f080d3d`: 40/40 steps, 1088 s
  ([evidence](evidence/release-gate-31f080d3-20261027/result.json)).
- `bun run test:e2e:full` 157/157 in 516 s on `c25cdcf6d` (before the J catch-up fence landed).

## First red command/error

1. `bun run test:e2e:full` on `62af9959b`: `tests/e2e/payments/e2e-rebalance-bar.spec.ts:1658`
   "persistence: mined rebalance survives H1 and user restart exactly once" — after the user
   reload the rebalance state never reaches requested 0 / uncollateralized 0 / finalized at the
   mined J height within 60 s. Passed before `e3b434a7c` (J catch-up fence); under investigation.

## Artifact path

- `docs/evidence/release-gate-31f080d3-20261027/result.json`
- Mac Studio: `/tmp/e2e-run21.log`, `/tmp/run21-shard43/` (failing shard copy).

## Next single command

```bash
bun run test:e2e:full && bun run gate:release
```

Run both on one SHA. Do not wrap `gate:release` in `stand:run`: its steps take the stand
themselves and the wrapper's default 30 s timeout kills it. Exact reruns that the runner
demands (`BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED`) must pass before a broad run starts.

## Open decisions and known gaps

- Owner fork (bad RPC → pause jurisdiction): peer-originated J-dependent Account frames while a
  jurisdiction is paused — A) per-Entity not-ready to peers, senders keep outputs in their
  committed outbox, or B) paused set as a WAL Runtime input and Accounts withhold ACK. The local
  command fence is ready as an unlanded patch.
- Hub/MM crash when a quiesce arrives during startup bootstrap
  (`RUNTIME_INPUT_INGRESS_AFTER_PERSISTENCE_PAUSE`): fix in progress.
- Wallet RPC snapshot reads at a numeric height are not authenticated against a header root.

## Remaining final gates

- Same-J Swap, Cross-swap and Lending on EVM and native TRON: browserless scenarios plus owning
  React E2E on one immutable candidate (EVM React steps are green in `gate:release`).
- Native TRON (TVM) four-flow evidence; receipt-authentication trust decision is open.
- Public Sepolia financial proof on current bytecode (real-clock disputes and exits).
- Public testnet redeploy of the current candidate with served-SHA browser verification.
- Valid 1,000-user live TPS run (AGENTS.md TPS rules) and uninterrupted 1-hour soak.
- `bun run gate:mainnet` on the final clean SHA, then owner-reviewed deployment packet.

Mainnet readiness: UNKNOWN until every gate above passes on the same SHA.
