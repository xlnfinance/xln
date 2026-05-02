# XLN Merkle Storage Plan

Status: implementation plan plus current implementation notes for audit and mainnet hardening.

Date: 2026-05-01.

## Executive Summary

The current storage Merkle implementation is correct enough for small and medium states, but it is not the final design for a mainnet hub with one million accounts. The latest code already replaced the worst fixed-depth trie behavior with a compressed radix builder, so a small tree no longer creates a long artificial branch chain. It also removed `StorageEntityHashDoc.cells[]`; persisted root, branch, and leaf rows are now the only durable Merkle shape.

The target design is an incremental, persisted, compressed Merkle collection engine:

- no giant single-value `cells[]` blob for large entity maps;
- no eager parent pointers rebuilt on load;
- just-in-time traversal stack for each dirty key;
- `.hash` as a cache on branch/leaf objects, never as encoded business state;
- persisted internal branch nodes keyed by entity/namespace/path;
- a shared implementation that can later back accounts, trading pairs/books, lock maps, and future large collections;
- optional recovery/audit verification of doc hashes and branch hashes.

This document intentionally does not introduce a `v2` hash mode. The goal is to fix the current storage shape and implementation while preserving the existing high-level storage contract where possible.

During the migration, `canonicalStateHash` is the safety anchor for replay verification. The storage Merkle root is still recorded, but any replacement of the entity root internals must be deployed with canonical replay checks enabled until the new root is verified across fresh boot, restore, and epoch rotation. Once the branch-backed root has been proven deterministic, `stateHash` returns to being the primary storage commitment.

Current implementation note: mainline storage now persists root/branch/leaf side records and stores `rootKind` plus `rootPath` in the root document. A cold materialization can update a touched sparse entity through a just-in-time branch stack loaded from `KEY_MERKLE_BRANCH` / `KEY_MERKLE_LEAF`, without rebuilding the million-account cell map from live account docs. This is intentionally an integrity root. It is not a proof API.

## Current State

The current storage system has these durable pieces:

- live docs:
  - `KEY_LIVE_ENTITY`
  - `KEY_LIVE_ACCOUNT`
  - `KEY_LIVE_BOOK`
- per-doc hashes:
  - `KEY_LIVE_DOC_HASH`
- per-entity hash doc:
  - `KEY_LIVE_ENTITY_HASH`
- frame records:
  - `StorageFrameRecord.stateHash`
  - `StorageFrameRecord.entityHashes`
- canonical audit hash:
  - `canonicalStateHash`
  - `canonicalEntityHashes`

The current Merkle builder is compressed and deterministic. It deduplicates keys, compresses shared prefixes, and splits branches only at divergence.

Before the branch-backed update landed, `prepareStorageStateHashes()` worked conceptually like this:

1. Load or build a `StorageEntityHashDoc`.
2. Convert `cells[]` into a map.
3. Apply touched doc hash updates/deletes.
4. Rebuild the entity root from all cells.
5. Persist the updated `StorageEntityHashDoc` as one value.

That shape has been removed from the hot path. Current storage reads root
metadata from the persisted Merkle keyspace, descends only the touched path,
updates/collapses the affected nodes, and writes the dirty branch/leaf records
in the same materialization batch. If live docs exist without the required
root metadata, the storage layer treats that as corruption instead of
rebuilding from a parallel source of truth.

## Why This Is Not Enough For 1M Accounts

For a hub entity with one million accounts:

- a single touched account should not require rehashing all account cells;
- `KEY_LIVE_ENTITY_HASH` should not be a multi-megabyte single value containing every cell;
- startup or recovery should not need to rebuild parent links for the whole tree;
- deep verification should be possible, but not required on the hot path;
- account, book, lock, and route collections need the same scalable primitive.

The current design keeps `KEY_LIVE_DOC_HASH` as leaf truth and keeps
`StorageEntityHashDoc` as root metadata only (`entityId`, `hash`,
`cellCount`). It must never persist a `cells[]` array. Recovery and cold
updates use the persisted Merkle root/branch/leaf keyspace; if a live entity
exists without those keys, storage is corrupt and must fail fast.

## Target Mental Model

Runtime state changes first. Storage materialization then updates durable docs and Merkle collections for the dirty overlay.

Each large collection is represented as a compressed Merkle tree. Branch nodes and leaf metadata are persisted separately. Hashes are caches that can be invalidated and recomputed.

Mutation flow:

