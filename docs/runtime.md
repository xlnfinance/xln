# Runtime architecture and invariants

This document is the normative architecture for the production Runtime. It
defines ownership, ordering, worker scheduling, commitments, durability,
recovery and TypeScript/Rust parity. TypeScript safety rules remain normative
in [fints.md](fints.md); this document does not replace or weaken them.

The immediate implementation target is RS Core. Rust must first prove this
architecture correct and fast; TypeScript adopts the same deterministic
architecture afterwards. Both remain authoritative engines selected once at
Runtime startup: Rust for high-throughput hubs, TypeScript for user Runtimes,
wallets and constrained environments. There is no fallback, dual execution or
cross-engine routing. Both engines must remain wire, checkpoint and disk
compatible and produce identical committed bytes.

The worker count is an operational parameter, never a protocol parameter. The
same Runtime must work with any positive configured count (`1`, `2`, `5`, `8`,
`16`, ...). Changing it may change only physical execution placement. It must
not change state, frames, effects, intents, proposals, matching, output order,
Merkle roots or WAL semantics. The Rust design target is at least 10k–20k
completed economic operations/s without imposing an architectural ceiling near
that range.

## 1. Canonical R → E → A cascade

| Layer | Live replica | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

Every layer has one deterministic transition:

```text
(replica, input) -> { replica, outputs }
```

- Runtime selects ordered inputs, invokes Entity transitions, seals one
  `RuntimeFrame`, writes the single WAL and publishes the flat ordered outbox.
- Runtime alone owns Runtime ordering, cross-Entity/cross-jurisdiction atomic
  validation, WAL sequencing, the durability boundary and external
  publication.
- Entity applies `EntityTx[]`, owns Paybook, Orderbook and Crontab, and creates
  local `AccountTx[]`. It also owns future Entity sections such as Landbook.
  `accountInput` carries an exact child `AccountInput`.
- Account alone owns bilateral balances, credit, locks, pending proposals,
  committed bilateral history, dispute state, Account consensus and Account
  frames. Network `AccountInput` and local `AccountTx[]` use the same canonical
  Account transition; local transactions never enter routing or P2P.
- `*State` contains only deterministic committed data. Mempools, candidates,
  retry state, worker queues, transport and WAL handles live in `*Replica`.

There is no alternative reducer, compatibility path or second financial
formula. The vocabulary above is part of the protocol.

## 2. One shared CPU worker pool

The Runtime owns one reusable CPU worker pool. Every worker can execute work
for Account, Paybook, Orderbook and Crontab shards. Separate per-module CPU
pools are forbidden because they leave cores idle during another module's
stage and require extra movement between pools.

- Account has 4096 logical shards selected by the first 12 bits of canonical
  `accountId`.
- Paybook has 256 logical shards selected by the first byte of canonical
  `hashlock`; `hashlock` is the payment identity.
- Orderbook has 256 logical shards selected by the first byte of its canonical
  pair key. One pair is one sequential price-time matching domain.
- Crontab uses the canonical radix key and due range. A frame reads only the
  due range; it never scans every hook.
- Landbook and other demonstrated-large Entity sections default to 256 logical
  shards unless their protocol key space proves a different split necessary.
- A logical shard has one worker owner during a process lifetime. Physical
  assignment is operational and must not alter bytes, output order or roots.
- The OS schedules worker threads. Correctness must never depend on CPU-core
  pinning, timing, work completion order or the selected worker count.

The coordinator buckets references or owned batch rows into preallocated
worker lanes. It does not clone replicas, encode the same value again, scan
untouched shards or fold the entire forest. Workers keep shard state resident
and return positional outputs plus dirty-shard commitments only when requested.

The WAL committer is the sole separate thread because it is I/O-bound. It is
not a second state machine and owns no financial state.

### Logical ownership versus physical ownership

The Runtime is deterministic, statically sharded and shared-nothing. Logical
state ownership is permanent; physical CPU ownership is configurable. An
Account always maps to the same logical Account shard. Restarting with another
worker count may assign that logical shard to another worker, but it cannot
change Account identity, state or commitment.

Stateful work stealing is forbidden. No Account or shard migrates dynamically,
no two workers mutate one logical shard, and no lock-protected shared financial
state is introduced. Pure stateless jobs may be considered for work stealing
only after profiling, without changing shard ownership.

Workers are long-lived and retain their assigned Account, Paybook, Orderbook,
Crontab and future section shards across every phase and frame. They are never
recreated or moved between subsystem-specific pools.

