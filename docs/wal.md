# Runtime storage and WAL

Status: normative storage, materialization, recovery, and crash-safety
specification for xln. TypeScript safety remains governed by
[`fints.md`](fints.md). Where older storage documentation describes full state
blobs, complete-map rewrites, or a second Merkle representation, this document
takes precedence.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. Recovery invariant

For every committed Runtime height `H`, loading the latest materialized state at
height `M <= H` and replaying the authoritative Runtime frames `M+1..H` MUST
produce exactly the same Runtime replica, Runtime root, Entity roots, Account
roots, order books, and durable outbox as uninterrupted execution:

```text
restore(materializedState[M], runtimeFrames[M+1..H]) == liveRuntime[H]
```

Equality means canonical-byte and commitment equality, not merely equivalent
business balances. Recovery MUST NOT lose an output, invent an output, skip an
input, depend on wall-clock state, or require an in-memory candidate that was
not committed before the crash.

The WAL is authoritative between materializations. The materialized state is a
rebuildable acceleration structure, never an alternative source of truth.

## 2. One live graph, one disk projection

RAM is the decoded, typed projection of the current LevelDB key graph. There is
no blob state, parallel storage tree, chunked copy, compatibility projection,
or second financial representation.

- Runtime owns a small, normally bounded set of Entity replicas and MAY keep
  that top-level collection flat.
- Potentially large collections inside an Entity or Account MUST use the shared
  persistent Patricia/radix map: Accounts, order-book price pages, HTLC/lock
  entries, debt collections, replay protection, and other unbounded indexes.
- Keys use canonical raw protocol bytes. Patricia paths split those bytes into
  radix slots; keys are not hashed merely to place them in the tree.
- Radix `16` is the canonical default. Another supported radix is an explicit
  genesis/configuration choice and MUST NOT change for an existing tree.
- An update path-copies only the changed leaf and its ancestor path. Ordinary
  frame work MUST be `O(dirty paths)`, never `O(all leaves)`.
- A persisted value MUST be smaller than `10_000` bytes. Large logical values
  require a separately approved bounded-page design.

LevelDB keys are canonical byte concatenations such as:

```text
<entity-id><family-tag><account-id>
<entity-id><book-tag><pair-id><side><price><uint16-page>
<entity-id><family-tag><patricia-branch-path>
```

Short enum family tags keep keys compact. Every key format and value has one
exact decoder from `unknown`; disk bytes never acquire a trusted type through a
generic cast.

### 2.1 Lifecycle-partitioned roots

The graph is a typed Merkle forest with one final root per replica layer. A
small fixed root record is used at a trust boundary; a path-compressed Patricia
map is used only for a collection that can grow.

```text
AccountReplicaRoot = fixed(AccountStateRoot, AccountEnvelopeRoot)

EntityStateRoot = fixed(
  header,
  accountReplicaIndexRoot,
  orderbookRoot,
  htlcRoot,
  crossJurisdictionRoot,
  governanceRoot
)
```

`AccountStateRoot` is the bilateral root authenticated by `AccountFrame`.
`AccountEnvelopeRoot` commits the bounded current/pending consensus
coordination that Entity validators must agree on. Historical frames and
evidence remain in their dedicated history stores; an unbounded history array
or map MUST NOT enter the live envelope.

An Account transition is always nested inside an Entity transition. The child
overlay produces immutable roots and node mutations which the Entity overlay
adopts. It MUST NOT create an Account WAL, Account snapshot, Account cursor, or
independently published durable anchor. Runtime atomically persists the folded
Runtime/Entity/Account graph.

The unified same-chain/cross-jurisdiction order book shares the Entity
lifecycle. Its Patricia keys are ordered protocol bytes such as
`pair | side | price-big-endian | page-u16`; the leaf is the bounded FIFO page.
Derived RAM locators MAY accelerate lookup but MUST NOT create a second
commitment or storage representation.

### 2.2 Explicit overlays

`beginEntityOverlay(base)` and nested `beginAccountOverlay(entity, account)`
create explicit branded transaction handles. Each overlay stores one canonical
dirty/tombstone set and exposes typed prefix lenses. Reads consult dirty state
before immutable base nodes. Writes never mutate the base graph.