```ts
async function updateLeaf(entityId, namespace, key, valueHashOrNull) {
  const stack = await descend(entityId, namespace, key); // just-in-time parent stack
  mutateLeafOrDelete(stack, key, valueHashOrNull);
  recomputeBottomUp(stack);
  persistChangedNodes(stack);
}
```

There are no long-lived parent pointers and no parent graph rebuild at load. The stack exists only for the current update.

Hash flow:

```ts
function hashNode(node) {
  if (node.hash) return node.hash;

  if (node.kind === 'leaf') {
    node.hash = hashLeaf(node.path, node.valueHash);
    return node.hash;
  }

  node.hash = hashBranch(node.path, node.children);
  return node.hash;
}
```

Dirty invalidation:

```ts
function invalidateStack(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const node = stack[index];
    if (!node.hash) break;
    delete node.hash;
  }
}
```

If a parent was already dirty, ancestors above it are already dirty too, so invalidation can stop early.

## Durable Keyspace

The exact key bytes can be adjusted during implementation, but the logical structure should be:

```text
KEY_LIVE_DOC_HASH      | liveDocKey
KEY_MERKLE_ROOT        | entityId | namespace
KEY_MERKLE_BRANCH      | entityId | namespace | packedPath
KEY_MERKLE_LEAF        | entityId | namespace | packedPath
```

If keyspace pressure matters, leaf metadata can be implicit for simple doc-backed leaves and only branch nodes need separate records. The doc hash remains in `KEY_LIVE_DOC_HASH`.

Example root document:

```ts
type MerkleRootDoc = {
  entityId: string;
  namespace: MerkleNamespace;
  rootHash: string;
  rootKind: 'empty' | 'branch' | 'leaf';
  rootPath: number[];
  leafCount: number;
};
```

Example branch document:

```ts
type MerkleBranchDoc = {
  entityId: string;
  namespace: MerkleNamespace;
  path: string; // packed nibble prefix
  children: Array<{
    slot: number;
    kind: 'branch' | 'leaf';
    path: string;
    hash: string;
  }>;
  hash: string;
};
```

Example in-memory node:

```ts
type MerkleNode =
  | {
      kind: 'branch';
      path: Uint8Array;
      children: Map<number, MerkleNodeRef>;
      hash?: string;
      dirty?: boolean;
    }
  | {
      kind: 'leaf';
      path: Uint8Array;
      valueHash: string;
      hash?: string;
      dirty?: boolean;
    };
```

The `.hash` field is a cache. It is not part of encoded account/entity/book docs.

## Shared Merkle Collection Engine

The implementation should be a reusable storage primitive, not account-specific code.

```ts
type MerkleNamespace =
  | 'entity-core'
  | 'accounts'
  | 'books'
  | 'lock-book'
  | 'account-deltas'
  | 'account-locks'
  | 'account-swap-offers'
  | 'htlc-routes';

type MerkleKeyCodec<K> = {
  namespace: MerkleNamespace;
  encodeKey(key: K): Uint8Array;
};

type MerkleCollection<K> = {
  getRoot(): Promise<string>;
  put(key: K, valueHash: string): Promise<void>;
  del(key: K): Promise<void>;
  flush(): Promise<MerkleFlushResult>;
  verify(mode: 'none' | 'shallow' | 'deep'): Promise<void>;
};
```

Domain code provides key codecs. The shared engine owns:

- nibble path encoding;
- compressed branch split;
- branch collapse after delete;
- just-in-time traversal stack;
- dirty hash invalidation;
- bottom-up recompute;
- dirty node writes;
- optional verification;
- flat persistence for small maps;
- auto-promotion to persisted branch mode.

Inclusion proofs are explicitly out of scope for this storage layer. XLN uses
this Merkle tree as an integrity/checkpoint root, not as a content proof API.
If a future product needs subset evidence, that must be a separate design
review and not hidden inside the main hot-path storage primitive.

## Entity Root Shape

Longer-term, if account internals and lock maps become separate persisted docs, the entity root should be able to become a small root over coarse namespace roots:

```text
EntityRoot
  entityCoreDocHash
  accountsRoot
  booksRoot
  lockBookRoot
  htlcRoutesRoot
  otherLargeNamespaceRoot
```

This makes the entity root cheap to update after a collection root changes.

Possible future namespaces:

1. `entity-core`
2. `accounts`
3. `books`
4. `lock-book`

Later, if individual account docs become too large, split account internals:

```text
AccountRoot(counterpartyId)
  accountCoreDocHash
  deltasRoot
  locksRoot
  swapOffersRoot
  pendingWithdrawalsRoot
```

Do not implement every possible nested tree at once. For the current integrity-only storage root, one `runtime-roots` collection over existing storage doc refs is acceptable as long as touched updates are path-local and do not scan all accounts. The shared interface must allow namespace split later.

## Flat Mode And Auto-Promotion

For small collections, flat persistence is simpler and faster than persisted branch nodes.

Recommended policy:

- if `leafCount <= 128` or `leafCount <= 256`, keep flat mode;
- when threshold is exceeded, auto-promote to branch mode;
- never create fixed-depth chains;
- create branches only at actual key divergence;
- collapse branches after delete when a branch has only one child, unless this creates excessive write churn.

Important consensus rule: flat and branch persistence must produce the identical root for the same canonical leaf set. "Flat mode" does not mean a different hash algorithm. It means branch nodes are not separately persisted because the tree is small enough to recompute locally.

Canonical root:

```text
hashCompressedTree(sorted([keyPath, valueHash]))
```

Persisted branch root:

```text
hashCompressedTree(sorted([keyPath, valueHash]))
```

The promotion threshold is a storage policy constant, not a consensus fork boundary. Crossing the threshold must not change the root unless the leaf set changed.

## Materialization Flow

Current materialization receives overlay dirty refs. Target flow:

1. Build live doc puts/dels from overlay.
2. Encode changed docs.
3. Compute `docHash = keccak256(encodedDoc)`.
4. Write `KEY_LIVE_DOC_HASH`.
5. For each dirty doc ref, update the corresponding Merkle collection:
   - `entity-core` for entity doc;
   - `accounts` for account doc;
   - `books` for book doc;
   - `lock-book` for lock map entries once lock map is split.
6. Recompute the small entity root from namespace roots.
7. Recompute runtime root from entity roots.
8. Persist changed branch/root nodes in the same LevelDB batch as live docs and frame/head.

The important invariant is: head moves last. A frame is committed only if all live docs, doc hashes, branch nodes, frame record, and head update are in the committed batch.

Snapshot and epoch rotation must copy the full Merkle keyspace (`KEY_MERKLE_ROOT`, `KEY_MERKLE_BRANCH`, and any explicit leaf metadata keyspace) together with live docs. A restored epoch without branch nodes is invalid even if live docs are present.

Branch split/collapse is applied to the net final overlay for the frame, not to every transient mutation. If an HTLC lock is added and removed before materialization, no branch churn should be persisted for that path.

## Recovery

Normal recovery should be lazy:

- read `StorageHead`;
- read latest frame root;
- read needed live docs;
- read Merkle root docs;
- do not load every branch node eagerly.

On the first update/read of a path, `descend()` loads branch nodes on demand and builds a local stack.

Optional verification modes:

### Shallow

- verify `KEY_LIVE_DOC_HASH == hash(encodedDoc)` for docs being loaded;
- verify loaded branch node hash matches its children hashes;
- verify collection root matches root doc.

### Deep

- stream all live docs and all branch nodes;
- verify every doc hash;
- verify every leaf is included;
- verify no branch has impossible/corrupt child references;
- verify every collection root;
- verify entity root;
- verify runtime root against latest materialized frame.

Deep verification is for recovery/audit/CI, not for every frame.

## What Should Be Deleted Or Replaced

Eventually remove or replace:

- any `StorageEntityHashDoc.cells[]` persistence path;
- full entity root rebuild from all cells on every materialization;
- single-key multi-megabyte entity hash documents for large hubs.

Keep:

- `KEY_LIVE_DOC_HASH` as leaf truth;
- frame hash chain;
- canonical audit hash during migration;
- overlay materialization model;
- existing radapter paged read model.

## Risks And Open Questions

1. Root compatibility.
   - Replacing the entity root algorithm changes `stateHash` for newly materialized frames.
   - The user explicitly does not want a `v2` mode.
   - Migration is guarded by canonical replay verification. Existing DBs should either be re-materialized at a checkpoint or rebuilt from frame input with canonical equality asserted.

2. Flat-to-branch transition root semantics.
   - Resolved: roots must be identical. Flat/branch is persistence policy only.

3. Branch node key design.
   - Key must be byte-sortable by entity/namespace/path.
   - It must support efficient subtree delete/collapse.

