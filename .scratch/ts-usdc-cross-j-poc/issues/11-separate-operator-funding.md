# 11: Fund operator liquidity separately under explicit owner authority

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: None

## Accepted scope

On 2026-11-23 the owner accepted the separately authorized and reconciled
operator funding as completion of this ticket. The funded Runtime restore for
the public PoC is recorded in [12](12-public-rpc-capacity-and-funded-catchup.md).
The stopped restore of the November 17 stand remains in the campaign history.

## Problem

The prepared Hub reserves were zero in the initial public snapshot. The owner
required separate funding before ticket 05 can finish. Wallet funds and signed
credit alone do not create the target collateral needed for external payout.

## Original approvals and funding plan

The owner approved the concrete funding packet from 10, including amounts,
payers, recipients, networks and numeric ETH limits. The six exact funding
transactions and their limits are in the
[execution authorization](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-authorizationjson).
That authorization superseded the earlier read-only restriction. User funding,
journeys and new-nonce recovery were outside its scope.

The owner selected preparation of a five-run budget: source Hub reserve 1 USDC
(the retained provisional buffer) and target Hub reserve 5 USDC. The plan
provided one round of operator funding for the series. The user's individual
1-USDC deposits had a separate authorization.

## Acceptance criteria

- [x] Provide a bounded funding submission path for the exact approved funder,
      Hub reserve recipients, token amounts and native transfers. Enforce cumulative
      fee/value limits across replacements and restarts, using canonical batch,
      signing and chain-receipt helpers. Preparation can be implemented without
      authorizing or broadcasting public funding.
- [x] Revalidate the approved candidate, current chain/contract/token bindings,
      payer balances, exact calls and authority immediately before signing.
- [x] Execute only separately approved operator funding and gas transfers.
      Record receipts, actual native spend and identified before/after balances.
      Do not perform the user's deposit or Cross-J journey in this ticket.
- [x] Reconcile funder debits, on-chain Hub reserve credits, backing, debts,
      signer ETH topups and nonce progression from the approved receipts.
- [x] Verify interrupted funding locally with the same manifest and nonce
      slots, and reconcile accepted transfers without another debit.

## Completion evidence

All six authorized calls confirmed. Ethereum Sepolia credited 1 USDC to the
source Hub and 0.001 ETH to its signer. Arbitrum Sepolia credited 5 USDC to the
target Hub and 0.0001 ETH to its signer. The post-funding audit reconciled the
approved calls, actual gas, backing and debts. The funding window consumed
nonces 106–108 and 30–32 on the respective networks.

- [Six transaction hashes and the local receipt record](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson)
- [Post-funding balance and reserve audit](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-balances-public.json)

## Comments

Owner decision on 2026-11-17: record the original stand's catch-up blocker in
[12](12-public-rpc-capacity-and-funded-catchup.md) and stop Runtime attempts
without further expense. The six funding transactions had already executed.

Final [post-funding balance audit](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-balances-public.json)
reconciles backing/reserves of 1/5 USDC, zero debts, unchanged User/MM wallets,
exact Hub native balances and funder nonces 109/33. The
[observation-candidate verification](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-observation-verificationjson)
records 54 green owning tests / 300 assertions and the final green aggregate
check, with the funding and subsequent transport candidates identified separately.

Public funding executed, 2026-11-17: the
[six canonical receipts](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson)
confirm 1/5-USDC Hub reserves and 0.001/0.0001-ETH Hub signer topups. Every receipt
has at least twelve confirmations. Funder nonce slots 106-108 / 30-32 are consumed
exactly once; final nonces are 109 / 33. Funder USDC balances are now 8 / 15.
Actual gas fees are 0.000069654310652745 / 0.000004927532416 ETH; complete native
outflows are 0.001069654310652745 / 0.000104927532416 ETH, inside the approved
0.003 / 0.0003 maxima. No user funding or journey was executed.

The execution candidate digest is
`d84d264559ae425aabd002145636f2a385c8128cc3d26a04902e524025d6429a`.
Subsequent gateway availability/header-transport fixes belong to the Runtime
observation candidate; they do not rewrite that executed grant or authorize
another transfer. At the time, the ticket also tracked reserve observation and
same-store restore for the original stand.

