# Bridge threat model

Scope: a liquidity-backed lock/release bridge built from the active xln Runtime,
Account, cross-j, jurisdiction, Depository, and watchtower components.

This document does not assess a canonical burn/mint bridge or light-client bridge;
those mechanisms are not present in the reconstructed design.

## Assets to protect

- external tokens held by each jurisdiction Depository;
- Entity reserves and bilateral collateral;
- correctness of cumulative source and target pull settlement;
- Runtime and Entity signing keys;
- runtime encryption keys, hash-ladder seeds, HTLC secrets, and Account watch seeds;
- latest signed Account proofs and dispute argument snapshots;
- route availability through fill, clear, claim, expiry, dispute, and salvage;
- integrity of chain observations, persisted state, backups, and recovery ordering.

## Actors

| Actor | Intended authority | Must not be able to do |
|---|---|---|
| User Entity validators | Authorize user Entity and bilateral Account evolution | Spend another Entity, forge hub liquidity, rewrite finalized routes |
| Hub Entity validators | Operate liquidity, book, and hub-side Accounts | Forge target lock evidence, exceed signed allowances, censor forever without recoverable consequence |
| User Runtime | Host source/target user sibling Entities | Speak for hub Entities or inject arbitrary hub instructions |
| Hub Runtime | Host source/target hub siblings and book owner | Speak for user Entities or invent user Account commitment |
| Relay | Discover connected runtimes and forward ciphertext | Read payloads, replace runtime keys, forge source identity, acknowledge lost financial traffic |
| Jurisdiction watcher | Observe finalized chain events | Invent or omit events without validator-threshold detection |
| Entity validator set | Finalize Entity and J-event observations | Finalize conflicting block/event sets below threshold |
| Depository | Custody and settle jurisdiction assets | Accept replayed/wrong-chain batches or transformer overreach |
| DeltaTransformer | Resolve signed conditional claims | Change unallowed deltas or accept invalid/late evidence |
| Blind backup tower | Retain encrypted recovery state | Read plaintext state or substitute an undetectable bundle |
| Last-resort tower | Submit a narrow delayed counter-dispute | Start disputes, cooperative-close, act early, or alter the authorized proof |
| RPC provider / chain | Provide blocks, logs, receipts, and calls | Cause unsafe release through stale, omitted, or reorganized observations |
| Operator / host | Run Runtime, storage, watchers, and towers | Silently disable durability or expose local secrets |

## Trust boundaries

### Entity and Account consensus

Hankos and frame heights protect bilateral and Entity state. The target Runtime
may execute a raw cross-j Entity instruction before its local Entity signs the
resulting frame. Therefore transport ingress is a security boundary, not merely
an availability boundary.

### Runtime-to-runtime transport

Hello proves a runtime EOA within a timestamp window. EntityInput is encrypted to
the target Runtime. The current envelope does not contain a source-Entity Hanko,
and inbound processing does not establish that the authenticated source Runtime
is the route's paired user/hub Runtime.

### Cross-j admission

The intended invariant is target-first locking followed by source locking and
two-receipt book admission. The target receipt currently proves internally
consistent fields, not a target Account frame/state commitment signed by the
target user Entity.

### Runtime-to-jurisdiction submission

The Depository batch Hanko binds chain ID, contract, exact encoded batch, and
Entity nonce. Runtime persistence occurs before submission. This is a strong
authorization boundary, assuming Entity consensus and keys are sound.

### Chain-to-Runtime observation

Watchers apply confirmation depth; Entity validators then agree on block hash and
event-set hash. Safety depends on chain-specific finality, independent validator
observations, complete log parsing, and a defined response to deep reorganization.

### Local and remote recovery

Local LevelDB is authoritative for restart and contains sensitive material.
Remote recovery bundles are encrypted and integrity-checked. The remote backup
barrier is optional, so its protection depends on operator configuration.

## Primary threat scenarios

| Scenario | Existing defense | Residual risk |
|---|---|---|
| Forge a different J batch from a captured Hanko | Chain/contract/batch/nonce domain binding | Low in reconstructed path |
| Replay an old Account frame | Monotonic height and previous-frame binding | Low in reconstructed path |
| Transformer steals another delta | Signed transformer clause and directional allowances | Address governance/audit still open |
| Fake target lock, then induce source lock | Target-first flow | Receipt lacks target Account cryptographic proof |
| Arbitrary Runtime injects cross-j command | Authenticated encrypted transport | Inbound source topology/Entity authorization missing |
| Replay hello with substituted encryption key | Timestamped runtime signature | Key omitted from signature; nonce consumption absent |
| Relay loses offline financial message | Sender durable outbox; relay rejects offline target | Retry/duplicate evidence not executed in this pass |
| Crash after commit but before send | Persisted pending output | Static implementation present |
| Crash between history/current DB writes | History-first diff recovery | Crash-injection evidence deferred |
| Disk theft | None identified for local projected secrets | High confidentiality/key-exposure risk |
| Watcher skips an expected log | Validator event-set agreement | All validators may share ABI/parser defect; cursor advances |
| Deep chain reorg after accepted finality | Conflicting hash rejection | Runtime halts; no rollback/remediation path identified |
| User goes offline during dispute | Wake service and delayed last-resort tower | Deployment and freshness unproven |
| Operator disables storage | Storage enabled by default | Disabled mode still permits financial side effects |
| Local disk dies after commit | Optional backup barrier and tower bundle | Barrier and backup SLO are not mandatory |

## Security invariants required before production

1. Every inbound cross-j instruction is authorized by the route's expected source
   Runtime and, where authority originates in an Entity, by a source-Entity proof.
2. Source locking cannot proceed from a target receipt unless that receipt binds
   a committed target Account frame/state and the required target-user authority.
3. Runtime handshake signatures bind the encryption key, endpoint/protocol
   context, expiry, and a server challenge or consumed nonce.
4. Financial Runtime profiles cannot start with storage disabled, canonical state
   commitments disabled, or an unwritable persistence path.
5. Sensitive local state is encrypted at rest or isolated behind a protected key
   service with explicit recovery semantics.
6. Each jurisdiction has a reviewed finality policy, independent watcher layout,
   expected-log decode policy, and catastrophic-reorg runbook.
7. Backup freshness and watchtower action are measured, redundant, and regularly
   restored/exercised.
8. Contract deployments, bytecode, transformer addresses, asset registrations,
   and administrative authority match an audited release manifest.

