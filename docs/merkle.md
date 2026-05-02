# XLN Storage Merkle Architecture

Status: current mainnet-target design, no legacy fallback.

Date: 2026-05-02.

## Executive Summary

XLN uses the storage Merkle tree as an integrity/checkpoint root. It is not a proof API and it does not need inclusion-proof endpoints for the current product.

The durable source of truth is split in two layers:

- saved state rows: `KEY_LIVE_ENTITY`, `KEY_LIVE_ACCOUNT`, `KEY_LIVE_BOOK`;
- saved Merkle rows: `KEY_MERKLE_ROOT`, `KEY_MERKLE_BRANCH`, `KEY_MERKLE_LEAF`.

There is no durable `cells[]` blob, no hidden `cellMap`, no hidden in-memory Merkle tree attached to serializable docs, and no fallback rebuild from all account rows on the hot path. If saved state rows exist for an entity, the Merkle root for that entity must exist too. Missing Merkle root means corruption in the current storage contract.

The update path is incremental:

1. Runtime mutates entity/account/book state.
2. Overlay marks the exact dirty docs.
3. Materialization writes changed docs.
4. The persisted Merkle editor descends only the touched key path through `KEY_MERKLE_BRANCH` / `KEY_MERKLE_LEAF`.
5. It updates or deletes the leaf, collapses branches after delete, recomputes the bottom-up stack, and writes only dirty root/branch/leaf records.

For a one-million-account hub, a single account update must be `O(depth)` in the persisted Merkle tree, not `O(account_count)`.

Large benchmark fixtures may bulk-materialize Merkle rows once, because fixture creation is not the production hot path. Runtime traffic still uses the persisted editor and touches only updated key paths.

## Terminology

Saved state rows are the actual encoded runtime state stored in LevelDB:

- one entity core row;
- one account row per counterparty;
- one book row per trading pair.

Merkle rows are integrity metadata for those state rows:

- one root row per entity/namespace;
- branch rows for internal radix nodes;
- leaf rows for doc hashes.

The code must not treat missing Merkle rows as an old schema. This testnet is rewritten from scratch. If state rows exist without required Merkle metadata, fail fast.

## Current Durable Keyspace

```text
KEY_LIVE_ENTITY        | entityId
KEY_LIVE_ACCOUNT       | entityId | counterpartyId
KEY_LIVE_BOOK          | entityId | pairId

KEY_MERKLE_ROOT        | entityId | namespace
KEY_MERKLE_BRANCH      | entityId | namespace | packedPath
KEY_MERKLE_LEAF        | entityId | namespace | packedPath
```

Per-entity root summaries are read from `KEY_MERKLE_ROOT`; there is no parallel entity-hash keyspace.

## Root Shape

The current implemented namespace is `runtime-roots`.

Within that namespace, leaf paths are domain-separated by logical doc family:

- `entity`
- `accounts/<counterpartyId>`
- `books/<pairId>`

The entity state root is then included in the runtime state root:

```text
runtime state root
  entityId -> entity Merkle root
```

Future namespaces such as `accounts`, `books`, `lock-book`, and `htlc-routes` may be split into independent collection roots if those collections become separate storage hot spots. That change must preserve determinism and must not reintroduce a blob of all cells.

## Hashing

Merkle hashing has explicit domain separation:

- `xln.storage.merkle.leaf.v1`
- `xln.storage.merkle.branch.v1`
- `xln.storage.merkle.extension.v1`

Branch children are hashed in slot order. Compressed path segments are length-prefixed and byte-deterministic. A one-leaf tree stays one leaf. Branches split only where keys diverge. Deletes collapse branches immediately.

`stateHash` uses the storage Merkle root. `canonicalStateHash` is an opt-in audit oracle behind `XLN_STORAGE_VERIFY_CANONICAL=1`; it is intentionally not part of the production hot path.

## Incremental Update Contract

For every dirty doc:

```ts
put(docRef, encodedDocHash)
  -> persistedEditor.put(docRefCellKey(docRef), encodedDocHash)

del(docRef)
  -> persistedEditor.del(docRefCellKey(docRef))
```

The persisted editor:

- opens `KEY_MERKLE_ROOT(entityId, namespace)`;
- descends through branch/leaf rows only for the touched path;
- updates or deletes the target leaf;
- collapses empty or one-child branches immediately;
- recomputes hashes bottom-up;
- flushes root, dirty branch puts, dirty leaf puts, branch deletes, and leaf deletes.

If the same key appears in both Merkle deletes and Merkle puts in a single flush, puts win and the delete is stripped before writing the LevelDB batch. This makes the batch order robust and avoids accidental deletion of a newly written node.

