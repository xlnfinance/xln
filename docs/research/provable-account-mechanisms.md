# Provable account mechanisms compared with xln

Jurisdictions, entities and accounts are the existing architecture of finance.
xln makes those relationships replicated, transparent, signed and enforceable
through programmable J machines. The comparison below examines useful mechanisms
for that architecture; upstream project terminology does not define xln's model.

Reviewed 2026-09-30. Read-only runtime/contract baseline:
`5d89c1ebbd7b4f6216db76a09ca30ff16bf3ca6c`.
Documentation corrections accompanying this report do not change that implementation.

xln already implements shared secret evidence, bilateral signed state, replay
protection, collateral plus credit, conditional allocation, scoped tower authority
and canonical recovery. Adding another reveal registry or importing Bitcoin's
funding/revocation machinery would duplicate or misfit those primitives.

The useful followups are timely claim preservation near expiry, exit capacity on
low-gas XLNC, deployable wallet-authored clauses, and merchant request identity.
Some are missing production evidence rather than demonstrated defects. Optional
multipart and privacy capabilities are not established merely by transformer
extensibility. This study does not certify an exhaustive superset or release readiness.

## Refined research prompt

Act as an independent financial-protocol engineer. Treat J/E/A as the existing
jurisdiction/entity/account structure and assess how xln makes financial accounts
provable. Compare pinned primary specifications AND implementation with pinned
production xln, not project popularity, names or release frequency.

Trace signatures and authority; opening/funding/credit; nonce and duplicate
delivery; lock commitment; preimage generation, sharing and publication; exact
deadline conversions; forward/reverse acknowledgement; partial and multipart
payments; fees and directional capacity; routing and privacy; expiry and reorg;
close/counter/finalize/withdraw races; gas/inclusion; delegation and tower funding;
crash recovery; arbitrary clauses and forced application progress. Include Sprites,
Counterfactual, Nitro and Perun where their mechanisms answer a concrete question.

For each mechanism provide pinned source, actual xln boundary, classification
(covered / deliberate difference / implementation gap / evidence gap / optional),
an adversarial sequence and the smallest next production check. Distinguish a
specification from implemented code and tested behavior from an inspected test.
Challenge each suspected defect twice: reconstruct both parties' state and
existing remedies, then check exact arithmetic/authority against code. Withdraw
false candidates. Never equate provable debt with fully backed recovery.

Preserve the selected XLNC direction: conventional stateful EVM, roughly 10–20×
less block gas capacity, rebalances/disputes rather than per-payment publication.
No stateless execution, ZK or execution-witness protocol is required. Advance the
first real financial artifact before inventing a broad audit or new framework.

## Immutable primary sources

Links below pin the examined bytes. Source locations in the tables resolve under
these revisions. Upstream test suites were not executed.

