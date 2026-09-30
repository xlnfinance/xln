# final-sweep: the last recorded divergences and the final audit

og = core/ + jurisdictions/ at 566c850 is the authority. The branch starts from claude/project-thread-nkes8j at 10f74e5 (426 pass).
Tests: `pure/diff/runtime/final-sweep.test.ts`, plus the edited tests named below. Every MATCH test runs og live.
Result: `bun test` 434 pass, 0 fail (28 files). tsc is clean.

## Fixes (one commit each)

| # | Item | Commit | What changed | Evidence |
|---|------|--------|--------------|----------|
| 1 | Dead Hole machinery | 36fc04b | Deleted `HoleNames` (`reveal_before_height`, `quote_last_ms`), the `Hole` type, the `unchosen` error variant and Author `unchosen`. Nothing used them, and og has no equivalent. | tsc, full suite |
| 2 | cross-book.md row 24: SwapMatched for cross fills | f2d4e55 | The cross fill path emits og's `SwapMatched` runtime event with og's count (commitOrderbookMatchResult). | cross-book.test.ts cross fill test (count equals og) |
| 3 | disputes-final.md: unsafe-frame dispute reason | de39e0f | `accountTxFailure` gives og's per-tx replay error text for every Account tx handler, including thrown Errors, the 128-row cap, HTLC secrets, lending replay, maker limit price and the settlement Hanko texts. The unsafe-frame dispute reason carries that text. | final-sweep.test.ts "og per-tx failure text for every Account tx handler" (80 lockstep sequences, targeted and settlement cases) |
| 4 | RF-15 residuals | 22f116c | A remote leg's malformed-ingress refusal is og `CROSS_J_ACCOUNT_PAIR_PROTOCOL_REJECTED`, a mempool refusal is NOT_COMMITTED, and invariants and replays refuse the frame (og applyAtomicEntityInputPair). The Account head keeps og's committed-frame cross-j txs (`crossTxs`), so an already-committed ACK is judged by exact replay against the committed frame. | runtime-final.test.ts (600 committed-ACK batches vs og selectMatchedCrossJAccountInputPairs, full-mempool leg vs og getEntityMempoolAdmissionError) |
| 5 | RF-18 signer | c831900 | An Account message to an Entity with no local replica binds og's certified counterparty proposer (the frame Hanko's first member), then og's gossip `verifiedProfileRoutes` signer, then the replay hint. It fails with og `SIGNER_RESOLUTION_FAILED` (og resolveEntityProposerId order). | final-sweep.test.ts "RF-18 outbox signer" |
| 6 | SJ-18 fallback | f8c459f | With no certified board passed, `settlementBoardAuthority` resolves the board from the source Entity's local replicas, as og resolveSettlementBoardAuthority does: lazy, unique config, certified signing board, and og's DIVERGENCE / MISMATCH / CERTIFIED_BOARD_SIGNING_* refusals. It runs before the Hankos are read. | final-sweep.test.ts "SJ-18" (300 random replica sets vs og createAccountConsensusContext) |
| 7 | RF-18 retained outbox | b38bced | A frame commits only og's retained network outbox (og applyRecoveryRuntimeOutputPlan): source-frame stamp, settled-proposal prune, lane split and route-key merge, local continuation, signer alignment, Runtime binding and the 10000 cap. Transport acceptance retires rows. Recovery takes og selectRetainedRecoveryOutbox plus the replay routes and signer hints. | final-sweep.test.ts "RF-18 retained network outbox" (400 frames vs og, retirement and recovery); runtime-2.test.ts WAL |
| 8 | Stale markers | a246c72 | Removed the unused `tx_unported` FrameHashError variant and the stale "not ported" comments (board refresh hashes, Host dispute finality, REB_STEP). | tsc, full suite |
| 9 | Stale findings rows | 9db3513 | Flipped with evidence: j-layer.md (J7 and the whole Remaining list, including the `flushDeferredHashLadderReveals` call), lending-hub LH-5 / LH-7 (followup-order.test.ts), the entity-txs-3.md scope line, T3-7 / T3-8 and the BLOCKED / HOST-ONLY tx rows, account-consensus.md (AC-11, BOARD_HANKO_REFRESH, STALE_SETTLEMENT_HANKO), account-tx.md (AT-10, AT-17, AT-20, AT-22), hashes.md (J ingress, walkBinary), scheduler-disputes #13 / #18, boards BH-1, entity-j EJ-R3. The first-wave snapshots in SUMMARY.md and entity-runtime.md are marked superseded. | rows cite the tests |

## Kind audit (enumerated from og core/types; the rewrite's unions are in xln.ts)

