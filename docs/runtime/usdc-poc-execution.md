# Execute the headless USDC PoC

The financial CLI restores the selected user WAL and uses the existing ingress,
Cross-J, signed cover and withdrawal commands. A campaign permits one to five
sequential deposits of exactly 1,000,000 source USDC units. Each completed run
must pay at least 850,000 units to the user's target signer EOA, with no source
remainder and a source-to-payout difference no greater than 150,000 units.
After source collateral is committed, the CLI prices the selected quote under
the destination Hub tariff in the signed Account frame. It requires at least
850,000 units after the tariff before it submits a new Cross-J intent. An
unacceptable quote stops the run with source collateral intact. The same rule
checks the effective tariff again when requesting cover. Recovery of an already
accepted cover still uses the committed amounts.

This implementation does not authorize public spending. Operator funding is
[ticket 11](../../.scratch/ts-usdc-cross-j-poc/issues/11-separate-operator-funding.md).
Fresh executable quotes, tariffs and complete normal/recovery gas preparation
remain [ticket 05](../../.scratch/ts-usdc-cross-j-poc/issues/05-public-preflight-and-gas-plan.md).
Public financial proof belongs to ticket 06. Native ETH and operator liquidity
are separate from the user's one-USDC deposit.

## Existing stores and RPC roles

Keep the original six Entities, three private vaults and three Runtime stores
from the [session guide](usdc-poc-session.md). The user store must already contain
a committed WAL; neither `prepare` nor `run` creates replacement vaults or
resets funded state. Select paths explicitly from the retained invocation.

The loopback gateway has two explicit RPC roles:

| Route                           | Purpose                                             | Upstream                                                       |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `/rpc`, `/rpc2`                 | Current observations and approved signed submission | `POC_RUNTIME_<chainId>_RPC`, or the existing chain RPC binding |
| `/history/rpc`, `/history/rpc2` | Historical nonces, balances and receipts; read-only | `ETH_SEPOLIA_RPC`, `ARB_SEPOLIA_RPC`                           |

The history role requires archive state. The selected public Arbitrum runtime
RPC rejected an old nonce query with `missing trie node`; the separate archive
returned the same historical nonce and token balance successfully. A history
read failure stops execution. There is no automatic endpoint substitution.
An archive may trail the current head: the CLI waits up to 60 seconds for the
fixed anchor or consumed nonce, then rejects unresolved history. Matching block
hashes are required before using historical transaction evidence.

Without an execution manifest, the gateway rejects every signing/submission
RPC. Historical routes keep that restriction in all modes.
Load RPC credentials from the protected environment. No deployment private key
is forwarded to operators or needed by this CLI.

## Prepare an unapproved campaign

Cleanly stop the previous session supervisor and retain its exact stores. Killing
only its user child would stop the entire supervised session. Start a standalone
read-only gateway for preparation, or keep an independently managed read-only
gateway available. No user Runtime needs to run during preparation. Use the existing verified
USDC-only catalog: Ethereum Sepolia 11155111 and Arbitrum Sepolia 421614,
registered token 1, six decimals, selected deployed contracts.

Create a private limits JSON file with exactly these keys:

- `expiresAt`: a future Unix timestamp in milliseconds, as a JSON integer.
- `runIds`: one to five distinct identifiers, each 1–48 characters matching
  `[a-z0-9][a-z0-9-]*`. Use identifiers never used by another campaign.
- `source-user`, `target-user`, `target-hub`: each an object containing exactly
  `gasLimit`, `maxFeePerGasWei`, `maxPriorityFeePerGasWei`, `totalFeeLimitWei`.
  Every cap is a canonical nonnegative decimal **string**, with a positive gas
  limit and maximum fee. Choose amounts from ticket 05's actual estimates and
  owner-approved payer budgets; local test caps are not public recommendations.

Run the following commands inside one owned stand lease for the complete
operator workflow. Set `POC_DIRECTORY`, `POC_USER_STORE`, `POC_LIMITS` and
`POC_AUTHORITY` to the selected preparation directory, existing user Runtime
root, private limits file and new output path. The gateway defaults to
`http://localhost:8080`; the Hub RPC defaults to `ws://127.0.0.1:18081/rpc`.

For a standalone read-only gateway, load the protected RPC environment and run
`bun jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts` as a
separately supervised child of that workflow. Stop it before the session
launcher starts its approved gateway. Keep one stand owner across the complete
workflow; starting another independent stand while the first lease is held is
rejected by design.

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts prepare \
  --directory "$POC_DIRECTORY" --user-store "$POC_USER_STORE" \
  --limits-file "$POC_LIMITS" --output "$POC_AUTHORITY"