Explicit owner authorization, 2026-11-17: the owner selected the full permission
sentence for the six testnet transactions, identified funder and Hub recipients,
1/5-USDC reserve capital, 0.001/0.0001-ETH Hub topups, 0.002/0.0002-ETH cumulative
gas ceilings and 0.003/0.0003-ETH maximum native outflows. The canonical executor
uses the newly approved fresh readiness manifest and has started public funding.
The earlier short-A review rejection did not launch a process or send a
transaction. The subsequent explicit approval is recorded separately above.

Funding discussion resumed, 2026-11-17. The
[fresh unapproved readiness record](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-readiness.json)
binds current blocks 12156163 / 330176097, the unchanged executable candidate,
same amounts/limits and four fresh gas estimates. Funder balances remain 9/20
USDC and confirmed/pending nonces 106/106 and 30/30. The selected protected key
matches the expected funding EOA; no signature was made. Public execution still
requires explicit confirmation; the local manifests remain disabled.

Earlier owner instruction, 2026-11-17: **read-only verification only**. It
supersedes the preceding short `A` approval. Automatic approval review rejected
the attempted funding-process launch before it started because it did not accept
that short reply as explicit confirmation of the exact packet and limits. No
Ethereum transaction or funding Hanko was signed, and no financial broadcast
occurred. The prepared local execution manifest has been set back to
`approved: false`; the original unsigned proposal remains unchanged.

The [current read-only revalidation](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-public-prevalidation.json)
passed on both public chains: approved candidate/catalog, chain anchors and code
hashes match; funder confirmed/pending nonces remain 106/106 and 30/30; zero
campaign slots were consumed. Funder wallets retain 9/20 USDC, Hub reserves,
debts and native balances remain zero, and current base fees fit the proposed
caps. No Runtime loops or tests were started for this revalidation. Public E2R
estimates remain conditional, and funded Runtime observation is still pending.

Implementation prepared and verified locally, 2026-11-17. The
[funding CLI](../../../jurisdictions/scripts/usdc-cross-j-preflight/funding/index.ts)
uses the canonical batch/Hanko, submission and receipt helpers, exactly three
funder nonce slots per chain, and finite cumulative fee/value limits. Preparation
writes an unapproved manifest and signs nothing. Fixed signing inputs and
historical nonce reconciliation resume an interrupted campaign without renewing
its budget or duplicating deposits. See the
[operator guide](../../../docs/runtime/usdc-poc-operator-funding.md).

The [retained local evidence](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-executorjson)
records six actual funding calls on two private Anvil chains, SIGKILL after
source approval and target deposit, repeat reconciliation without another debit,
and exact funded Hub roots/Accounts/Hankos/outbox across the ticket-09 restore.
Final verification: 34 authority/preparation tests / 78 assertions; 4 real-node
financial tests / 150 assertions; aggregate check green (3 short, 38 source,
10 soundcheck gates), deployment types green, frozen core unchanged. The
interruption criterion above is established for these named local cuts.

The earlier preparation phase preceded public authorization and execution.
The [refreshed unsigned proposal](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-proposal.json)
binds the implemented candidate, sealed code, exact recipients, nonce domains,
unsigned batch digests and current estimates. Its manifest remains `approved: false`.
The [operator guide](../../../docs/runtime/usdc-poc-operator-funding.md#current-unsigned-proposal)
lists the exact token/ETH allocations and cumulative funding ceilings for review.

Owner selection, 2026-11-17: record the existing account separation and proceed
with preparation of this ticket. The [identity record](../../../docs/runtime/usdc-poc-identities.md)
retains the existing user/Hub/MM vaults. A new operator funding EOA and direct
external-wallet integration remain deferred. The executor must bind an explicit
funding signer; the existing unsigned packet's payer is the deployer. Preparing
and testing the executor does not authorize public signatures or transfers.

Current code boundary, verified after ticket 08: its execution grant has only
source-user, target-user and target-hub roles, rejects nonzero native value and
permits exact user ingress/target cover/exit calls. It therefore cannot submit
the funder's 1/5-USDC Hub deposits or Hub ETH topups. The existing reserve
roundtrip deposits one USDC into the funder's own reserve and withdraws it; it
does not implement this packet's recipients, amounts or cumulative funding caps.
The separate funding executor above belongs to 11; completed 08 remains the
user-journey executor.

Owner decision 2026-11-17: keep 05 incomplete until this separate funding step.
Ticket 06 does not absorb it. Neither this ticket nor the existing provisional
ETH envelopes authorizes signing or spending.