## 3. Exactly three dependency-ordered stages

One Runtime frame executes exactly these three stages. A JOIN is a dependency
barrier, not an extra protocol round.

### Stage 1: Account inputs

Runtime-selected `accountInput` Entity transactions are bucketed once by
Account shard. Every worker applies its Account inputs in their original dense
positions and returns Account effects into those positions.

`ack_frame` is the only proposal-carrying Account input; there is no standalone
`frame` input kind. When `ack_frame` carries an ACK, Account applies the ACK
before the proposal within the same Account transition. No Entity or transport
code recreates that ordering.

The compact internal binary wire for proposal/ACK dispatch has exactly two
discriminators: tag `0` is `ack_frame` with an optional ACK and tag `1` is
`ack`. A tag is only a binary codec discriminator, not a product term, protocol
phase or third Account-input method. Dispute and board-Hanko-refresh remain
their canonical typed `AccountInput` variants; they do not justify another
proposal/ACK discriminator.

`JOIN 1` waits for all Account-input lanes required by the frame. Stage 2 may
not observe partial Account effects.

### Stage 2: Entity financial transactions

Account effects and due Crontab rows are routed by canonical Paybook,
Orderbook and Crontab keys. The shared pool applies those logical shards in
parallel. Paybook, Orderbook and Crontab emit local `AccountTx[]` into dense
positional slots.

- Paybook is the only payment lifecycle keyed by `hashlock`. Separate
  `lockBook`, `htlcRoutes` or payment-view state is forbidden.
- Orderbook is the only representation of bids, asks, rests and fills. A hot
  pair remains sequential inside its one shard; different pairs run in
  parallel.
- Crontab is point/range addressed by due time. Full collection scans and a
  second durable due index are forbidden.

`JOIN 2` waits for every Entity-financial lane. Stage 3 cannot start early
because Account proposals consume Stage-2 outputs.

### Stage 3: Account transactions and proposals

Stage 3 receives one final sharded work set. Each Account appears at most once:

```text
{ accountId, accountTxs, forceAck }
```

`accountTxs` contains the local `AccountTx[]` produced by Stage 2. `forceAck`
is transient response control, not Account state: it is `true` only when the
ordered Stage-1 result for an accepted or duplicate counterparty proposal
requires this frame to send/re-send its ACK, and is `false` otherwise. When
multiple Account inputs for the same Account occur in one Runtime frame, their
ordered results fold into this one final boolean; a later accepted pure ACK may
cancel an earlier force before Stage 3.

The work set is bucketed directly by Account shard. Workers admit the local
transactions and derive ACK/proposal behavior from the resident Account state
they exclusively own. In particular, Entity and the coordinator never carry,
clone or reconstruct ACK bytes. When `forceAck` is true, the Account worker
reuses the exact resident outbound ACK: Account-frame height/hash, frame Hanko
and optional dispute proof. Missing resident evidence is a loud invariant
failure. If a new proposal is also produced, the same ACK is attached to its
`ack_frame`; otherwise the worker emits `ack`.

`forceAck` is never stored in Account/Entity/Runtime state, WAL, checkpoint,
frame bytes or any Merkle root. Local Account transactions never pass through
network decoding, routing or P2P.

`JOIN 3` waits for all proposal lanes. Only then may the Runtime seal the
frame or start Stage 1 of the next frame.

No stage 2+3 fusion, same-frame fixed-point loop or unconditional second
Account/Entity pass is allowed. An actual protocol-required continuation must
be a bounded, typed set derived from explicit Stage-3 results, never a scan.

Stage 3 of frame `N` and Stage 1 of frame `N+1` must not be fused into one
mutable phase. Stage 1 of `N+1` starts only after Stage 3 of `N` establishes a
clean in-memory frame boundary. Avoiding that boundary would require MVCC,
undo logs or retained Account generations and is forbidden until measured
evidence justifies a protocol-level redesign.

## 4. Positional determinism

- Accepted Runtime inputs retain their dense selection positions.
- Each input owns a naturally ordered output vector.
- Workers write results into the originating positions.
- The coordinator performs a plain positional flatten.
- Worker completion order is never observable.
- Financial inputs or outputs must not be sorted by id, hash, signer, route,
  shard or worker. Sorting is allowed only inside a canonical data structure
  whose protocol semantics explicitly require it, such as price-time order.

