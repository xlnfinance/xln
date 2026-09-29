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
