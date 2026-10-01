# Deploying the frozen contract set

Everything here is prepared; nothing here deploys to a live network by itself. A live deploy waits for Arthur's word.

| File | What it is |
| --- | --- |
| `sepolia.manifest.json` | The prepared manifest for Ethereum Sepolia (chain 11155111): the dispute-window floors (60 s build floor, 21 600 s mainnet floor), `HANKO_PRELUDE_GAS` 4 900 000, the batch gas total 5 437 937 and its ceiling, the faucet token to list, and an empty `peers` slot for the static peer table (Q-T-4). No address, no key. |
| `manifest.ts` | The manifest type and its validator. A deployed manifest must carry every contract with address, block, transaction hash, gas used and the code hash the chain holds. |
| `deploy-set.ts` | Deploys the eight contracts, binds the Depository, lists the token through the Foundation, writes a deployed manifest. |
| `smoke.ts` | Runs on a deployed manifest: fund and deposit, open, a cooperative signed batch, a dispute start and finalize from the implicit proof and from a signed proof. Any failed or skipped batch fails it. |
| `dry-run.ts` | Starts a throw-away anvil, deploys, smoke-tests, stops anvil. `--fork <rpc>` makes it an anvil fork (reads only; every transaction stays in anvil's memory). |

## Commands

```sh
export PATH=$PATH:/foundry                     # anvil
bash contracts/scripts/build.sh                # the build the manifest is checked against
bun contracts/deploy/dry-run.ts                # plain anvil, chain 31337
bun contracts/deploy/dry-run.ts --fork https://ethereum-sepolia-rpc.publicnode.com   # anvil fork of Sepolia, chain 11155111
bun test contracts/test/gate/deploy-guards.test.ts contracts/test/gate/deploy-dry-run.test.ts   # the refusals and the dry run, as tests (anvil needed, a missing anvil fails)
```

The live deploy, once Arthur says so (the only command here that sends a transaction to a real network):

```sh
DEPLOYER_PRIVATE_KEY=... bun contracts/deploy/deploy-set.ts --rpc <sepolia rpc> --live   # writes the result into sepolia.manifest.json
bun contracts/deploy/smoke.ts --rpc <sepolia rpc> --manifest contracts/deploy/sepolia.manifest.json --live
```

## What is refused before anything is sent

A node whose chain id is not the manifest's; an RPC that is not this machine without `--live`; a chain the deploy gate refuses (the 60 s floor on a chain that is not a named testnet); a manifest whose floors, `HANKO_PRELUDE_GAS` or batch gas total differ from the compiled build, or whose total is above `maxRequiredTxGas`; a build that needs more than the chain's transaction gas cap; a manifest that is already deployed; a dry run without `--out` (it cannot overwrite the prepared manifest). Any single deployment above the transaction gas cap or above EIP-170 fails after it is mined and before the next one.

## Keys

None are stored. `DEPLOYER_PRIVATE_KEY` is read from the environment. On a loopback node with no key set, anvil's public dev account #0 signs; on any other RPC no key means no deploy. The Foundation board is the 1-of-1 deployer, so the deployer key is also the key that lists the token.

## Smoke test on a live network

It sends real transactions and spends testnet ETH, so it also needs `--live`. The dispute finalize waits the real floor (60 s start window plus 60 s response window) when the node cannot advance time.
