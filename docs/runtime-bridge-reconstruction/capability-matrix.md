# Capability matrix

Status: static code reconstruction only. Evidence levels do not imply that any
test or deployment was executed during this pass.

Legend:

- `IMPLEMENTED`: active code path identified.
- `TESTED`: reserved for later executable-test mapping.
- `INTEGRATED`: static call path crosses the required subsystem boundaries.
- `E2E_PROVEN`: reserved for later multi-process/multi-chain evidence.
- `PRODUCTION_PROVEN`: reserved for deployment and operational evidence.
- `OPEN`: reconstruction has not reached enough code to classify it.

| Capability | Current level | Static evidence | Remaining reconstruction |
|---|---|---|---|
| Canonical bilateral account identity | IMPLEMENTED | Account state root binds chain ID, Depository, both entity IDs and watch seed | Trace account creation and jurisdiction selection |
| Account-frame replay protection | IMPLEMENTED | Height, previous frame hash, current/pending frame lifecycle | Trace persistence and resend after restart |
| Bilateral frame authorization | INTEGRATED | Entity validators sign the Account-frame secondary hash; receiver verifies before replay/commit | Map executable multi-validator evidence later |
| Dispute-seal authorization | INTEGRATED | Exact Solidity dispute hash, proof-body hash and proof nonce are verified | Trace Entity-to-J batch construction |
| Outbound capacity reservation | IMPLEMENTED | Unified left/right holds deducted by `deriveDelta` | Map every handler sharing the hold fields |
| HTLC creation | IMPLEMENTED | Unique lock, capacity check, dual deadline, committed hold | Trace Entity-level route construction |
| HTLC secret settlement | IMPLEMENTED | Preimage verification, deadline checks, exact offdelta mutation | Trace routed secret propagation |
| HTLC refund/release | IMPLEMENTED | Beneficiary active release; payer only after expiry | Trace scheduler-triggered timeout path |
| HTLC on-chain dispute representation | INTEGRATED | Locks become DeltaTransformer Payment clauses in signed ProofBody | Trace reveal-secret J batch path |
| Pull creation | IMPLEMENTED | Payer-created ratio commitment with capacity hold | Trace cross-j route preparation source |
| Partial pull settlement | IMPLEMENTED | Hash-ladder verification and cumulative incremental claim | Trace fill-ack production and exact amount calculation |
| Pull cancellation/refund | IMPLEMENTED | Beneficiary release or expired payer cancel | Trace cross-j clear orchestration |
| Pull on-chain dispute representation | INTEGRATED | Pulls become DeltaTransformer Pull clauses in signed ProofBody | Trace dispute argument snapshot generation |
| Source-before-target cross-j claim ordering | INTEGRATED | Source Account closes first; committed follow-up relays identical close proof to target Account | Resolve target-receipt authenticity finding |
| Exact cross-j close binding | IMPLEMENTED | Route hash, pull IDs, amounts, ratio and binary hash are bound | Trace canonical route-hash inputs |
| Runtime-ms to Solidity-second deadline conversion | INTEGRATED | Explicit conversion for both HTLC and pull proof clauses | Map all external deadline ingress paths |
| Cross-runtime encrypted delivery | IMPLEMENTED | Previously mapped under networking/direct/relay paths | Continue in Runtime/networking phase |
| Jurisdiction asset custody | IMPLEMENTED | Previously mapped Depository external-token reserve ingress/egress | Continue in Jurisdiction phase |
| Canonical cross-j route identity | IMPLEMENTED | Route hash binds participants, stack/contract/asset domains, amounts and settlement/time policies | Trace initial route builder/API ingress |
| Deterministic pull/secret derivation | IMPLEMENTED | Pull IDs and private hash-ladder seed derive from route hash and runtime seed | Trace recovery of runtime seed and active routes |
| Target-first cross-j setup | INTEGRATED | Target pull commit follow-up precedes source pull request | Resolve whether target receipt proves that commit cryptographically |
| Two-receipt book admission | INTEGRATED | Book owner requires matching source and target admission receipts | Receipt authenticity remains open |
| Full cross-j route FSM | IMPLEMENTED | Explicit allowed transition table plus setup/fill/clear/claim/terminal handlers | Map sweep/expiry lifecycle next |
| Exact partial-fill economics | IMPLEMENTED | Rational fill amounts remain exact; uint16 ratio is dispute projection only | Map matcher input and price-improvement funding |
| Fill sequencing and idempotency | IMPLEMENTED | Strict next `fillSeq`, monotonic amounts/ratio, same-seq conflict rejection | Map cross-runtime duplicate delivery behavior later |
| Book/account consistency | INTEGRATED | Book updates follow committed source Account ACKs; pending ACK evidence is preserved | Trace persistence projections later |
| Cooperative source-to-target close | INTEGRATED | Source close proof is relayed to target pull and terminal state | Resolve raw EntityTx authorization boundary |
| Dispute salvage | INTEGRATED | J-event argument decoding queues target resolve/dispute or forces source dispute | Continue in J-event/finality phase |
| Chain-finality mechanism | INTEGRATED | Confirmation-depth watcher plus validator-threshold block/event observations | Production policy remains open per chain |
| Active-route crash recovery | INTEGRATED | Cross-j FSM, Account claims, books, replica state, and pending outputs hydrate | Executable crash evidence deferred |
| Solver market and pricing | OPEN | Swap offers and cross-j route types identified | Reconstruct orderbook and orchestrator |
| Multi-solver/multi-runtime fills | OPEN | Current topology deliberately permits one user runtime and one hub runtime | Requires separate signed inter-entity authorization model |
| Target admission receipt authenticity | OPEN_SECURITY | Receipt is a self-hash without Account-frame Hanko/state proof | Bind target Account commitment and target-user authority |
| Raw cross-j EntityTx authorization | OPEN_SECURITY | Remote instruction names target signer but carries no source Entity Hanko | Add inbound source authorization and signed envelopes where required |
| Runtime as independently networked node | IMPLEMENTED | Runtime identity, hosted replicas, P2P lifecycle, ingress queue, output routing | Deployment evidence deferred |
| Persist-before-network side effects | INTEGRATED | Finalized frame and pending remote outputs are saved before dispatch | Crash/restart evidence deferred |
| Durable sender outbox with retries | INTEGRATED | Persisted pending outputs and bounded exponential retry | Failure evidence deferred |
| Signed Entity-to-runtime discovery | INTEGRATED | Hanko-signed profiles populate verified runtime routes | Freshness and recovery remain to map |
| Direct and relay transport | IMPLEMENTED | Authenticated WebSockets with direct preference and relay fallback | Multi-process evidence deferred |
| Mandatory EntityInput encryption | INTEGRATED | X25519 plus ChaCha20-Poly1305; plaintext rejected at transport boundaries | Cryptographic review deferred |
| Two-runtime subnet/spoke topology | INTEGRATED | User siblings co-located; hub siblings/book owner co-located; outbound edge enforced | Inbound enforcement is missing |
| Inbound cross-j source-runtime authorization | OPEN | Target/signer checked, but source runtime is not checked against route topology | Add canonical inbound authorization gate |
| Hello replay and encryption-key binding | OPEN | Signed hello omits encryption key; no nonce replay cache found | Threat-model and harden handshake |
| Dedicated jurisdiction escrow | IMPLEMENTED | Depository holds external assets, Entity reserves, collateral, and debts | Deployment/audit evidence deferred |
| Hanko-authorized chain batches | INTEGRATED | Domain, chain, contract, exact batch, and sequential Entity nonce are bound | On-chain execution evidence deferred |
| Consensus-sealed J submission | INTEGRATED | Runtime persists and submits exact Entity-consensus Hanko; no local-sign fallback | Failure/restart evidence deferred |
| External token lock and release | IMPLEMENTED | External-token-to-reserve and reserve-to-external operations exist | Asset matrix and production config remain to map |
| Cooperative bilateral settlement | IMPLEMENTED | Newer counterparty Hanko authorizes immediate account finalization | Executable evidence deferred |
| Unilateral dispute settlement | IMPLEMENTED | Start, counter-dispute, timeout finalize, and watchtower last resort exist | Threat model and evidence deferred |
| On-chain HTLC enforcement | IMPLEMENTED | Secret plus deadline changes allowed delta during finalization | Executable evidence deferred |
| On-chain partial hash-ladder pulls | IMPLEMENTED | Full/partial evidence verifies incremental uint16 claim | Exact off-chain economics remain higher precision |
| Transformer confinement | IMPLEMENTED | Signed address/batch plus per-index directional allowances bound delta changes | External transformer allowlisting policy is open |
| Confirmation-depth watcher | INTEGRATED | Safe block scanning and post-apply cursor advancement | Chain-specific production policy unestablished |
| Validator-threshold J observations | INTEGRATED | Signed block/event-set observations require Entity voting threshold | Independent watcher deployment evidence deferred |
| Reorg recovery beyond finality depth | OPEN | Conflicting finalized hashes halt; no rollback path identified | Define chain-specific catastrophic reorg procedure |
| Watcher log parse completeness | OPEN | Per-log parse exceptions are skipped while scan cursor can advance | Fail loudly for expected Depository logs |
| Canonical burn/mint bridge | MISSING | No remote light-client proof or destination wrapped-asset mint path identified | Separate protocol and contracts required |
| Active cross-j route persistence | INTEGRATED | Routes, admissions, pending ACKs, pulls, locks, books, and dispute evidence are projected | Restart evidence deferred |
| Replica consensus persistence | INTEGRATED | Proposals, locked frames, validator state, mempool, and Hanko witnesses persist | Crash evidence deferred |
| Pending network output recovery | INTEGRATED | Committed frame restores `runtimeOutputs` for at-least-once retry | Duplicate-delivery evidence deferred |
| Split-DB crash repair | IMPLEMENTED | History-first write and diff replay repair materialized DB lag | Crash injection evidence deferred |
| Frame-chain integrity | IMPLEMENTED | Complete frame records form a previous-hash chain; tail checked on open | Full-history audit is operator initiated |
| Independent canonical state audit | PARTIAL | Canonical state hash exists but is opt-in | Require it for production bridge nodes |
| Snapshot and epoch rotation | IMPLEMENTED | Materialized snapshots, pruning, rotation marker, previous epoch | Operational evidence deferred |
| Encrypted remote recovery | IMPLEMENTED | AES-GCM snapshot plus journal tail keyed by Runtime seed | Backup freshness and restore drills unproven |
| Recovery backup barrier | PARTIAL | Side effects can wait for backup acknowledgement when configured | Barrier is optional |
| Blind backup watchtower | IMPLEMENTED | Tower stores ciphertext and signs quota/retention receipt | Independent deployment evidence deferred |
| Delayed last-resort watchtower | IMPLEMENTED | Narrow owner-authorized counter-dispute path | Operational and adversarial evidence deferred |
| Local secret-at-rest protection | OPEN | LevelDB projection stores Entity private key and Account watch seed | Add encrypted storage or protected key boundary |
| Production storage-required policy | OPEN | Storage-disabled mode returns successful no-op | Fail startup if disabled for financial operation |
| Backup/tower operational readiness | OPEN | Mechanisms exist, deployment/freshness/diversity/restore drills not established | Define SLOs and runbooks |
