# Storage Map

> Normative protocol: [`../wal.md`](../wal.md). This page is a file map only.
> Complete-frame blobs, `StorageDoc` graphs, `runtime-machine-graph`, and
> snapshot+diff recovery are non-canonical.

This folder implements `RuntimeStore`: one `commitFrame` that syncs a thin
Runtime WAL record, and `recover` / `rotateEpoch` over the same typed Patricia
graph that live execution uses.

## What it does

- commits one RuntimeFrame per `sync:true` (header + input records + outbox refs)
- accumulates dirty Patricia/header `set/delete` ops and materializes every 100 frames
- recovers by materialized graph + WAL replay with Hanko verification
- rotates a new epoch DB from live canonical records every 10k frames
- materializes history views after WAL commit; history is a rebuildable index, never authority

## Persistence roles

1. Authoritative LevelDB: current graph headers/branches/leaves, Runtime WAL, outbox, HEAD.
2. History DBs: certified Entity/Account frames, rebuildable from WAL bytes.
3. RAM overlay: dirty mutations only; never written. Crash rebuilds it from graph + WAL inputs.

`localhost:8080` uses the daemon Runtime and this LevelDB store. An in-browser
Runtime is an explicit ephemeral mode until the same `RuntimeStore` exists on IndexedDB.

## Main files

- `index.ts` — `commitFrame` orchestration
- `types.ts` — `RuntimeFrame` and storage records
- `codec/` — exact encode/decode; the only LevelDB write path
- `wal/` — frame hash, outbox CAS payloads, checkpoint headers
- `read/` — recover/hydrate from typed nodes
- `commit/` — batch assembly and safety
- `database/` — epoch handles, lifecycle, LevelDB
- `history/` — rebuildable certified-frame indexes
- `queries/` — inspection APIs over history/WAL

Overlays and the Patricia engine live in `core/protocol/state/`, not here.

## Called by

- `runtime.ts`
- `radapter/` read paths

## Calls into

- `protocol/state/persistent-radix-value-map.ts`
- `protocol/state/radix-overlay.ts`
- Entity/Account/Book typed maps
