# Jurisdiction Requirement

**CRITICAL ARCHITECTURAL INVARIANT:**

> You cannot create entities without a jurisdiction (J-Machine).

## Why?

**All bilateral accounts are disputed/settled on-chain via Depository.sol:**
- `Depository.sol` lives inside a jurisdiction (EVM instance)
- Entity creation calls `EntityProvider.sol` (also in jurisdiction)
- Reserve/Collateral operations are on-chain transactions

**J-Machine = EVM instance** (local Hardhat, or Ethereum mainnet, or any EVM chain)

## For Demos/Tutorials:

When no J-Machine exists (e.g., `/view` isolated mode), tutorials auto-create a **mock jurisdiction**:

```typescript
// In prepopulate-ahb.ts
if (!arrakis) {
  arrakis = {
    name: 'Arrakis (Demo)',
    chainId: 31337,
    entityProviderAddress: '0x5FbDB...',
    depositoryAddress: '0xe7f17...',
    rpc: 'http://localhost:8545'
  };
}
```

This allows tutorials to run without requiring user to manually deploy contracts.

## UX Flow:

```
User opens /view
  → Architect → Economy
  → Sees: "⚠️ No J-Machine - Tutorials will create demo jurisdiction"
  → Clicks: "Start Tutorial"
  → Mock jurisdiction created automatically
  → Tutorial runs!
```

**Production Flow:**
```
User creates real J-Machine (Hardhat/Mainnet)
  → Deploys EntityProvider.sol + Depository.sol
  → Creates entities via blockchain
  → Entities can now open accounts + dispute on-chain
```

## Memory:

- J-Machine = prerequisite for entities
- Tutorials bypass this with mock jurisdictions
- Production requires real EVM deployment
