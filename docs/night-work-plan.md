# Current xln execution handoff

The only handoff. Replace this file on each handoff; never append history (git keeps it).
The live queue is [todo.md](../todo.md); scope and authority are in [AGENTS.md](../AGENTS.md).

## Current SHA

- `main`: `<CURRENT_SHA>` (fill in with `git rev-parse --short HEAD` at handoff).
- Public testnet `xln.finance` (private chains 31337/31338) serves `e4abb8c14`:
  [rollout evidence](evidence/public-testnet-e4abb8c1-20261024.json).
- Uncommitted work from other agents may be present; preserve it.

## Last green command

- Public React wallet on `e4abb8c14`: `ui/tests/e2e-production-wallet.spec.ts`
  passed 6/6 (import 32.1 s, faucet 3.9 s, reserve 5.1 s, pay 6.4 s,
  credit 4.7 s, reload 20.1 s); all 131 hub Account roots and financial fields
  identical across the rollout.
- No full `bun run check` or `bun run gate:release` is recorded on any newer SHA.

## First red command/error

1. Unverified on the current SHA: run `bun run check`, then `bun run gate:release`,
   and record the first failure here. The last integrated release run (2026-10-18)
   failed the swap oracle at frame 48 (`eventBarrier` versus `submitted/txHash` in
   `lastResultFingerprint`); confirm whether it still reproduces before any fix.
2. Wallet import latency: 32.1 s, reload 20.1 s. Dominant phase is two full
   authenticated header passes from EntityProvider deployment
   (`core/jurisdiction/adapter/receipt/reader.ts`, range pass + fence pass, O(J height)).

## Artifact path

- `docs/evidence/public-testnet-e4abb8c1-20261024.json`
- `docs/evidence/cold-import-primary-first-20261024.json`
- `docs/evidence/cold-import-page-amortization-20261024.json`

## Next single command

```bash
bun run stand:status && bun run check && bun run stand:run --reason release -- bun run gate:release
```

## Remaining final gates

- Same-J Swap, Cross-swap and Lending on EVM and native TRON: browserless financial
  scenarios plus owning React E2E on one immutable candidate.
- Native TRON (TVM) four-flow evidence; two EVM simulators do not count.
- Public Sepolia financial proof on current bytecode (real clock disputes and exits).
- Wallet import/reload latency within the acceptance budget.
- Valid 1,000-user live TPS run (AGENTS.md TPS rules) and uninterrupted 1-hour soak.
- `bun run gate:mainnet` on the final clean SHA, then owner-reviewed deployment packet.

Mainnet readiness: UNKNOWN until every gate above passes on the same SHA.
