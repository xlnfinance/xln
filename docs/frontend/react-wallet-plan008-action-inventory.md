# React wallet Plan 008 action inventory

This inventory is the parity contract for account, asset, payment, lending, settlement, dispute, address, and testnet surfaces. React owns validation and presentation only. Amount parsing uses `parseTokenAmountInput`; bilateral values use `deriveDelta`; transaction construction uses the named canonical helpers below.

## Command status contract

| Evidence | UI meaning |
|---|---|
| Reviewed immutable command | Exact operation, raw amount, asset, destination, and state evidence are shown; no mutation has occurred. |
| Runtime command `pending` / `accepted` / `observed` | Submitted but not committed. The UI never labels this success. |
| Runtime command `committed` | The submitted `RuntimeInput` is present in committed Runtime evidence. |
| Runtime command `error` | Rejection is displayed verbatim and the intent guard is released. |
| J-batch `draft` / `sent` | On-j operations remain explicitly draft or broadcast; neither is described as finalized. |
| Settlement workspace evidence | Hash, revision, Hanko ownership, executor side, and status determine the available action. A changed hash invalidates review. |

## Account and asset actions

| User action | Displayed/input units | Boundary validation | Canonical operation | Completion and failure evidence | Focused evidence |
|---|---|---|---|---|---|
| Open bilateral account | Full 32-byte Entity ID | Exact ID, not self, not already open, same discovered jurisdiction | `buildOpenAccountTx` → `openAccount` | Runtime command receipt plus refreshed committed account list; rejection remains error | `credit-settlement-ui-adapter`, wallet browser flow |
| Add asset to account | Token ID, zero raw amount | Known positive token ID, existing account | `buildAddTokenToAccountTx` → `extendCredit(amount=0)` | Runtime receipt and committed delta presence | `credit-settlement-ui-adapter` |
| Extend credit | Decimal token units and raw preview | Positive exact decimal; token metadata required | `extendCredit` through `buildWalletCreditInput` | Runtime receipt and canonical bilateral projection | `credit-settlement-ui-adapter`, `account-view-model` |
| Request hub credit | Decimal token units and raw request | Positive exact decimal; hub account required | `/api/credit/request` server ingress | Upstream Runtime ingress receipt or explicit HTTP error | `runtime-command-bus` |
| Reserve → reserve | Decimal token units and raw preview | Full recipient Entity ID, not self, amount ≤ committed reserve | `buildReserveToReserveTx` → `r2r` draft | Runtime receipt, J-batch draft/sent state, reserve validation errors | `credit-settlement-ui-adapter`, `pending-batch-preview` |
| Reserve → external | Decimal token units, EOA, raw preview | Valid EOA, amount ≤ committed reserve | `buildReserveToExternalEoaTx` → `r2e` draft | Runtime receipt and J-batch evidence | `credit-settlement-ui-adapter`, `pending-batch-preview` |
| Reserve → account collateral | Decimal token units and raw preview | Existing destination account, positive amount | `buildReserveToCollateralTx` → `r2c` draft | Runtime receipt and J-batch evidence | `credit-settlement-ui-adapter` |
| Account → reserve | Decimal token units and canonical withdrawable raw amount | Existing account, amount ≤ `deriveDelta().outCollateral` | `settle_propose(c2r)` plus canonical empty continuation and broadcast | Workspace/Hanko/receipt/J-batch evidence; no optimistic reserve credit | `account-view-model`, `credit-settlement-ui-adapter` |
| Account → external | Decimal token units, EOA, withdrawable raw amount | Existing account, valid EOA, canonical capacity boundary | `settle_propose(c2r)` + `buildMoveSettlementContinuation(r2e)` | Workspace then J-batch evidence | `credit-settlement-ui-adapter` |
| Account → account | Decimal token units, source/destination accounts | Distinct existing accounts, canonical capacity boundary | `settle_propose(c2r)` + `buildMoveSettlementContinuation(reserve_to_collateral)` | Workspace then J-batch evidence | `credit-settlement-ui-adapter` |
| External ERC-20 allowance | Exact raw approval, token contract, Depository spender | Registered non-native token, positive amount, local unlocked signer | `JAdapter.approveErc20` | Chain readback must be ≥ requested allowance or action fails loud | React TypeScript boundary; browser flow when mesh is available |
| External → reserve | Decimal token units, finalized balance/allowance, raw preview | Registered ERC-20, amount ≤ finalized external balance, observed allowance ≥ amount | `buildExternalToReserveTx` → `e2r` draft | Runtime receipt plus J-batch evidence; snapshot read errors fail loud | `credit-settlement-ui-adapter` |
| External → account | Same as external → reserve plus destination account | Same allowance/balance checks and existing account | Sequential canonical `e2r`, then `r2c`, under one logical intent guard | Each Runtime command is journaled; partial rejection stays explicit and never reports success | `credit-settlement-ui-adapter`, `wallet-financial-actions` |
| External → external | Decimal token units, EOA, finalized balance | Valid non-self EOA, amount ≤ finalized balance | `JAdapter.transferNative` or `JAdapter.transferErc20` | Returned chain transaction hash is labeled accepted, not Runtime-committed | React TypeScript boundary; browser flow when local J-adapter is available |
| Request external test asset | Fixed policy amount, owner EOA, symbol | Local wallet owner and known asset required | `/api/faucet/gas` or `/api/faucet/erc20` server ingress | HTTP response is labeled accepted; finalized J-adapter balance remains completion evidence | `wallet-test-asset-actions` |
| Request reserve test asset | Fixed policy amount, Entity ID, registered token ID | Positive registered token ID and local Runtime context | `/api/faucet/reserve` server ingress | HTTP response is labeled accepted; committed reserve projection remains completion evidence | `wallet-test-asset-actions` |
| Request account test asset | Fixed policy amount, Runtime/Entity/account IDs, token ID | Existing account and positive registered token ID | `/api/faucet/offchain` server ingress | HTTP response is labeled accepted; committed bilateral projection remains completion evidence | `wallet-test-asset-actions` |

