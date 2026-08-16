# Findings register

This register contains static code findings only. No tests, builds, or runtime
verification were performed for this pass.

## BRIDGE-001 — Bilateral commitments are jurisdiction-domain bound

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** An Account commitment is not portable to a different chain or
  Depository deployment.
- **Evidence:** `computeAccountStateRoot` includes chain ID and lowercased
  Depository address together with canonical left/right entity IDs.
- **Files:** `runtime/account/state-root.ts`, `runtime/account/consensus/frame.ts`
- **Bridge impact:** Prevents the same account state root from representing an
  obligation under a different jurisdiction contract domain.
- **Next verification:** Trace the source of the domain passed during proposer
  and receiver state-root calculation.

## BRIDGE-002 — HTLC and pull holds are committed capacity, not side metadata

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** Creating an HTLC or pull reduces payer outbound capacity and the
  hold participates in bilateral signed state.
- **Evidence:** Both handlers call `addHold`; `deriveDelta` subtracts holds from
  capacity; deltas and commitment maps enter `accountStateRoot`.
- **Files:** `runtime/account/tx/handlers/htlc-lock.ts`,
  `runtime/account/tx/handlers/pull.ts`, `runtime/account/tx/hold-utils.ts`,
  `runtime/account/utils.ts`, `runtime/account/state-root.ts`
- **Bridge impact:** Parallel frames cannot legitimately reuse capacity already
  reserved by a committed bridge leg.
- **Next verification:** Trace same-height proposal collision handling and
  persistence of pending frames.

## BRIDGE-003 — Account HTLC semantics provide conditional pay or release

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** A valid preimage before both deadlines pays the beneficiary;
  failure releases capacity without payment; the payer cannot cancel an active
  lock before expiry.
- **Evidence:** `handleHtlcResolve` verifies preimage and caller side before
  releasing the hold and mutating `offdelta`.
- **Files:** `runtime/account/tx/handlers/htlc-resolve.ts`,
  `runtime/account/consensus/deadline-policy.ts`
- **Bridge impact:** Supplies the bilateral atomic-swap primitive.
- **Next verification:** Trace Entity routing of success/error outcomes across
  multiple accounts.

## BRIDGE-004 — Pulls provide cumulative partial settlement

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** Pull claims are monotonic and apply only the difference between the
  previous and newly proven cumulative amounts.
- **Evidence:** `handlePullResolve` verifies hash-ladder evidence, ignores
  duplicate/lower ratios, calculates cumulative claim, releases incremental
  hold, and updates `claimedRatio`/`claimedAmount`.
- **Files:** `runtime/account/tx/handlers/pull.ts`,
  `runtime/protocol/htlc/hash-ladder.ts`
- **Bridge impact:** Supports partial cross-j fills without creating one HTLC
  per unit of liquidity.
- **Next verification:** Trace the exact-fill numerator/denominator projection
  from the cross-j orderbook into the uint16 proof ratio.

## BRIDGE-005 — Cross-j source and target claims are asymmetrically ordered

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** A source claim requires a target receipt and committed clear
  progress; a target claim requires the source close proof and identical
  hash-ladder evidence.
- **Evidence:** `validateCrossJurisdictionPullResolve` applies different guards
  for source and target bindings.
- **Files:** `runtime/account/tx/handlers/pull.ts`,
  `runtime/types/cross-jurisdiction.ts`
- **Bridge impact:** The Account layer already encodes a bridge-specific
  settlement order; it is not merely a generic partial-payment primitive.
- **Next verification:** Establish how target receipts and source close proofs
  are produced, signed, persisted, and transported by Entity/cross-j code.

## BRIDGE-006 — Close proofs bind exact cumulative settlement

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** A cross-j close cannot be reused for a different route, pull,
  cumulative amount, ratio, or reveal binary.
- **Evidence:** `crossProofMatchesBinding` and `handleCrossPullClose` compare
  order ID, route hash, both pull IDs, source/target cumulative amounts, fill
  ratio, and binary hash, then reject amount/ratio regression and overflow.
- **Files:** `runtime/account/tx/handlers/pull.ts`,
  `runtime/types/cross-jurisdiction.ts`
- **Bridge impact:** Makes partial close evidence route-specific and bounded by
  the originally held amount.
- **Next verification:** Reconstruct canonical route-hash derivation and all
  fields included in it.

## BRIDGE-007 — Active HTLCs and pulls are on-chain enforceable proof clauses

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** Runtime commitments are deterministically encoded into the same
  `ProofBody` interpreted by `DeltaTransformer` during dispute finalization.
