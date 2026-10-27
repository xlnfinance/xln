# Current xln execution handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

## Current SHA

- Release candidate: `e838188fd` (2026-10-27) — full browser E2E and `gate:release` both green.
- Public testnet `xln.finance` (private chains 31337/31338) still serves `e4abb8c14`:
  [rollout evidence](evidence/public-testnet-e4abb8c1-20261024.json). Not redeployed since.
- Uncommitted work from other agents may be present in other checkouts; preserve it.

## Last green command

- On `e838188fd`, Mac Studio
  ([evidence](evidence/release-candidate-e838188f-20261027/result.json)):
  - `bun run test:e2e:full`: 157/157, strict browser health 0 issues, 514 s.
  - `bun run gate:release`: 40/40 steps.

## First red command/error

- None on the candidate. Next gates are not yet run (see below).

## Artifact path

- `docs/evidence/release-candidate-e838188f-20261027/result.json`
- Mac Studio: `/tmp/e2e-run30.log`, `/tmp/gate-release-run30.log`, `/tmp/run30/`.

## Next single command

```bash
bun run test:e2e:full && bun run gate:release
```

Run both on one SHA. Do not wrap `gate:release` in `stand:run`: its steps take the stand
themselves and the wrapper's default 30 s timeout kills it. `gate:release` cleans
`.logs/e2e-parallel` and `.logs/gates`; copy a failing run's directory before starting it.
Exact reruns that the runner demands (`BROAD_RUN_BLOCKED_EXACT_RERUN_REQUIRED`) must pass
before a broad run starts.

## Open decisions and known gaps

- Owner fork (bad RPC -> pause jurisdiction): peer-originated J-dependent Account frames while a
  jurisdiction is paused — A) per-Entity not-ready to peers, senders keep outputs in their
  committed outbox, or B) paused set as a WAL Runtime input and Accounts withhold ACK. The local
  command fence is ready as an unlanded patch.
- Wallet RPC snapshot reads at a numeric height are not authenticated against a header root.
- `anvil_reset` is still used for used dev chains; runner-owned anvil restarts would remove it.

## Remaining final gates

- Public testnet redeploy of the candidate with served-SHA browser verification.
- Native TRON (TVM) four-flow evidence; receipt-authentication trust decision is open.
- Public Sepolia financial proof on current bytecode (real-clock disputes and exits).
- Valid 1,000-user live TPS run (AGENTS.md TPS rules) and uninterrupted 1-hour soak.
- `bun run gate:mainnet` on the final clean SHA, then owner-reviewed deployment packet.

Mainnet readiness: UNKNOWN until every gate above passes on the same SHA.
