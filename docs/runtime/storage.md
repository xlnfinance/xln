# Storage Map

This folder owns persistence, replay, and canonical restore verification.

## What it does

- projects runtime/entity/account/book state into durable docs
- writes frame records and WAL
- restores state by snapshot + diff replay
- verifies restore against canonical runtime-state hashes

## Daemon checkpoint and restore

1. **Load and decode.** The daemon reads the retained snapshot plus its frame/diff tail. Every Runtime, Entity, Account, replica metadata, Merkle node, and DAG node crosses a domain-local validator before entering memory.
2. **Rebuild and verify.** Hydration reconstructs Maps and reachable immutable node stores, then checks replica lineage, J-history roots, materialized state, and the canonical runtime/entity hashes. Any missing or malformed authoritative record aborts restore.
3. **Start live work.** Only after exact restore succeeds does the caller attach trusted RPC/network adapters and start the runtime loop. New J-events are admitted normally and the durable outbox is retried from its restored exact payload and signer route.

Checkpoint publication uses one LevelDB batch for the changed materialized documents, immutable nodes, replica metadata, frame record, and published head. The head is never visible without the records it names. Historical account/J bodies used only for display may be pruned; consensus roots and live retry state may not.

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
- `frame-db.ts`
  Separate account-frame journal DB helpers.
- `verify.ts`, `safety.ts`, `lifecycle.ts`
  Storage checks, compaction safety, and lifecycle helpers.

## Called by

- `runtime.ts`
- `radapter/` read paths

## Calls into

- `types.ts`
- `state-helpers.ts`
- `wal/`

## Audit note

If a field is added to runtime/entity/account state, check projection,
hydration, and canonical hash assumptions together. Restore bugs come from
schema drift, not from one file in isolation.
