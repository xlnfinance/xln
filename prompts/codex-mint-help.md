# Codex - Help Fix mintReserves Flow

## Problem
Trying to make `mintReserves` work the SAME way as `reserve_to_reserve` (via jBatch → j_broadcast → J-processor).

**Current status:**
- mintReserves EntityTx adds to `jBatch.reserveToReserve[]` ✅
- j_broadcast queues to J-mempool ✅
- J-processor executes batch ✅
- **BUT:** BrowserVM.processBatch fails with `invalid BytesLike value...value=null`

## Code

**mintReserves handler** (runtime/entity-tx/handlers/mint-reserves.ts:36):
```typescript
newState.jBatchState.batch.reserveToReserve.push({
  receivingEntity: entityState.entityId,
  tokenId,
  amount,
});
```

**BrowserVM processBatch** (frontend/src/lib/view/utils/browserVMProvider.ts:544-556):
```typescript
for (const r2r of batch.reserveToReserve) {
  if (r2r.receivingEntity === entityId) {
    // MINT: No sender
    const events = await this.debugFundReserves(r2r.receivingEntity, r2r.tokenId, r2r.amount);
    allEvents.push(...events);
  } else {
    // R2R: Transfer
    const events = await this.reserveToReserve(entityId, r2r.receivingEntity, r2r.tokenId, r2r.amount);
    allEvents.push(...events);
  }
}
```

**Error:** `invalid BytesLike value (argument="value", value=null`

**Question:** What's null and why? How should mint work in processBatch?

**Context:** R2R works fine (Hub → Alice, Hub → Bob). Mint fails (Hub self-mint).

Give me the 1-line fix.
