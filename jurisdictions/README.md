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
