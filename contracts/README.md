# xln contracts (ours)

Fork of `jurisdictions/` at og 566c850. `jurisdictions/` stays frozen as the og reference and is never edited; this
directory is the contract source of truth for the spec and for testnet. The first commit here is a byte-identical copy
(the build reproduces og's `typechain-types` exactly); every later commit is a reviewed change with a test that fails
before it and passes after it.

- Build: `contracts/scripts/build.sh` compiles with Hardhat and regenerates the committed `typechain-types/`.
- Tests that run the real stack in BrowserVM live in `test/vm/` (bun). They load this fork's bytecode into og's BrowserVM
  through `test/vm/rig.ts`, without editing `core/`. Run one file per process: `bun test contracts/test/vm/<file>`.
- The inherited Hardhat mocha suites under `test/` are unchanged copies. Several fail on this toolchain before any change
  (chai matcher version, missing og fixture); the baseline counts are in `BASELINE.md`.

## Changes from og (each has a BrowserVM test in `test/vm/`)

| id | change | test |
|---|---|---|
| C1 | `ondeltaEpoch` bound into dispute proofs and settlements; advances on settlement, C2R and finalize, not R2C | `c1-epoch` |
| C2 | `processBatch(entityId, ...)`, batch hanko binds the entity, domain V2 | `c2-batch-entity` |
| H1 | finalize reverts `PaymentRevealWindowActive(deadline)` for an unrevealed HTLC until its deadline, unless the secret is public | `h1-htlc-deadline` |
| H2 | both response windows of every proof body must be at least `MIN_RESPONSE_SECONDS` (60 s, testnet only; mainnet needs hours), else `ResponseWindowTooShort` | `h2-window-floor` |
| H3 | evidence signed by a retired board still counts, but a dispute settling on it cannot make the retired side pay from reserves (retired Left clamped at Δ ≥ 0, retired Right at Δ ≤ collateral); what the retired entity is owed is never clamped | `h3-retired-board-cap` |
| J2 | inside `processBatch`, a dispute op that is stale or already applied (a start the Account moved past or that is already open, a counter already registered, superseded, late or for no open dispute, a finalize for no open dispute or another dispute's nonce) is skipped with `DisputeOpSkipped(sender, counterentity, op, reason, nonce)` instead of reverting the batch, so an HTLC secret reveal in the same batch still lands. A bad signature or hanko, malformed evidence, the wrong sender and a finalize that is only early still revert. The watchtower entrypoint keeps reverting. Skip reasons are tested before the wrong-sender and evidence-body checks, so those revert only while the op is otherwise live (a wrong-sender counter after the window is a skip). Reason 7 can still upgrade `disputeRetiredSide` to 0 before it skips | `j2-skip-stale-dispute-ops` |
| J5 | a batch with no dispute, reveal, hash-ladder or external-deposit op whose ops cannot apply returns normally: nothing applies, the entity nonce stays spent, `BatchFailed(entityId, nonce, reason)` says why (the 4-byte error selector). Still reverting, no nonce: a failure of the batch's own hanko (E4 in the outer check), a wrong nonce, malformed or oversize batches, an op that fails with an empty reason, and batches carrying dispute, reveal, hash-ladder or deposit ops (deposits pull from the caller, so a relayer must not burn the nonce). A bad counterparty signature inside the ops (a settlement or C2R signed at an old account epoch) is a `BatchFailed` E4 with the nonce spent. Spec rule: dispute, reveal, hash-ladder and deposit ops never share a batch with payment, settlement or reserve ops. A gas guard reverts `BatchGasStarved` when a failure left under 1/32 of the gas. R2C pair total cap 256 to 250 (max batch measured 14,763,601 gas) | `j5-batch-failed`, `j5-review-extra`, `J5Attacks` |

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