- **Evidence:** `buildAccountProofBody` sorts locks and pulls, fails if their
  token delta is missing, builds transformer allowances, ABI-encodes the body,
  and hashes it for Hanko signing.
- **Files:** `runtime/protocol/dispute/proof-builder.ts`,
  `runtime/protocol/dispute/proof-body.ts`,
  `jurisdictions/contracts/DeltaTransformer.sol`,
  `jurisdictions/contracts/Depository.sol`
- **Bridge impact:** Cooperative off-chain settlement has an on-chain fallback
  tied to the signed bilateral state.
- **Next verification:** Trace dispute argument snapshots and which side can
  supply each secret/pull reveal.

## BRIDGE-008 — Deadline units are converted at the Solidity boundary

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** Runtime HTLC and pull deadlines use milliseconds, while Solidity
  transformer deadlines use seconds; both paths explicitly normalize units.
- **Evidence:** HTLC payments divide the lock timelock while building the
  runtime batch. Pulls divide `revealedUntilTimestamp` during ABI conversion.
  `DeltaTransformer` compares the encoded values with `block.timestamp` or
  stored argument timestamps.
- **Files:** `runtime/protocol/dispute/proof-builder.ts`,
  `jurisdictions/contracts/DeltaTransformer.sol`,
  `jurisdictions/contracts/Depository.sol`
- **Bridge impact:** Different chain block times do not directly enter pull
  expiry; the cross-j commitment uses an absolute time domain.
- **Next verification:** Trace external deadline construction and per-chain
  finality safety margins.

## BRIDGE-009 — Receiver-local deadline admission supplements frame validation

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** A peer cannot rely solely on its own signed frame timestamp to
  create or exercise an unenforceable deadline transition.
- **Evidence:** `getIncomingAccountDeadlineViolation` evaluates new locks,
  secrets, pull claims, and payer cancellations against receiver-local Entity
  time and finalized J height with an enforcement reserve.
- **Files:** `runtime/account/consensus/deadline-policy.ts`,
  `runtime/account/consensus/index.ts`, `runtime/account/consensus/frame.ts`
- **Bridge impact:** Network delay and stale retransmission are separated from
  financial expiry safety.
- **Next verification:** Trace the exact security context supplied on every
  inbound AccountInput path.

## BRIDGE-010 — Full bridge completeness classification

- **Status:** `RESOLVED`
- **Severity:** high
- **Claim:** Account primitives alone do not establish a safe bridge. The full
  static reconstruction now classifies xln as a reusable liquidity-bridge
  substrate with unresolved production blockers.
- **Evidence:** Entity/cross-j, Runtime/network, jurisdiction/contracts, and
  storage/recovery were subsequently reconstructed.
- **Files:** `runtime/entity/`, `runtime/extensions/cross-j/`,
  `runtime/jurisdiction/`, `runtime/jadapter/`, `runtime/storage/`,
  `runtime/recovery/`, `runtime/orchestrator/`
- **Bridge impact:** xln should be reused as an integrated substrate, not reduced
  to its hashlock helper and not deployed unchanged.
- **Resolution:** See `final-assessment.md` and `threat-model.md`.
- **Next verification:** Executable and deployment evidence remains deferred.

## BRIDGE-011 — Entity validators sign the complete secondary hash manifest

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** Account-frame, dispute, settlement, profile, and J-batch Hankos are
  derived from hashes emitted by deterministic Entity-frame replay, not from an
  unverified proposer attachment.
- **Evidence:** Validators rebuild `hashesToSign`, compare the complete manifest,
  sign each hash, and reject commit manifests that differ. Committed Hankos are
  attached to Account and J outputs by hash.
- **Files:** `runtime/entity/consensus/hanko-witness.ts`,
  `runtime/entity/consensus/index.ts`, `runtime/entity/consensus/frame.ts`
- **Bridge impact:** A bridge Account/J authorization is coupled to Entity
  consensus over the state transition that produced it.
- **Next verification:** Map multi-validator organization configuration and key
  rotation during active routes.

## BRIDGE-012 — Cross-j route identity is extensively domain bound

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** The canonical route hash binds economic terms, participant roles,
  jurisdiction stacks, contract-domain hints, asset references, settlement
  policy, clocks, and finality-policy label.
- **Evidence:** `deriveCrossJurisdictionRouteHash` ABI-encodes these fields;
  supplied route hashes must match recomputation.
- **Files:** `runtime/extensions/cross-j/index.ts`,
  `runtime/extensions/cross-j/market.ts`