4. Branch collapse policy.
   - Immediate collapse is required for deterministic compactness.
   - Apply collapse to the net final state of a materialization batch to avoid HTLC add/remove churn.

5. Cache bounds.
   - A materialization can keep an in-memory branch cache for touched paths.
   - Long-lived global caches should be bounded or avoided.

6. Nested account maps.
   - Account docs may later need internal Merkle collections.
   - Do not split all account internals in the first PR unless profiling proves it is needed.

7. Snapshot interaction.
   - Resolved as invariant: snapshots and epoch rotation must include Merkle root/branch keyspaces.
   - Deep verification after rotation must prove restored roots match the latest materialized frame.

## Implementation Plan

### PR 1: Merkle Collection Primitive

- Add reusable compressed Merkle collection module.
- Implement flat mode and branch mode.
- Implement `put`, `del`, `getRoot`, `flush`.
- Implement just-in-time `descend()` returning a stack.
- Implement split and collapse.
- Unit-test:
  - one leaf stays compact;
  - shared prefix splits correctly;
  - insert with collision creates one branch at divergence;
  - delete collapses branch;
  - flat persistence and branch persistence produce the same root;
  - root deterministic across insertion order;
  - update touches only path-local nodes.

### PR 2: Entity Accounts Collection

- Replace account cells inside `StorageEntityHashDoc` with `accountsRoot`.
- Update account doc materialization to call Merkle collection `put/del`.
- Keep entity core and books on current path if needed.
- Add benchmark/test for 10k-100k synthetic accounts showing update does not scan all accounts.
- Acceptance budget: incremental update at 1M leaves should rewrite O(log16 N) nodes and target <100 us amortized CPU per touched leaf on a warm store, excluding LevelDB fsync.

### PR 3: Books And LockBook Collections

- Move orderbook/trading-pair docs into the same collection engine.
- Move lockBook into the same engine.
- Add key codecs for pair ids and lock ids.
- Add paging compatibility tests.

### PR 4: Recovery Verification

- Add `XLN_STORAGE_VERIFY_MERKLE=shallow|deep`.
- Shallow verifies loaded docs and branch nodes.
- Deep streams all live docs and branch nodes.
- Add corruption tests:
  - bad doc hash;
  - missing branch;
  - bad branch hash;
  - orphan branch;
  - root mismatch.
- Add epoch rotation test: branch-backed Merkle keyspace is copied and deep verification succeeds after rotation.

### PR 5: Remove Giant Entity Hash Docs

- `StorageEntityHashDoc.cells[]` has been removed. Keep it that way.
- Do not add compatibility readers that rebuild Merkle roots from live docs on
  the hot path.
- Update inspect/metrics to show branch counts, leaf counts, flat/branch mode, and max branch depth.

## Audit Checklist

An auditor should verify:

- updates are O(path depth), not O(collection size);
- no hot path loads all accounts for one touched account;
- branch nodes are persisted atomically with frame/head update;
- root after recovery equals root before restart;
- optional verification detects corrupted live doc values;
- optional verification detects corrupted branch nodes;
- branch split/collapse is deterministic;
- flat-to-branch promotion is deterministic;
- no WeakMap/WeakSet is used for durable state;
- `.hash` cache is never serialized into business docs;
- branch cache is bounded or scoped to materialization;
- snapshots/epoch rotation include all required Merkle keyspaces.

## Bottom Line

The correct mainnet design is not a bigger `cells[]` document and not eager parent graph rebuild. It is a shared persisted Merkle collection engine with just-in-time traversal stacks and cached hashes on branch/leaf objects. Accounts, trading pairs/books, and lock maps should all use the same engine through domain-specific key codecs.

---

## Review — Claude (Opus 4.7), 2026-05-01

Read against `runtime/storage/{merkle.ts, hashes.ts, types.ts, keys.ts}` head of `main`.

### ============ AGREE ============

- O(N) hot path is the real bug. `prepareStorageStateHashes` → `buildEntityHashDoc` → `buildHexKeyedMerkle(allCells)` rebuilds the full radix tree per frame for any touched entity. At 1M accounts that's the whole world per HTLC. Fix is mandatory before mainnet.
- Namespace split (`accounts`/`books`/`lock-book`/`entity-core`) mirrors the existing key prefixes (0x21–0x23) and the touched-set already tracked in `StorageOverlayRefs`. Cheap to land.
- `.hash` as cache, not encoded state. Current `setHiddenDocComputedValue` already follows this discipline — just generalize to branch nodes.
- JIT `descend()` over eager parent graph. Correct for cold restarts: `loadEnvFromDB` should not pay branch-graph rehydration on every start.