| Source              | Revision                                   | Primary entry point                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lightning BOLTs     | `1aadb719b4007c4cea0ba6e36b08c4fb53788dee` | [BOLT2](https://github.com/lightning/bolts/blob/1aadb719b4007c4cea0ba6e36b08c4fb53788dee/02-peer-protocol.md), [BOLT4](https://github.com/lightning/bolts/blob/1aadb719b4007c4cea0ba6e36b08c4fb53788dee/04-onion-routing.md), [BOLT12](https://github.com/lightning/bolts/blob/1aadb719b4007c4cea0ba6e36b08c4fb53788dee/12-offer-encoding.md)                                                                                                |
| LND                 | `afcea30d9b37b2d06cecf1745973e63367ee1a5c` | [link implementation](https://github.com/lightningnetwork/lnd/blob/afcea30d9b37b2d06cecf1745973e63367ee1a5c/htlcswitch/link.go), [invoice-request codec](https://github.com/lightningnetwork/lnd/blob/afcea30d9b37b2d06cecf1745973e63367ee1a5c/bolt12/invoice_request.go)                                                                                                                                                                    |
| Raiden contracts    | `ce3d253cc5fbbedbb878a4f8722008ac954aeea3` | [TokenNetwork](https://github.com/raiden-network/raiden-contracts/blob/ce3d253cc5fbbedbb878a4f8722008ac954aeea3/raiden_contracts/data/source/raiden/TokenNetwork.sol), [SecretRegistry](https://github.com/raiden-network/raiden-contracts/blob/ce3d253cc5fbbedbb878a4f8722008ac954aeea3/raiden_contracts/data/source/raiden/SecretRegistry.sol)                                                                                             |
| Raiden client       | `90cd5a6cc27e31088a39fd35c0dccf89871dfa88` | [mediator](https://github.com/raiden-network/raiden/blob/90cd5a6cc27e31088a39fd35c0dccf89871dfa88/raiden/transfer/mediated_transfer/mediator.py)                                                                                                                                                                                                                                                                                             |
| Raiden light client | `d3b79fe3e4accf47e6cd930aa034002178a58655` | [source tree](https://github.com/raiden-network/light-client/tree/d3b79fe3e4accf47e6cd930aa034002178a58655/raiden-ts/src)                                                                                                                                                                                                                                                                                                                    |
| Hydra 2.4.1         | `099f5dd775d8640047d0074edef294c1b39a600d` | [HeadLogic](https://github.com/cardano-scaling/hydra/blob/099f5dd775d8640047d0074edef294c1b39a600d/hydra-node/src/Hydra/HeadLogic.hs), [J handlers](https://github.com/cardano-scaling/hydra/blob/099f5dd775d8640047d0074edef294c1b39a600d/hydra-node/src/Hydra/Chain/Direct/Handlers.hs)                                                                                                                                                    |
| Interledger RFCs    | `d4ce278977850fab5d9d4df2a8fe41918308149e` | [ILPv4](https://github.com/interledger/rfcs/blob/d4ce278977850fab5d9d4df2a8fe41918308149e/0027-interledger-protocol-4/0027-interledger-protocol-4.md), [STREAM](https://github.com/interledger/rfcs/blob/d4ce278977850fab5d9d4df2a8fe41918308149e/0029-stream/0029-stream.md), [BTP](https://github.com/interledger/rfcs/blob/d4ce278977850fab5d9d4df2a8fe41918308149e/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md) |
| Rafiki              | `3b2653bdde1a57479393b3b1c6e624af27fa249e` | [connector middleware](https://github.com/interledger/rafiki/tree/3b2653bdde1a57479393b3b1c6e624af27fa249e/packages/backend/src/payment-method/ilp/connector/core/middleware)                                                                                                                                                                                                                                                                |
| Nitro               | `64c4ee9a17f38939b393c647fb771313e7749043` | [ForceMove](https://github.com/statechannels/go-nitro/blob/64c4ee9a17f38939b393c647fb771313e7749043/packages/nitro-protocol/contracts/ForceMove.sol)                                                                                                                                                                                                                                                                                         |
| Counterfactual      | `f431e3ded7ffeec2e1e2c3cf7b4eeb1854e1154a` | [CREATE2 derivation](https://github.com/counterfactual/monorepo/blob/f431e3ded7ffeec2e1e2c3cf7b4eeb1854e1154a/packages/node/src/utils/create2-address.ts)                                                                                                                                                                                                                                                                                    |
| Perun Go API/client | `1204ffc58cd47bbc0aaa08d8a39ec38d44f4fcae` | [adjudicator API](https://github.com/hyperledger-labs/go-perun/blob/1204ffc58cd47bbc0aaa08d8a39ec38d44f4fcae/channel/adjudicator.go)                                                                                                                                                                                                                                                                                                         |
| Sprites paper       | arXiv `1702.05812v2`                       | [paper](https://arxiv.org/abs/1702.05812v2)                                                                                                                                                                                                                                                                                                                                                                                                  |

## xln evidence boundaries

The canonical cascade is [Runtime → Entity → Account](../core/rjea-architecture.md).
State transitions remain pure; Runtime publishes external effects after WAL commit.
Historical Account frames do not become another live financial state surface.

| Boundary                                                  | Source                                                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed proof selection, transformer execution, collateral | [Account.sol](../../jurisdictions/contracts/Account.sol), [Depository.sol](../../jurisdictions/contracts/Depository.sol)                                                                                 |
| Conditions and first-public-reveal time                   | [DeltaTransformer.sol](../../jurisdictions/contracts/DeltaTransformer.sol)                                                                                                                               |
| Hold admission / recipient resolve authority              | [lock.ts](../../core/account/tx/handlers/htlc/lock.ts), [resolve.ts](../../core/account/tx/handlers/htlc/resolve.ts)                                                                                     |
| Prepare proof and encode clauses                          | [proof-builder.ts](../../core/protocol/dispute/proof-builder.ts)                                                                                                                                         |
| Routed payment / secret followups                         | [payment-admission.ts](../../core/entity/paybook/payment-admission.ts), [lifecycle.ts](../../core/entity/paybook/lifecycle.ts)                                                                           |
| Emergency scheduler / J evidence                          | [due-hooks.ts](../../core/entity/scheduler/due-hooks.ts), [start-evidence.ts](../../core/entity/tx/handlers/dispute/start-evidence.ts), [finalize.ts](../../core/entity/tx/handlers/dispute/finalize.ts) |
| Encrypted route instructions                              | [onion.ts](../../core/protocol/htlc/codec/onion.ts), [envelope.ts](../../core/protocol/htlc/codec/envelope.ts)                                                                                           |
| Present payment request format                            | [xlnInvoice.ts](../../frontend/src/lib/utils/xlnInvoice.ts), [native parser](../../ui/src/native/payment-request.ts)                                                                                     |
| Worst-case J envelope test                                | [BatchBounds.t.sol](../../jurisdictions/test/foundry/stress/BatchBounds.t.sol)                                                                                                                           |

## Lightning and Sprites

Source shorthand: B2/B4/B12 refer to the pinned BOLTs. Locations name actual
code/spec branches; a proposed extension is not treated as an implemented service.

| Mechanism and upstream evidence                                             | xln behavior                                                                                                          | Verdict and smallest adversarial check                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bitcoin commitment revocation / B2                                          | Newer signed proof and Account nonce/counter branches                                                                 | Deliberate difference. Replay stale proof after counter and attempt old finalization; import monotonic authority, not UTXO punishment.                                                                                                                                                           |
| Exact retransmission / B2                                                   | `account/consensus/incoming/replay.ts:131–159` reuses canonical evidence                                              | Covered. Duplicate proposal/ACK must not append another economic transition; conflicting hash/signature rejects.                                                                                                                                                                                 |
| Commit before forward                                                       | Account candidate is committed into Entity candidate; Runtime effects follow WAL                                      | Covered canonical ordering. Crash after commit before publication must republish the same outbox once economically.                                                                                                                                                                              |
| Shared preimage / B4 and Sprites                                            | Same secret propagates across signed locks; AAD binds party/J/asset/amount/deadline                                   | Covered. Wrong domain or altered neighboring identity must fail; learning a secret alone does not authorize unrelated financial movement.                                                                                                                                                        |
| Sprites shared first-timestamp registry                                     | `DeltaTransformer:47–51,273–283,400–414`                                                                              | Already implemented. Later repeated reveal cannot refresh the first timestamp; no second registry is needed.                                                                                                                                                                                     |
| Sprites common expiry / path-independent lock duration                      | xln uses staggered hop heights and side-specific timed J evidence; cross-J needs portable authority and salvage       | Deliberate difference. One-J shared registry result does not automatically prove constant-time multi-J recovery. Test source-late-reveal and target copying against each signed clock.                                                                                                           |
| Preimage learned near expiry / LND forwarding and Raiden danger-zone policy | `lifecycle:66–76` waits 120s after secret; `due-hooks:44–64` can defer full start batch                               | Evidence gap/candidate. Downstream completes, upstream withholds ACK, J reveal deadline approaches. Prove timely registry reveal OR timely dispute-start arguments through real WAL/J, not merely a prepared dispute.                                                                            |
| Cancellation authority                                                      | `htlc/resolve.ts`: beneficiary cancellation while live; payer cancellation after expiry                               | Covered structural safeguard. Payer cannot cancel a live beneficiary right; expiry race must preserve timely published evidence.                                                                                                                                                                 |
| Directional fee and liquidity                                               | `htlc-quote.ts`, `utils.ts`, admission's `maxSenderDebit`                                                             | Covered mechanism. Exercise inverse rounding, both directions, exact maximum debit and held capacity; secured and unsecured capacity remain separate.                                                                                                                                            |
| Fixed-size onion / B4:145–177                                               | xln nested encrypted packets have length prefixes and no comparable fixed padding                                     | Optional privacy gap. Compare 2/4/8-hop packet lengths. Contents are encrypted; remaining route length is not thereby hidden. Padding requires an explicit wire/size choice.                                                                                                                     |
| Recipient route blinding / B4:442–542                                       | Sender currently constructs full route from real Entity IDs                                                           | Optional privacy gap. An authenticated opaque recipient suffix could hide private topology; preserve real bilateral counterparty/J binding.                                                                                                                                                      |
| Basic MPP and AMP / B4:350–431, LND `amp/sharer.go`                         | Active hashlock guard prevents multiple concurrent legs using one hash; each recipient lock resolves independently    | Capability gap, not a broken existing promise. `mpp.ts` means Machine Payments Protocol, not multipart. Two routes of capacity 60 do not establish one atomic payment of 100. Need receiver aggregation and unique child identities; one missing shard must never produce full-order acceptance. |
| Signed offers/invoices / B12:663–785                                        | Existing URI is reusable unsigned payment intent without order ID, issuer signature or expiry                         | Application capability gap. User still authorizes spending. Merchant checkout needs authenticated terms and paid-once/retry semantics; not every transfer link needs one-use behavior.                                                                                                           |
| Invoice request retry / LND `bolt12/invoice_request.go:65–73`               | Frame retransmission and active payment hashes do not identify a business order                                       | Application gap. Crash after payment commit before merchant response; repeat request returns prior result, not a second purchase. Pinned LND BOLT12 is a codec library, not proof of complete deployed flow.                                                                                     |
| Quiescence / B2:1491–1556                                                   | Settlement transition freezes unrelated AccountTx admission                                                           | Already analogous. Race an in-flight proposal against settlement revisions and reconnect; use canonical workspace rather than a new generic phase.                                                                                                                                               |
| Splicing / B2:1558 onward                                                   | R2C/C2R rebalance with certified J receipt and existing account identity                                              | Deliberate difference. Reject speculative capital before J finality; replacement Bitcoin funding transactions add no needed primitive.                                                                                                                                                           |
| Taproot versus PTLC                                                         | xln uses Keccak conditions and Hanko-authorized clauses                                                               | Optional cryptographic extension. Pinned LND Taproot success path still checks a preimage; no implemented PTLC state machine established. Arbitrary clauses do not mean adaptor-signature machinery is implemented.                                                                              |
| Maximum future CLTV / LND `link.go:2595–2666`                               | Inspected lock/forward admission has past-deadline checks and 32-lock count cap, no comparable maximum future horizon | Operational policy gap; loss unproven. Fill slots with far-future locks, offer honest payment, exercise expiry/cancellation/close. Choose provider admission policy without forbidding negotiated long-term clauses.                                                                             |

## Raiden and generalized applications

TN is pinned `TokenNetwork.sol`; SR is `SecretRegistry.sol`. The comparison uses
this revision rather than assuming all historical Raiden designs are identical.

| Mechanism and upstream evidence                                                                       | xln behavior                                                                                                                           | Verdict and smallest adversarial check                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature domain / TN:1535–1620                                                                       | `Account:523–606` binds chain, Depository, pair, nonce, proposer, body and watchseed                                                   | Covered. Replay across another J/pair/nonce; use actual Hanko/contract vectors.                                                                                                                                   |
| Single-token funded account / TN opening/deposit                                                      | Multi-token Account with earmarked collateral, reserves and granted credit                                                             | Deliberate generalization. Show an unsecured remainder honestly; proof of debt cannot promise assets outside J.                                                                                                   |
| Concurrent withdrawals / TN:382–514                                                                   | `Account:1240–1300` nonce/dispute gates                                                                                                | Covered primitive; combined race evidence not established. Two withdrawals plus a prior proof must have exactly one canonical capital outcome.                                                                    |
| Close/update/settle / TN:558–700,1187–1204                                                            | Signed proof selection, counterproof, equal-nonce left precedence                                                                      | Richer explicit branch semantics. New counterproof followed by stale finalize cannot revert to the old state.                                                                                                     |
| Lock commitment / TN:1461–1484                                                                        | Bounded signed payment clauses; maximum 32 locks                                                                                       | Deliberate difference. Pinned Raiden hashes concatenated 96-byte locks, not individual Merkle inclusion proofs. Max-state finalize must fit selected J.                                                           |
| Reveal timing / SR:18–38, TN:1487–1516                                                                | Immutable registry timestamp; signed seconds inclusive, exclusive millisecond conversion in proof-builder                              | Covered with differing representations. Test deadline−1ms/deadline and converted J-second boundaries; no automatic off-by-one finding.                                                                            |
| Danger zone / Python mediator:90–111,735–789                                                          | Timed starter arguments and public reveal exist, fixed ACK watchdog can consume deadline                                               | Combined production evidence missing. Reuse existing evidence path; do not create a new global secret service.                                                                                                    |
| Expiry and reorg grace / Python channel:183–202,315–340                                               | Pure deadline checks, authenticated pre-finality watcher rewind, finalized J admission                                                 | Deliberate finality boundary. Unfinalized reveal rollback and finalized contradiction have different authority; exercise both.                                                                                    |
| Settlement and debts / TN:763–882                                                                     | `Depository:900–1004` earmarked collateral, reserve allocation, remaining debt, future Entity/token reserve recourse                   | Broader financial primitive. Concurrent exits must conserve secured rights; future reserve recourse is not guaranteed seizure of all external wealth.                                                             |
| Tower reward and timing / MonitoringService:112–167,238–363                                           | Narrow signed appointment, late rescue eligibility and actual tower transaction; optional HTTP fee fields alone are not funded service | Authority covered; operational funding/inclusion evidence missing. Fund tower, take owner offline, start stale close, spike fees, restart tower; include latest proof before timeout.                             |
| Generic force-progress / Nitro ForceMove:39–79,218–232; Counterfactual challenge responder; Perun API | xln evaluates signed terminal financial allocation through transformers                                                                | Deliberate scope. No equivalent generic forced intermediate app progression established. First show a financial use case that requires it; avoid framework expansion for its own sake.                            |
| Counterfactual CREATE2 / Counterfactual derivation:30–79                                              | Arbitrary signed transformer execution and proof serialization exist; wallet author/approve/deploy handlers not found                  | Implementation gap. One real compile/sign/restart/permissionless deploy/finalize artifact is required before claiming usable custom-clause support.                                                               |
| Failed interpreter / Counterfactual conditional execution                                             | `Account:863–938` fails finalization on missing code, revert/OOG or malformed result                                                   | Covered safety; SPEC was wrong. Skipping a signed option can erase its holder's right. Correct documentation, preserve strict execution, measure deployability and gas before admission.                          |
| Hierarchical apps / Perun child-state API                                                             | Clauses share one signed proof; a broken admitted clause can block whole finalization                                                  | New protocol choice if isolation is needed. Bounded admitted clauses or separate Accounts may suffice. Allowances constrain allocation, not execution liveness. Perun EVM backend was not verified in this study. |

## Hydra

This revision initializes an empty Head; old commit/collect/abort descriptions
would misstate its current lifecycle. Head snapshots require all Head parties,
while xln Accounts are bilateral under Entity authority.

| Mechanism and upstream evidence                                                          | xln behavior                                                                                                        | Verdict and smallest adversarial check                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Increment admission / Direct Handlers:327–357                                            | Bounded J batches and Account proof clauses                                                                         | Important evidence gap. Hydra drafts future exit to reject unclaimable deposit. xln's max-128-token Foundry vector asserts a 15M envelope, not fitness for reduced XLNC gas. Execute worst legal mixed proof under selected limit before admission. |
| Validation before snapshot ACK / HeadLogic:491–500, security regression in HeadLogicSpec | Incoming preflight plus draft `applyAccountTx` before ACK; signed-malformed and poisoned-envelope regressions exist | Covered principle. Never validate only on the original locally constructed path. Exercise queued/remote/replayed provenance with real signatures.                                                                                                   |
| Exact deposit identity / Snapshot and Head validator                                     | J claim binds chain, contract, pair, height, block hash and event hash                                              | Covered domain. Mine before receipt WAL crash, restart, deliver duplicate plus lookalike event; credit exactly once or reject conflict.                                                                                                             |
| Snapshot version and ordered financial content                                           | Hanko domain, nonce, exact frame/root and canonical ordered outputs                                                 | Covered comparable boundary. A valid signature on altered order/domain/body must not validate.                                                                                                                                                      |
| All-party agreement                                                                      | Bilateral Account agreement; Entity has its own board rules                                                         | Deliberate scaling difference. An offline Head party halts Head progress; offline xln counterparty affects its Account. Do not impose whole-hub unanimity.                                                                                          |
| Close/contest and bounded extension                                                      | xln signed fixed response windows and monotonic counterproof branches                                               | Deliberate difference. Do not copy automatic contest extension into already signed clocks. Race close, counter, board change and finalize using their exact authority.                                                                              |
| Fanout, including partial fit                                                            | Independent bounded account settlement, not one shared Head UTXO fanout                                             | Import future-exit-fit principle, not a new global state commitment. Lower J capacity still needs aggregate simultaneous-exit measurement.                                                                                                          |
| Funded solvency                                                                          | RCPAN secured entitlement plus signed debt                                                                          | Deliberate richer credit model. Report secured recovery and unsecured exposure separately.                                                                                                                                                          |
| Restore and pending-effect identity                                                      | Canonical checkpoint + Runtime WAL + flat outbox                                                                    | Covered architecture; exact combined J-crash scenario still needed where absent. No second receipt/frontier oracle. Hydra persistence fsync semantics were not fully verified.                                                                      |
| Formal model / Solvency and validator agreement                                          | Existing xln TLA/Kani/Foundry evidence programme                                                                    | Method worth retaining, not a new release-blocking campaign. Hydra solvency file explicitly covers 6/12 transition bundles, not universal correctness. Close xln's existing named model/production gap before adding a new formal language.         |

Hydra's [invalid-snapshot advisory](https://github.com/cardano-scaling/hydra/releases/tag/2.4.1) demonstrates why signed agreement alone does
not replace transition validation. The relevant xln malformed-input regressions
already check rejection before acknowledgement; this is evidence of coverage,
not justification to assume every provenance path is green.

## Interledger

ILPv4 is packet forwarding; STREAM is an end-to-end transfer protocol; BTP leaves
automated settlement and dispute behavior to subprotocols. Rafiki supplies a
concrete service/accounting implementation, not xln's adjudication authority.

| Mechanism and upstream evidence                                                     | xln behavior                                                             | Verdict and smallest adversarial check                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bilateral credit / HTLA architecture, BTP settlement boundary                       | Signed credit range plus collateral and programmable J enforcement       | xln adds common financial recourse. Bilateral credit was prior art; the contribution is the enforceable composition, not discovery of bilateral accounts.                                                   |
| Fulfillment hash / ILPv4:29; Rafiki validate-fulfillment                            | Signed Keccak locks and domain-bound encrypted evidence                  | Covered condition mechanism. Wrong preimage, amount or J cannot fulfill another obligation. Hash algorithms need not match.                                                                                 |
| Expiry reduction / ILPv4:78–82; Rafiki reduce-expiry                                | Signed hop deadlines and J enforcement policy                            | Comparable ordering, different guarantee. Rafiki's 1s minimum / 30s max packet holds are not a safe J-inclusion budget. Do not import its timers into pure RJEA.                                            |
| Short packet credit versus conditioned settlement / ILPv4 architecture              | xln can retain signed J-adjudicable conditional obligations              | Deliberate difference. An unconditional underlying settlement account can leave a bounded connector credit loss; packet expiry alone does not manufacture enforceable collateral.                           |
| Pending debit then post/void / Rafiki balance middleware                            | Canonical holds/draft transition followed by WAL and outbox              | Covered accounting discipline. Reject/expiry/restart must free exactly the right hold without speculative external effects. Do not add a TigerBeetle ledger beside canonical state.                         |
| Receiver minimum and sender maximum / STREAM:136–140,295–296                        | Quotes, directional fees and `maxSenderDebit`; encrypted final amount    | Covered transfer boundary; merchant acceptance is separate. Validate recipient's intended J/asset/amount and total order acceptance rather than treat a successful small packet as complete checkout.       |
| Chunking / STREAM packet sequence and fulfillment derivation                        | Individual signed routed locks, cross-J ladder partial fills             | Optional adaptive-payment capability. STREAM incrementally transfers value; that is not proof of all-or-nothing multipart order completion. Test interrupted delivery and explicit accepted partial amount. |
| Flow control / STREAM:214–216; ILPv4 peer bandwidth                                 | Credit/capacity, finite locks and typed rejection                        | Comparable bounds, not full anti-jamming proof. Late lower advertised service limits must not retroactively cancel admitted signed rights. Operational admission stays separate from committed authority.   |
| Duplicate sequence and transient received totals / STREAM; Rafiki stream controller | Frame identity, cached ACK evidence and canonical durable economic state | Covered replay discipline; business-order identity still missing. A service's Redis totals/TTL must not become another financial oracle on restart.                                                         |
| External key exchange / STREAM:158                                                  | Entity authority and advertised encryption keys                          | Different trust boundary. Authenticate application requests against intended beneficiary/domain; HTTPS service authorization is not authority to change an Account.                                         |
| Path feedback, packet sizing and partial-payment hooks / Rafiki                     | Routing hints outside deterministic financial truth                      | Optional service optimization. Add only after measured failed-route cost; asynchronous callback or rate oracle never silently decides committed RJEA state.                                                 |

## Two rounds of criticism

First pass identified deadline risk, route privacy, admission/exit fit and missing
wallet clause lifecycle. Second pass checked existing countermeasures: timed
starter arguments, idempotent public registry, Hanko domains, fixed bilateral
authority and authenticated J admission. These prevent overstating the candidates.

One suspected defect was withdrawn: a long route does **not** make the target
reveal height negative. Origin admission adds `3 × totalHops`; each downstream
step subtracts 3. At base height 1000 a 100-hop route starts at 1350 and ends at 1053. A source-only subtraction calculation was wrong. Route-length privacy and
correlated dispute capacity remain separate valid questions.

Similarly, allowances do not solve arbitrary-clause liveness, encrypted contents
do not imply fixed-length anonymity, an inspected max-gas test is not a device
benchmark, and transformer extensibility does not mean every app is implemented.

## Minimum followup sequence

These are recommendations, not another live task list. The active execution
authority remains [todo.md](../../todo.md) and [launch design](../launch-design.md).
No core/contract changes or protocol forks were made for this research.

1. **Claim survives withheld ACK.** Produce A → hub → B on the real Runtime/WAL/J
   path. B reveals late; hub commits downstream; A withholds ACK; start batch is
   saturated; recover after crash. Measure authoritative evidence inclusion before
   each signed deadline and final secured allocation on both legs. Existing unit
   tests cover parts, not this complete guarantee. Fix only a demonstrated first
   divergence through the existing scheduler/evidence/outbox path.
2. **Low-gas exit fits.** Use the selected absolute gas limit and interval. Measure
   start/counter/reveal/finalize/withdraw for the maximum legal mixed proof, then
   correlated account remedies. For reserved fraction `f`, gas `G`, remedy cost
   `g`, interval `t` and window `W`, the simple capacity ceiling is
   `floor(W/t) × floor(fG/g)`; variable gas, bytes, fees and inclusion policy need
   real measurement. Restrict financial admission if a legal obligation cannot exit.
3. **One deployable custom clause.** Compile with pinned inputs, independently
   reproduce hash/address, bilaterally sign, restart both sides, deploy on demand,
   finalize with bounded allowances and strict failure semantics. No generic DSL,
   global registry or skip-on-failure protocol change is needed.
4. **First useful merchant artifact.** If checkout is the pilot, distinguish a
   repeatable transfer link from a one-use authenticated invoice. Bind J, asset,
   amount, beneficiary and order; keep attempts distinct; restart after commit
   before response and return prior completion. Keep business acceptance above
   financial entitlement. Optional atomic multipart follows a demonstrated need.
5. **Offline recovery service.** Use the existing narrow tower appointment and
   actual funded gas arrangement. Demonstrate inclusion under hub failure, fee
   pressure, multiple disputes and tower restart. Subscription/funding can be
   operational; on-chain rewards would be a new explicit protocol choice.

Phone/laptop XLNC targets use ordinary persistent full-node state. Measure fresh
bootstrap separately from two-day incremental catch-up, five-minute catch-up
completion, sustained CPU/RAM/disk/bandwidth/energy and emergency inclusion.
Lower block gas bounds execution but does not by itself quantify client overhead
or accumulated state. No stateless or ZK prerequisite is introduced.

## Owner choices and MML

The remaining useful choices are the absolute XLNC gas limit/interval and client,
reusable link versus one-use merchant request, first-release route-length privacy,
and who funds delegated emergency gas. They are not assumptions of new consensus.

The contribution most worth demonstrating is common provable account finance:
Entity authority, secured and unsecured exposure, signed executable conditions,
programmable J recourse and local economic activity in one canonical system.
That is broader than token payments. Historical exclusivity and universal strict
dominance have not been established by this bounded source study.

[MML](../intro.md#mission) is accounts supporting 51% of world GDP made provable
by 2050, including programmable J reserves and account claims. Measure backing
and claims separately; avoid double-counting routed hops, swap legs or circular
traffic. Annual GDP coverage is not balance stock or raw payment turnover.
The first persuasion artifact should show useful payment/finance, deliberately
chosen credit, a stopped hub, retained evidence and actual secured recovery.

## Limits of this review

Fresh xln verification: four existing test files passed, **20 tests / 89 assertions**:
HTLC events and dispute tail, dispute-secret publication, opaque Entity encryption,
and frontend invoice URL policy. These verify their named components, not the full
deadline/inclusion or merchant-order scenarios recommended above. Runtime-doc paths
passed (45 runtime entries / 11 docs), vocabulary passed (18 required terms / zero
import aliases), and all 20 local report links resolved.

`bun run check` was attempted under the stand lock. Short gates passed (contract
artifact drift, 2,882-file size check; four immutable-metadata contracts). Full
verification stopped at `rscore:fmt`: `cargo: command not found`, exit 127.
Cancelled sibling gates are not passes. No runtime/contract changes were made,
and this report is not a release-readiness claim.

Not exhausted: every historical revision, every cryptographic proof or branch,
all upstream test suites, complete Perun EVM backend, all formal Hydra transitions,
every arbitrary application's force-progress theorem, deployed PTLC interoperability,
live adoption, phone hardware, maximum mixed-proof gas or multi-J failure matrix.
Source findings and inspected regressions are distinguished from fresh execution.
Research supplies concrete experiments; it is not a certificate of no defects.