Only the transition coordinator may prepare, publish, or discard an overlay.
Handlers receive a synchronous draft view without lifecycle capabilities.
Preparing path-copies changed Patricia branches, returns a disjoint node diff,
and consumes the overlay. Discard consumes it without storage work. Overlays
are never serialized; after a crash they are recomputed from the last
materialized graph plus authoritative Runtime inputs.

Full Runtime, Entity, Account, AccountReplica, AccountState, or Book clones are
forbidden on transition paths. This does not forbid an `O(1)` copy of a bounded
header/leaf or the `O(depth)` structural path-copy required to publish a dirty
Patricia leaf.

## 3. Patricia integrity

RAM branch and leaf objects MAY cache computed hashes for fast path-copy. Disk
records do not store a node's hash beside that node's own data:

- a leaf value is stored in the leaf record;
- the leaf commitment is stored only in its parent branch payload;
- a branch commitment is stored only in its parent branch payload;
- only the tree root is stored in the owning header;
- Entity and Runtime headers commit their child roots, preserving the complete
  Runtime -> Entity -> Account/Book integrity chain.

This avoids redundant self-hashes that can disagree with their value. On cold
load, the default mode MUST decode every record, recompute child commitments
bottom-up, and compare the resulting root with the owning header. An explicit
operator trusted-disk mode MAY reuse parent commitments to reduce recovery
CPU, but it MUST still exact-decode and bounds-check every record. Network,
imported, restored, and recovery-bundle bytes MUST always be fully verified.

## 4. Live updates and accumulated materialization

Every committed Runtime frame immediately updates the live persistent graph in
RAM. Storage changes also update one bounded-by-dirty-keys accumulator:

```text
Map<CanonicalStorageKey, EncodedValue | null>
```

`value` means set/replace and `null` means delete. A later change to the same
key replaces the earlier accumulator entry, so one materialization writes only
the latest result. The accumulator is ordinary strongly owned Runtime
infrastructure; `WeakMap` and `WeakSet` are prohibited.

The default materialization cadence is `100` Runtime frames and MUST be
configurable. At the cadence boundary:

1. freeze the accumulator for the frame being committed;
2. add the Runtime frame, outbox records, accumulated graph sets/deletes,
   materialized height, and root to one authoritative LevelDB batch;
3. sync that single batch exactly once;
4. update any disposable read-optimized mirror only after the authoritative
   batch succeeds;
5. clear only the successfully persisted accumulator entries.

Frames between cadence boundaries MUST NOT rewrite the state graph. A crash
before the authoritative batch leaves the previous materialization and frame
head visible. A crash after the batch sees the new frame, outbox, graph, and
materialized root together. A disposable mirror may lag and be rebuilt; it is
never recovery authority. A torn mixed authoritative graph is impossible.

## 5. Minimal authoritative Runtime frame

Every Runtime frame is durably appended before any external effect. Its
authoritative record contains only the information required to reproduce and
verify the transition:

```text
height
timestamp from deterministic input/context
previous frame hash
previous Runtime root
validated Runtime input
post Runtime root
references to newly created or terminal outbox records
small protocol/version metadata
```

The post Runtime root is a parent commitment over child digests, not a hash of
a serialized Runtime object. Its children are the Entity-replica commitment,
the jurisdiction commitment, durable Runtime-infrastructure roots/digests, and
the ordered outbox payload references. BrowserVM contributes its canonical
`stateRoot`; its trie bytes MUST NOT be rescanned by each Runtime frame.

Runtime frames MUST NOT embed a full Runtime/Entity/Account/Book snapshot,
state-document diff, history view, activity log, storage overlay, or repeated output body. Entity and
Account certified frame histories live in their own append-only LevelDB
keyspaces and are read on demand; live state is never an archive.

## 6. Durable outbox

An external effect is represented by one canonical outbox record keyed by its
deterministic output ID. The frame references that ID instead of duplicating the
payload.

Creation of a frame and its new outbox records MUST occur in the same synced
authoritative WAL batch. Dispatch begins only after that batch succeeds.
Delivery is at-least-once and receivers MUST deduplicate by deterministic
identity. A terminal receipt is persisted before the corresponding outbox
record becomes eligible for deletion.