## Payment and receive actions

| User action | Displayed/input units | Boundary validation | Canonical operation | Completion and failure evidence | Focused evidence |
|---|---|---|---|---|---|
| Direct payment | Decimal units, raw amount, raw fee, two-Entity route | Existing account, positive exact decimal, direct route length exactly two | `directPayment(deliveryMode=direct)` | Runtime receipt; committed success only after command evidence | `payment-input-adapter`, `runtime-command-bus` |
| Instant HTLC | Decimal units, raw amount/fee and route | Positive exact decimal and canonical route endpoints | `htlcPayment(deliveryMode=instant)` | Runtime receipt and HTLC committed/error evidence | `payment-input-adapter`, route selection continues in Plan 009 |
| Async HTLC | Decimal units, raw amount/fee and route | Same as instant, with async delivery mode preserved | `htlcPayment(deliveryMode=async)` | Runtime receipt and HTLC committed/error evidence | `payment-input-adapter`, route selection continues in Plan 009 |
| Trusted payment | Decimal units, zero fee, exact three-Entity route | Route length exactly three and total fee exactly zero | `directPayment(deliveryMode=trusted)` | Runtime receipt; route discovery/selection is Plan 009 | `payment-input-adapter` |
| Create/copy invoice | Entity ID, optional token/decimal amount/description | Canonical invoice encoder; clipboard failure is visible | `buildXlnInvoiceDeepLink` (no financial mutation) | Generated deep link or clipboard error | wallet browser flow |

## Lending, settlement, and dispute actions

