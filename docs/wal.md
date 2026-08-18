# Runtime storage, overlays, WAL, and recovery

Status: normative storage specification for xln. TypeScript and boundary safety
remain governed by [`fints.md`](fints.md). Any older document or implementation
that stores complete machine blobs, maintains a second state representation, or
hashes on every mutation is non-canonical.

## 1. One invariant

For every committed Runtime height `H`, the latest materialized graph at height
`M <= H` plus authoritative Runtime frames `M+1..H` MUST reconstruct exactly the
same live Runtime and durable outbox as uninterrupted execution:

```text
recover(graph[M], frames[M+1..H], outbox[H]) === liveRuntime[H]
```

Equality is byte-exact and includes Runtime, Entity, Account, order-book and
BrowserVM roots, current/pending consensus envelopes, and every non-terminal
outbox record. Recovery MUST NOT need an overlay or cache that existed only in
RAM before the crash.

There is one authoritative LevelDB for the current graph, Runtime WAL, outbox,
and authoritative heads. Entity and Account certified-frame history is stored
in separate history databases and read on demand. History is never live state.

## 2. One graph in RAM and on disk

RAM is the decoded typed form of the same records stored in LevelDB. There is no
blob snapshot, flattened copy, chunk/rebranch layer, document Merkle tree, or
parallel financial representation.

- Runtime normally owns fewer than one hundred Entity replicas and MAY keep
  that top-level index flat.
- Every collection that may become large MUST use the shared typed Patricia
  engine: Entity Accounts, Account collections, order-book pages, HTLCs,
  subcontracts, locks, replay protection, and other growing indexes.
- Patricia placement uses canonical raw key bytes. It MUST NOT hash keys merely
  to place them in the tree.
- Radix `16` is the default. Other supported fanouts are explicit immutable
  tree configuration, not runtime heuristics.
- Every LevelDB value MUST encode to fewer than `10_000` bytes. An oversized
  value fails loudly until that semantic value has an approved bounded-page
  design.
- The storage shape imposes no fixed Account-count limit on an Entity. Account
  admission economics, Hashcash and bonds are separate resource policies; they
  MUST NOT reintroduce a traversal-based or consensus-state capacity ceiling.

The same typed node object model is used by Account, Book, Entity collections,
storage hydration, recovery, and snapshot export. A component MUST NOT rebuild
the same collection through a private Map or a second Merkle implementation.

## 3. Typed Merkle forest

Growing collections use one shared Patricia implementation. Small fixed root
records compose those collection roots into the canonical R/E/A cascade:

```text
RuntimeRoot = H(
  runtimeHeader,
  entityReplicaCommitments,
  jurisdictionRoot,
  outboxRoot,
  BrowserVM.stateRoot
)

EntityRoot = H(
  entityHeader,
  accountReplicaIndexRoot,
  bookIndexRoot,
  htlcRoot,
  subcontractRoot,
  governanceRoot,
  crossJurisdictionRoot
)

AccountReplicaRoot = H(AccountStateRoot, AccountEnvelopeRoot)
```

`AccountStateRoot` is the bilateral state authenticated by `AccountFrame`.
`AccountEnvelopeRoot` commits only current bounded consensus coordination:
current/pending frame, mempool, ACK/resend, dispute and routing state. Historical
frames, closed-order history and activity logs MUST NOT enter the live root.

The Entity Account leaf binds only the Account identity and its
`AccountReplicaRoot`; it MUST NOT embed or re-encode the entire Account.

The unified same-j/cross-j order book uses one tree and one matcher. Its ordered
page key is:

```text
pair | side | sortable-price-big-endian | page-sequence-u16
```

The page value is a bounded FIFO page. Price-time priority walks prices in
economic order and pages in increasing sequence. Account state stores the
order and its Book reference; the Book stores the executable FIFO projection.
Derived RAM locators are rebuildable indexes with `commitment: false`; they are
not persisted and never produce a root.

The price and page sequence live in the key and are not repeated in the page
value. A live price level never reuses a page sequence. When its final order is
removed, the whole level is deleted and a later level at the same price starts
again at page zero. Exhausting `uint16` while the level is still live rejects
the next order loudly; it never wraps or overwrites FIFO state.

