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
| H3 | evidence that verifies only under a retired board settles clamped to `[0, collateral]`: no reserves drawn, no debt | `h3-retired-board-cap` |

Reasons and options: `plan/contracts-decisions.md`. `scripts/deploy-gate.cjs` refuses `MIN_RESPONSE_SECONDS` below 6 hours on any chain that is not a named testnet (`test/gate/`). CI: the `contracts-fork` job rebuilds, checks `typechain-types` is current and runs every `test/vm` and `test/gate` file in its own process.

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
