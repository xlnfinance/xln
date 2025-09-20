# XLN Trading Integration Plan

## Current State

The XLN system has three working layers:
- **J-machine (Jurisdiction)**: Processes blockchain events, maintains reserve balances
- **E-machine (Entity)**: BFT consensus, state management
- **A-machine (Account)**: Bilateral settlement between entities

Trading components exist but are NOT wired:
- `src/orderbook/lob_core.ts` - High-performance orderbook (unused)
- `src/orderbook/lob.ts`, `lob2.ts`, `lob3.ts` - Duplicate implementations
- 2019 rebalancing logic in spec files

## Architecture Decision: Entity-Owned Orderbooks

Each entity that wants to make a market owns its own orderbook instance:
- Entity acts as the exchange/market maker
- Other entities submit orders to that entity's book
- Matches generate bilateral settlement events

## Incremental Implementation Steps

### Phase 1: Add Trading Transaction Types ✅
Add to `src/types.ts`:
```typescript
export type EntityTx =
  | // ... existing types ...
  | {
      type: 'place_order';
      data: {
        orderId: number;
        side: 0 | 1;  // 0=BUY, 1=SELL
        price: number; // in ticks
        quantity: number; // in lots
        tif: 0 | 1 | 2; // GTC/IOC/FOK
      };
    }
  | {
      type: 'cancel_order';
      data: { orderId: number };
    }
  | {
      type: 'modify_order';
      data: {
        orderId: number;
        newPrice?: number;
        deltaQty?: number;
      };
    };
```

### Phase 2: Add Orderbook to Entity State
In `src/types.ts`, add to `EntityState`:
```typescript
export interface EntityState {
  // ... existing fields ...

  // 🎯 Trading state
  orderbook?: any; // Will be lob_core instance
  markets?: Map<string, MarketConfig>; // ETH/USDT, etc
}
```

### Phase 3: Wire Order Processing
In `src/entity-tx/apply.ts`, add handlers:
```typescript
case 'place_order':
  if (state.orderbook) {
    const cmd = {
      kind: 0, // NEW
      owner: tx.from,
      orderId: data.orderId,
      side: data.side,
      tif: data.tif,
      postOnly: false,
      reduceOnly: false,
      priceTicks: data.price,
      qtyLots: data.quantity
    };
    const events = lob_core.processCmd(state.orderbook, cmd);
    // Process events, generate AccountInputs for trades
  }
  break;
```

### Phase 4: Trade Settlement via A-machine
When orderbook generates TRADE events:
1. Create AccountInput for bilateral settlement
2. Update reserves based on trade
3. Queue for A-machine processing

### Phase 5: Rebalancing Implementation
Port from 2019 logic:
```typescript
function rebalanceChannels(entity: EntityState) {
  // 1. Identify net-receivers (need collateral)
  const receivers = entity.accounts
    .filter(a => a.needsCollateral())
    .sort((a, b) => b.deficit - a.deficit);

  // 2. Identify net-senders (excess collateral)
  const senders = entity.accounts
    .filter(a => a.hasExcess() && a.isOnline())
    .sort((a, b) => b.excess - a.excess);

  // 3. Match and create batch
  const batch = matchAndBatch(receivers, senders);

  // 4. Submit to J-machine
  submitRebalanceBatch(batch);
}
```

### Phase 6: Clean Up Duplicates
Once lob_core is wired and tested:
1. Delete `lob.ts`, `lob2.ts`, `lob3.ts`, `lob_prod.ts`
2. Keep only `lob_core.ts` and supporting files
3. Update imports

## Testing Strategy

1. **Unit tests** for order types and matching
2. **Integration test** for full order flow:
   - Entity 1 creates market
   - Entity 2 places order
   - Match generates trade
   - Settlement updates reserves
3. **Rebalancing test**:
   - Create imbalanced accounts
   - Trigger rebalance
   - Verify collateral optimization

## Key Invariants to Maintain

- **No breaking changes** to existing J→E→A flow
- **Incremental commits** after each phase
- **Test between phases** to catch regressions
- **Keep it simple** - MVP first, optimize later

## Implementation Order

1. ✅ Fix jBlock initialization (DONE)
2. Add trading tx types
3. Wire orderbook to entity
4. Connect trade settlements
5. Implement rebalancing
6. Clean up duplicates
7. Full integration test

## Notes on lob_core.ts

The orderbook is well-designed with:
- Typed arrays for performance
- Self-trade prevention (STP)
- Time-in-force orders (GTC/IOC/FOK)
- Deterministic event hashing
- Ring buffer for event recording

Integration points:
- `init(params)` - Initialize with price range
- `processCmd(lob, cmd)` - Process order commands
- Events returned for settlement processing

## Rebalancing Algorithm (from 2019)

Key concepts:
- **Net-receivers**: Entities needing more collateral
- **Net-senders**: Entities with excess collateral
- **Pullable**: Senders who are online and responsive
- **Batching**: Combine withdrawals/deposits for efficiency

Process:
1. Calculate uninsured balances per entity
2. Sort receivers by need (largest first)
3. Find online senders with excess
4. Match and create withdrawal/deposit pairs
5. Submit batch to blockchain

Optimizations to consider:
- Time-based patterns vs point-in-time
- Asset-specific rebalance schedules
- Cross-entity insurance requests
- Minimize dispute risk