## 4. Overlay semantics

An overlay is a separate strongly owned RAM object. It is not a copied Entity,
Account, Book, branch, or tree. It contains canonical key mutations and
tombstones for one transition lifecycle.

```ts
type OverlayMutation<K, V> =
  | Readonly<{ kind: 'set'; key: K; value: V }>
  | Readonly<{ kind: 'delete'; key: K }>;

interface OverlayView<K, V> {
  get(key: K): Readonly<V> | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  edit(key: K, reducer: (previous: Readonly<V>) => V): void;
  delete(key: K): boolean;
  entries(prefix?: Uint8Array): IterableIterator<readonly [K, Readonly<V>]>;
}
```

The generic interface belongs only to the shared Patricia engine. Product
handlers receive named typed lenses such as `account.deltas`, `account.locks`
or `book.pages`; they never pass a runtime string tree name or cast a key/value
between collections. Values returned by `get` are read-only. `edit` must return
a newly owned value and direct mutation of a returned committed value is a
type/gate violation.

Reads are always overlay-first and base-second. `set`, `edit`, and `delete`:

- own and validate the key/value;
- update only the overlay mutation table;
- do not path-copy the base tree;
- do not create or invalidate parent objects;
- do not compute a leaf, branch, edge, collection, Account, Entity, or Runtime
  hash.

Entity and Account overlays have separate branded lifecycle handles because
their consensus cycles differ. An Account overlay is evaluated by the Account
machine and returns an immutable prepared child result. The Entity overlay may
adopt that result, but MUST NOT own or serialize the Account overlay itself.

Handlers receive only a synchronous typed view. Only the owning transition
coordinator may fold, publish, or discard an overlay. TypeScript brands plus a
runtime lifecycle token reject double fold, double publish, and use after
discard.

## 5. One fold at the root boundary

The Runtime loop requests the final root once for a candidate frame. That call
folds each dirty overlay exactly once:

1. canonicalize mutations by raw key bytes;
2. traverse the immutable base and overlay together;
3. create the final changed leaves and their changed ancestry once;
4. structurally share every untouched base subtree;
5. compute missing hashes bottom-up;
6. return the new root, committed typed graph and exact physical node changes.

The overlay MUST NOT replay N mutations through N calls to a persistent
`updated()` method. Shared dirty prefixes are folded together. Work is
proportional to changed values and the union of their paths, not to all leaves
and not to `mutations × depth` repeated construction.

```ts
type PreparedTreeFold<R, K, V> = Readonly<{
  root: R;
  tree: CommittedPatriciaMap<K, V>;
  graphOps: readonly GraphOp[];
}>;

declare function foldOverlay<R, K, V>(
  overlay: ActiveOverlay<K, V>,
): PreparedTreeFold<R, K, V>;
```

Folding is deterministic and consumes the overlay. Discarding consumes it
without changing base state or storage.

## 6. Hash ownership

`hash` is a derived RAM property of a node object. It is computed lazily and is
not stored beside that node's own data.

- A node whose immutable content is unchanged MAY retain its cached `.hash`.
- A final node created by folding dirty content starts without a hash.
- Root calculation recursively computes only missing hashes and caches them.
- A cached hash may change only from absent to its deterministic value. A
  different rewrite is a fatal invariant violation.
- A second root read without state changes performs zero new hashing.
- An absent hash is never comparable as a commitment; `undefined === undefined`
  MUST NOT prune a storage diff.

On disk, a parent branch record stores the commitments of its children. A leaf
record stores its semantic key/value but not its own hash. A branch record does
not store its own hash. The owning header stores the tree root. Thus every hash
has one storage location:

```text
leaf hash   -> parent branch payload
branch hash -> parent branch payload
root hash   -> owning header
```

Cold load exact-decodes every record and, by default, recomputes commitments
bottom-up before accepting the owning root. A local operator MAY explicitly
enable trusted-disk mode to reuse persisted parent commitments, but key/value
decoding, bounds and ownership checks remain mandatory. Network, import and
recovery-bundle data always use full verification.

## 7. Canonical LevelDB records

