# Storage Map

This folder owns persistence, replay, canonical restore verification, and
rebuildable history views.

## What it does

- projects runtime/entity/account/book state into durable docs
- appends complete Runtime frames to the authoritative WAL
- materializes filterable Entity/Account/J activity views after WAL commit
- restores state by snapshot + diff replay
- verifies restore against canonical runtime-state hashes

## Daemon checkpoint and restore

1. **Load and decode.** The daemon reads the retained snapshot plus its frame/diff tail. Every Runtime, Entity, Account, replica metadata, Merkle node, and DAG node crosses a domain-local validator before entering memory.
2. **Rebuild and verify.** Hydration reconstructs Maps and reachable immutable node stores, then checks replica lineage, J-history roots, materialized state, and the canonical runtime/entity hashes. Any missing or malformed authoritative record aborts restore.
3. **Start live work.** Only after exact restore succeeds does the caller attach trusted RPC/network adapters and start the runtime loop. New J-events are admitted normally and the durable outbox is retried from its restored exact payload and signer route.

Persistence has three physical roles:

1. `current` is the hot, rebuildable Runtime state.
2. `runtimeWal` is the authoritative sequence of complete Runtime frames.
3. `historyViews` contains rebuildable Entity/Account/J frame and activity
   indexes for inspection and UI filtering.

The Runtime WAL is committed first. History views advance only after that
durable commit and record their own Runtime-height cursor. If the process dies
between databases, startup replays the WAL from `cursor + 1`; it never rolls the
authoritative Runtime back to a secondary view. The current-state database is
published last and is likewise rebuilt from the WAL when it lags.

## Main files

- `index.ts`
  High-level persistence orchestration and config.
- `read.ts`
  Restore/replay path from snapshot + diffs.
- `projections.ts`
  Entity/account/book projection and hydration.
- `canonical-hash.ts`
  Canonical runtime-state commitment for fail-fast restore.
- `hashes.ts`
  Frame/entity storage hashes.
- `history-view.ts`, `history-view-schema.ts`
  Rebuildable Entity/Account/J frame and activity indexes.
- `runtime-dbs.ts`
  Explicit handles and paths for current state, Runtime WAL, and history views.
- `verify.ts`, `safety.ts`, `lifecycle.ts`
  Storage checks, compaction safety, and lifecycle helpers.

## Called by

- `runtime.ts`
- `radapter/` read paths

## Calls into

- `types.ts`
- `account/state/state-clone.ts`
- `entity/state-clone.ts`
- `entity/replica-clone.ts`
- `wal/`

## Audit note

If a field is added to runtime/entity/account state, check projection,
hydration, and canonical hash assumptions together. Restore bugs come from
schema drift, not from one file in isolation.