- **Bridge impact:** A route cannot be silently reinterpreted for another pair,
  stack, asset, expiry, amount, or rounding policy.
- **Next verification:** Trace route construction from the public API and ensure
  all optional contract addresses are populated in production.

## BRIDGE-013 — Current cross-j risk mode is fully collateralized only

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** Although route types mention partially collateralized and credit
  modes, canonicalization rejects every mode except `fully_collateralized`.
- **Evidence:** `assertCrossJurisdictionRiskPolicy` throws for other modes.
- **Files:** `runtime/extensions/cross-j/index.ts`
- **Bridge impact:** The current bridge path does not yet use xln credit to
  reduce cross-chain prefunding. Credit-backed bridge claims remain future work.
- **Next verification:** Determine whether bilateral Account capacity may still
  include credit despite the route-level policy name.

## BRIDGE-014 — Setup implements a target-first escrow sequence

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** Source pull creation is requested only after the target pull has
  committed and produced a target admission receipt.
- **Evidence:** Prepare creates the target pull first. Its committed Account
  follow-up emits `commitCrossJurisdictionSwap`; source commit embeds the target
  receipt in the source pull binding.
- **Files:** `runtime/entity/tx/handlers/cross-j-setup.ts`,
  `runtime/entity/tx/handlers/account-cross-j-followups.ts`
- **Bridge impact:** The intended safety order is destination liquidity first,
  source claimability second.
- **Next verification:** Resolve BRIDGE-019 before treating the receipt as proof
  of target commitment.

## BRIDGE-015 — Book admission waits for both pull receipts

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** A cross-j order is exposed to matching only after book admission
  contains source and target receipts matching the canonical route and pulls.
- **Evidence:** Account committed-pull follow-ups produce receipts;
  `getCrossJurisdictionBookAdmissionError` requires both before `admitted`.
- **Files:** `runtime/extensions/cross-j/orderbook.ts`,
  `runtime/entity/tx/handlers/cross-j-book-order.ts`,
  `runtime/entity/tx/handlers/account-cross-j-followups.ts`
- **Bridge impact:** A mere source swap offer cannot become executable liquidity.
- **Next verification:** Resolve receipt authenticity and book-owner runtime trust.

## BRIDGE-016 — Economic fill amounts are not rounded through uint16

- **Status:** `IMPLEMENTED`
- **Severity:** informational
- **Claim:** Exact rational fill progress controls economic source/target
  amounts; the uint16 ratio is only a hash-ladder and dispute projection.
- **Evidence:** Matcher fill construction stores numerator/denominator and exact
  cumulative amounts. Progress validation checks exact amounts and dust bounds.
- **Files:** `runtime/extensions/cross-j/index.ts`,
  `runtime/extensions/cross-j/orderbook.ts`,
  `runtime/account/tx/handlers/cross-swap-fill-ack.ts`
- **Bridge impact:** Repeated partial fills do not accumulate economic drift from
  values such as `1/4 -> 16384/65535`.
- **Next verification:** Trace price-improvement balance movements and fee policy.

## BRIDGE-017 — Account commitment, not book match, advances canonical fill

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** A book match first becomes a fill notice; canonical route progress
  advances only after `cross_swap_fill_ack` commits in the source bilateral
  Account.
- **Evidence:** Fill notice queues an Account mempool operation. Committed-frame
  follow-up updates Entity route and book projection. Missing source offer/account
  state is preserved as pending divergence evidence rather than silently repaired.
- **Files:** `runtime/entity/tx/handlers/cross-j-fill.ts`,
  `runtime/entity/consensus/index.ts`,
  `runtime/entity/tx/handlers/account-cross-j-followups.ts`
- **Bridge impact:** Orderbook projections cannot independently move money.
- **Next verification:** Trace persisted pending-fill ACK recovery.

## BRIDGE-018 — Dispute salvage exists for interrupted cross-runtime close

- **Status:** `INTEGRATED`
- **Severity:** informational
- **Claim:** Pull evidence exposed in a source dispute can be transported to the
  target user for resolution and on-chain enforcement; a target dispute without
  evidence can force a source dispute.
- **Evidence:** J-event handlers decode starter pull arguments and queue
  `crossJurisdictionSalvage`, `resolvePull`, `disputeStart`, and `j_broadcast`.
- **Files:** `runtime/entity/tx/j-events-htlc.ts`,
  `runtime/entity/tx/handlers/cross-j-salvage.ts`
- **Bridge impact:** Cooperative relay failure has a designed dispute path.
- **Next verification:** Reconstruct J-event authentication, finality, and
  persisted dispute-argument snapshots.

