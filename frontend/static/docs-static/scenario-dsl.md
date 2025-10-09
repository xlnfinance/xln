# Scenario DSL Specification

## On-Chain Primitives

### Reserve Operations

```
# Reserve-to-Reserve (direct entity transfer)
r2r <from> <to> <amount> [tokenId]
r2r 1 2 100000          # Entity 1 sends 100k reserves to Entity 2 (token 1)
r2r 1 2 50000 2         # Entity 1 sends 50k USDC reserves to Entity 2

# Reserve-to-Collateral (fund bilateral account)
r2c <entity> <counterparty> <amount> [tokenId]
r2c 1 2 100000          # Entity 1 funds 100k into collateral with Entity 2
r2c 1 2 50000 2         # Using USDC

# Collateral-to-Reserve (withdraw from bilateral account)
c2r <entity> <counterparty> <amount> [tokenId]
c2r 1 2 50000           # Entity 1 withdraws 50k from collateral back to reserve
```

### External Token Operations

```
# External-Token-to-Reserve (import from wallet)
et2r <entity> <amount> <tokenAddress> [tokenId]
et2r 1 1000000 0x... 2  # Entity 1 imports 1M USDC from external wallet

# Reserve-to-External-Token (withdraw to wallet)
r2et <entity> <amount> <recipientAddress> [tokenId]
r2et 1 500000 0x... 2   # Entity 1 withdraws 500k USDC to external address
```

### Batch Operations

```
# Batch settlement (multiple operations atomically)
batch <entity> {
  r2c 2 100000          # Fund 100k to collateral with entity 2
  r2c 3 50000           # Fund 50k to collateral with entity 3
  c2r 4 25000           # Withdraw 25k from collateral with entity 4
}

# Example: Hub rebalancing
batch 5 {
  c2r 1 100000          # Withdraw from user 1
  c2r 2 100000          # Withdraw from user 2
  r2c 6 200000          # Fund into account with hub 6
}
```

## Implementation Mapping

### EntityTx Types

```typescript
// New EntityTx types to add:

type EntityTx =
  | { type: 'r2r'; data: { toEntity: string; tokenId: number; amount: bigint } }
  | { type: 'r2c'; data: { counterparty: string; tokenId: number; amount: bigint } }
  | { type: 'c2r'; data: { counterparty: string; tokenId: number; amount: bigint } }
  | { type: 'et2r'; data: { tokenAddress: string; amount: bigint; internalTokenId?: number } }
  | { type: 'r2et'; data: { recipient: string; tokenId: number; amount: bigint } }
  | { type: 'batch_settle'; data: { operations: SettleOp[] } }
```

### Handler Flow

```
Scenario: r2c 1 2 100000
  ↓
EntityTx: { type: 'r2c', data: { counterparty: '0x...02', tokenId: 1, amount: 100000n } }
  ↓
Handler (entity-tx/handlers/settle.ts):
  - Validate invariant: -100000 + 0 + 100000 = 0 ✓
  - Call Depository.settle(entity1, entity2, [{tokenId:1, leftDiff:-100000, rightDiff:0, collateralDiff:100000, ondeltaDiff:0}])
  ↓
Depository emits: SettlementProcessed(entity1, entity2, 1, ...)
  ↓
J-Watcher catches event:
  - Creates AccountTx: { type: 'account_settle', data: { tokenId:1, collateralDiff:100000 } }
  ↓
Bilateral consensus processes settlement
  ↓
Both sides update collateral += 100000
```

## Scenario Parser Extensions

```typescript
// Add to parseAction() in scenario-executor.ts

if (parts[0] === 'r2r') {
  const [_, from, to, amount, tokenId = '1'] = parts;
  return {
    type: 'r2r',
    entityId: parseInt(from),
    data: {
      toEntity: parseInt(to),
      tokenId: parseInt(tokenId),
      amount: BigInt(amount)
    }
  };
}

if (parts[0] === 'r2c') {
  const [_, entity, counterparty, amount, tokenId = '1'] = parts;
  return {
    type: 'r2c',
    entityId: parseInt(entity),
    data: {
      counterparty: parseInt(counterparty),
      tokenId: parseInt(tokenId),
      amount: BigInt(amount)
    }
  };
}

// Similar for c2r, et2r, r2et...
```

## Example Extended Scenario

```
LIQUIDITY REBALANCING DEMO

===

t=0
title: setup
description: 3 entities with reserves

import 1 2 3
r2r 1 1 1000000    # Fund entity 1 with 1M
r2r 2 2 1000000    # Fund entity 2 with 1M
r2r 3 3 500000     # Fund entity 3 with 500k

===

t=2
title: collateral funding
description: entities fund bilateral accounts

openAccount 1 2
openAccount 2 3
r2c 1 2 100000     # Entity 1 funds 100k into account with 2
r2c 2 3 150000     # Entity 2 funds 150k into account with 3

===

t=4
title: multi-hop payment
description: entity 1 pays entity 3 through entity 2

pay 1 3 50000

===

t=6
title: rebalancing
description: hub entity 2 rebalances collateral

batch 2 {
  c2r 1 25000      # Withdraw from account 1-2
  r2c 3 25000      # Add to account 2-3
}

===

t=8
title: settlement
description: entity 3 withdraws to external wallet

c2r 3 2 50000      # Withdraw collateral
r2et 3 50000 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
```

## Implementation Files Needed

1. **src/entity-tx/handlers/reserve-ops.ts** - r2r, et2r, r2et handlers
2. **src/entity-tx/handlers/settle-ops.ts** - r2c, c2r, batch handlers
3. **src/scenario-executor.ts** - Extend parser for new primitives
4. **src/types.ts** - Add new EntityTx variants

## Priority

**P0 (Essential for demos):**
- r2c (reserve → collateral funding)
- c2r (collateral → reserve withdrawal)
- r2r (direct reserve transfers)

**P1 (Nice to have):**
- et2r (import external tokens)
- r2et (withdraw to wallet)
- batch (atomic multi-operation)

**Estimated effort:** ~3-4 hours for P0 primitives