Physical keys are short byte concatenations beginning with a stable enum tag.
Variable-width segments are length-prefixed; Patricia paths carry their exact
slot length so odd radix-16 paths cannot collide.

```text
HEAD
FRAME_HEADER       | height-u64
FRAME_INPUT        | height-u64 | ordinal-u32
OUTBOX             | output-id32

RUNTIME_HEADER
ENTITY_HEADER      | entity-id32
ACCOUNT_HEADER     | entity-id32 | account-id32
BOOK_HEADER        | entity-id32 | pair-length-u16 | pair-bytes

BRANCH             | tree-kind-u8 | owner | packed-path
LEAF               | tree-kind-u8 | owner | packed-path
```

`tree-kind` identifies the actual typed RAM collection. `owner` is exactly one
of Runtime, Entity, Account, or Book identity. Branch values contain a slot
bitmap and canonical child references/commitments. Leaf values contain the
exact typed semantic key and value. Headers contain bounded scalar fields and
child roots.

Every key family has one exact encoder and one `unknown -> decoded` decoder.
Unknown tags, extra fields, non-canonical paths, mismatched owner/key/value,
duplicate slots, missing children, orphan nodes and values at or above
`10_000` bytes fail loudly.

## 8. Canonical storage API

There is one production API. There are no `durable` versus `resolved` machine
types and no fallback reader. Recovery returns the actual current
`RuntimeReplica` reconstructed from stored records and Runtime inputs.

```ts
type StorageFamily =
  | 'runtimeHead'
  | 'frameHeader'
  | 'frameInput'
  | 'outbox'
  | 'runtimeHeader'
  | 'entityHeader'
  | 'accountHeader'
  | 'bookHeader'
  | 'branch'
  | 'leaf';

declare const STORAGE_KEY_FAMILY: unique symbol;

type StorageKey<F extends StorageFamily> = Uint8Array & {
  readonly [STORAGE_KEY_FAMILY]: F;
};

interface StorageValueByFamily {
  runtimeHead: CommittedRuntimeHead;
  frameHeader: RuntimeFrameRecord;
  frameInput: RuntimeInputRecord;
  outbox: OutboxRecord;
  runtimeHeader: RuntimeHeaderRecord;
  entityHeader: EntityHeaderRecord;
  accountHeader: AccountHeaderRecord;
  bookHeader: BookHeaderRecord;
  branch: PatriciaBranchRecord;
  leaf: PatriciaLeafRecord;
}

type StorageSet = {
  [F in StorageFamily]: Readonly<{
    kind: 'set';
    key: StorageKey<F>;
    value: StorageValueByFamily[F];
  }>
}[StorageFamily];

type StorageDelete = {
  [F in StorageFamily]: Readonly<{
    kind: 'delete';
    key: StorageKey<F>;
  }>
}[StorageFamily];

type GraphOp = StorageSet | StorageDelete;

type RuntimeFrameRecord = Readonly<{
  protocolVersion: StorageProtocolVersion;
  height: RuntimeHeight;
  timestamp: RuntimeTimestamp;
  previousFrameHash: RuntimeFrameHash;
  previousRuntimeRoot: RuntimeRoot;
  inputRefs: readonly RuntimeInputRef[];
  postRuntimeRoot: RuntimeRoot;
  outboxRefs: readonly OutboxId[];
}>;

type CommittedRuntimeHead = Readonly<{
  epoch: RuntimeEpoch;
  latestHeight: RuntimeHeight;
  latestFrameHash: RuntimeFrameHash;
  latestRuntimeRoot: RuntimeRoot;
  materializedHeight: RuntimeHeight;
  materializedRuntimeRoot: RuntimeRoot;
}>;

type Materialization = Readonly<{
  height: RuntimeHeight;
  runtimeRoot: RuntimeRoot;
  graphOps: readonly GraphOp[];
}>;

type RuntimeFrameCommit = Readonly<{
  frame: RuntimeFrameRecord;
  inputs: readonly RuntimeInputRecord[];
  outboxOps: readonly OutboxOp[];
  materialization?: Materialization;
}>;

interface RuntimeStore {
  commitFrame(commit: RuntimeFrameCommit): Promise<CommittedRuntimeHead>;
  recover(): Promise<RuntimeReplica>;
  rotateEpoch(): Promise<EpochRotationReceipt>;
}
```

