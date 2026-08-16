# Architecture map

Status: initial static reconstruction. No tests, builds, or runtime verification
were performed for this pass.

## Active runtime layers

```text
Runtime
  machine/                 deterministic input merge, frame execution, output routing
  networking/ + relay/     runtime discovery and encrypted entity-input delivery
  storage/ + wal/          durable runtime and account history
  recovery/ + watchtower/  state restoration and dispute assistance
    |
Entity
  entity/consensus/        validator proposal, precommit, Hanko collection, commit
  entity/tx/               account commands, cross-j orchestration, J-batch construction
    |
Account
  account/consensus/       bilateral frame proposal, ACK, replay and dispute seals
  account/tx/handlers/     deltas, HTLCs, pulls, swaps, settlement-side actions
    |
Jurisdiction
  jurisdiction/            deterministic J-batch representation
  jadapter/                RPC submission and chain observation
  jurisdictions/contracts  Depository, Account, EntityProvider, DeltaTransformer
```

`runtime/types.ts` is a compatibility barrel. New canonical domain types live
under `runtime/types/`.

## Account financial boundary

One bilateral account stores a canonical left/right representation. Both sides
agree on an `AccountFrame` containing:

- frame height, timestamp, finalized J height, and previous frame hash;
- the ordered `AccountTx[]` transition list;
- canonical delta records;
- the complete bilateral `accountStateRoot`.

The account-state root commits these namespaces:

```text
identity
  chainId, Depository, left/right entity IDs, watch seed
financial
  deltas, credit limits, J nonce, dispute configuration
commitments
  HTLC locks, pulls, swap offers, custom transformers, lending receipts
jurisdiction
  finalized J height, both observation sets, finalized event chain
rebalance
  bilateral rebalance requests and fee state
```

Local lifecycle and automation state is committed separately by the owning
Entity through `accountShadowRoot`; it is not bilateral account state.

## Bilateral frame lifecycle

```text
Account mempool
  -> proposer clones AccountMachine
  -> applies candidate AccountTx values to the clone
  -> computes accountStateRoot
  -> computes frame hash over transition + txs + deltas + state root
  -> entity Hanko signs frame hash and current dispute proof hash
  -> sends AccountInput(kind=frame or frame_ack)
  -> receiver checks local deadline/J-height safety
  -> receiver verifies frame Hanko
  -> receiver replays transactions on an isolated clone
  -> receiver compares the resulting state/hash
  -> receiver commits by replaying on real state
  -> receiver returns ACK Hanko
  -> proposer replays pending frame on real state and commits
```

Replay protection for off-chain account frames is the monotonic frame chain:
`height + prevFrameHash`. On-chain nonces are reserved for settlement and
dispute proof ordering.

## HTLC account flow

```text
htlc_lock
  -> require unique lockId
  -> require future timestamp and J-height deadlines
  -> derive payer outbound capacity
  -> add payer-side hold
  -> store HtlcLock in bilateral commitments
  -> commit through bilateral AccountFrame

htlc_resolve(secret)
  -> require valid 32-byte preimage
  -> require timestamp and J-height not expired
  -> release payer hold
  -> mutate offdelta by the locked amount
  -> delete lock

htlc_resolve(error)
  -> beneficiary may release active lock
  -> payer may release only after local expiry
  -> release hold without changing offdelta
  -> delete lock
```

Receiver admission applies an additional enforcement reserve. A peer-controlled
frame timestamp cannot create a lock too close to expiry, reveal a secret after
the receiver can no longer enforce it, or exercise a payer timeout before the
receiver's local Entity time/J height considers it expired.

## Pull and partial-fill account flow

A pull is a beneficiary-claimable, ratio-gated commitment. Its sign determines
the beneficiary: positive credits left; negative credits right.

```text
pull_lock
  -> paying side proposes
  -> require fullHash and partialRoot commitments
  -> require future absolute runtime-ms deadline
  -> reserve payer capacity with a hold
  -> store claimedRatio=0 and claimedAmount=0

pull_resolve(binary)
  -> beneficiary proposes
  -> verify full or partial hash-ladder evidence
  -> require ratio monotonicity and live deadline
  -> for cross-j, require route-specific receipts/status/proofs
  -> release only the incremental claimed hold
  -> increment offdelta by exact cumulative claim difference

cross_pull_close(binary, proof)
  -> require route/order/pull/binary/amount binding
  -> require beneficiary and non-regressing ratio/amount
  -> apply exact committed claim
  -> release the entire unfilled remainder
  -> delete pull

pull_cancel
  -> beneficiary may release an active pull
  -> payer may cancel after expiry
  -> cross-j pulls must first enter an allowed clear lifecycle
```