## BRIDGE-019 — Target admission receipt lacks cryptographic commitment proof

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** The intended target-first invariant may rely on a receipt that proves
  field consistency but not that the target-user bilateral Account committed the
  target pull.
- **Evidence:** `CrossJurisdictionBookAdmissionReceipt` contains route/pull fields,
  timestamp, and an unkeyed `keccak256` receipt hash. It contains no Account frame
  hash, target-user ACK Hanko, Account state root, or target Entity-frame Hanko.
  Source commit recomputes the receipt hash and fields but does not inspect the
  target sibling Account state.
- **Files:** `runtime/types/cross-jurisdiction.ts`,
  `runtime/extensions/cross-j/orderbook.ts`,
  `runtime/entity/tx/handlers/cross-j-setup.ts`,
  `runtime/entity/tx/handlers/account-cross-j-followups.ts`
- **Bridge impact:** If no additional trust boundary supplies authenticity, a
  malicious hub runtime could potentially construct a syntactically valid target
  receipt and induce source locking before real destination liquidity is locked.
- **Next verification:** Trace the complete remote `EntityInput` authorization
  model and intended user-runtime/hub-runtime trust assumptions. A likely proper
  proof would bind the target Account frame/state root and target-user Hanko.

## BRIDGE-020 — Raw cross-j Entity instructions are not source-Hanko envelopes

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** Cross-runtime system instructions rely on authenticated runtime
  transport and topology checks; the raw `EntityTx[]` does not carry proof that
  the source Entity authorized that specific instruction.
- **Evidence:** `buildCrossJurisdictionEntityOutput` sets the target entity and a
  target signer hint. `validateEntityInput` validates shape. The target Entity
  later signs its own frame, but no source Hanko is present on setup/fill/clear
  Entity transactions.
- **Files:** `runtime/entity/tx/cross-j-outputs.ts`,
  `runtime/entity/consensus/index.ts`,
  `runtime/extensions/cross-j/boundary.ts`, `runtime/types.ts`
- **Bridge impact:** This may be an intentional two-runtime trust model, but it
  must not be mistaken for signed inter-entity messaging. It is especially
  relevant to receipt authenticity and any future third-party solver runtime.
- **Next verification:** Continue through Runtime/network ingress and establish
  whether authenticated runtime identity is explicitly treated as authority for
  its resident entities.

## BRIDGE-021 — Runtime persists the remote outbox before dispatch

- **Status:** `INTEGRATED`
- **Claim:** A committed Runtime frame includes pending remote outputs before any
  network or chain side effect is emitted.
- **Evidence:** `process()` plans `pendingNetworkOutputs`, calls `saveEnvToDB()`,
  optionally passes a recovery-backup barrier, and only then dispatches Entity
  outputs and J batches. Transient failures are rescheduled.
- **Files:** `runtime/runtime.ts`, `runtime/machine/output-routing.ts`,
  `runtime/storage/index.ts`
- **Bridge impact:** A node crash should not silently erase a committed outbound
  cross-j instruction.
- **Next verification:** Deferred by instruction: crash/restart and retry tests.

## BRIDGE-022 — Relay does not queue offline financial traffic

- **Status:** `IMPLEMENTED`
- **Claim:** Offline financial delivery remains the sender Runtime's durable
  responsibility rather than becoming a volatile relay mailbox.
- **Evidence:** Relay routing rejects `entity_input` when the target is absent;
  only gossip is queued. Runtime routing retains transient failures in its outbox.
- **Files:** `runtime/relay/router.ts`, `runtime/machine/output-routing.ts`
- **Bridge impact:** The relay cannot acknowledge financial work that exists only
  in its process-local queue.
- **Next verification:** Deferred by instruction: disconnect/reconnect flow.

## BRIDGE-023 — Entity discovery is Hanko-signed and route-bearing

- **Status:** `INTEGRATED`
- **Claim:** Remote Entity-to-runtime routing is derived from Entity-board signed
  profiles rather than unsigned discovery metadata.
- **Evidence:** Profiles use canonical `xln-profile-v1` hashing and general Hanko
  verification. Only verified profiles populate `verifiedProfileRoutes`.
- **Files:** `runtime/networking/profile-signing.ts`,
  `runtime/networking/p2p.ts`, `runtime/networking/gossip.ts`
- **Bridge impact:** A signed discovery substrate already locates user and hub
  Entities across runtime nodes.
- **Next verification:** Map freshness, rotation, expiry, and recovery semantics.

## BRIDGE-024 — Cross-j v1 has an explicit two-runtime subnet/spoke model

