# Prepare and execute operator funding

Ticket 11 provisions the existing Hub Entities and proves their funded state
through the original Runtime WAL and authenticated J observation. It uses the
[recorded identity separation](usdc-poc-identities.md). The user's deposits,
Cross-J operations and payouts remain outside this funding invocation.

The [fresh one-run demo](usdc-poc-fresh-demo.md#unsigned-funding-proposal)
uses the same executor with its own reviewed operator and user funding scope.
The instructions below describe the original ticket 11 grant.

The approved public funding has now executed: [six confirmed receipts](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson),
1/5-USDC Hub reserves and 0.001/0.0001-ETH Hub topups. Actual gas fees were
0.000069654310652745 / 0.000004927532416 ETH. The original execution grant's six
nonce slots are consumed; do not prepare another prefunding campaign. Canonical
funded Runtime observation and restore remain the unfinished part of ticket 11.
The owner chose to retain the [RPC/catch-up blocker in ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md)
and keep 11 open, without new expenses. Public Runtime attempts are stopped.
Future work reuses the existing reserves and receipts; it does not repeat funding.

## Scope and authority

The initial two-chain funding campaign contains three ordered funder nonce
slots on each chain:

| Chain                     | Slot 0                       | Slot 1                             | Slot 2                                        |
| ------------------------- | ---------------------------- | ---------------------------------- | --------------------------------------------- |
| Ethereum Sepolia 11155111 | Approve 1 USDC to Depository | E2R 1 USDC into source Hub reserve | Exact approved ETH topup to source Hub signer |
| Arbitrum Sepolia 421614   | Approve 5 USDC to Depository | E2R 5 USDC into target Hub reserve | Exact approved ETH topup to target Hub signer |

USDC uses the selected stack's registered token 1 with six decimals. The funder
EOA supplies tokens and gas. Its lazy Entity authorizes the E2R batch; the Hub
Entity receives the reserve. The signer key is selected explicitly by environment
variable name and must match the manifest's funding EOA. There is no implicit
selection of the deployer key or a newly generated funding wallet.

The source Hub's one-USDC amount retains the owner's discretionary buffer. The
target five-USDC amount is the proposed capital for the five-run series, not full
backing for all operator credit or maker orders. Funding is once per series.
The ETH topups are initial allocations; ticket 05 still prepares complete normal
and recovery gas for the later journeys.

Preparation writes `approved: false` and cannot sign or submit. Public execution
requires explicit owner approval of the refreshed candidate, exact payer and
recipients, amounts, per-call fees and cumulative native limits. The
[older capital packet](usdc-poc-capital-plan.md) is a planning reference until
refreshed against the implemented funding candidate.

## Current unsigned proposal

The owner explicitly authorized the six funding transactions through
the [execution authorization](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-authorizationjson).
The canonical funding executor used its approved fresh manifest; the earlier
read-only restriction is superseded. This authority excludes user funding and
journeys. The original unapproved proposal below remains a preparation snapshot.

The earlier short `A` approval did not pass automatic approval review, so that
attempt was rejected before process launch. The owner first selected read-only
work and then provided the full explicit funding permission recorded above.
The retained [read-only evidence](../evidence/ts-usdc-cross-j-poc/operator-funding-public-prevalidation.json)
describes the pre-funding nonces, balances and zero Hub reserves.

Funding preparation was resumed without execution. The
[fresh readiness record](../evidence/ts-usdc-cross-j-poc/operator-funding-readiness.json)
contains a new `approved: false` manifest at blocks 12156163 / 330176097,
unchanged candidate and limits, fresh payer balances/nonces and approval/topup
estimates. The explicitly selected protected key was verified to derive the
expected funder address without signing. The subsequent execution authorization
approves a separate copy of that exact fresh manifest; the preparation copy
remains `approved: false`.

The [refreshed public proposal](../evidence/ts-usdc-cross-j-poc/operator-funding-proposal.json)
binds the implemented dirty candidate and both sealed stacks. Its manifest is
`approved: false`, expires at **2026-11-18 18:15:12 UTC**, and names funder
`0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b`. No public transaction or funding
Hanko has been signed. Review this proposal before authorizing execution.

| Funding allocation or limit            |         Ethereum Sepolia |        Arbitrum Sepolia |
| -------------------------------------- | -----------------------: | ----------------------: |
| Hub reserve USDC                       |                 1.000000 |                5.000000 |
| ETH value sent to Hub signer           |                 0.001000 |                0.000100 |
| Cumulative funder gas-fee ceiling, ETH |                 0.002000 |                0.000200 |
| Maximum funder native outflow, ETH     |                 0.003000 |                0.000300 |
| Maximum fee per gas, gwei              |                      1.0 |                     0.1 |
| Maximum priority fee per gas, gwei     |                      0.1 |                       0 |
| Gas limits: approval / E2R / ETH topup | 200000 / 600000 / 300000 | 90000 / 600000 / 300000 |

The source reserve recipient is
`0xd3a0d7b3939571af73af38d3cfb0f914f065e23e50daaf60fc80cd6fd52e70a8`;
its ETH signer is `0x7fd492c67d1b1bab5ba3487e4246c8044db44598`.
The target reserve recipient is
`0x0b669a275953ec4f68ebbf1ec6a0aedd7f2ae671ba527fcf745bde4df44c5447`;
its ETH signer is `0x0b2fffb8b3e09bb3ea2d5ec2442cf055bdfdcdd2`.

Preparation anchors are blocks **12156109** and **330173685**, with hashes in
the proposal. Funder EOA nonce slots start at 106 and 30; its funding Entity
nonce is 2 on both chains, so each E2R uses nonce 3. Current funder wallets hold
9 and 20 USDC. Hub reserves and debts remain zero. These are observations, not
nonce reservations. Revalidation remains mandatory at execution.

Exact unsigned approval and ETH-topup gas estimates are 140018 / 207391 on
Ethereum and 56240 / 21000 on Arbitrum. Both E2R limits remain conditional:
the exact authorized Hanko and confirmed allowance are required to estimate
the complete calls. The retained proposal includes unsigned batch encoding and
Hanko digests without generating signatures. Its spare fee ceiling does not
authorize new-nonce recovery calls or automatic fee bumps.

## Prepare without signing

Select the existing public preparation directory with its current verified
USDC catalog and original user/Hub/MM vaults. Stop old fresh-attempt probes;
after funding, only the [restore launcher](usdc-poc-session.md) may select the
funded stores. A read-only gateway is not required for funding preparation:
current and archive RPC capabilities are selected explicitly from the protected
environment, with no endpoint failover.

Create a private limits file with exactly `expiresAt` and `chains`:

- `expiresAt`: future Unix milliseconds as a JSON integer.
- `chains` contains one object for a single-network reserve top-up or two
  objects in Ethereum Sepolia, Arbitrum Sepolia order (11155111, 421614).
  Each contains `chainId`, `amount`, `hubTopupWei`, `totalFeeLimitWei`,
  `totalNativeOutflowLimitWei` and `calls`.
- `calls` contains `approval`, `deposit` and, when `hubTopupWei` is positive,
  `native-topup`. Each contains `gasLimit`, `maxFeePerGasWei` and
  `maxPriorityFeePerGasWei`.
- Amounts and fee limits are canonical decimal strings. Use `1000000` source
  units and `5000000` target units for the initial operator-only campaign.
  For an existing reserve, set `amount` to the exact USDC units to add and
  `expectedHubReserve` to the exact opening reserve in USDC units.
  Omitting `expectedHubReserve` selects an opening reserve of zero.

For each chain, the sum of the `gasLimit * maxFeePerGasWei` reservations for all
selected calls must fit `totalFeeLimitWei`. That fee limit plus the ETH values
must fit `totalNativeOutflowLimitWei`. The owner approves these caps.

For the repeat-demo target top-up, select only chain `421614`, set
`hubTopupWei` to `"0"` and supply the `approval` and `deposit` caps.
This reserves exactly two funder nonce slots on Arbitrum. The source user's
next principal transfer is a separate operation. The applicable amount comes
from the refreshed quote and free backing for that run.

Set the paths below explicitly. The current unsigned plan selects the deployer
as funder; the proposed independent funding EOA remains deferred.

```sh
POC_RUNTIME_421614_RPC=https://sepolia-rollup.arbitrum.io/rpc \
  bun --env-file=/Users/nick/.config/xln/testnet-deployer.env \
  jurisdictions/scripts/usdc-cross-j-preflight/funding/index.ts prepare \
  --directory "$POC_DIRECTORY" \
  --funder-address 0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b \
  --limits-file "$POC_FUNDING_LIMITS" --output "$POC_FUNDING_AUTHORITY"
```

The version-2 manifest binds the current HEAD and executable/configuration hashes,
catalog, chain anchors, contract/token code, funding Entity and EOA nonce domains,
Hub identities, `hubReserveBefore` at each chain anchor, and exact numeric limits.
Preparation rejects a reserve that differs from `expectedHubReserve`, pending
funder transactions, outstanding Hub debt, an operator/user signer used as
funder, insufficient balances and approval/top-up estimates above the proposed
caps. Use a new preparation for a new funding scope.

No deposit Hanko is created during preparation. Exact E2R gas estimation needs
the approved Hanko and confirmed allowance, so the deposit gas limit remains
explicitly conditional until the authorized run. A measured over-cap estimate
stops that run before deposit broadcast; the CLI never raises limits.

## Execute the approved funding packet

Perform the entire workflow under one owned stand lease. Public Ethereum
confirmation takes several minutes: retain a suitable workflow budget, such as
30 minutes, instead of the default ordinary-check timeout. Concurrent funding
processes in the same preparation directory are rejected by its native host lock.

After the exact manifest receives approval, run:

```sh
POC_RUNTIME_421614_RPC=https://sepolia-rollup.arbitrum.io/rpc \
  bun --env-file=/Users/nick/.config/xln/testnet-deployer.env \
  jurisdictions/scripts/usdc-cross-j-preflight/funding/index.ts run \
  --directory "$POC_DIRECTORY" --authority-file "$POC_FUNDING_AUTHORITY" \
  --key-env DEPLOYER_PRIVATE_KEY --output "$POC_FUNDING_RECEIPTS"
```

This explicit key selector applies to the existing deployer-funded proposal.
A separately approved funding EOA needs its own matching protected key selector.
No key or seed appears in the manifest, process arguments or published reports.

The CLI signs fixed type-2 fee fields and exact nonce slots. It verifies current
code, chain anchors, Hanko authority, actual estimates and remaining fee/value
liability before submission. Every receipt requires twelve confirmations and a
canonical block; the host wait is bounded at ten minutes per receipt. The report
contains actual gas costs, raw signed transactions/receipts and identified
before/after wallet, reserve, debt and backing balances. Accounting verifies
the stated reserve at the manifest anchor and the exact credited increase
at each reconciled stage. A changed reserve outside the approved calls
stops reconciliation.

## Resume and complete Runtime observation

Resume an interrupted operation with the original authority and another new
report path. Fixed signing inputs reconstruct the same transaction hashes after
a lost response. Historical nonce lookup verifies every consumed slot, including
actual fees; restarting never renews the budget. Exact known pending transactions
are confirmed without a second deposit. A different unresolved pending nonce,
mined revert, stale/expired authority or changed configuration stops the run.

The CLI does not automatically bump fees: fixed approved values make rebroadcast
stable. A consumed same-nonce replacement must still satisfy the original call
and fee limits. New-nonce retries/cancellations and forced disputes need a
separately reviewed remaining-obligation packet; unused budget is not permission
to add operations.

`status: funded-on-chain` certifies the calls in the approved packet. Restore the original
Hub/MM stores through ticket 09 and let their authenticated J observation commit
the reserve changes to Runtime WAL. Compare retained identities, roots, Accounts
and reserve values across restore. Never write reserves manually or replace the
funded stores with a fresh operator-probe attempt.

Ticket 11 closes only after actual funding and canonical Runtime observation are
retained. Ticket 05 then checks funded executable depth, quotes, tariffs, user
credit and complete journey/recovery costs. Ticket 06 requires separate journey
authority before the user's first public deposit.

## Local verification

The [target-only top-up](../evidence/ts-usdc-cross-j-poc/funding-target-topup.json)
added 799,602 USDC atoms to an opening reserve of 100,199. Preparation rejected
an omitted reserve expectation. Execution rejected a mismatched manifest
reserve before submission. After a process interruption at E2R, resume and
reconfirmation returned the same two Arbitrum receipts. The Ethereum funder
nonce and Hub reserve stayed fixed.

On that candidate the funding suites passed 23 tests and 151 assertions,
including the original six-call and nine-call packages and their WAL
restores. Deployment TypeScript and `bun run check` passed.

The [current observation-candidate verification](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-observation-verificationjson)
retains 54 passing owning tests / 300 assertions, including all four real-node
financial scenarios. A subsequent test-only serializer correction passed its
seven owning tests and the final aggregate check: 3 short, 38 source and
10 soundcheck gates, frozen core unchanged. The artifact distinguishes the
executed public funding candidate from the later observation/transport candidate
and records their exact hashes. Public funded Runtime proof remains incomplete.

The [retained executor evidence](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-executorjson)
binds the earlier dirty executor candidate, six private funding receipts, two crash cuts and exact funded
Hub WAL restore. The final related financial suite passed 4 tests / 150 assertions;
the authority/preparation suite passed 34 tests / 78 assertions. The aggregate
`bun run check` passed 3 short, 38 source and 10 soundcheck gates, including the
unchanged frozen core. These are local verification results, not closure of
ticket 11's public funding and Runtime-observation criteria.

The owning scenario uses two private Anvil nodes with the selected public IDs,
actual contracts and token transfers. It kills the funding process after source
approval and target deposit acceptance, resumes the original grant, reconciles
six nonce slots without duplication, and restores the funded Hub's exact WAL
roots and Account evidence. Those private results do not establish public
Arbitrum Nitro execution or approve public funding.

```sh
bun run stand:status
bun run stand:run --reason poc-operator-funding --timeout-ms 300000 -- \
  bun test core/__tests__/market/startup/usdc-operator-funding.test.ts
```
