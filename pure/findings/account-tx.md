# account-tx: og per-transaction Account transitions vs pure/xln.ts

Tests: `pure/diff/account/account-tx.test.ts`. Run from `pure/` with `bun test diff/account/account-tx.test.ts`: 33 pass, 0 fail, about 10.4k expects.

Every test is `MATCH:`. It runs og's own handler and the rewrite `applyAccountBody` on the same input and asserts they agree. Most tests are lockstep tests. They seed a persistent og replica from the rewrite's committed view (`ogHarness`) and drive og through the real transition overlay:

1. `beginAccountTransition`
2. the handler
3. `commitAccountTransition`

After every tx, both sides must agree on accept or reject, and every accepted tx must give an equal `accountStateRoot`. Randomized cases use a seeded PRNG.

## Catalog mapping (og `core/account/tx/catalog.ts` vs rewrite `AccountTxNames` / `applyArm`)

| og tx | rewrite arm | status |
|---|---|---|
| add_delta | add_delta | MATCH |
| set_credit_limit | set_credit_limit | MATCH |
| direct_payment | payment (wire `direct_payment`) | MATCH. The forward effect is FIXED (consensus-final.md): entity-consensus-2.test.ts ER-15 trusted gateway MATCH, cross-j.test.ts "40 random sequences ... outputs (directPaymentForward)". |
| htlc_lock | htlc_lock | MATCH, including the envelope (consensus-final.md): cross-j.test.ts "200 random htlc_lock txs with envelopes". |
| htlc_resolve (secret / error) | htlc_resolve (outcome-based) | MATCH |
| swap_offer | swap_offer (`swapOffer`) | MATCH. Cross-j is FIXED (consensus-final.md): cross-j.test.ts "60 random pull-lock / offer / resolve / close sequences". |
| swap_cancel_request | swap_cancel_request | MATCH |
| swap_resolve | swap_resolve (`swapResolve`) | MATCH |
| settle_transition (upsert/submit/clear/hanko) | settle_transition (`settleTransition`) | MATCH. Hanko success depends on H1/H2 and on consensus wiring. |
| j_event_claim | j_event_claim (`claimJ` / `finalizeSettled`) | MATCH |
| request_collateral / rebalance_refund / rebalance_policy | same names (`requestCollateral`, `rebalanceRefund`, `rebalancePolicy`) | MATCH. The rewrite quote/accept/deposit_collateral kinds are removed. |
| lending_* (6 kinds) | same names (`lending`) | MATCH |
| cross_pull_lock / cross_pull_close | refused as the `unchosen: cross_open` hole | FIXED (consensus-final.md): cross-j.test.ts "60 random pull-lock / offer / resolve / close sequences", "a pull holds amount on the payer side". |
| (none in og) | deposit_to_custody / withdraw_from_custody / hub_custody_debit | **REMOVED** (integration): with `AccountBody.hub/custody/debits` and `HubSide`; test "MATCH: the rewrite-only custody kinds are gone" |
| (none in og) | subcontract_* | Removed. og never writes `subcontracts`. |

## Findings