Hash-ladder ratios range from `0` to `65535`. Full fill uses one 32-byte secret;
partial fill uses four nibble-ladder reveals. Pull state tracks cumulative ratio
and amount, so repeat evidence is idempotent and lower ratios cannot reverse a
claim.

## Cross-j ordering enforced at Account layer

The generic pull handler adds cross-j-specific claim ordering when a
`CrossJurisdictionPullBinding` is present:

```text
Source pull claim
  requires target admission receipt
  requires clear_requested or clearing status
  requires committed fill progress > 0
  cannot exceed committed ratio

Target pull claim
  requires source close proof
  requires identical ratio
  requires identical hash-ladder binary hash
  cannot exceed committed ratio
```

`cross_pull_close` additionally binds the order ID, canonical route hash, source
and target pull IDs, cumulative source/target amounts, fill ratio, and binary
hash. This makes a close proof specific to one route and one cumulative fill.

## On-chain enforceability

Active locks and pulls are not merely local runtime objects. The dispute proof
builder deterministically converts them into a signed Solidity `ProofBody`:

```text
AccountMachine
  -> sorted token deltas and offdeltas
  -> sorted HTLC Payment clauses
  -> sorted Pull clauses
  -> transformer allowances
  -> ABI ProofBody
  -> proofBodyHash
  -> bilateral dispute-seal Hankos
  -> Depository dispute start/finalize
  -> DeltaTransformer applies timely evidence
```

HTLC and pull deadlines are runtime milliseconds in Account state. HTLC
payments normalize to seconds while building the runtime proof batch. Pulls
remain milliseconds until ABI conversion, where they are divided by `1000`.
Solidity compares both against `block.timestamp` or the stored dispute-argument
timestamp in seconds.

## Primary files read in this slice

| Area | Active files |
|---|---|
| Domain types | `runtime/types/account.ts`, `cross-jurisdiction.ts`, `entity-tx.ts`, `hanko.ts`, `jurisdiction-runtime.ts` |
| Account dispatch | `runtime/account/tx/apply.ts` |
| HTLC | `runtime/account/tx/handlers/htlc-lock.ts`, `htlc-resolve.ts`, `runtime/protocol/htlc/utils.ts` |
| Pulls | `runtime/account/tx/handlers/pull.ts`, `runtime/protocol/htlc/hash-ladder.ts` |
| Capacity | `runtime/account/utils.ts`, `runtime/account/tx/hold-utils.ts` |
| Consensus | `runtime/account/consensus/index.ts`, `propose.ts`, `frame.ts`, `deadline-policy.ts`, `flush.ts` |
| State commitment | `runtime/account/state-root.ts` |
| Dispute bridge | `runtime/protocol/dispute/proof-builder.ts`, `proof-body.ts` |
| Hanko | `runtime/hanko/signing.ts`, `batch.ts`, `core.ts` |
| Solidity counterpart | `jurisdictions/contracts/Depository.sol`, `DeltaTransformer.sol`, `Account.sol`, `EntityProvider.sol` |

## Entity consensus boundary

Entity consensus is the organizational layer above bilateral accounts. One
Entity frame deterministically applies ordered `EntityTx` values, updates route
and book projections, queues Account mempool operations, proposes eligible
Account frames, and emits remote Entity or J outputs.

```text
EntityInput
  -> ordered EntityTx application on cloned EntityState
  -> cross-j route/book changes and Account mempoolOps
  -> orderbook matching
  -> deterministic EntityState snapshot
  -> eligible Account-frame proposals
  -> collect hashes requiring Entity authorization
  -> Entity frame hash
  -> validator replay and hash-manifest comparison
  -> validator signatures for Entity frame + secondary hashes
  -> quorum Hankos
  -> committed outputs receive Account/J Hankos
```