Retries replay the same accepted Runtime WAL input. Transport ACKs, delivery
sequences, receipts and worker ordinals are not protocol authority.

## 5. Lazy commitments and root-on-demand

Mutation and commitment are separate operations. Updating a persistent radix
tree path must not encode or hash that path merely because it was updated.

An existing boundary may express demand with these booleans:

```text
needShardRoot: boolean
needNodeChanges: boolean
```

- `needShardRoot` requests the canonical commitment for dirty logical shards
  and the corresponding incremental sparse top-root update.
- `needNodeChanges` requests physical path-keyed node changes for a durable
  checkpoint.
- `needNodeChanges === true` requires `needShardRoot === true`; any other
  combination is rejected loudly.
- Public migration boundaries may default `needShardRoot` to `true` while
  callers are converted. These flags are demand signals, not a second tree
  mode or subsystem. The final tree API must remain naturally lazy: `root()`
  materializes invalid commitments, and mutation only invalidates them.
- Stage 1 and Stage 2 never request roots merely for diagnostics. They carry
  dirty immutable structure forward. Intermediate Account visits set
  `needShardRoot=false` and `needNodeChanges=false` unless a root is actually
  consumed by a protocol assertion at that boundary.
- There is no intermediate Account root between Stage 1 and Stage 3. Stage 1
  marks Account commitment paths invalid; Stage 3 may mutate them again; only
  the final frame commitment boundary may request the Account root.
- While the current frame format requires a root every frame, the tree must
  support carrying invalid commitments across frames and materializing them
  only at a later checkpoint. Enabling that mode must require removing root
  calls, not writing another Merkle implementation.
- `needNodeChanges=true` only at checkpoint materialization. Ordinary frames
  seal the final root but do not enumerate physical nodes.
- Unchanged subtrees reuse cached commitments. Only dirty leaf-to-root paths
  are hashed; no full-tree materialization or all-shard fold is allowed.
- Node changes are derived from the same path-keyed persistent tree. They are
  not a second tree, sidecar state, CAS graph or alternate checkpoint.

Commitment validity is represented by the cached commitment itself, not by a
separate boolean that can disagree with it. Conceptually, `Some(hash)` means
valid and `None` means invalid. Rust may choose an equivalent measured memory
layout, but it must be impossible to read a stale hash as valid.

Invalidation propagates toward the root only until it reaches an already
invalid ancestor. Thousands of mutations under one invalid branch must
collapse into one later bottom-up commitment calculation. Thus the optimized
steady state is: mutate values and invalidate paths during Stages 1–3, seal
each distinct invalid path once when requested, and enumerate node changes only
when the same boundary is a durable checkpoint.

Large collections share one persistent radix-16 Patricia implementation.
Commitment cost is approximately `O(distinct invalid nodes)`, never `O(total
state)`. Full reconstruction, all-shard walks, unchanged-leaf serialization,
unchanged-branch hashing and rebuilding root arrays are forbidden.

## 6. Frame seal and commitment ownership

After `JOIN 3`, workers seal only invalid shard paths on explicit request. The
coordinator performs only minimal final metadata orchestration over already
prepared section commitments and derives, in dependency order:

```text
Account roots + Paybook root + Orderbook root + Crontab root
    -> Entity root
    -> Runtime root
    -> RuntimeFrame hash + ordered flat outbox
```

The coordinator may not combine roots with XOR, unordered reduction or worker
completion order. Canonical Patricia child positions define the fold.

Canonical encoded bytes are created once and carried forward to hashing,
signing, WAL and publication. No repeated JSON/msgpack conversion, repeated
signature, unchanged-component hashing or second materialization is allowed.

The coordinator is control plane only. It may freeze/select frame input,
advance the epoch, select phases, wake workers, wait at the three barriers,
observe completion, seal minimal Runtime metadata and enqueue the WAL record.
It must not execute Account/Paybook/Orderbook/Crontab transitions, encode or
hash Account state, build trees, fold thousands of leaves, clone/gather large
results, sort financial outputs, serialize full state or synchronously write
WAL.

Local workers are execution lanes, not distributed services. Work moves as
typed Rust values/references or ownership-safe batch rows. JSON, msgpack,
structured clone, generic RPC envelopes and repeated canonical encoding merely
to cross CPU threads are forbidden unless Rust ownership makes a byte boundary
unavoidable and profiling proves its cost acceptable.

## 7. WAL, publication and overlap

