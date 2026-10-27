# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release queue, not a product
backlog; long-term work belongs in `docs/roadmap.md`. Scope and authority come from
[AGENTS.md](AGENTS.md) RELEASE SCOPE (2026-10-18); the current execution handoff is
[docs/night-work-plan.md](docs/night-work-plan.md). Delete an item when it is done.

## Release scope

Pay, same-J Swap, Cross-swap and Lending on EVM and native TRON, served by the React
`ui/` wallet. Open participation with users' own funds; no protocol monetary cap.
Testnet evidence never authorizes real-funds activation.

## Blockers, in order

1. Done on `e838188fd`: full browser E2E 157/157 and `gate:release` 40/40 on one SHA
   ([evidence](docs/evidence/release-candidate-e838188f-20261027/result.json)). Keep it green
   on every later candidate.
2. Same-J Swap, Cross-swap and Lending: browserless financial scenarios plus owning React
   E2E on one immutable candidate. Public `xln.finance` proves only import, faucet,
   reserve, pay, credit and reload (6/6 on `e4abb8c14`).
3. Native TRON: genuine TVM/native RPC/event/finality evidence for all four flows. The
   validating-node trust decision for receipt authentication is open in
   [docs/tron-native-test-plan.md](docs/tron-native-test-plan.md).
4. Public Sepolia on current bytecode with a real clock: three disputes (own collateral;
   counterparty owes beyond collateral → exact payout plus debt row; stale dispute against
   an offline wallet → watchtower counters) and secured/unsecured exits.
5. Wallet import latency (32.1 s) and reload (20.1 s): remove the duplicate authenticated
   header pass in `core/jurisdiction/adapter/receipt/reader.ts`.
6. Valid 1,000-user live TPS run under the AGENTS.md rules (last run: 20,000 payments,
   zero pending ACKs, drain 26,183 ms against the unchanged 25,000 ms limit).
7. Uninterrupted one-hour soak and `bun run gate:mainnet` on the final clean SHA.
8. Real mainnet operations documented and drilled: chain/RPC, operator keys, tower gas
   policy, backup/restore and last-resort dispute drills, monitoring thresholds, rollback.
9. Solidity 2^200 money domain: coherent arithmetic and transformer ABI decision pending
   owner confirmation in [docs/money-domain.md](docs/money-domain.md). Do not claim all
   contract monetary ceilings are gone.
10. Classify every runtime exception as `drop`, `defer`, `debug-assert` or `fatal` (open P1
    from the former status queue; no closure evidence yet).
11. Release review packets for authorized reviewers include the documented consensus/Hanko
    and contract-governance manual-review questions (the scans run in `security:audit-pack`).
12. Rust financial parity and the history-reader counterexamples (carried from the former
    handoff; Rust is the second engine for high-TPS hubs, not a launch blocker for TS).
13. R2C guard with runtime parity (delegated 2026-10-14; mark done only with a cited SHA/test).

## Product and network work that gates public launch

- Honest CI green on `main`, 10 consecutive runs.
- TS = Solidity entitlement differential harness.
- Account-level recovery coverage UI with tower receipt/failure visibility.
- Explicit token support boundary: prove multi-token E2E or label the wallet single-token.
- Two market makers and three independent hub operators; our H1–H3/MM are the
  engineering stand, not independent failure domains. Prove H2 failure while an
  independently funded H1–H3 route stays executable ([launch design](docs/launch-design.md)).
- MML v0 formula in `docs/intro.md`: unaffiliated obligations only; a hub-routed payment
  counts once, on the commercial edge.
- Owner: 10 conversations with OTC/MM/payout firms → at least 2 written intents.

## Release evidence contract

The candidate is publishable only after all of the following are green on the same bytes
and the independent contract/runtime audit (each bug and fix confirmed by >=3 different
AIs; external sign-off optional) reports no blocker:

- `bun run check`
- `bun run gate:release`
- `bun run gate:mainnet` (includes the one-hour soak)
- post-deploy `bun run prod:health`
- fully green unit tests, deterministic scenarios and browser E2E on the same immutable
  candidate bytes

Any new blocker is added here immediately and removes release authority until fixed and
re-gated.