The secondary hash manifest includes Account-frame hashes, dispute hashes,
settlement hashes, profile hashes, and J-batch hashes. Validators recompute the
manifest locally; a proposer cannot append a different money-authorizing hash
to an otherwise valid Entity frame.

The Entity-frame hash commits the Entity transaction list, reserves, Account
frame hashes, Account shadow root, HTLC routes/fees, lock book, orderbook,
cross-j state, jurisdiction observations, and other Entity-owned state.

## Cross-j route identity

The canonical route hash binds:

- order, book owner, venue, maker, and hub identifiers;
- both jurisdictions, both bilateral entity pairs, tokens, and amounts;
- price, expiry, risk mode, and price-improvement policy;
- source/target stack IDs and optional EntityProvider/DeltaTransformer addresses;
- source/target asset references;
- rounding, dust, and minimum-fill policy;
- runtime/settlement clock definitions and finality-policy label.

Only `fully_collateralized` risk mode is currently accepted. Pull IDs and the
private hash-ladder seed are derived from the canonical route hash. The private
seed is deterministic from `env.runtimeSeed + routeHash` and is not included in
the public route clone.

## Cross-j setup lifecycle

The active setup path is target-first:

```text
1. Source user: requestCrossJurisdictionSwap
   - validate local source account and jurisdiction binding
   - persist route as intent
   - send prepare request to source hub

2. Source hub: prepareCrossJurisdictionSwap
   - derive deterministic hash ladder
   - derive source and target pull IDs
   - target deadline = source deadline + dispute window + safety margin
   - register route on target participants
   - ask target hub to create target pull against target user

3. Target bilateral Account commits pull_lock
   - Entity committed-frame follow-up constructs target admission receipt
   - route moves to target_locked
   - receipt is sent to source user and canonical book owner

4. Source user: commitCrossJurisdictionSwap
   - validate target receipt fields/hash
   - queue source pull_lock and source swap_offer

5. Source bilateral Account commits pull_lock
   - require target receipt inside source pull binding
   - construct source admission receipt
   - route becomes resting
   - send source receipt to canonical book owner

6. Book owner
   - requires both source and target receipts
   - marks admission admitted
   - exposes route to matching
```

The matcher cannot expose a cross-j order merely because a source swap offer
exists. Admission is driven by committed Account pull follow-ups.

## Fill and clearing lifecycle

Orderbook matching produces an exact rational fill and a coarse uint16 proof
ratio. These serve different purposes:

```text
exact numerator/denominator  -> economic source/target amounts
uint16 ratio                 -> hash-ladder/dispute evidence
```

Fill progression requires a strictly next sequence number, increasing ratio,
increasing source and target amounts, exact cumulative arithmetic, and bounded
quantization dust.

```text
book match
  -> crossJurisdictionFillNotice to source hub
  -> source hub queues cross_swap_fill_ack in source Account
  -> bilateral Account frame commits exact fill progress
  -> committed follow-up updates Entity route and book projection
  -> partial fill resizes book order
  -> full/cancel-remainder fill removes order and requests clear
```

Clear always closes the source pull before the target pull:

```text
requestCrossJurisdictionClear
  -> source hub closes/cancels live swap offer first
  -> derive hash-ladder reveal for committed ratio
  -> source cross_pull_close commits exact claim and remainder release
  -> committed source follow-up records sourceCloseProof
  -> relay identical binary + close proof to target user sibling
  -> target cross_pull_close commits target claim
  -> route becomes settled and book admission closes
```

Pure cancellation uses ratio zero and releases the source hold. Partial clear
claims the committed cumulative amount and releases the unfilled remainder.

## Dispute salvage

If cooperative cross-runtime propagation fails, J events inspect committed
dispute arguments:

```text
source dispute exposes pull binary
  -> J-event decoder extracts best valid ratio/binary
  -> sends crossJurisdictionSalvage to target user sibling
  -> target verifies binary against target pull commitment
  -> target queues resolvePull + disputeStart + j_broadcast

target dispute without pull binary
  -> source user dispute is queued
  -> source dispute forces the hub to reveal or forgo the source claim
```

Salvage uses only starter initial arguments. A merely precommitted incremented
argument does not trigger settlement until that newer proof is actually used.