The production Runtime has one ordered WAL and one bounded committer queue.

Live scheduling has one canonical `runtimeConfig.minFrameDelayMs`: the minimum start-to-start
interval between produced Runtime frames. It is the only batching delay. Socket,
Account, Entity, WAL and publication layers must not add private coalescing
windows. The Runtime records the process-local start instant, commits the frame,
then sleeps only `delay - elapsed` when that remainder is positive; `0` starts
the next ready frame immediately. This wall-clock instant is never persisted:
the WAL is the only recovery authority. Replay is always unpaced and never reads
this live setting. HLT evidence records the exact interval beside worker count
and offered load.

- Frame `N` becomes the in-memory head only after all three stages and its seal.
- The committer appends and fsyncs frame `N` in order.
- The Runtime may compute frame `N+1` from the sealed in-memory head while the
  committer persists `N`, subject to the bounded speculative depth.
- Initially `MAX_SEALED_NOT_DURABLE_FRAMES = 1`. A deeper speculative pipeline
  is forbidden without measured WAL service-rate evidence; it retains extra
  state versions/outboxes and complicates shutdown, failure and recovery.
- Outbox `N` is published only after durable acceptance of `N`.
- WAL failure poisons the Runtime. It must not publish `N`, retry apply, skip a
  frame or continue from an uncertain head.
- Checkpoint work may overlap later compute but cannot mutate live state or
  change canonical output order.

`fsync` overlap is an operational pipeline optimization, not a second source
of truth. The WAL remains the only Runtime history authority.

`RuntimeFrame` does not contain a complete copy of resulting state. Durable
authority is the path-keyed checkpoint/state database plus ordered Runtime WAL.
The WAL stores only what deterministic recovery needs; redundant state
serialization in the frame or WAL is forbidden.

On WAL write, checksum, short-write or fsync failure the Runtime is poisoned.
Frame `N` is not published, speculative `N+1` is discarded, later frames are
not attempted, and recovery starts from the last durable authority. Apply is
never retried against uncertain in-memory state.

## 8. Crash recovery

Recovery loads one canonical checkpoint and replays ordered accepted Runtime
WAL inputs through the same production transitions. It does not reconstruct
history by scanning certified Account/Entity views and does not query one row
per Account.

After a crash:

- unaccepted mempool work and speculative candidates are discarded;
- accepted Runtime inputs are replayed deterministically;
- the flat outbox of durable frames may be republished best-effort;
- per-frame Runtime, Entity and Account roots must equal the original roots;
- transient transport, ACK/resend and worker scheduling state is never read
  from durable state.

## 9. TypeScript/Rust parity

TypeScript and Rust implement the same canonical transitions, codec, shard
keys, positional order and roots. Worker count and scheduler implementation
are not protocol inputs.

Current implementation work changes RS Core only. TypeScript parity remains a
required eventual gate, but it must not force a second Rust path, compatibility
branch or local worker serialization. Once Rust is correct and measured, the
same architecture is ported to TypeScript rather than emulated through Rust.

Parity is complete only when all of the following are green:

- every supported `EntityTx` and `AccountTx` shared vector;
- identical per-frame Runtime/Entity/Account roots;
- identical ordered event, effect and outbox bytes;
- payment, same-chain swap, cross-j and dispute scenarios;
- live J watcher → Entity → batch submission → receipt handling;
- production and test Rust trees compile;
- H1 launches the same complete Rust process under dev, scenario and HLT
  drivers; TypeScript does not execute H1 financial transitions.

Catalog equality, wire decoding, a release build or replay root equality alone
does not prove semantic parity.

## 10. Required observability

One compact record per Runtime frame is sufficient:

- selected Runtime inputs, selected Entity inputs and Account rows;
- per-stage wall time, useful worker CPU, items and dirty shards per worker;
- JOIN wait and coordinator dispatch/fold time for all three stages;
- encoded bytes, hashed bytes, root requests and node-change requests;
- clone counts qualified by cloned type and sampled bytes;
- WAL queue depth, write/fsync time and publication time;
- per economic operation ledger keyed by payment `lockId` or swap id.

Telemetry is not committed state and must not change scheduling or output.

### Replay scaling diagnostic

The standard replay comparison is `w1` versus `w4`, run sequentially against
independent native database directories. Its input is one WAL recording made
by the live user workload; replay removes user Runtime CPU/disk contention but
executes the same production Rust H1 transitions, WAL/checkpoint writes and
durable fsync path.

