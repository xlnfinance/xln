# Current xln execution handoff

## Current SHA

- Deployment source commit: `ceb1d0522d20b171ca21803f152ecf3fd5875441`, `testnets_deploy`.
- Resolve the current documentation commit with `git rev-parse HEAD`; unrelated owner edits remain dirty.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`; unchanged by this task.
- Owner-approved MacBook M5 execution exception. Two local commits authorized; no push or public broadcast.

## Last green command

Read-only public preflight: 2/2 network/token/signer records, 16/16 independent
constructor estimates, 2/2 proxy observations and reference-header matches.
Both network records and the read-only probe invocations exited zero. Generated
local reports are excluded from the commits; this handoff records the
outcomes and the [operator guide](deployment/ignition-stack-design.md#next-public-preflight)
provides the refresh command.

`bun run check:deployment`: 6/6 gates, 274 Hardhat tests, 64 Foundry checks,
93 Bun tests / 3,505 assertions.
All 552 covered source and 181 artifact hashes still match the committed source
content. Documentation-only recording reuses that evidence; no broader profile
was run and no clean whole-product release is claimed.

## First red command/error

No unresolved failure in the selected read-only probes. The earlier missing-RPC
error is superseded: both configured RPCs now work. The complete eleven-operation
public deployment remains unrun, including the two bindings and signed listing.
The Account creation call failed at 16,777,216 gas on Ethereum, then returned
runtime at the actual 36,287,198 estimate; its exact low-gas failure reason was
not established. This is not recorded as a deployment failure.

## Artifact path

- Generated local verification reports are excluded from the commits.
- The next deployment will create native artifacts under
  `jurisdictions/ignition/deployments/eth-sepolia-ignition-01/`.
- [Operator guide](deployment/ignition-stack-design.md#next-public-preflight).

## Next single command

Later public deployment execution step only; this command signs and broadcasts.
It was checked with `--help`, not executed. Prerequisites: stand available,
unchanged tested candidate/artifacts, intended signer/key and both RPC variables
in `~/.config/xln/testnet-deployer.env`, fresh nonce/fee/state observations, no
concurrent signer use and an absent fresh deployment directory. Do not print secrets.

```sh
bun run stand:run --reason ethereum-sepolia-deployment --timeout-ms 600000 -- \
  node --env-file="$HOME/.config/xln/testnet-deployer.env" \
  node_modules/hardhat/dist/src/cli.js --config jurisdictions/hardhat.config.ts \
  xln-deploy --network ethereum-sepolia \
  --parameters "$PWD/jurisdictions/ignition/parameters/ethereum-sepolia.json" \
  --deployment-id eth-sepolia-ignition-01 --mode new
```

## Remaining final gates

- Native Ethereum Sepolia execution: eight creations, two bindings, one signed
  USDC listing; actual winning receipts with twelve confirmations, exact current
  linked code/bindings/token/foundation and receipt/balance expense accounting.
- Then separate fresh Arbitrum Sepolia ID `arb-sepolia-ignition-01` with its network
  and parameter file. Preserve both attempts' journals, artifacts and results;
  recover interruptions with the same ID and `--mode resume`.
- Public deposits/withdrawals/Cross-J and interrupted-transfer proof remain separate.
  Constructor estimates and local balances do not establish those outcomes.
- Discovery/Runtime activation and TS/Rust HTTP/UI integration are deferred consumers.
- Whole-product/mainnet acceptance still needs repository/browser/financial/release
  gates and one clean committed source SHA. No such acceptance is claimed here.
