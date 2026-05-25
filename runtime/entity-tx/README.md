# Entity Tx Map

This folder owns entity-layer transaction application.

## What it does

- validates entity ingress
- mutates `EntityState`
- bridges runtime/J-layer/account-layer events into entity decisions

## Main files

- `apply.ts`
  Entity-tx dispatcher and top-level error policy.
- `handlers/account.ts`
  Committed account-input followups, orderbook refresh, and cross-j followup entry.
- `j-events.ts`
  J-layer observation ingestion and finalization.
- `handlers/dispute.ts`, `handlers/settle.ts`, `handlers/j-broadcast.ts`
  J-layer state transitions and settlement broadcast path.
- `handlers/cross-j-*.ts`
  Cross-j setup, fill, clear, salvage, sweep, and book-order coordination.
- `cross-jurisdiction-helpers.ts`
  Shared validation/binding helpers used by cross-j handlers.

## Called by

- `entity-consensus.ts`
- `runtime.ts` through merged entity inputs

## Calls into

- `account-tx/`
- `cross-jurisdiction.ts`
- `j-batch.ts`
- `storage/` indirectly through persistence after frame commit

## Audit note

Entity-tx changes can be fatal even when bilateral logic looks unchanged. The
highest-risk paths here are `j-events.ts`, `handlers/account.ts`, and the
cross-j handlers.