## Cross-j transport trust boundary

Cross-j system `EntityTx` outputs are routed as `EntityInput` values containing
the target entity ID, a target signer hint, and transactions. Entity consensus
signs the target Entity frame after applying those transactions, but the raw
cross-entity instruction does not itself carry a source-entity Hanko.

Transport authentication proves the source runtime identity. Cross-j topology
guards restrict remote messages to the paired user-runtime/hub-runtime route.
This is separate from proving that a specific source or target Account frame
committed. Account-frame payloads carry their own Hankos; cross-j setup receipts
currently do not.

## Additional primary files read

| Area | Active files |
|---|---|
| Entity frame consensus | `runtime/entity/consensus/index.ts`, `frame.ts`, `hanko-witness.ts` |
| Cross-j primitives | `runtime/extensions/cross-j/index.ts`, `market.ts`, `fill-ack.ts`, `orderbook.ts`, `boundary.ts` |
| Setup | `runtime/entity/tx/handlers/cross-j-setup.ts` |
| Fill and clearing | `cross-j-fill.ts`, `cross-j-clear.ts`, `account-cross-j-followups.ts` |
| Book admission | `cross-j-book-order.ts`, `runtime/orderbook/cross-j-orderbook.ts` |
| Salvage | `cross-j-salvage.ts`, `runtime/entity/tx/j-events-htlc.ts` |
| Remote outputs | `runtime/entity/tx/cross-j-outputs.ts`, `cross-jurisdiction-helpers.ts` |

## Runtime node and transport boundary

The active runtime is a stateful node, not only an in-process state reducer. It
owns a runtime identity, hosts locally signable Entity replicas, publishes
signed Entity profiles, resolves remote Entity-to-runtime routes, and delivers
Entity inputs through direct WebSockets or a relay.

### Durable execution and delivery order

The main `process()` loop applies and plans a Runtime frame, puts unsent remote
outputs in `pendingNetworkOutputs`, persists the finalized frame, passes an
optional recovery-backup barrier, and only then dispatches network and chain
side effects. Transient failures remain in the Runtime outbox with bounded
exponential retry. The relay deliberately rejects offline financial
`entity_input` traffic, leaving durable retry responsibility with the sender.

### Identity, discovery, and transport

- Runtime hello authenticates an EOA-shaped runtime ID.
- Canonical, Hanko-signed Entity profiles establish verified Entity-to-runtime
  routes and advertise relay/direct endpoints plus encryption keys.
- Financial Entity inputs must be encrypted. The wire scheme uses ephemeral
  X25519 ECDH and ChaCha20-Poly1305 to the target runtime key.
- Direct runtime delivery is preferred when available; relay delivery is the
  fallback. The relay forwards opaque ciphertext.

### Cross-j subnet/spoke model

The remembered subnet/spoke design is explicit in
`runtime/extensions/cross-j/boundary.ts`:

```text
user runtime                         hub runtime
  source-user Entity  <---------->    source-hub Entity / book owner
  target-user sibling Entity           target-hub sibling Entity
```

Both user Entities must resolve to one user runtime. Both hub Entities and the
book owner must resolve to one different hub runtime. Outbound cross-j system
messages are rejected unless their route resolves to exactly this edge;
`crossPullClose` is local-only.

### Authorization boundary discovered

Transport authenticates the source runtime but does not prove that a source
Entity authorized each decrypted raw `EntityTx[]`. Inbound admission checks that
the target Entity and target signer are local, but does not apply the cross-j
topology predicate to the authenticated source runtime. The two-runtime rule is
therefore enforced on outbound generation, not symmetrically at hostile ingress.

### Additional primary files read

| Area | Active files |
|---|---|
| Runtime commit loop | `runtime/runtime.ts`, `runtime/machine/input-queue.ts`, `runtime/machine/admission.ts` |
| Runtime routing | `runtime/machine/entity-routing.ts`, `output-routing.ts`, `p2p-lifecycle.ts` |
| Identity and profiles | `runtime/networking/runtime-id.ts`, `hello-auth.ts`, `profile-signing.ts` |
| P2P transport | `runtime/networking/p2p.ts`, `ws-client.ts`, `ws-protocol.ts`, `p2p-crypto.ts` |
| Direct transport | `runtime/networking/direct-runtime-bun.ts`, `runtime/server/relay-direct.ts` |
| Relay | `runtime/relay/router.ts` |
| Public discovery | `runtime/orchestrator/public-discovery.ts` |
| Cross-j topology | `runtime/extensions/cross-j/boundary.ts` |