- **Status:** `INTEGRATED`
- **Claim:** Cross-j orchestration is restricted to a user runtime and a hub
  runtime, each hosting sibling Entities for both jurisdictions.
- **Evidence:** Route topology requires source/target users to share one runtime,
  source/target hubs and book owner to share another, and the runtimes to differ.
  Outbound routing enforces this edge.
- **Files:** `runtime/extensions/cross-j/boundary.ts`,
  `runtime/machine/output-routing.ts`, `runtime/machine/entity-routing.ts`
- **Bridge impact:** The remembered hub-and-spoke architecture exists in active
  code; generic multi-runtime solvers are explicitly outside v1.
- **Next verification:** Map placement configuration, persistence, and recovery.

## BRIDGE-025 — Financial EntityInput transport is encrypted end to end

- **Status:** `INTEGRATED`
- **Claim:** Relay and direct transports refuse plaintext financial payloads.
- **Evidence:** Each message uses ephemeral X25519 ECDH and
  ChaCha20-Poly1305. Relay forwards opaque ciphertext; client, direct server, and
  relay reject plaintext EntityInput.
- **Files:** `runtime/networking/p2p-crypto.ts`,
  `runtime/networking/ws-client.ts`, `runtime/networking/direct-runtime-bun.ts`,
  `runtime/relay/router.ts`
- **Bridge impact:** Confidentiality exists, but it is not Entity authorization.
- **Next verification:** Review sender binding, rotation, recovery, and replay.

## BRIDGE-026 — Inbound cross-j topology authorization is missing

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** An authenticated runtime can submit raw cross-j `EntityTx[]` to a
  locally hosted target Entity without proving it is the route's paired runtime.
- **Evidence:** Outbound planning invokes the cross-j topology predicate. Inbound
  handling checks only that the target replica and signer are local, then queues
  the decrypted payload. It receives `fromRuntimeId` but does not compare it with
  route topology, and the payload has no source Entity Hanko.
- **Files:** `runtime/machine/output-routing.ts`,
  `runtime/machine/entity-routing.ts`, `runtime/extensions/cross-j/boundary.ts`
- **Bridge impact:** The subnet/spoke restriction is an honest-sender invariant,
  not yet a hostile-ingress authorization boundary. This strengthens BRIDGE-020
  and may make forged admission flows reachable.
- **Next verification:** Trace every handler's participant checks, then design one
  canonical inbound authorization gate before implementation.

## BRIDGE-027 — Hello signature does not bind the encryption key

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** WebSocket hello signs runtime ID, timestamp, and nonce, but not
  `fromEncryptionPubKey`; no nonce replay cache was found in this slice.
- **Evidence:** `hashHelloMessage()` omits the separately advertised encryption
  key. Relay and direct servers accept/cache that key after a skew-window check.
- **Files:** `runtime/networking/ws-protocol.ts`,
  `runtime/networking/hello-auth.ts`, `runtime/relay/router.ts`,
  `runtime/networking/direct-runtime-bun.ts`
- **Bridge impact:** A captured fresh hello may be replayable with a substituted
  encryption key, subject to socket timing and TLS/deployment assumptions. This
  is not yet classified as a confirmed exploit.
- **Next verification:** Threat-model TLS termination and duplicate sockets; bind
  the encryption key and protocol context into the signed challenge if confirmed.

## BRIDGE-028 — Depository is a dedicated jurisdiction escrow contract

- **Status:** `IMPLEMENTED`
- **Claim:** xln already has a contract that can custody external assets and
  account for Entity reserves, bilateral collateral, settlement, and debt.
- **Evidence:** `externalTokenToReserve` transfers registered assets into the
  Depository; `reserveToExternalToken` releases them. Reserve/collateral movement
  and account finalization are internal ledger operations with emitted evidence.
- **Files:** `jurisdictions/contracts/Depository.sol`,
  `jurisdictions/contracts/Types.sol`
- **Bridge impact:** A liquidity-backed lock/release bridge can reuse a real xln
  escrow boundary; dedicated escrow was not a missing primitive.
- **Next verification:** Map deployed jurisdictions, registered assets, token
  metadata, custody administration, and contract audit status.

## BRIDGE-029 — J batches bind authorization to chain, contract, payload, and nonce

- **Status:** `INTEGRATED`
- **Claim:** An Entity Hanko cannot be replayed as a different batch, on another
  chain, against another Depository, or at another Entity nonce.