| id | severity | og file:line | rewrite (now) | what differed | Status |
|---|---|---|---|---|---|
| AT-1 | critical | protocol/htlc/utils.ts:73-79; htlc/resolve.ts:183 | `hashHtlcSecret`, htlc_resolve | The HTLC hashlock was keccak256(utf8 secret). og uses keccak256 of the 32-byte secret. | **FIXED**. Test: "hashlock = keccak256(bytes32 secret)". |
| AT-2 | critical | htlc/resolve.ts:175-180; htlc-deadline.ts:18-23 | `htlcExpired` | The rewrite accepted a secret reveal after expiry. | **FIXED**. Test: "400 random resolves". |
| AT-3 | critical | swap/resolve/validation.ts:147-228 | `swapResolve` | Fills came from the ratio alone, and no limit-price check was applied. | **FIXED**. Any non-zero fill now requires explicit execution amounts, `filledWant·qGive ≥ filledGive·qWant`, the canonical ratio (`exactFillRatioToUint16`), and exact-ratio / resting-terms checks. |
| AT-4 | high | swap/lifecycle/cancel.ts | `swap_cancel_request` | The rewrite deleted the offer and freed the hold at once. | **FIXED**. `swap_cancel` is renamed; the maker-only request makes no state change. |
| AT-5 | high | swap/resolve/validation.ts:128-130 | `swapResolve`, `AccountKinds.swap_resolve` = bilateral | Only the hub could resolve. | **FIXED**. Any non-maker resolves; the maker is refused. |
| AT-6 | high | swap/resolve/validation.ts:303 | `swapResolve` | fillRatio 0 kept the offer open. | **FIXED**. It now closes the offer. |
| AT-7 | critical | j-claim-transition.ts:214-221; j-events/finality.ts:166-173 | `claimJ`, `finalizeSettled`, `AccountBody.jNonce` | A stale claim rolled state back, nonces could regress, and jNonce was fixed at 0. | **FIXED**. |
| AT-8 | high | j-claim-transition.ts:229-255, 115-116 | `claimJ` (`claimRows` membership) | A peer at an older pending height never finalized. A peer-side conflict was stored instead of rejected. | **FIXED** |
| AT-9 | high | j-events/finality.ts:28-34 | `finalizeSettled` | A foreign pair was filtered out silently. | **FIXED**. It is now refused, and the pair match is case-insensitive. |
| AT-10 | high | settlement/transition.ts:251-720 | `upsertWorkspace` / `hankoWorkspace` / `settleTransition` | A hanko attached with no workspace was accepted, and upsert/submit/clear were missing. | **FIXED** for all four kinds, holds and the revision chain. The workspace hash equals og `createSettlementWorkspaceHash`. (a) **FIXED**: the hanko settlement, proof and dispute hashes equal og's. "MATCH: hanko attach" runs the full lockstep (`rewriteAgrees` is true). (b) **FIXED** (integration): proposal (`planOpen`, `planAccountProposal(..., verify)`), peer replay (`admitPeerFrame`), recovery (`restoreCandidate`, via `Candidate.floor`) and Entity/Host admission pass `FoldCtx.settlement`. The floor is og `getMinimumSafeSettlementNonce` over the pre-frame witnesses (`proofNonceFloor`). Test: "MATCH (AT-10b)". (c) **FIXED** (integration): `promoteSettled` ports the replica side of og `activatePostSettlementProof`. It promotes own/peer N+1 hankos into `current`/`counterparty`, refuses same-nonce equivocation, and bumps `nextProofNonce`. It runs before the dispute plan on the proposer and before the requirement check on the receiver. Test: "MATCH (AT-10c)". **Residuals FIXED** (final-sweep.md): the extra `nextProofNonce` bump per finalized claim is j-layer.md J4 (`promoteSettled` over the `finalized` list), the refreshable stale reject is J5 (`stale_settlement_hanko`), and the finalizing second j_event_claim is J3 (branch proofs in `stampClaims`). History: the promotion was derived per frame from the pre/post bodies. If a second claim finalizes a higher nonce in the same frame, og's extra `nextProofNonce` bump for the first nonce is not reproduced. og's refreshable `ACCOUNT_INPUT_FRAME_STALE_SETTLEMENT_HANKO` reject is not ported. A proposer cannot yet put the finalizing (second) j_event_claim in a frame, because `stampClaims` needs branch proofs; that is a separate j-claim gap. |
| AT-11 | medium | tx/mutation.ts:188-194; transition.ts:636-648 | `settlementFreeze` in `applyAccountBody` | There was no freeze. | **FIXED** |
| AT-12 | medium | htlc/lock.ts:42-47 | htlc_lock | An already-expired lock was accepted. | **FIXED** |
| AT-13 | medium | htlc/lock.ts:40 | htlc_lock | The rewrite did not require lockId == hashlock. | **FIXED** |
| AT-14 | medium | htlc/lock.ts:73-81 | `MAX_ACCOUNT_HTLC_LOCKS` | There was no 32-lock cap. | **FIXED** |
| AT-15 | medium | htlc/resolve.ts:199-211 | htlc_resolve `outcome:"error"` | The rewrite had no early beneficiary refund and no timestamp expiry. | **FIXED**. `htlc_timeout` is removed. |
| AT-16 | medium | direct-payment.ts:134; lock.ts:49-51 | `MAX_PAYMENT_AMOUNT` = 2^256-1 | The ceiling was 2^128-1. | **FIXED**. `representable` adds og's int512 offdelta check. |
| AT-17 | medium | swap/offer/{admission,quantization,commit}.ts; swap-limits.ts | `swapOffer`, `SwapOffer` (og shape) | Admission checks and quantization were missing. | **FIXED**: ':' check, duplicate, the 50/32 offer caps and the 32 per-side-per-market cap, decimals, amount bounds, maxFee/minNetReceive authority, same token, timeInForce, lot size, canonical price (step 1, stable-quote orientation), priceTicks drift, requantized authority, capacity and hold overflow. EXTRA `minFillRatio`/`expiresAtHeight` are removed. `createdHeight` = frame jHeight, as og mutation.ts passes it. Cross-j offers (`crossJurisdiction`): **FIXED** with the cross-j route model (cross-j.md, cross-book.md). |
| AT-18 | medium | swap/resolve/{validation,settlement,remainder}.ts | `swapResolve` | The taker fee and the remainder requantization were missing. | **FIXED**: fee authority (`assertSwapNetAuthorization`), fee movement, exact-lot remainder requantization, dust release and pro-rata authority. |
| AT-19 | low | direct-payment.ts:141-278 | `paymentRoute`, payment tx fields, `wireTx` payment | Route, deliveryMode and trusted gateway were missing. | **FIXED** (consensus-final.md): validation, wire form and the directPaymentForward effect (entity-consensus-2.test.ts ER-15 MATCH). |
| AT-20 | low | j-events/finality.ts:56-66 | `finalizeSettled` | `requestedRebalance` was not reduced. | **FIXED** with og-shaped `requested`/`requestFees`. Test: "MATCH (AT-20)". The shadow `submittedAtByToken` deletion: **FIXED** (cross-j.md, replica shadow `rebalance.submittedAtByToken` row). |
| AT-21 | low | tx/mutation.ts:183-186 | replica phase grammar | The dispute-status guard is not re-checked per tx. | **EQUIVALENT, no change.** og `canProcessAccountTxForDisputeStatus` admits only `active`. In the rewrite, frames fold only in the `open`/`proposed`/`received` phases, which map to og `active`. `preparing`/`disputed` never fold txs. |
| AT-22 | info | handlers/rebalance/*, balance/lending.ts, settlement/pull.ts | see catalog | Kinds were missing or replaced. | **FIXED**: request_collateral, rebalance_refund, rebalance_policy and lending_* are ported with og state (`requestedRebalance`, `requestedRebalanceFeeState`, `rebalanceFeePolicies`, `lendingIntents`), and root lockstep tests cover them. **REMOVED**: the EXTRA set_rebalance_policy, rebalance_request, rebalance_quote, rebalance_accept, deposit_collateral (with its `queue_r2c` effect) and subcontract_*. **Former residuals, all FIXED:** (1) cross_pull_lock/close are ported with og's cross-j route canonicalization, pull binding and hash-ladder binary (cross-j.md, cross-j-final.md); the `unchosen` refusal and its Hole type are deleted (final-sweep.md). (2) ~~The EXTRA custody kinds are kept~~ **FIXED (integration)**: deposit_to_custody / withdraw_from_custody / hub_custody_debit, `hub`, `custody` and `debits` are removed; `lendingIntents` commits og's map only; `consumerExample` uses a direct payment. (3) The runtime events og returns are emitted as Account effects: `request_collateral_committed`, `swap_cancel_requested` and `htlc_error` (xln.ts `kind(...)` effect table for request_collateral, swap_cancel_request and htlc_resolve). |

## Wire form

`wireOf` now emits og's AccountTx field types: numeric `tokenId`/`giveTokenId`/`wantTokenId`/`feeTokenId`/`requestTokenId`, and a numeric htlc `revealBeforeHeight`. For the ported kinds, `ownWire(wireOf(tx))` deep-equals og's tx object, and `accountFrameHash` equals og `computeFrameHash` (test: "wire form of the ported kinds").

## Coverage (checked, MATCH)

- deriveDelta outCapacity grid, set_credit_limit bounds, payment capacity and sign, and HTLC holds reducing payment capacity. These are the earlier MATCH tests, still green.
- Committed-root lockstep, tx by tx, against og `commitAccountTransition` for random sequences of:
  - HTLC lock/resolve
  - swaps
  - settle_transition upsert/clear/submit
  - rebalance
  - lending
  - direct_payment envelopes
- j_event_claim lockstep against og `handleJEventClaim`, with real `prepareAccountJClaimTx` proofs, covering pending roots, jNonce, lastFinalizedJHeight and collateral/ondelta.