## Jurisdiction, contracts, watchers, and finality

### On-chain jurisdiction stack

Each jurisdiction deploys a dedicated stack:

```text
EntityProvider
  verifies Entity boards and Hankos
        |
        v
Depository.processBatch(encodedBatch, hanko, entityNonce)
  reserves + collateral + bilateral account nonce/dispute state + debt
        |
        v
Account library                       DeltaTransformer
  cooperative/dispute proofs            HTLC secrets
  settlement and collateral              swaps and fill ratios
  dispute start/finalize                  hash-ladder pulls
```

`Depository` is therefore a real bridge escrow candidate, not a placeholder.
It holds registered external assets, accounts for per-Entity reserves and
bilateral collateral, releases reserves back to external token recipients, and
settles insufficiency into reserve payment followed by explicit debt.

### Hanko-authorized J batch path

Entity consensus seals the exact encoded batch and next Entity nonce. The signed
hash binds the Depository domain, chain ID, Depository address, encoded batch,
and nonce. `processBatch()` recovers the authorizing Entity through
`EntityProvider`, requires strict sequential nonce, executes atomically, and
emits `HankoBatchProcessed`.

The Runtime persists the sealed J output before `JAdapter.submitTx()` sends it.
The adapter is forbidden from locally rebuilding or signing a missing batch;
it submits the exact consensus Hanko. Submission receipts are informational—the
watcher, not the submitter, is the authoritative path back into Runtime state.

### Dispute and transformer settlement

Cooperative close requires a newer counterparty Hanko. Unilateral settlement is
a two-transaction dispute: start stores the proof commitment and starter
arguments; finalize either reveals a newer signed proof or waits for timeout.
The signed `ProofBody` fixes token IDs, off-chain deltas, transformer addresses,
encoded transformer batches, and per-delta allowances.

During finalization, `DeltaTransformer`:

- applies HTLC payments only for a matching secret revealed before expiry;
- applies swap ratios supplied by the counterparty side;
- verifies full or partial hash-ladder pull evidence and claims only the
  increment above the already-claimed ratio;
- treats malformed adversarial argument evidence as empty while keeping signed
  ProofBody data strict.

Transformer output is constrained by explicit left/right allowances before the
Depository allocates collateral, reserves, and debt.

### Watcher and J-event consensus

The RPC watcher scans only blocks below a configured confirmation depth. Defaults
are zero for dev/scenario chains, 12 for Ethereum mainnet, a guarded TRON depth,
and 2 for other chains. It groups canonical logs by block, derives optional
dispute-finalization calldata evidence, and queues signed validator observations.

An Entity finalizes a jurisdiction block only when validator voting power agrees
on the same block hash and canonical event-set hash. Conflicting threshold block
hashes or event sets fail loudly. Dispute calldata evidence that can trigger
cross-j salvage requires its own threshold agreement. Finalized J-events then
update reserves, account observations, disputes, secrets, debts, and batch state
through normal Entity consensus.

### Bridge interpretation

The implemented asset path is:

```text
external token -> jurisdiction Depository reserve
               -> bilateral collateral/off-chain cross-j obligation
               -> destination-side reserve/liquidity settlement
               -> external token withdrawal
```

This is compatible with a liquidity-backed lock/release bridge. It does not by
itself implement canonical burn/mint issuance, cross-chain light-client proof
verification, or trustless verification of one chain inside another.

### Additional primary files read

| Area | Active files |
|---|---|
| Contracts | `jurisdictions/contracts/Depository.sol`, `Account.sol`, `DeltaTransformer.sol`, `HashLadder.sol`, `Types.sol` |
| Entity authorization | `jurisdictions/contracts/EntityProvider.sol`, `runtime/jurisdiction/batch.ts` |
| J submission | `runtime/machine/j-submit.ts`, `runtime/jadapter/rpc.ts`, `runtime/jadapter/types.ts` |
| Watcher ingress | `runtime/jadapter/helpers.ts`, `runtime/jurisdiction/event-normalization.ts`, `event-evidence.ts` |
| J-event consensus | `runtime/jurisdiction/event-observation.ts`, `runtime/entity/tx/j-events.ts`, `j-events-batch.ts` |
| Jurisdiction binding | `runtime/jurisdiction/jurisdiction-runtime.ts`, `height.ts` |