- **Evidence:** The batch hash includes `XLN_DEPOSITORY_HANKO_V1`, chain ID,
  Depository address, exact encoded batch, and nonce. `processBatch()` requires
  `entityNonces[entityId] + 1` and atomically reverts incomplete execution.
- **Files:** `runtime/jurisdiction/batch.ts`,
  `jurisdictions/contracts/Account.sol`, `Depository.sol`, `EntityProvider.sol`
- **Bridge impact:** The jurisdiction write path has the core domain separation
  and replay protection expected for bridge escrow control.
- **Next verification:** External contract audit and deployed bytecode matching.

## BRIDGE-030 — J submission cannot invent missing consensus authorization

- **Status:** `INTEGRATED`
- **Claim:** The post-commit adapter must submit the exact batch and Hanko sealed
  by Entity consensus.
- **Evidence:** `submitTx()` rejects a batch missing `hankoSignature`,
  `encodedBatch`, or `entityNonce`; it does not read a fresh chain nonce and sign
  locally. Runtime sends it only after the R-frame is durable.
- **Files:** `runtime/machine/j-submit.ts`, `runtime/jadapter/rpc.ts`,
  `runtime/runtime.ts`
- **Bridge impact:** Chain side effects remain tied to committed Entity state.
- **Next verification:** Crash/rebroadcast behavior is deferred.

## BRIDGE-031 — DeltaTransformer enforces HTLC and hash-ladder outcomes on-chain

- **Status:** `IMPLEMENTED`
- **Claim:** Hashlocks and partial hash-ladder pulls are not merely Runtime
  bookkeeping; they affect final account deltas during contract settlement.
- **Evidence:** Payments accept matching secrets only before their deadline.
  Pulls verify either the full secret or four partial ladder reveals, then apply
  only the increment above `claimedRatio`.
- **Files:** `jurisdictions/contracts/DeltaTransformer.sol`,
  `jurisdictions/contracts/HashLadder.sol`
- **Bridge impact:** xln provides enforceable conditional release primitives for
  a liquidity bridge, including partial fills.
- **Next verification:** Gas bounds, independent audit, and adversarial evidence.

## BRIDGE-032 — Transformer authority is bounded by signed allowances

- **Status:** `IMPLEMENTED`
- **Claim:** A transformer cannot mutate arbitrary settlement deltas solely
  because its address appears in a proof.
- **Evidence:** The signed ProofBody fixes transformer address and encoded batch.
  Depository compares every transformed delta with the original and rejects
  changes outside listed indices or directional left/right allowances.
- **Files:** `jurisdictions/contracts/Depository.sol`,
  `jurisdictions/contracts/Types.sol`
- **Bridge impact:** Conditional bridge claims can be isolated to explicitly
  budgeted asset deltas.
- **Next verification:** Determine whether production accepts arbitrary
  transformer addresses or restricts them to reviewed deployments.

## BRIDGE-033 — Watcher finality and Entity observation consensus are distinct

- **Status:** `INTEGRATED`
- **Claim:** A chain log is first depth-filtered by each watcher and then requires
  Entity-validator agreement on block hash and event-set hash.
- **Evidence:** RPC polling scans only through `tip - confirmationDepth`.
  Validators sign a domain-separated observation digest; Entity finalization
  requires threshold voting power over the identical block/event set.
- **Files:** `runtime/jadapter/rpc.ts`, `runtime/jadapter/helpers.ts`,
  `runtime/jurisdiction/event-observation.ts`, `runtime/entity/tx/j-events.ts`
- **Bridge impact:** A single untrusted event relayer cannot unilaterally finalize
  jurisdiction state when the Entity board threshold exceeds its voting power.
- **Next verification:** Establish that production validators actually operate
  independent RPC/watcher infrastructure.

## BRIDGE-034 — Chain-specific production finality policy is insufficiently established

- **Status:** `OPEN_OPERATIONS`
- **Severity:** high
- **Claim:** Runtime has confirmation-depth mechanics, but a production bridge
  safety policy is not established for every configured jurisdiction.
- **Evidence:** Static defaults are 12 blocks for Ethereum mainnet, a guarded TRON
  depth, and 2 for other non-dev chains. No per-chain economic finality rationale,
  reorg budget, or deployed override evidence was established in this slice.
- **Files:** `runtime/jadapter/rpc.ts`, `runtime/jadapter/types.ts`,
  `runtime/jurisdiction/height.ts`
- **Bridge impact:** Bridge release safety depends directly on destination/source
  reorg assumptions; a generic two-block default is not production proof.
- **Next verification:** Build a jurisdiction-by-jurisdiction finality table from
  deployed configuration and chain guarantees.