| User action | Displayed/input units | Boundary validation | Canonical operation | Completion and failure evidence | Focused evidence |
|---|---|---|---|---|---|
| Offer liquidity | Decimal units, raw preview, term, interest bps, immutable position ID | Positive amount, supported term, non-negative bps, hub account | `lendingOffer` | Runtime receipt plus server-projected committed market state | `credit-settlement-ui-adapter` |
| Borrow | Decimal units, raw preview, term, maximum bps, immutable request ID | Same boundaries as offer | `lendingBorrow` | Runtime receipt plus committed loan state | `credit-settlement-ui-adapter` |
| Repay | Exact remaining raw amount | Canonical `repaymentAmount - repaidAmount`; malformed negative state fails loud | `lendingRepay` | Runtime receipt plus refreshed loan state | `credit-settlement-ui-adapter` |
| Approve settlement | Workspace hash/revision and Hanko evidence | Active workspace, local Hanko absent, reviewed hash unchanged | `buildSettlementApproveTx` → `settle_approve` | Workspace and Runtime receipt | `account-view-model`, `credit-settlement-ui-adapter` |
| Execute settlement | Workspace hash, executor side, both Hankos | `ready_to_submit`, local executor, reviewed hash unchanged | `settle_execute` | Runtime receipt and committed workspace/J-batch transition | `account-view-model`, `credit-settlement-ui-adapter` |
| Reject settlement | Workspace hash and explicit wallet rejection reason | Active unsubmitted workspace, reviewed hash unchanged | `settle_reject` | Runtime receipt and refreshed workspace | `credit-settlement-ui-adapter` |
| Clear/broadcast/rebroadcast J-batch | Exact draft/sent counts and reserve issue | Live mode; broadcast only when canonical reserve validation permits | `j_clear_batch`, `j_broadcast`, `j_rebroadcast` | Runtime receipt and refreshed J-batch state | `pending-batch-preview`, `credit-settlement-ui-adapter` |
| Prepare dispute | Counterparty, account status, exact cross-j risk | Complete risk evidence required; nonzero risk requires explicit exact-loss acceptance | `buildPrepareDisputeTx` → `prepareDispute` | Runtime receipt and `dispute_preparing`/batch evidence | `account-view-model`, `credit-settlement-ui-adapter` |
| Finalize dispute | Counterparty and active-dispute evidence | Active dispute and live state required | `buildDisputeFinalizeTx` → `disputeFinalize` | Runtime receipt and J-batch evidence | `credit-settlement-ui-adapter` |
| Reopen disputed account | Counterparty and finalized dispute status | Disputed account without active dispute | `buildReopenDisputedAccountTx` | Runtime receipt and refreshed committed account status | `credit-settlement-ui-adapter` |

## Read-only routes

- `/address` reads the current Runtime directory and exposes stable Entity links.
- `/address/:entityId` validates the exact ID, distinguishes malformed from unavailable IDs, and never redirects to a fallback entity.
- `/testnet` is a public wallet-owned launch surface. It performs no mutation and labels all funds as test-only.

## Known ownership boundary

- Payment route discovery, trusted gateway selection, routed fees, swap, orderbook, activity, and history are intentionally completed in Plan 009. Plan 008 preserves their canonical builders but does not invent route or fee calculations.
- External wallet writes require a local unlocked Runtime/J-adapter. Remote projections fail closed; dispute preparation also fails closed remotely when compact projection cannot prove complete cross-j risk evidence.

## Function-size review

- The former all-in-one Entity panel is decomposed into account projection/store, open/configure/dispute, payment/receive, move/external, lending, settlement, route, and test-asset modules; every new source file remains below the 300-line repository limit.
- Stateful form components remain single hook owners even when their component bodies exceed 30 lines. Keeping reviewed immutable commands, pending guards, and submit closures in one React hook order prevents stale-form reconstruction; pure builders, projections, and side-effect adapters are extracted and focused-tested separately.
- The account projection and external-store refresh each publish one atomic immutable snapshot. Their orchestration functions exceed 30 lines because splitting publication across helpers would create observable partial state; all financial derivation remains in canonical helpers rather than those orchestration bodies.
