# xln contracts (ours)

Fork of `jurisdictions/` at og 566c850. `jurisdictions/` stays frozen as the og reference and is never edited; this
directory is the contract source of truth for the spec and for testnet. The first commit here is a byte-identical copy
(the build reproduces og's `typechain-types` exactly); every later commit is a reviewed change with a test that fails
before it and passes after it.

- Build: `contracts/scripts/build.sh` compiles with Hardhat and regenerates the committed `typechain-types/`.
- Tests that run the real stack in BrowserVM live in `test/vm/` (bun). They load this fork's bytecode into og's BrowserVM
  through `test/vm/rig.ts`, without editing `core/`. Run one file per process: `bun test contracts/test/vm/<area>/<file>`.
- The inherited Hardhat mocha suites under `test/dispute`, `test/governance` and `test/protocol` are unchanged copies. Several fail on this toolchain before any
  change (chai matcher version, missing og fixture); the baseline counts are in `BASELINE.md`. No gate runs them, so they are listed in
  `pure/rules/checks/contract-tests.ts` (`HARDHAT_ONLY`). Every other contract test must sit where a gate runs it: `test/vm/<area>/`, `test/gate/` or
  `test/foundry/` (`bun rules/check.ts --tests-only` in `pure/`, part of the one gate). `DisputeHashVector` and the A12 test were moved there.

## Changes from og (each has a BrowserVM test in `test/vm/`)

| id | change | test |
|---|---|---|
| C1 | `ondeltaEpoch` bound into dispute proofs and settlements; advances on settlement, C2R and finalize, not R2C | `c1-epoch` |
| C2 | `processBatch(entityId, ...)`, batch hanko binds the entity, domain V2 | `c2-batch-entity` |
| H1 | finalize reverts `PaymentRevealWindowActive(deadline)` for an unrevealed HTLC until its deadline, unless the secret is public | `h1-htlc-deadline` |
| H2 | both response windows of every proof body must be at least `MIN_RESPONSE_SECONDS` (60 s, testnet only; mainnet needs hours), else `ResponseWindowTooShort` | `h2-window-floor` |
| H3 | evidence signed by a retired board still counts, but a dispute settling on it cannot make the retired side pay from reserves (retired Left clamped at Δ ≥ 0, retired Right at Δ ≤ collateral); what the retired entity is owed is never clamped | `h3-retired-board-cap` |
| J2 | inside `processBatch`, a dispute op that is stale or already applied (a start the Account moved past or that is already open, a counter already registered, superseded, late or for no open dispute, a finalize for no open dispute or another dispute's nonce) is skipped with `DisputeOpSkipped(sender, counterentity, op, reason, nonce)` instead of reverting the batch, so an HTLC secret reveal in the same batch still lands. A bad signature or hanko, malformed evidence, the wrong sender and a finalize that is only early still revert. The watchtower entrypoint keeps reverting. Skip reasons are tested before the wrong-sender and evidence-body checks, so those revert only while the op is otherwise live (a wrong-sender counter after the window is a skip). Reason 7 can still upgrade `disputeRetiredSide` to 0 before it skips | `j2-skip-stale-dispute-ops` |
| J5 | a batch with no dispute, reveal, hash-ladder or external-deposit op whose ops cannot apply returns normally: nothing applies, the entity nonce stays spent, `BatchFailed(entityId, nonce, reason)` says why (the 4-byte error selector). Still reverting, no nonce: a failure of the batch's own hanko (E4 in the outer check), a wrong nonce, malformed or oversize batches, a batch offered less gas than its signed budget needs, and batches carrying dispute, reveal, hash-ladder or deposit ops (deposits pull from the caller, so a relayer must not burn the nonce). A bad counterparty signature inside the ops (a settlement or C2R signed at an old account epoch) is a `BatchFailed` E4 with the nonce spent. Spec rule: dispute, reveal, hash-ladder and deposit ops never share a batch with payment, settlement or reserve ops. The batch carries a signed gas budget (`gasBudget`, in the signed bytes, at least 500,000): the ops run with exactly that gas, so the outcome never depends on the relayer's gas. A transaction with less than `budget * 64 / 63 + 30,000` (the fixed reserve that lets the call hand over the whole budget) reverts `BatchGasStarved` with no nonce; once the self-call has had the budget, every failure inside it, out-of-gas and gas-burning callees included, is `BatchFailed`, and only the 4-byte revert selector is read, so a return-bomb cannot cost more gas (G1). An empty revert reason is `BatchFailed(0)`. A third party making the batch dearer between simulation and inclusion leads to `BatchFailed` with the nonce spent, not a stall (accepted). Spec rule R-SIMULATE: sign only after the batch simulates at the head, with a named margin on the budget, never above the chain's transaction gas cap, and never a time-gated op before its gate opens. The deploy gate refuses a chain whose cap cannot cover the hanko prelude (with intrinsic gas) for 128 signing validators plus the minimum budget. The Runtime signs only after a simulation at the final budget, sized from the applyBatch gas. Dispute, counter, finalize and ladder ops that another party's move made permanently impossible are skipped with `DisputeOpSkipped`, not reverted, so they never pin the entity nonce (S1); a dispute start signed at an old account epoch is skipped too (`ondeltaEpoch` in the start, reason 11). Spec rule R-COSIGN: a batch with a co-signed op (settlement, C2R) carries only ops for that one Account. R2C pair total cap 256 to 250 (max batch measured 14,763,601 gas) | `j5-batch-failed`, `j5-review-extra`, `j5-gas-budget`, `j5-gas-callee`, `j5-gas-prelude`, `j5-gas-exact`, `j5-fourth-budget`, `J5Budget`, `J5BudgetBoundary`, `J5Starve`, `j5b-review-extra`, `j5-stuck-nonce`, `j5-cosign-veto`, `J5Attacks` |
| SW | out-of-gas is never a normal outcome (R-OOG). `DeltaTransformer._decodeArguments` swallowed a decode that ran out of gas as "no evidence", so a finalize that should pay could land unpaid at a transaction gas limit the relayer chose. It now reverts `DecodeGasBudgetUnavailable` (a) when `gasleft() < 50,000 + 8 * length`, a fast path for plain decodes, and (b) after the catch when the caller kept only about 1/64 of its gas, which means the decode was starved (the bound: no size, shape or memory assumption; the 8 a byte alone is unsound, two arrays can read the same words). The control-lane reads of a listed Depository in `EntityProvider` are a gas-capped one-word read, so one broken Depository cannot brick the lane. Every other try/catch and low-level call was audited (table in `plan/contracts-decisions.md`, "Swallowed failures"): the ERC-1271 member call reads starvation as "invalid" but every consumer reverts on invalid (swept), the rest revert or are guarded. `test/gate/swallowed-failures.test.ts` reads the compiled AST and fails when a site is added, removed or moved | `j5-fifth-transformer-gas`, `GasSwallow`, `GasGuardUnpaid`, `ReviewB`, `ControlLaneFaultIsolation`, `swallowed-failures`, `BoardRotationAuthority` (gas sweep) |

Reasons and options: `plan/contracts-decisions.md`. `scripts/deploy-gate.cjs` refuses `MIN_RESPONSE_SECONDS` below 6 hours on any chain id that is not a named testnet, on every deploy path, reading the compiled build (`test/gate/`). The TRON deploy path (`deploy-chain-matrix.cjs` with `compile-tron.cjs`) has never been run end to end here; only the gate in front of it is tested. `deployTron` gates on its own because other scripts call it directly. **Do not use the root `bun run deploy:chains:mainnet` or `deploy:mainnets`, nor anything in `jurisdictions/`:** they deploy og's unfixed `jurisdictions/` contracts, with no response-window floor and no gate (`core/` and `jurisdictions/` are frozen, so we cannot make them refuse). Mainnet deploys go through `cd contracts && bun run deploy:chains:mainnet`. CI: the `contracts-fork` job rebuilds, checks `typechain-types` is current, and runs every `test/vm` and `test/gate` file (including the EIP-170 size check) in its own process.

---

# xln jurisdiction contracts

The only production deployment path is the chain matrix, which deploys and
verifies the complete immutable contract graph in one operation:

```sh
bun run compile
bun run deploy:chains:testnet
bun run deploy:chains:mainnet
```

`deploy:chains:mainnet` requires the configured production RPCs, deployer key,
foundation address, real token addresses, and an explicit confirmation. It
refuses to overwrite an existing target unless the operator deliberately uses
the replacement workflow. The generated deployment evidence is written only
after every selected chain succeeds; activation remains a separate reviewed
configuration change.

Do not invoke Hardhat Ignition or individual deployment scripts directly.
They cannot produce the complete cross-chain release evidence required by the
runtime readiness gate.