## Storage, restart recovery, and operations

### Local durable state

Runtime persistence is split into a history/frame database and a materialized
current-state database. Each committed frame records its input, pending remote
outputs, touched documents, previous frame hash, and state commitments. Entity,
Account, order-book, replica-consensus, and frame-history data are stored as
separate projections.

The history frame is written before the materialized state database. If a crash
occurs between those writes, startup compares both heads and replays stored diffs
from history into the current database. A current database ahead of history is a
fatal invariant violation. Snapshot creation, history pruning, and epoch rotation
are explicit lifecycle operations with rotation markers for interrupted moves.

### Active cross-j restoration

The storage projection contains the bridge-critical state:

- complete `crossJurisdictionSwaps` route FSMs;
- book-admission state and pending cross-j fill ACKs;
- Account pulls, locks, swap offers, pending frames and forwards;
- dispute Hankos, proof bodies, argument snapshots, settlement workspaces, and
  active disputes;
- order-book documents and rebuilt pair indices;
- Entity proposals, locked frames, validator-computed state, and Hanko witnesses;
- pending remote Entity inputs for at-least-once retry after restart.

Hydration reconstructs these maps and indices rather than resetting routes to a
generic pending state. This means active bridge routes are designed to survive a
normal Runtime restart.

### Integrity and replay

Frame hashes chain complete persisted frame records, including pending transport
outputs. The frame DB verifies a tail of frames on open. Materialized frames have
Merkle state roots; an independent canonical hash can additionally commit
directly to Runtime Entity state. Canonical hashing is configurable and disabled
unless explicitly enabled.

Restore loads projected state at a selected height, restores pending outputs,
rebuilds jurisdiction replicas, and can compare the restored state against a
canonical commitment when one exists. Recovery journal replay requires contiguous
heights and restores each frame's pending output set.

### Remote recovery and watchtowers

Runtime can produce a full checkpoint plus bounded journal-tail recovery bundle.
Bundles are integrity-hashed and encrypted with AES-GCM under a key derived from
the Runtime seed. A blind backup tower stores encrypted snapshots/tails and signs
storage receipts without learning their contents.

A separate delayed-last-resort mode stores narrowly scoped encrypted
counter-dispute remedies. The Depository authorization binds the tower, account,
proof, final nonce, last-resort window, and appointment sequence. Towers may only
counter-dispute late in the window; they cannot start disputes or cooperatively
close accounts. A read-only dispute watcher can also send wake notifications.

### Operational boundaries

- Storage is enabled by default but can be disabled by configuration. The
  persistence function treats disabled storage as a successful no-op, so a
  production bridge must explicitly prohibit that mode.
- The recovery-backup barrier exists but is optional; remote outputs and J-batches
  wait for it only when an operator has configured one.
- Local LevelDB projections include `entityEncPrivKey`, Account `watchSeed`, and
  dispute/settlement evidence without an identified database-at-rest encryption
  layer. Remote tower bundles are encrypted, but local storage is not.
- Static code establishes mechanisms, not backup freshness, replica placement,
  tower diversity, restore drills, disk durability, or monitored deployment.

### Additional primary files read

| Area | Active files |
|---|---|
| Frame persistence | `runtime/storage/index.ts`, `types.ts`, `hashes.ts`, `verify.ts` |
| Projection/hydration | `runtime/storage/projections.ts`, `hydration.ts`, `read.ts` |
| DB lifecycle | `runtime/storage/runtime-dbs.ts`, `lifecycle.ts`, `safety.ts` |
| Runtime restore | `runtime/runtime.ts`, `runtime/wal/snapshot.ts` |
| Recovery bundles | `runtime/recovery/bundle.ts`, `crypto.ts`, `types.ts` |
| Watchtower storage/action | `runtime/watchtower/store.ts`, `action.ts`, `dispute-watch.ts` |
