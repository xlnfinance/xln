# Deploying the frozen contract set

Everything here is prepared; nothing here deploys to a live network by itself. A live deploy waits for Arthur's word.

| File | What it is |
| --- | --- |
| `sepolia.prepared.manifest.json` | The prepared manifest for Ethereum Sepolia (chain 11155111): the dispute-window floors (60 s build floor, 21 600 s mainnet floor), `HANKO_PRELUDE_GAS` 4 900 000, the batch gas total 5 437 937 and its ceiling, the faucet token to list, and an empty `peers` slot for the static peer table (Q-T-4). No address, no key. |
| `sepolia.manifest.json` | The live record: what `deploy-set.ts --live` wrote on 2026-10-01 (chain 11155111, eight contracts, the faucet token as id 1). Never an input, never overwritten: a deploy refuses to write over it. |
| `manifest.ts` | The manifest type and its validator. A deployed manifest must carry every contract with address, block, transaction hash, gas used and the code hash the chain holds. |
| `deploy-set.ts` | Deploys the eight contracts, binds the Depository, lists the token through the Foundation, writes a deployed manifest. |
| `verify.ts` | Read-only. Compares the deployed code with the current build: for each of the eight contracts and the faucet token it rebuilds the runtime code from the compiled artifact (library addresses substituted into the link slots, every immutable set to the value the deploy gave it), reads the code at the manifest's address through a public RPC, and prints `match` or `differ` per contract. Exit 0 only when every contract matches, 1 when any differs, 2 when the check could not be made. |
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

Is what Sepolia holds the code of the current build? Read-only, no key, no `--live`:

```sh
bash contracts/scripts/build.sh                                    # the build to compare against (verify.ts refuses an artifact older than its source)
bun contracts/deploy/verify.ts                                     # the manifest in this folder, https://ethereum-sepolia-rpc.publicnode.com
bun contracts/deploy/verify.ts --rpc <any sepolia rpc> --manifest contracts/deploy/sepolia.manifest.json
bun test contracts/test/gate/deploy-verify.test.ts                 # the comparison itself, against a fake node: every way a chain can differ, planted one at a time
```

A contract is `match` only when the chain's code equals the rebuilt code byte for byte (the first differing byte is named, as compiled code, as a link slot for a library, or as a named immutable) and its keccak256 equals the manifest's `codeHash`. `differ` has two causes that read differently: the chain differs from the manifest's own hash (the manifest does not describe that address), or the chain still equals the manifest and the current build has moved on (a contract changed after the deploy, so the deployed set is no longer the set `main` builds). The only calls it makes are `eth_chainId`, `eth_blockNumber` and `eth_getCode` (every `eth_getCode` is read at the one block `eth_blockNumber` answered, so the nine codes are one moment of the chain; the test suite asserts that block on each read); the test suite asserts no other method and no key is ever used. A build older than the sources it imports is refused (exit 2), so an edited source cannot print `match` against code compiled from the old one.

The live deploy, once Arthur says so (the only command here that sends a transaction to a real network):

```sh
DEPLOYER_PRIVATE_KEY=... bun contracts/deploy/deploy-set.ts --rpc <sepolia rpc> --live   # writes the result into sepolia.manifest.json
bun contracts/deploy/smoke.ts --rpc <sepolia rpc> --manifest contracts/deploy/sepolia.manifest.json --live
```

## What is refused before anything is sent

A node whose chain id is not the manifest's; an RPC that is not this machine without `--live`; a chain the deploy gate refuses (the 60 s floor on a chain that is not a named testnet); a manifest whose floors, `HANKO_PRELUDE_GAS` or batch gas total differ from the compiled build, or whose total is above `maxRequiredTxGas`; a build that needs more than the chain's transaction gas cap; a manifest that is already deployed; a dry run without `--out` (it cannot overwrite the prepared manifest). Any single deployment above the transaction gas cap or above EIP-170 fails after it is mined and before the next one.

## Keys

None are stored. `DEPLOYER_PRIVATE_KEY` is read from the environment, and only with `--live`. Without `--live` (every dry run, every test) anvil's public dev account #0 signs on the loopback node and the variable is ignored even when it is set; with `--live` and no key a loopback node still gets the dev account and any other RPC gets no deploy. The Foundation board is the 1-of-1 deployer, so the deployer key is also the key that lists the token.

## Smoke test on a live network

It sends real transactions and spends testnet ETH, so it also needs `--live`. The dispute finalize waits the real floor (60 s start window plus 60 s response window) when the node cannot advance time.