`commitFrame` is the only production write entry point. It exact-validates all
records, checks the previous head/root, rejects duplicate physical operations,
enforces the row-size limit, creates one LevelDB batch and syncs it once. The
live Runtime pointer is published and external dispatch begins only after that
commit succeeds.

History APIs are separate read-only services over their dedicated databases:

```ts
interface CertifiedHistoryStore {
  readEntityFrames(query: EntityHistoryQuery): Promise<EntityHistoryPage>;
  readAccountFrames(query: AccountHistoryQuery): Promise<AccountHistoryPage>;
}
```

## 9. Runtime frames and outbox

Every committed Runtime frame is written before external effects. Its header
contains only height, deterministic time, previous frame/root, input refs,
post root, outbox refs and small protocol metadata. Large input lists are
semantic `FRAME_INPUT` records; a frame header never becomes a blob.

Runtime frames MUST NOT contain Runtime/Entity/Account/Book snapshots, graph
diff blobs, overlays, history arrays, activity logs, or repeated output bodies.

An outbox record is keyed by deterministic output identity. Creation of a frame
and its new outbox records is one synced batch. Dispatch is at-least-once and
starts only after commit. Receivers deduplicate by identity. A terminal receipt
is committed before the outbox entry may be deleted. Recovery restores every
non-terminal entry and resumes delivery; duplicate delivery is acceptable,
loss of a committed output is forbidden.

Repeating a content-addressed payload with the same hash and the same bytes is a
no-op. Different bytes under the same hash are a fatal collision.

`pendingRuntimeInput` belongs to the Runtime envelope, not the frame header.
Crash recovery reconstructs it by replaying committed inputs. If a deferred
payload cannot be derived from those inputs, it is a separate content-addressed
queue record and MUST NOT be duplicated inside the frame.

Replay of a WAL tail re-verifies Hanko with the same halt semantics as live
execution. An internal crypto error remains a Runtime halt; it is never rewritten
as an invalid-signature skip.

## 10. Accumulated materialization

Every frame updates the live graph in RAM. Between materializations, exact
physical graph changes accumulate as:

```text
Map<StorageKey, StorageRecordValue | null>
```

`null` means delete. A later operation for the same key replaces the earlier
one. The accumulator is strongly owned infrastructure; `WeakMap` and `WeakSet`
are prohibited.

The default materialization cadence is `100` Runtime frames and is configurable.
Ordinary frames write only the WAL frame/intake/outbox/head batch. At cadence:

1. freeze the accumulated map for the candidate frame;
2. include its deduplicated graph operations, the current frame/intake/outbox,
   materialized height/root and HEAD in the same authoritative LevelDB batch;
3. sync exactly once;
4. publish the new live head;
5. clear only accumulator entries included in the successful batch.

A crash before materialization replays frames from the previous materialized
root. A crash after materialization opens the new graph and replays only later
frames. No mixed graph/head can be authoritative.

Materialization does not wait for every local validator replica to converge.
A stale or broken local replica is its operator's recovery problem and MUST NOT
stall an otherwise valid Runtime WAL commit.

## 11. Epochs and retention

The default epoch cadence is `10_000` Runtime frames and is configurable. Epoch
rotation:

1. materializes accumulated changes;
2. verifies the current Runtime root;
3. writes a fresh DB from the current canonical graph records;
4. writes and syncs its genesis head/root;
5. reopens and verifies it;
6. atomically publishes the active-epoch pointer;
7. retains the previous epoch and WAL according to operator policy.

The previous epoch MUST remain bootable until the new epoch is verified.
Runtime WAL, Entity history and Account history have independent configurable
retention. Rotation never implies immediate deletion.

Required configuration:

- `materializePeriodFrames`, default `100`;
- `epochPeriodFrames`, default `10_000`;
- `epochPeriodBytes`, default `0` (disabled until measured);
- `maxFrameInputRecords`, operator-configurable;
- `maxStorageRecordBytes`, default and protocol maximum `10_000` (an operator
  may lower it, never raise it for an existing network);
