# disputes-final: disputes and cross-j recovery

og (core/ + jurisdictions/ at 566c850) is the spec. The tests are in `pure/diff/disputes/disputes-final.test.ts`. Run them from `pure/` with `bun test diff/disputes/disputes-final.test.ts`: 17 pass, 0 fail. Every test is `MATCH:` and runs live og on seeded random inputs.

## Rows closed

| Row | og item | Rewrite | Status |
|---|---|---|---|
| entity-j EJ-R1 | j-events.ts `DisputeStarted` / `CounterDisputeRegistered` / `DisputeFinalized` / `HashLadderRevealRegistered` Entity handlers, `flushDeferredHashLadderReveals` | `finalizedJEvent` cases `disputeStartedJEvent`, `counterRegisteredJEvent`, `disputeFinalizedJEvent`, `ladderRegisteredJEvent`. An unknown finalized event halts with `FINALIZED_J_EVENT_HANDLER_MISSING`. | FIXED (5ae3355). MATCH: 200 random signed dispute events and 150 random signed secret/ladder ranges, through og `applyJEvent`. |
| entity-j EJ-R2 | `applySecretRevealedJEvent` → `applyKnownHtlcSecret` | `knownSecret`: paybook route, fee, inbound `htlc_resolve`, cross-j relay output | FIXED (5ae3355). Covered by the 150 range MATCH. |
| scheduler-disputes 14 | Proofs carrying locks/swaps/pulls, the arguments built from them, and the reveal flush on finalize | `accountProofBody` clauses (6688ad8); arguments (102f0d2); the flush in `batchProcessedJEvent` and `entityJBroadcast` (5ae3355) | FIXED. MATCH: 600 random Accounts' ProofBodies, 500 argument sets, and 250 flush states. |
| scheduler-disputes 15 | Starter-argument secrets (`applyKnownHtlcSecret`), cross-j recovery, and source hub claims on finalize | `disputeStartedJEvent` starter secrets and recovery plan; `finalitySettlements`; `eventSourceClaims` | FIXED (5ae3355). Covered by the 200 dispute-event MATCH. |
| cross-j-final 10 | `crossJurisdictionBookOrderRemoved` dispute branch; `handlePrepareDispute` recovery, book removal and readiness | `disputeRemovalAck`, `prepareDispute` (`planTargetRecovery`, `disputeBookRemoval`, `pendingOrderbookRemovalIds`) | FIXED (1abcef3). MATCH: 200 removal ACKs and 250 prepare / sibling cases. |
| cross-j-final 11 | `crossJurisdictionSalvage`, `crossJurisdictionForceSiblingDispute` | `crossSalvage`, `forceSiblingDispute` | FIXED (d2773bd). MATCH: 250 reveal ports; sibling fanout is inside the 250 prepare / sibling cases. |
| cross-j-final 12 | Cross-j recovery, source hub claims, starter secrets, proofs with locks/swaps/pulls | as rows 14, 15 and 10 | FIXED. |
| cross-j-final 13 | `flushDeferredHashLadderReveals` | `flushDeferredReveals`, called on `j_broadcast` and on an exact `HankoBatchProcessed` finalize | FIXED (d2773bd, 5ae3355). MATCH: 250 flush states. `stashPendingRegistryReveal` is now reachable through salvage and `HashLadderRevealRegistered`. |
| cross-book 18 | `crossJurisdictionBookOrderRemoved` dispute branch (`confirmDisputeBookRemoval`, `draftPreparedDisputeStartIfReady`) | `disputeRemovalAck`, `draftPreparedStart` | FIXED (1abcef3). MATCH: 200 random ACKs (proof in d6dee21). |
| entity-consensus-2 33 | prepareDispute, disputeStart, disputeFinalize | prepare with book removal and recovery; start with argument overrides (`DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED` is og's own halt); finalize with proof selection and the crontab hook | FIXED. MATCH: 200 `disputeStart` with real Hankos and overrides; 250 prepares; 400 finalizations (scheduler-disputes); hooks inside the 200 dispute-event MATCH. |
| entity-lane 31 | The other cross-j Entity txs | salvage and sibling dispute here; the book txs in cross-book.md; clear / pullClose / sweep in cross-j-final.md | FIXED. |
| entity-lane 32 | Cross-j `disputeStart` / `resolveHtlcLock` runtimeOutput authority (`assertRuntimeCrossJRecoveryAuthority`) | `recoveryAuthority` in `runtimeOutputAuthError` | FIXED. MATCH: 800 random envelopes against og `assertRuntimeOutputAuthorization`. Force-sibling via runtimeOutput is refused by both. |
| entity-lane 33 | `flushDeferredHashLadderReveals` | as cross-j-final 13 | FIXED. |
| cross-j 47 | Secret-ACK deadline dispute (due hook); `persistVerifiedPaymentSecret` on dispute paths | The due hook is in scheduler-disputes (MATCH there). `unsafeAccountFrame` ports og `handleUnsafeAccountFrame` (b21994f). | FIXED. MATCH: 200 random unsafe frames against og `handleUnsafeAccountFrame`; 200 `resolveHtlcLock`. |
| cross-j 49 | Entity cross-j handlers and collections | all ported (rows above, cross-book.md, cross-j-final.md) | FIXED. |
| cross-j 50 | `flushDeferredHashLadderReveals` | as cross-j-final 13 | FIXED. |
| settle-jsubmit SJ-19 | finalize latches (`finalizeQueued`) in j-abort / j-clear | `disputeFinalize` sets the latch (`latchFinalize`), and `releaseEntityLatches` clears it | FIXED. The row was stale. MATCH: 200 random aborts and clears (a12dd12). |

## Behaviour changed in this area

- **Unsafe Account frames.** An Account input refused with a dispute disposition used to only freeze the Account, and its `start_dispute` output was dropped. It now runs og `handleUnsafeAccountFrame`:
  - A just-created inbound Account is dropped.
  - The secret-window evidence secret is persisted, then resolved upstream with its ACK deadline.
  - `handlePrepareDispute` runs.
  - A queued start latches `autoBroadcastDraft` and emits a self `j_broadcast`.
  - No committed followups run.
- **`finalizedJEvent`.** Its default is now a halt, not `J_EVENT_<type>_ENTITY_HANDLER_NOT_PORTED`.
- **`foldTx` is exported.** Tests use it to inspect one tx without the Entity frame's Account proposals.

## Follow-up divergences (after the merge of claude/project-thread-nkes8j, 52dde22)

- **Mempool on DisputeFinalized: not a divergence.** og `applyAccountDisputeFinality` filters out `settle_transition`, then sets status `disputed` and calls `freezeAccountForDispute(account, false)`. With that status and flag, the freeze keeps no deferred claims and no optional evidence, so og's mempool always ends empty, just like the rewrite's `disputeFinalized`. PROVED (29c34e8): 400 random live / preparing / disputed Accounts with mixed mempools and pending frames give the same mempool, jNonce and nextProofNonce.
- **`DISPUTE_CANONICAL_DELTA_BATCH_INVALID`: FIXED (1191082).** `ethersBatchPulls` reproduces the ethers 6.17.0 decode of the DeltaBatch tuple as og runs it, including its error texts:
  - `data out-of-bounds` and `insufficient data length`, with buffer / length / offset;
  - `overflow` and `invalid BytesLike value`;
  - the deferred-error texts for an overflow in the batch offsets (`index 0`) or in the pull slot (`property "pull"`).

  A payment or swap count overflow stays deferred and unread, as in og. MATCH: 1500 random ProofBodies against og `proofBodyHasPulls`.
- **`ACCOUNT_EXTERNAL_FINALITY_REFUSED`: FIXED (0b650a3).** og's Account layer refuses no `dispute_finalized`. An unsafe finalized nonce or token id halts upstream in og `applyDisputeFinalizedJEvent`, and `childFinality` now maps the Account refusal to that same upstream text (`J_EVENT_DISPUTE_FINAL_NONCE_INVALID` / `J_EVENT_DISPUTE_FINAL_TOKEN_ID_INVALID`). The generic fallback is unreachable: the envelope is the Account's own terms, and every tag takes `external_finality`. `disputeFinalizedJEvent` checks both conditions first, with og's text, so no input reaches the mapping and no MATCH test can.
- **Unsafe-frame reason: FIXED where reproducible (d41537a).** `admitPeerFrame` now carries og's failureMessage on the evidence for these refusals:
  - `Bilateral account state root mismatch`;
  - every `getDisputeHankoRequirementError` text with og's values (`disputeRequirementText`).

  MATCH: 1500 random requirement inputs against og. The account-consensus test also asserts og's root-mismatch text and the shape of its DISPUTE_HANKO_REQUIRED text. Per-tx replay failure: FIXED (final-sweep.md). `accountTxFailure` renders og's rejection or thrown text for every Account tx handler; `admitPeerFrame` gives `Frame application failed: <og text>` for a rejection, and a thrown handler aborts the Entity input (`account_tx_thrown`). MATCH: `final-sweep.test.ts` random lockstep texts, plus the account-consensus dispute-reason test against og `applyAccountInput`.
- **`rejectedFrameEvidence` in the root: FIXED (d41537a).** og `handleUnsafeAccountFrame` sets `shadow.rejectedFrameEvidence` and never clears it. og commits it in the Account leaf as `{ reason, frameHash, frameHanko }`. The Account envelope now keeps `rejectedFrame` through every phase (via `envMeta`), and `installedAccount` commits it. MATCH: the unsafe-frame test compares the committed value with og's projection for both secret-window and root-mismatch reasons.
