# XLN Merkle Storage Plan

Status: design note for audit and implementation planning.

Date: 2026-05-01.

## Executive Summary

The current storage Merkle implementation is correct enough for small and medium states, but it is not the final design for a mainnet hub with one million accounts. The latest code already replaced the worst fixed-depth trie behavior with a compressed radix builder, so a small tree no longer creates a long artificial branch chain. That is a useful correctness and shape improvement, but it still rebuilds entity-level roots from large cell arrays during materialization.

The target design is an incremental, persisted, compressed Merkle collection engine:

- no giant single-value `cells[]` blob for large entity maps;
- no eager parent pointers rebuilt on load;
- just-in-time traversal stack for each dirty key;
- `.hash` as a cache on branch/leaf objects, never as encoded business state;
- persisted internal branch nodes keyed by entity/namespace/path;
- shared implementation for accounts, trading pairs/books, lock maps, and future large collections;
- optional recovery/audit verification of doc hashes and branch hashes.

This document intentionally does not introduce a `v2` hash mode. The goal is to fix the current storage shape and implementation while preserving the existing high-level storage contract where possible.

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

However, `prepareStorageStateHashes()` still works conceptually like this:

1. Load or build a `StorageEntityHashDoc`.
2. Convert `cells[]` into a map.
3. Apply touched doc hash updates/deletes.
4. Rebuild the entity root from all cells.
5. Persist the updated `StorageEntityHashDoc` as one value.

That means the hot path still has O(entity-cell-count) behavior on materialization for a large entity.

## Why This Is Not Enough For 1M Accounts

For a hub entity with one million accounts:

- a single touched account should not require rehashing all account cells;
- `KEY_LIVE_ENTITY_HASH` should not be a multi-megabyte single value containing every cell;
- startup or recovery should not need to rebuild parent links for the whole tree;
- deep verification should be possible, but not required on the hot path;
- account, book, lock, and route collections need the same scalable primitive.

The current design has the right leaf truth (`KEY_LIVE_DOC_HASH`) but the wrong large-map root shape (`StorageEntityHashDoc.cells[]`).

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
  mode: 'flat' | 'branch';
  rootHash: string;
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
  verify?(mode: 'shallow' | 'deep'): Promise<void>;
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
- flat mode for small maps;
- auto-promotion to branch mode.

## Entity Root Shape

Entity root should not be one flat collection of all individual accounts/books/locks forever. It should be a small root over coarse namespace roots:

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

Recommended first namespaces:

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

Do not implement every possible nested tree at once. The shared interface must allow it later.

## Flat Mode And Auto-Promotion

For small collections, a flat sorted hash is simpler and faster than persisted branch nodes.

Recommended policy:

- if `leafCount <= 128` or `leafCount <= 256`, keep flat mode;
- when threshold is exceeded, auto-promote to branch mode;
- never create fixed-depth chains;
- create branches only at actual key divergence;
- collapse branches after delete when a branch has only one child, unless this creates excessive write churn.

Flat mode root:

```text
hash("flat", sorted([keyPath, valueHash]))
```

Branch mode root:

```text
hash("branch", compressed tree)
```

Open question: whether flat and branch modes must produce identical roots for the same leaves. Identical roots are elegant but can complicate implementation. Different roots are acceptable if mode is part of the committed root document and the transition is deterministic.

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

- large `StorageEntityHashDoc.cells[]` as the primary entity hash cache;
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
   - The user explicitly does not want a `v2` mode. The implementation must still document how old DBs are handled.

2. Flat-to-branch transition root semantics.
   - Decide whether flat and branch modes produce the same root for same leaves.
   - If not, mode must be committed and transition must be deterministic.

3. Branch node key design.
   - Key must be byte-sortable by entity/namespace/path.
   - It must support efficient subtree delete/collapse.

4. Branch collapse policy.
   - Immediate collapse keeps trees small.
   - Lazy collapse reduces write churn.
   - Recommended: immediate collapse for simple single-child branches, but benchmark.

5. Cache bounds.
   - A materialization can keep an in-memory branch cache for touched paths.
   - Long-lived global caches should be bounded or avoided.

6. Nested account maps.
   - Account docs may later need internal Merkle collections.
   - Do not split all account internals in the first PR unless profiling proves it is needed.

7. Snapshot interaction.
   - Snapshots currently copy live docs, not Merkle branch nodes.
   - If branch nodes become durable truth, epoch/snapshot copy paths must include Merkle root/branch keyspaces.

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
  - root deterministic across insertion order;
  - update touches only path-local nodes.

### PR 2: Entity Accounts Collection

- Replace account cells inside `StorageEntityHashDoc` with `accountsRoot`.
- Update account doc materialization to call Merkle collection `put/del`.
- Keep entity core and books on current path if needed.
- Add benchmark/test for 10k-100k synthetic accounts showing update does not scan all accounts.

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

### PR 5: Remove Giant Entity Hash Docs

- Stop writing `cells[]` for large collections.
- Keep a small compatibility reader only if necessary.
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