The report includes Account inputs/second, Runtime frames/second, apply,
projection, storage, publication, worker utilization and exact per-frame
parity. These are replay diagnostics, never live TPS. A replay with storage or
fsync disabled is not production-shaped scaling evidence.

## 11. Forbidden duplicate work and state

- no full Account, Paybook, Orderbook or Crontab scans in a normal frame;
- no full replica/tree clone for a candidate;
- no root, encoding, hashing or signature computed twice for the same bytes;
- no root calculation before an explicit `needShardRoot` request;
- no eager encode/hash on mutation and no separate `dirty` truth beside the
  commitment-validity representation;
- no node enumeration before `needNodeChanges`;
- no `lockBook`, `htlcRoutes`, shadow financial projection or second orderbook;
- no transport receipt/sequence/frontier in committed state;
- no separate worker pools for the three CPU stages;
- no stateful work stealing, shard migration or multiple mutable shard owners;
- no local-worker JSON/msgpack/RPC boundary;
- no fusion of proposal `N` with ingress `N+1`;
- no speculative durability depth greater than one without owner approval and
  measured proof;
- no test-only H1 financial engine or replay-only production path;
- no compatibility aliases, version branches or silent fallback readers.
- no ACK/Hanko bytes carried through the Entity coordinator; Stage 3 carries
  only transient `forceAck`, and the owning Account worker reads exact evidence
  from its resident replica;

## 12. Change admission

Before changing the Runtime hot path, record:

1. the exact canonical owner and state transition;
2. the measured production-live cost and maximum possible gain;
3. the required output order and commitment bytes;
4. crash/replay and adversarial financial-safety behavior;
5. the narrow TS/Rust parity vector that proves the change.

Prefer deletion, batching and carrying an already-proven value forward. A new
cache, index, persistent field, identifier, wrapper stage or protocol term is
rejected unless deletion or batching cannot solve the measured problem and the
owner explicitly approves it.

## 13. Entity and market-specific ownership

### Paybook

`paybook[hashlock]` is the sole Entity-owned payment lifecycle. `hashlock` is
the canonical top-level lock identifier. All operations are point operations
in one of 256 logical shards and produce Account intents such as forward,
settle, reveal, fail and refund. Paybook never mutates Account authority and is
never fully scanned.

### Orderbook and a hot pair

Orderbook alone owns resting offers, price levels and matching state; Account
alone owns financial balances and canonical remaining financial authority. A
trading pair maps to one of 256 logical shards and remains one sequential
price-time domain. Different pairs execute concurrently.

One hot pair is not speculatively split across workers. That would require
conflicting matches, deterministic merge, rollback and a second matching
formula. The serial matching kernel must instead be made minimal while parsing,
validation, Account settlement and other pairs remain parallel. Batch auction
or deterministic pro-rata matching would be an explicit economic protocol
change, not an optimization.

### Crontab

Crontab uses a persistent ordered due-time index driven only by the committed
Runtime frame timestamp. A frame visits approximately `due <= frameTimestamp`
in canonical order and routes only due work to its owning shards. Full scans
and wall-clock consensus reads are forbidden.

### Multiple Entities

An Entity frame never directly mutates another Entity's internal state.
Independent Entity-local transitions are a natural future parallelism
dimension. Cross-Entity and cross-jurisdiction cohort validation remains owned
by Runtime and must preserve the same final positional ordering and atomic
Runtime commitment.

## 14. Deferred scenario evidence

A complex scenario that is useful but outside the current release priority may
remain as an explicitly opt-in test set instead of blocking every hot-path
iteration. Deferral is evidence triage, not a production workaround:

- keep the scenario and its assertions intact; do not weaken them or add a
  production conditional that makes them pass;
- record the exact failing invariant, why it is currently non-blocking, the
  owning subsystem and the command that reproduces it;
- exclude the set only from the default fast gate and run it as a separate
  focused campaign when that subsystem becomes the active milestone;
- never defer compilation, payment, same-chain swap, canonical WAL/recovery,
  Runtime/Entity/Account root parity or the production Rust H1 launch path;
- a deferred failure must not be reported as green or as completed parity.

The current dispute-restart recovery campaign is such an opt-in set. Its known
failure is duplicate `scheduledWake` application during replay: the wake stored
in the WAL and the same wake derived from Crontab must be coalesced into one
canonical transition before this campaign can become a required gate.