After any crash, recovery reconstructs the exact non-terminal outbox and
resumes delivery. Duplicate delivery is permitted and harmless; missing a
committed output is forbidden.

## 7. Epochs and retention

The default epoch cadence is `10_000` Runtime frames and MUST be configurable.
Epoch rotation creates a compact genesis for a fresh current-state DB:

1. materialize all accumulated dirty keys;
2. verify the resulting Runtime root;
3. create the new epoch DB from the canonical current Patricia records;
4. write and sync its genesis manifest, height, and root;
5. atomically publish the active-epoch pointer;
6. retain the previous epoch and WAL according to configured policy.

The old epoch MUST NOT be deleted before the new epoch has reopened and passed
root/recovery verification. WAL retention is an operator policy; rotation does
not imply immediate deletion. Historical Entity and Account frame databases
have independent retention policies.

The principal configuration values are therefore:

- `materializePeriodFrames` — default `100`;
- `epochPeriodFrames` — default `10_000`;
- WAL retention by frames, bytes, time, or explicit archival policy;
- history retention for Entity and Account certified frames;
- cold-load integrity verification, enabled by default.

## 8. Crash boundaries

The implementation and tests MUST cover every boundary below:

| Crash point | Required recovery result |
|---|---|
| Before WAL batch | Frame and outputs are absent |
| During WAL batch | Atomic LevelDB semantics expose either the whole frame/outbox set or none |
| After WAL, before state materialization | Replay rebuilds identical state and outbox |
| During state materialization | Previous or new materialized root is visible, never a mixed graph |
| After state materialization | Reopen yields the committed root without full-map rewriting |
| Before output dispatch | Outbox retries the committed output |
| During/after dispatch, before receipt | At-least-once retry may duplicate; receiver deduplicates |
| After terminal receipt | Output is terminal and is not lost or re-executed financially |
| During epoch rotation | Old epoch remains bootable until new epoch is verified and published |

For each boundary, uninterrupted execution and recovered execution MUST end at
the same canonical Runtime root and the same durable outbox set.

## 9. Forbidden production patterns

Production gates MUST reject:

- `structuredClone`, deep copy, or full spread-copy of Runtime, Entity, or Book
  state on a frame path;
- rebuilding or sorting all Patricia leaves during ordinary update,
  materialization, hashing, or recovery replay;
- scanning all Accounts or orders to compute an unrelated frame commitment;
- storing an unbounded Map/array as one LevelDB value;
- storing Book, Account collection, Runtime, or Entity blobs in WAL/snapshots;
- writing both a canonical tree and a parallel chunk/tree representation;
- self-hashes stored beside a node's own value;
- external effects before the authoritative WAL commit;
- clearing dirty state before its atomic materialization succeeds;
- pruning WAL or the old epoch before replacement recovery is proven.

## 10. Required evidence

Changes to storage, WAL, roots, outbox, Patricia maps, or recovery require this
test ladder:

1. **L1 structure:** one update changes only its leaf and ancestor path; values
   stay below `10_000` bytes; malformed disk records fail exact decoding.
2. **L1 cadence:** frames `1..99` append WAL without state-graph writes; frame
   `100` writes the deduplicated accumulated set/delete map once.
3. **L2 differential recovery:** crash at every boundary in section 8 and prove
   live versus recovered canonical bytes, roots, and outbox equality.
4. **L2 epoch rotation:** crash before/after genesis publication and prove at
   least one complete epoch remains bootable.
5. **Performance:** report matcher TPS and fully-settled TPS separately, plus
   frame latency, signature CPU, LevelDB sync time, WAL bytes, dirty-key count,
   RSS, and recovery duration.
6. **L3 gates:** only after the owning L1 and L2 evidence is green, run the full
   TypeScript, FinTS, storage, scenario, and release gates once on unchanged
   bytes.

The target is not merely a fast matcher. A production benchmark succeeds only
when all expected swaps are bilaterally committed, pending outputs are zero,
the durable outbox is terminal, a cold replay produces the same roots, and no
financial transition was lost or duplicated.
