# Storage Map

This folder owns persistence, replay, and canonical restore verification.

## What it does

- projects runtime/entity/account/book state into durable docs
- writes frame records and WAL
- restores state by snapshot + diff replay
- verifies restore against canonical runtime-state hashes

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