```

Preparation reads real chain anchors, registry/code identity, vault-derived
signers and payer nonces. It rejects pending payer transactions and an existing
user reserve/collateral position which requires the original campaign. The new
file has `approved: false`; it grants no signing authority.

The manifest binds the Git HEAD and dirty executable/configuration hashes,
catalog digest, both chain anchors and code hashes, exact Entities/signers,
loopback origin, expiry, run IDs, nonce windows and numeric fee limits. Review
this concrete file before explicitly approving public execution. Source changes,
another HEAD, expired authority or a mismatched catalog reject before broadcast.

## Start operators and execute one run

After the exact campaign receives owner approval, stop Hub/MM before replacing
their relay/gateway. Restore their existing stores under the approved gateway:

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts \
  --directory "$POC_DIRECTORY" \
  --hub-store "$POC_HUB_STORE" --mm-store "$POC_MM_STORE" \
  --user-store "$POC_USER_STORE" --operators-only \
  --authority-file "$POC_AUTHORITY"
```

The supervisor owns Hub/MM stores; the financial CLI exclusively owns the user
store. Keep the supervisor alive while running the CLI as another child of the
same stand workflow. An independently supervised approved gateway can use
`--external-gateway`. Do not run the default session user and the financial CLI
against the same store concurrently.

For a prepared catalog that contains deployment metadata, start the
approved gateway as a separate supervised child with the original catalog
path. The gateway checks the catalog digest before listening. The Runtime
supervisor uses its own decoded copy and points to that running gateway.
Run both children under the same stand lease.

```sh
XLN_JURISDICTIONS_PATH="$POC_DIRECTORY/jurisdictions.json" \
  bun jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts \
  --api-base http://localhost:8080 --authority-file "$POC_AUTHORITY"
```

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts \
  --directory "$POC_DIRECTORY" \
  --hub-store "$POC_HUB_STORE" --mm-store "$POC_MM_STORE" \
  --user-store "$POC_USER_STORE" --operators-only --external-gateway
```

The protected RPC environment goes to the gateway. The financial CLI
uses the same authority and original catalog through its `--directory`
binding.

Separately approved funding must provide real operator reserves, native ETH for
the remaining worst-case payer reservations and exactly one USDC of new source
principal for each new run. The CLI does not move money from the funder. Wait for
operator readiness, then select one of the manifest's run IDs:

```sh
bun jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts run \
  --directory "$POC_DIRECTORY" --user-store "$POC_USER_STORE" \
  --authority-file "$POC_AUTHORITY" --run-id "$POC_RUN_ID" \
  --output "$POC_RUN_REPORT"
```

Use a fresh report path. The previous run must be fully settled with its exact
withdrawal receipt before the next run starts. Keep all five deposits at one
USDC each; do not turn the five-run budget into a five-USDC single swap.

## Spending bounds and recovery

For N runs the source-user grant reserves exactly 3N nonce slots: one exact
one-USDC approval, one E2R and one R2C per run. The target user and target Hub
each reserve N slots for exit and cover respectively. For every payer,
`slots * gasLimit * maxFeePerGasWei <= totalFeeLimitWei` must hold. These finite
windows reserve worst-case fees for the whole campaign, including consumed
slots. Replacement at the same nonce cannot replenish the cumulative allowance.
Unused fee reservation is conservative; it is not an extra spendable allowance.

The gateway validates actual signed type-2 transactions, chain, sender, nonce,
fees, value, token/contract, exact operation/recipient/amount and current on-chain
Hanko authority. An approval cannot increase allowance; a batch cannot hide an
unrelated operation. An exhausted nonce window rejects further transactions.
Forced dispute/recovery calls are outside these normal-flow grants and require
separately prepared authority.

After interruption, restore the same WAL under the **original manifest and run
ID**. Accepted financial work comes from Runtime WAL/outbox and chain receipts,
never from a report or a second financial queue. Do not transfer a second USDC
to resume an accepted deposit. Consumed nonce slots are reconstructed from chain
history and validated against the same grant. The report uses only the five
receipts for the selected run ID. It checks the Depository's Entity, batch hash
and Entity nonce against the signed calls, attributes both USDC transfers to
their receipts and reconciles payer ETH and recipient USDC balances at the
receipt blocks. Reconstructing a completed run after later runs uses the same
five hashes and needs no additional debit or range query for receipt logs.

Expired authority blocks new submission until the exact remaining obligation is
reviewed. A cancelled/expired partial route is reported as unfinished. It is not
a completed PoC. Never regenerate a campaign to hide an interrupted position,
renew a consumed allowance or reuse an old run ID under new nonce windows.

## Local verification

The owning test uses two private Anvil chains with the selected public IDs,
real contracts and separate user/Hub/MM processes. It executes five runs,
interrupts accepted deposit and withdrawal work with SIGKILL, restores the same
WAL, and checks independent payout evidence and no extra debit on reconfirmation.
The target RPC limits `eth_getLogs` to 10 blocks. The test confirms the same five
receipt hashes and unchanged payer nonces when rebuilding a report whose target
receipts span more than 10 blocks.
It also checks unapproved, stale, expired, unfunded and sixth-run rejection and
read-only history routes. These private-chain results do not establish public
Arbitrum Nitro execution or public funding readiness.

```sh
bun run stand:status
bun run stand:run --reason poc-public-cli --timeout-ms 240000 -- \
  bun test core/__tests__/market/startup/usdc-public-journey.test.ts