### ============ GAPS / DISAGREE ============

**1. Flat↔branch root equivalence is not an "open question" — it's a consensus property.**
- If roots differ across modes and one peer crosses the 128 threshold one frame earlier than another, `stateHash` diverges → fork.
- Resolution: mode is purely a function of `leafCount` (deterministic), so transition is safe. But the doc must commit: both modes hash the same canonical leaf set the same way *or* mode is part of the root preimage and the threshold is a hard protocol constant. Pick one. Don't ship with both options open.

**2. Migration story is hand-waved.**
- "No v2 mode" + "stateHash will change" is contradictory. PR2 alone changes the entity-root algorithm.
- `canonicalStateHash` already exists as a parallel audit channel (`StorageFrameRecord.canonicalStateHash`). Use it: during PR2–PR4, canonical is the consensus anchor, `stateHash` becomes advisory. After PR5 lands and is verified across replicas, `stateHash` returns as primary.
- Document this. Otherwise replay across the PR boundary explodes.

**3. Branch-node write amplification is unmeasured.**
- Per touched leaf: ~⌈log₁₆(N)⌉ branch rewrites. For N=1M, depth ≈ 5. 1k touches/frame → 5k branch puts/frame, plus root docs.
- LevelDB SSTable write-amp is typically 10–30× on a hot working set. Concrete budget needed in PR2 acceptance criteria, not "benchmark TBD". Suggest target: <100 µs amortized per touched leaf at 1M-account scale, with frame commit batch size cap.

**4. Inclusion proofs are deliberately excluded.**
- The current storage Merkle is an integrity/checkpoint root. XLN does not use it to prove content membership to light clients or disputes.
- Keeping proof APIs out reduces surface area and keeps the mainnet work focused on deterministic roots, path-local updates, recovery verification, and persistence cost.

**5. Branch collapse thrash on HTLC churn.**
- HTLC lock add → lock resolve in the same frame at the same path = create branch → collapse branch in one materialize pass. With order-of-N HTLCs/sec on a hub, this is the common case, not the edge.
- Spec the collapse rule on *net* per-frame change, not per-mutation. Equivalent to building the new tree from final overlay state, not replaying inserts/deletes.

**6. Snapshot/epoch coverage is listed as "consider" — it's a hard requirement.**
- Open question 7 must be promoted to invariant. If `KEY_MERKLE_BRANCH` is durable truth and epoch rotation copies only `KEY_LIVE_*`, recovery silently produces a wrong root. That's worse than the current state.
- Add to PR1 acceptance: epoch rotation copies the full Merkle keyspace; deep-verify gate runs after every rotation in CI.

**7. Hash domain separation is currently fragile.**
- `merkle.ts:22` uses single-byte tags 0x00/0x01/0x02 with an inner radix marker (0x10/0xff). Works, but the schema is implicit. New design should use length-prefixed ASCII tags ("xln.merkle.leaf.v1", "xln.merkle.branch.v1") or define a TLV explicitly in the doc. Future hash migration without this is painful.

**8. `entity-core` is a single doc; calling it a "Merkle collection" is overstatement.**
- Just hash the doc bytes and put it in the entity root as a fixed slot. No collection engine needed for n=1. Doc currently implies we wrap it in the collection abstraction — wasteful. Spell out: `entity-core` slot = `keccak256(encodedDoc)`, not a tree.

### ============ NIT ============

- `MerkleNamespace` enum should include `runtime-roots` (the per-entity hash map). Same engine, top of the cake.
- `verify?` should not be optional on the interface. Make it required, with `'none' | 'shallow' | 'deep'`.
- Drop `mode: 'flat' | 'branch'` from `MerkleRootDoc`'s persisted form once threshold is fixed; derivable from `leafCount`.

### ============ NEXT ============

- A) **Lock the migration anchor** — write down: canonicalStateHash is consensus root during PR2–PR5, stateHash becomes primary after PR5 verified. One paragraph, top of doc.
- B) **Resolve flat↔branch equivalence before PR1 lands** — pick one rule, write the hash preimages explicitly, add unit test fixtures.
- C) **Promote snapshot Merkle coverage to invariant** — move open question 7 into "Materialization Flow", add to PR1 audit checklist.
- D) **Do not ship inclusion-proof API** — proofs are explicitly deferred; storage Merkle is integrity-only for this cycle.
