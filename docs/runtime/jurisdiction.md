# Jurisdiction Machine

[Up: entity machine](./entity.md) | [Adapter](./jadapter.md) | [Protocol primitives](./protocol.md)

The J-machine converts finalized chain observations into deterministic entity inputs and batches entity-originated operations for contracts. Chain RPC and BrowserVM are adapters; canonical event normalization and J-batch state are protocol logic.

## Source

- [`core/jurisdiction/machine/`](../../core/jurisdiction/machine) - identity, height, event normalization, and J-batch logic.
- [`core/jurisdiction/adapter/`](../../core/jurisdiction/adapter) - RPC and BrowserVM adapters/watchers.
- [`core/entity/tx/j-events.ts`](../../core/entity/tx/j-events.ts) - applies threshold-observed J-events to entity state.
- [`core/jurisdiction/machine/batch/index.ts`](../../core/jurisdiction/machine/batch/index.ts) - canonical batch encoding and contract-limit checks.

## Main Methods

- `normalizeJurisdictionEvents(events)` - canonicalizes external observations.
- `canonicalJurisdictionEventKey(event)` - stable event ordering and identity.
- `encodeJBatch(batch)` / `decodeJBatch(bytes)` - deterministic batch wire format.
- `computeBatchHankoHash(...)` - commitment signed by the entity board.
- `getRuntimeJurisdictionHeight(env, ...)` - resolves finalized local J-height.
- `connectJurisdictionAdapter(config)` - opens the selected external chain adapter.

## Invariant

RPC data is untrusted input. Entity state changes only after canonical observation validation and the required signer threshold; adapter caches are not consensus state.