- `minFrameDelayMs`, default `0`; an optional batching delay is measured rather
  than assumed and does not change frame semantics;
- WAL retention by frames, bytes, time or explicit archive policy;
- Entity/Account history retention;
- cold-load integrity verification, enabled by default.

## 12. Recovery algorithm

`RuntimeStore.recover()` performs exactly one canonical path:

1. open the active epoch and exact-decode HEAD;
2. load the materialized headers, branches and leaves;
3. verify record ownership, bounds, references and configured integrity mode;
4. relink the typed Patricia objects directly without flattening to Maps;
5. reconstruct Runtime/Entity/Account/Book objects and derived RAM locators;
6. replay Runtime inputs from `materializedHeight + 1` through `latestHeight`
   using the same transition functions as live execution;
7. compare every replayed post root with its Runtime frame record;
8. restore the exact non-terminal outbox;
9. publish the Runtime only after the final root and head match.

Missing nodes, extra nodes, unknown records, invalid frames, root mismatches or
outbox inconsistencies halt recovery. There is no legacy or degraded reader.

## 13. Crash boundaries

Tests MUST inject crashes at least at these points:

| Boundary | Required recovered result |
|---|---|
| Before frame batch | Frame and outputs absent |
| During frame batch | Atomic old or new state, never partial |
| After WAL before dispatch | Frame present; outbox retries |
| Between materializations | Previous graph plus WAL replay equals live |
| During materialization batch | Previous or new graph/head, never mixed |
| After materialization | New graph opens at exact root |
| During dispatch before receipt | At-least-once retry, no financial duplicate |
| After terminal receipt | Output remains terminal |
| During epoch creation | Old epoch remains authoritative |
| After epoch pointer publication | New epoch reopens at exact root |

Uninterrupted and recovered execution MUST end with identical roots and durable
outbox contents.

## 14. Production gates

AST/type gates MUST reject:

- `structuredClone`, deep clone, or full traversal copy of Runtime, Entity,
  Account, AccountState or Book on a transition path;
- `Proxy`, `WeakMap`, `WeakSet`, or growing-state `extends Map` wrappers;
- Merkle/hash calls from overlay `get/set/edit/delete` or transaction handlers;
- applying overlay mutations through repeated persistent `updated()` calls;
- rebuilding, sorting or scanning all leaves for one update/root;
- storing a self-hash beside its own node value;
- storing a complete machine, collection, graph diff or snapshot as one value;
- any storage value at or above `10_000` bytes;
- direct LevelDB writes outside the canonical record codec and `commitFrame`;
- external dispatch before the authoritative commit;
- live historical arrays/maps;
- compatibility readers, fallback formulas or parallel state trees.

The branded TypeScript API MUST make raw disk/network bytes, wrong owner keys,
wrong tree roots, active/prepared/consumed overlays and Runtime/Entity/Account
roots non-interchangeable.

## 15. Required evidence

L1:

- N overlay mutations perform zero hash work before fold;
- overlay-first reads and tombstones are exact;
- fold visits only dirty values and the union of dirty paths;
- a second root read performs zero new hashing;
- mutation order produces identical bytes/root;
- incremental root equals cold rebuild root;
- Graph `set/delete` physical keys are disjoint;
- every encoded record is `<10_000` bytes;
- malformed, corrupt, missing and orphan records reject loudly.

L2:

- crash at every boundary in section 13;
- recovery produces identical R/E/A/Book roots and outbox;
- materialization frames `1..99` write no graph rows and frame `100` writes the
  deduplicated accumulated map once;
- epoch crash testing proves at least one complete epoch remains bootable;
- same-j and cross-j use one Book root and preserve FIFO through recovery.

Performance reports MUST separate matcher TPS from fully-settled economic TPS
and include p50/p95/p99 frame latency, signature CPU, LevelDB sync time, WAL
bytes per swap, dirty nodes per swap, RSS/GC and recovery duration. A product
benchmark passes only when bilateral Accounts are committed, all pending queues
are zero, the outbox is terminal and cold recovery reproduces the same roots.

Only after owning L1 and L2 evidence is green may the unchanged candidate run
the broad TypeScript, FinTS, storage, scenario and release gates once.