## BRIDGE-035 — No rollback path was identified for post-finality reorgs

- **Status:** `OPEN_OPERATIONS`
- **Severity:** high
- **Claim:** Once an Entity finalizes a J height, a different block hash at that
  height is rejected as a conflict; no automatic state rollback was found.
- **Evidence:** `applyJEvent()` throws when an already-finalized height is observed
  with another hash. Finalized events may already have produced Account and
  cross-j follow-up state.
- **Files:** `runtime/entity/tx/j-events.ts`, `runtime/jadapter/rpc.ts`
- **Bridge impact:** Catastrophic reorg handling must be operationally defined or
  prevented with suitably conservative finality thresholds.
- **Next verification:** Search storage/recovery and operator tooling for an
  explicit reorg recovery procedure.

## BRIDGE-036 — Expected watcher logs can be silently skipped

- **Status:** `OPEN_RELIABILITY`
- **Severity:** high
- **Claim:** A Depository log that fails ABI parsing can be discarded while the
  watcher later advances its scanned cursor.
- **Evidence:** The per-log parser catches all exceptions and continues. After
  processing the remaining logs, `lastSyncedBlock` advances to `toBlock`.
- **Files:** `runtime/jadapter/rpc.ts`
- **Bridge impact:** ABI drift or malformed expected logs could permanently omit
  reserve, dispute, secret, or batch-finalization evidence from Runtime state.
- **Next verification:** Distinguish unrelated address logs from expected
  Depository topics, then fail loudly on any expected-topic decode failure.

## BRIDGE-037 — xln does not currently provide canonical burn/mint verification

- **Status:** `MISSING`
- **Claim:** No contract path in this slice verifies a source-chain light-client
  proof and mints a canonical wrapped asset on the destination chain.
- **Evidence:** Cross-j settlement moves obligations between pre-funded Entity
  reserves and bilateral collateral. Watchers feed observed events into Runtime,
  not into a destination-chain verification contract.
- **Files:** `jurisdictions/contracts/Depository.sol`,
  `runtime/extensions/cross-j/index.ts`, `runtime/jadapter/rpc.ts`
- **Bridge impact:** The reusable architecture is liquidity-backed lock/release.
  A trust-minimized burn/mint bridge would be a separate protocol expansion.
- **Next verification:** None for the present design classification.

## BRIDGE-038 — Active cross-j routes are fully projected and hydrated

- **Status:** `INTEGRATED`
- **Claim:** Normal storage restore retains bridge routes instead of discarding
  or generically resetting them.
- **Evidence:** Entity projections include cross-j route FSMs, admissions, and
  pending fill ACKs. Account projections include pulls, locks, offers, pending
  consensus state, Hankos, argument snapshots, and active disputes. Books are
  stored separately and their pair index is rebuilt during hydration.
- **Files:** `runtime/storage/projections.ts`, `runtime/storage/hydration.ts`,
  `runtime/storage/types.ts`
- **Bridge impact:** Active lock/release operations have a concrete restart model.
- **Next verification:** Deferred: restart at each setup/fill/clear/salvage phase.

## BRIDGE-039 — Pending remote outputs survive Runtime restart

- **Status:** `INTEGRATED`
- **Claim:** A committed but undelivered cross-runtime instruction is restored for
  at-least-once delivery.
- **Evidence:** Frame records include `runtimeOutputs`; `loadEnvFromStorage()` and
  journal replay restore them into `pendingNetworkOutputs`.
- **Files:** `runtime/storage/types.ts`, `runtime/storage/index.ts`,
  `runtime/runtime.ts`, `runtime/wal/snapshot.ts`
- **Bridge impact:** Network outage or process restart need not strand a route
  solely because its next instruction was not delivered.
- **Next verification:** Deferred: duplicate, crash-after-send, and retry tests.

## BRIDGE-040 — Split persistence uses history as the repair authority

- **Status:** `IMPLEMENTED`
- **Claim:** A crash between history and materialized-state writes can be repaired.
- **Evidence:** Save writes the history/frame batch first. On startup,
  `recoverStorageDbFromHistory()` applies missing diffs to a lagging current DB;
  current state ahead of history fails loudly.
- **Files:** `runtime/storage/index.ts`, `runtime/storage/runtime-dbs.ts`
- **Bridge impact:** The two-database layout has an explicit partial-write recovery
  strategy rather than assuming cross-database atomicity.
- **Next verification:** Deferred: crash injection at both write boundaries.

## BRIDGE-041 — Canonical Runtime state commitments are optional

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** The independent canonical hash that can detect projection/hydration
  drift is disabled unless configured.