```

The retained [execution evidence](../evidence/ts-usdc-cross-j-poc/local-evidence.md#public-financial-clijson)
records exact source hashes, receipts, restored proofs and verification limits.

## Release the existing source collateral

An earlier run can leave 1 USDC of the source Hub's collateral in the Account
with the source user. To use those same Accounts in another campaign, the Hub
can propose a cooperative C2R. The user must sign the settlement and the Hub
must sign the batch. A successful C2R credits 1 USDC to the source Hub's
Ethereum Sepolia reserve. It creates no new user deposit or Arbitrum liquidity.

Restore and check the existing Accounts through read-only RPC first. The earlier
[review packet](../evidence/ts-usdc-cross-j-poc/fresh-public-demo-source-c2r-unsigned.json)
records the prior snapshot. Prepare a fresh manifest with `approved: false` and
review it against a current anchor and the exact cooperative workspace. The
gateway expects these fields:

| Fields                                                                      | Required scope                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`, `operation`, `approved`                                          | `1`, `source-c2r`, and approval only after the concrete manifest is authorized                                                                               |
| `candidateHead`, `candidateDigest`, `catalogDigest`, `expiresAt`, `apiBase` | Same revision and catalog fingerprints, Unix milliseconds, and loopback origin as normal execution                                                           |
| `chain`                                                                     | `chainId` 11155111, `anchorNumber`, `anchorHash`, `depository`, `entityProvider`, `token`, and `codeHashes` for at least those three contracts               |
| `hubEntity`, `userEntity`, `userSigner`                                     | Existing source Entities and the user's consenting signer                                                                                                    |
| `payer`                                                                     | The Hub signer's `address`, exact `firstNonce`, `gasLimit`, `maxFeePerGasWei`, `maxPriorityFeePerGasWei`, and `totalFeeLimitWei`                             |
| `settlement`                                                                | `amountAtoms` of `1000000`, opening `accountNonceBefore`, signed `accountNonce`, next `hubBatchNonce`, `hubReserveBeforeAtoms`, and `userReserveBeforeAtoms` |

Use integer JSON numbers for heights, timestamps, `firstNonce`, and Account
nonces. Use canonical decimal strings for fees, amounts, and `hubBatchNonce`.
The full gas reservation must fit the manifest ceiling.

After explicit approval, use the existing gateway in single-C2R mode under the
same stand lease. Start the restored Runtime operators with `--external-gateway`
as in the ordinary flow, then submit the cooperatively signed batch through the
source Hub Runtime. The gateway verifies the signed wire and does not sign it.

```sh
XLN_JURISDICTIONS_PATH="$POC_DIRECTORY/jurisdictions.json" \
  bun jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts \
  --api-base http://localhost:8080 --source-c2r-authority-file "$POC_C2R_AUTHORITY"
```

Use either `--source-c2r-authority-file` or `--authority-file` per gateway.
The C2R grant applies only to `/rpc`. It checks the anchor, opening collateral,
reserves, dispute and debt state, the two current Hankos, and an exact gas
estimate before forwarding the single batch. Duplicate pending requests reuse
the same hash. With the original manifest, a consumed nonce reaches the same
successful receipt only after verification of both Depository events and the
exact Account and reserve deltas. Replacement, a second nonce and writes on the
other routes are rejected. Confirm the receipt and both Runtime observations
before preparing a new deposit or campaign.

```sh
bun run stand:status
bun run stand:run --reason poc-source-c2r --timeout-ms 90000 -- \
  bun test core/__tests__/market/startup/usdc-source-c2r.test.ts
```