## No Legacy Fallback

These patterns are forbidden in storage Merkle code:

- rebuilding a large entity root by scanning all account/book state rows during normal materialization;
- serializing all Merkle cells into one doc;
- choosing an editor based on hidden runtime fields attached to a serializable doc;
- accepting missing root metadata when saved state rows exist;
- silently using old hash modes such as `storage-debug-v1` or `legacy-env-v1`;
- accepting static radapter HMAC keys without expiry.

Allowed bootstrap case:

- a brand-new entity has no saved state rows and no Merkle side rows, so the editor starts from an empty root.

Everything else must either use the persisted root/branch/leaf rows or throw.

## Recovery And Verification

On cold restart, storage reads the persisted Merkle root rows to recover per-entity root summaries. It does not need to scan a million account docs to reconstruct the root.

Optional verification mode:

- deep: re-read Merkle branch/leaf rows and verify that the root matches the saved state hash.

Deep verification is intentionally expensive and should be used in CI, audits, epoch-rotation checks, and operator diagnostics. It is not the normal hot path.

## Overlay Consistency

Overlay records decide which docs are dirty. The Merkle layer must mirror those records exactly:

- dirty entity core => entity leaf put;
- dirty account => account leaf put;
- dirty book => book leaf put;
- deleted account/book => leaf delete;
- no dirty mark => no Merkle mutation.

The Merkle leaf stores the encoded document hash. If a doc is deleted, its Merkle leaf is deleted. If a doc is put, its encoded hash is written to the leaf.

## Radapter Relationship

Radapter reads must not require the browser to download full hub state.

The `/app` remote path reads a bounded `view-frame` subset:

- head and height;
- entity summaries;
- active entity core;
- account page, default 10;
- book page, default 10, ordered by durable book key.

Embedded adapter calls the runtime directly and does not pay msgpack/WebSocket encode/decode. Remote adapter uses the shared binary codec over `/rpc`.

Auth is capability-token based:

```text
xlnra1.<read|full>.<expiresAtMs>.<hmac>
```

Old static HMAC keys are rejected.

## One-Million-Account Requirements

A hub with one million accounts must satisfy:

- updating one account does not scan all accounts;
- cold update after restart does not rebuild all account leaves;
- account list reads are paged;
- remote `/app` never serializes all accounts;
- e2e proves remote `/app` can open an existing hub runtime and see the hub entity through radapter;
- deep verification can be run deliberately without being part of every frame.

Known remaining scaling work outside the Merkle hot path:

- full runtime restore still materializes the entity state maps in memory;
- historical full-entity reads still materialize all accounts/books for the requested entity;
- full snapshots still copy live state and should be reviewed before very large production hubs.

These are separate storage/runtime scaling PRs. They must not reintroduce Merkle fallback logic.

## 1M Hub Benchmark

Run:

```bash
bun run bench:radapter:hub1m
```

This creates a hub with one million saved active account rows, one Merkle root/branch/leaf keyspace, a 1% hot set, and a real `/rpc` WebSocket connection through `RemoteRuntimeAdapter`. It records timestamped phases for state-row generation, Merkle materialization, Merkle persistence, paged reads, descending reads, authenticated sends, durable hot updates, and explicit GC probes.

Use the all-memory variant when the goal is to measure runtime heap/GC behavior rather than the hot-set production profile:

```bash
bun run bench:radapter:hub1m:allmem
```

## Audit Checklist

Ask an auditor to verify:

1. `StorageEntityHashDoc` has no `cells[]` or hidden cache fields.
2. `runtime/storage/hashes.ts` has one hot path: persisted root/branch/leaf editor.
3. Missing Merkle root with saved entity/account/book rows throws, rather than rebuilding.
4. Merkle root/branch/leaf rows are copied during epoch seeding.
5. Delete collapse removes obsolete branch/leaf rows and leaves no orphan rows.
6. Merkle puts and deletes are deduped before batch write.
7. `stateHash` uses only `storage-merkle-v1`.
8. `canonicalStateHash` is independent from storage projection.
9. Remote `/app` uses `view-frame` with bounded account/book pages.
10. Embedded adapter uses direct in-process calls.
11. Remote adapter uses msgpack binary `/rpc`.
12. Radapter auth requires expiring capability tokens.
13. Full e2e includes a remote hub `/app` test.

## Non-Goals

No inclusion-proof API is required now.

No schema migration compatibility is required for discarded testnet storage shapes.

No `v2` hash mode should be introduced just to clean up current code. The current contract should be fixed in place and kept simple.