- **Evidence:** `canonicalHashPeriodFrames` resolves to zero by default unless an
  environment/config flag enables it. Restore requires and compares the hash only
  when it exists or canonical audit is explicitly required.
- **Files:** `runtime/storage/index.ts`, `runtime/storage/hashes.ts`,
  `runtime/runtime.ts`, `runtime/storage/types.ts`
- **Bridge impact:** Default persistence integrity primarily proves consistency of
  its own projected format, not equivalence with complete live Runtime state.
- **Next verification:** Make canonical commitment mandatory for financial bridge
  profiles and quantify its performance cost.

## BRIDGE-042 — Storage-disabled mode can emit financial side effects

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** Configuration can disable storage while the commit loop treats the
  save as successful and continues to network/J side effects.
- **Evidence:** `saveRuntimeFrameToStorage()` returns a successful no-op when
  `storage.enabled` is false; `process()` then proceeds past its commit point.
- **Files:** `runtime/storage/index.ts`, `runtime/runtime.ts`
- **Bridge impact:** A production misconfiguration could run a bridge node without
  durable recovery while still locking or releasing funds.
- **Next verification:** Define a financial/production runtime profile that fails
  startup unless durable storage is enabled and writable.

## BRIDGE-043 — Local bridge secrets are stored without identified at-rest encryption

- **Status:** `OPEN_SECURITY`
- **Severity:** high
- **Claim:** Local storage projections contain sensitive cryptographic material in
  the normal encoded LevelDB documents.
- **Evidence:** Entity core projection includes `entityEncPrivKey`; Account
  projection includes `watchSeed`, dispute proofs, argument snapshots, Hankos,
  and settlement workspace. No local database encryption boundary was found.
- **Files:** `runtime/storage/projections.ts`, `runtime/storage/codec.ts`,
  `runtime/storage/types.ts`
- **Bridge impact:** Disk or backup compromise may expose routing confidentiality,
  watch seeds, dispute evidence, and possibly keys needed for protected payloads.
- **Next verification:** Classify each secret's authority, then use OS keystore,
  encrypted database, or split protected key storage as appropriate.

## BRIDGE-044 — Encrypted snapshot plus journal-tail recovery exists

- **Status:** `IMPLEMENTED`
- **Claim:** Runtime can recover remotely without giving a blind tower plaintext
  state.
- **Evidence:** Recovery bundles use a canonical checkpoint or contiguous bounded
  journal tail, integrity hashes, and AES-GCM under a Runtime-seed-derived key.
  Restore chooses the highest compatible snapshot/tail pair and validates gaps.
- **Files:** `runtime/recovery/bundle.ts`, `runtime/recovery/crypto.ts`,
  `runtime/runtime.ts`, `runtime/watchtower/store.ts`
- **Bridge impact:** Remote disaster recovery is architecturally present.
- **Next verification:** Deferred: freshness loss budget, restore drill, key-loss
  behavior, and multiple independent tower deployments.

## BRIDGE-045 — Recovery backup durability is optional before side effects

- **Status:** `OPEN_OPERATIONS`
- **Severity:** medium
- **Claim:** Runtime can require a recovery backup before remote/J side effects,
  but the barrier is not inherently mandatory.
- **Evidence:** `process()` invokes `recoveryBackupBarrier` only when configured.
- **Files:** `runtime/runtime.ts`, `runtime/types.ts`
- **Bridge impact:** Local disk failure immediately after commitment can exceed the
  intended recovery point unless operators configure and monitor the barrier.
- **Next verification:** Establish mandatory backup policy and latency/failure SLOs
  for bridge operators.

## BRIDGE-046 — Watchtower mechanisms exist but readiness is operationally unproven

- **Status:** `OPEN_OPERATIONS`
- **Severity:** high
- **Claim:** Blind backup, wake notification, and delayed counter-dispute code
  exist, but static code does not establish an available protection service.
- **Evidence:** Tower store, encrypted appointments, signed receipts, dispute-log
  polling, push wakeups, and restricted on-chain counter-dispute action are all
  implemented. No deployed endpoints, independent operators, freshness metrics,
  or restore/action SLOs were established.
- **Files:** `runtime/watchtower/store.ts`, `dispute-watch.ts`, `action.ts`,
  `jurisdictions/contracts/Depository.sol`
- **Bridge impact:** Offline-user safety must not be claimed from code presence
  alone.
- **Next verification:** Inventory deployments and define receipt freshness,
  redundancy, monitoring, and emergency procedures.
