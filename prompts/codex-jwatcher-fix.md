# Codex - Fix j-watcher Event Timing Issue

## Problem

mintReserves EntityTx goes through proper flow:
1. mintReserves adds to jBatch.reserveToReserve ✅
2. j_broadcast creates jOutput ✅
3. Runtime queues to J-mempool ✅
4. J-processor executes batch ✅
5. BrowserVM.processBatch calls debugFundReserves ✅
6. debugFundReserves emits ReserveUpdated event ✅
7. **j-watcher queues event to env.runtimeInput.entityInputs** ✅
8. **applyRuntimeInput CLEARS env.runtimeInput.entityInputs** ❌
9. **processJEvents finds empty queue** ❌

## Evidence

```
[BrowserVM] MINT detected
[BrowserVM] Funded 0x00000000... with 10000000000000000000000000
📮 QUEUE → 0002 (pending will be 1)          ← j-watcher queues event
⏱️  Tick 2 completed                         ← applyRuntimeInput completes
🔄 processJEvents CALLED: 0 pending in queue ← queue is empty!
```

## Root Cause

Events emitted DURING broadcastBatch (inside applyRuntimeInput tick) get queued to `env.runtimeInput.entityInputs`, which is then cleared at end of tick (runtime/runtime.ts:727).

## Files

- runtime/j-event-watcher.ts:246-304 - Queues to env.runtimeInput.entityInputs
- runtime/runtime.ts:727 - Clears env.runtimeInput.entityInputs
- runtime/runtime.ts:1616 - broadcastBatch called (emits events synchronously)
- runtime/scenarios/ahb.ts:706 - processJEvents called (finds empty queue)

## Question

How do we make j-watcher events survive the tick boundary?

**Options:**
A. Queue to separate buffer (env.pendingJEvents) that doesn't get cleared
B. Return events synchronously from broadcastBatch instead of async j-watcher
C. Process j-watcher queue BEFORE clearing runtimeInput
D. Something else?

**Constraint:** Must work in scenarios AND browser. R2R/R2C/settlements work fine (they don't use j-watcher for their own events, only for result events).

Give me the fix.