| og kind family | og source | og count | Handled by the rewrite | Missing |
|---|---|---|---|---|
| EntityTx | core/types/entity-tx.ts `EntityTxPayload` | 63 | 63: the `EntityTx` union and its aliases (JBatch, Settle, SwapRequest, Lending), each with a foldTx handler | none |
| AccountTx | core/types/account.ts `AccountTx` | 21 | 21 (`AccountTxNames`; og `direct_payment` is `payment`) | none |
| RuntimeTx | core/runtime/types.ts `RuntimeTx` | 16 | 16 (`RuntimeTx`, including importJ / completeImportJ) | none |
| EntityInput lanes | core/entity/types.ts `EntityInput` | 5: entityTxs, proposedFrame (+collectedSigs), hashPrecommitFrame + hashPrecommits, jPrefixAttestations, leaderTimeoutVote | 5: txs, proposal, precommit, jPrefixAttestations, leaderTimeoutVote | none |
| Routed wire fields | core/runtime/types.ts `RoutedEntityInput` | signerId, runtimeId, from, sourceRuntimeFrame, atomicCrossJurisdictionPair | all five (`RoutedEntityInput`, `laneProvenance`) | none |
| J events | core/types/jurisdiction-events.ts | 18 | 18: the 16 Depository / EntityProvider logs of `J_EVENT_SIGNATURES` plus the watcher-made ExternalWalletSnapshot / ExternalWalletDelta | none |

Enumeration: og EntityTx and AccountTx through their unions' top-level `type:` members; EntityTx cross-checked against the rewrite's union members. The rewrite's EntityTx has no kind og lacks (`profile-update` is og's own).

## og exported types the rewrite does not name

Of 172 exported types in core/types, core/runtime/types.ts and core/entity/types.ts, 92 never appear by name in xln.ts / xln_run.ts. Each was checked for its fields or a counterpart. The rewrite models all of them under its own names except these:

| og type(s) | Why none in the rewrite |
|---|---|
| RuntimeEntityInputsEnvelope, UnsignedRuntimeEntityInputsEnvelope, DeliverableEntityInput | The Runtime-signed transport envelope and og validateDeliverableEntityInput sit at network ingress (I/O). The rewrite receives the authenticated `RoutedEntityInput` it contains and emits only typed wire. |
| BrowserVMState, EnvSnapshot, RuntimeEntityMetricStats, RuntimeOverlayRecord, FrameLogEntry, LogCategory, Xlnomy | Host, UI, metrics and log types: never committed, hashed or replayed. |
| AccountNestedFieldCoverage, NestedHashCoverageEntry, AllKeys, AssertNever, Covered, FieldGap, CrossJNestedFieldCoverage, EvidenceNestedFieldCoverage | Compile-time hash-coverage assertions (no runtime value). |
| HankoHex, HankoString, HankoWireClaim, HankoEnvelopeInput | Branded aliases of hex strings. The rewrite's `Hanko` and claim codec carry the same bytes. |
| AccountSubcontract | The rewrite commits `subcontracts` as og's always-empty map. og has no mutation site (only readers in the proof builder and storage). |

The rest are modeled under other names:
- EntityCommandNonceState: `entityCommandNonces`
- PendingSettlementContinuation: SettlementContinuationPlan
- AccountJClaim*: jClaim accumulator and proofs
- NumberedRegistration*: numbered registration intents (entity-j.md EJ-4 / EJ-5)
- CertifiedEntityFrameLink: the certified link (RF-18)
- CertifiedBoardPatriciaNode: the certified-board registry
- CrossJurisdiction*: CrossRoute, pulls and close proof
- J finality and header types: the J watcher
- EntityProviderAction*: the EP actions

## Approximations that remain (none changes committed state, a hash or an output)

- A few deep proof and transformer failure codes collapse to og's outer code, where og's inner throw text is not observable in the rejection.
- A non-hex cross-j close binary reports og `CROSS_J_CLOSE_BINARY_INVALID` (og throws inside its hex decoder with the same class).
- HTLC texts that og formats with the wall clock use the frame clock, because a pure transition has no Date.now.
- og's security-incident telemetry (RF-15) is log output only: never replayed or committed.
- The route key uses digests that preserve equality in place of og's hash bytes. Merge and retire equality is identical, but the key text is not part of any state.
- og validateDeliverableEntityInput is not modeled: the rewrite only emits typed wire (see the table above).
- Gossip profile signature recovery is an injected oracle (`RuntimeRoutes.verifiedProfileSigner`); og reads the verified gossip cache.

## Cannot be made equivalent (unreachable in og)

- RF-17 and og's same-height `appendCertifiedEntityFrameLink` tie-break: og preauthentication requires `height + 1`, so a link never meets a head of its own height. The rewrite commits each height once, which is the same behaviour (runtime-final.md).
- A Set or Date inside a hashed value: outside the rewrite's `Binary` type, so no typed payload can carry one (hashes.md).

## Marker audit

ast-grep (`"$S"` string literals, `Tagged<$A, $$$B>` variants) and grep over xln.ts / xln_run.ts find no `NOT_PORTED`, `UNPORTED`, `unported`, `not ported`, hole or `unchosen` marker. Every remaining `UNSUPPORTED` string is og's own refusal text:
- IMPORT_J_*
- J_PREFIX_VERSION_UNSUPPORTED
- TOWER_*
- CROSS_J_RISK_MODE_UNSUPPORTED
- DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED
- the EIP-2718 transaction type texts
- the orderbook stpPolicy / replace texts
