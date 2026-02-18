# Why EVM? (Technical Constraint, Not Preference)

**XLN requires EVM because FIFO debt enforcement is mathematically impossible on UTXO chains.**

This is not "we chose EVM" - this is "only EVM-class VMs can execute the required primitive."

This document proves why UTXO, Solana, and other designs CANNOT support XLN's core settlement mechanism.

---

## TL;DR

**XLN requires:**
- Mutable storage (FIFO debt queues)
- Turing-complete loops (enforceDebts iteration)
- Atomic multi-entity state updates (settle)
- Programmable subcontracts (delta transformers)

**EVM provides all of these. UTXO provides none.**

---

## The FIFO Enforcement Problem

XLN's trustless credit system depends on **mechanical debt repayment**. When an entity receives funds, debts are paid in strict FIFO order:

```solidity
function enforceDebts(bytes32 entity, uint tokenId) public returns (uint totalDebts) {
    uint debtsLength = _debts[entity][tokenId].length;
    if (debtsLength == 0) return 0;

    uint memoryReserve = _reserves[entity][tokenId];
    uint memoryDebtIndex = _debtIndex[entity][tokenId];

    while (true) {
        Debt storage debt = _debts[entity][tokenId][memoryDebtIndex];

        if (memoryReserve >= debt.amount) {
            // PAY DEBT IN FULL
            memoryReserve -= debt.amount;
            _reserves[debt.creditor][tokenId] += debt.amount;
            delete _debts[entity][tokenId][memoryDebtIndex];

            if (memoryDebtIndex + 1 == debtsLength) {
                memoryDebtIndex = 0;
                delete _debts[entity][tokenId];
                break;
            }
            memoryDebtIndex++;
        } else {
            // PARTIAL PAYMENT - UPDATE DEBT AMOUNT
            _reserves[debt.creditor][tokenId] += memoryReserve;
            debt.amount -= memoryReserve; // MUTABLE UPDATE
            memoryReserve = 0;
            break;
        }
    }

    _debtIndex[entity][tokenId] = memoryDebtIndex;
    _reserves[entity][tokenId] = memoryReserve;
}
```

### Why This Matters

This function:
1. **Mutates debt amounts** (`debt.amount -= memoryReserve`) mid-execution
2. **Iterates dynamically** (while loop until reserve depleted)
3. **Updates multiple entities atomically** (creditor reserves + debtor index)
4. **Maintains sequential state** (debt index across transactions)

**None of these operations work in UTXO or non-Turing-complete VMs.**

---

## Why UTXO Chains Can't Support XLN

### Bitcoin, Cardano, Ergo, etc.

**UTXO Model Constraints:**

```
UTXO Transaction:
├─ Inputs: List of unspent outputs (immutable)
├─ Outputs: New outputs created (fixed at signing)
└─ Script: Validation logic (no loops, no external state)

To update a balance:
1. Consume entire UTXO
2. Create new UTXO with new amount
3. Sign transaction binding inputs to outputs

This is fundamentally incompatible with:
❌ Dynamic debt queues (can't iterate over variable-length arrays)
❌ Partial payments (can't update debt amount mid-execution)
❌ Multi-entity atomicity (each UTXO is independent)
❌ Sequential processing (no global debt index)
```

### Specific Failures

**1. No Mutable Storage**
```solidity
// XLN needs this:
debt.amount -= memoryReserve; // Update existing debt

// UTXO can only do this:
// Consume old debt UTXO, create new debt UTXO
// But: Can't do this in a loop with unknown iteration count
```

**2. No Turing-Complete Loops**
```solidity
// XLN needs this:
while (reserve > 0 && debts.length > index) {
    // Process next debt
}

// Bitcoin Script:
// OP_IF, OP_ELSE allowed
// Loops: FORBIDDEN (prevents halting problem)
```

**3. No Atomic Multi-Entity Updates**
```solidity
// XLN needs this:
_reserves[debtor][tokenId] -= amount;
_reserves[creditor][tokenId] += amount;
// Both updates succeed or both fail

// UTXO:
// Each entity's balance is a separate UTXO
// Can't atomically update multiple UTXOs in single script
```

**Could You Build "XLN-Lite" on UTXO?**

**NO.** Removing any of these features breaks the core primitive:
- No mutable debts → No partial payments → Credit system collapses
- No loops → No FIFO enforcement → Liquidity trap breaks
- No atomicity → Double-spend risk → Trustless settlement breaks

---

## Why Solana Doesn't Fit

Solana has **account-based state** (like EVM), so technically it COULD support XLN's logic. But:

### Architectural Mismatches

**1. Parallel Execution Model**
```rust
// Solana's concurrent transaction processing
// CONFLICTS with XLN's sequential debt processing

Solana: Process 50,000 TPS in parallel
XLN: Debts MUST be processed in strict FIFO order

// Race condition:
// Thread 1: Process debt #5 (reserve = 100)
// Thread 2: Process debt #6 (reserve = 100)
// Both think they can pay, but only one should succeed

// XLN requires SERIALIZED execution per entity
```

**2. Account Rent**
```rust
// Solana charges rent for account storage
// XLN debt queues grow unbounded during liquidity traps

// Example:
// Entity with 1000 unpaid debts
// Solana: Pay rent on 1000 Debt structs (expensive)
// EVM: Storage cost paid once at debt creation
```

**3. Ecosystem Mismatch**
```
Solana targets:
- High-frequency trading (orderbooks)
- NFT minting (parallelizable)
- Gaming (real-time state)

XLN targets:
- CBDC settlement (sequential debts)
- Corporate treasury (atomic multi-asset)
- Cross-border trade (programmable terms)

Different optimization targets = wrong substrate
```

**Could Solana Work With Modifications?**

Maybe, but you'd need:
- ✅ Serialize debt enforcement (loses Solana's parallelism advantage)
- ✅ Rewrite rent model (significant protocol change)
- ✅ Port all subcontracts (fragmented ecosystem)

At which point... why not just use EVM where 90% of DeFi already is?

---

## Why Other Designs Don't Fit

### Move VM (Aptos, Sui)

**Pros:**
- ✅ Account-based state
- ✅ Turing-complete
- ✅ Resource-oriented (good for asset safety)

**Cons:**
- ❌ Immature ecosystem (no CBDC adoption)
- ❌ Resource model conflicts with mutable debts
- ❌ No cross-chain bridges to EVM CBDCs (when they launch)

**Verdict:** Technically possible, strategically irrelevant.

### CosmWasm (Cosmos)

**Pros:**
- ✅ Account-based
- ✅ Turing-complete (Rust/Wasm)
- ✅ IBC for cross-chain

**Cons:**
- ❌ Fragmented liquidity across app-chains
- ❌ No major CBDC commitments
- ❌ Complex state migration for multi-chain debts

**Verdict:** Possible but over-engineered for XLN's needs.

### Tezos, Algorand, etc.

Same analysis: Technically capable, strategically wrong bet.

---

## The CBDC Reality

### Why EVM Won

```
Central Bank Requirements for CBDCs:
├─ Programmability (smart contracts)
├─ Privacy (selective disclosure)
├─ Compliance (KYC/AML/sanctions)
├─ Interoperability (cross-border settlement)
└─ Battle-tested security (billions at risk)

Ethereum:
✅ 10 years of security audits
✅ $200B+ TVL (proven at scale)
✅ USDC, USDT already using ERC20 standard
✅ Every major bank has EVM devs on staff
✅ Regulatory clarity (Howey test, securities law)

Other chains:
❌ Less mature (higher risk)
❌ Smaller dev ecosystem
❌ Uncertain regulatory status
❌ No institutional adoption yet
```

### Inevitable Convergence

```
2024: Stablecoins standardize on EVM (USDC, USDT)
2025: Major banks deploy EVM-based pilots (JPM Coin, etc.)
2026: First G20 CBDC launches on EVM-compatible chain
2027: Network effects lock in EVM as CBDC standard
2028+: XLN becomes settlement layer for EVM CBDCs

Other chains become irrelevant for MAINSTREAM finance.
(They'll survive for niche use cases: Bitcoin = SoV, Solana = gaming)
```

---

## Future Interoperability: Adapters

**XLN is EVM-native. But it can BRIDGE to other ecosystems.**

### Adapter Pattern

```
┌─────────────────────────────────────────┐
│ XLN Core (EVM)                          │
│ ├─ Depository.sol                       │
│ ├─ EntityProvider.sol                   │
│ └─ SubcontractProvider.sol              │
└─────────────────────────────────────────┘
         │
         ├─ EVM Adapter (native)
         │   └─ Ethereum, Polygon, Arbitrum, etc.
         │
         ├─ UTXO Adapter (bridge)
         │   ├─ Wrapped BTC (WBTC on EVM)
         │   ├─ Cross-chain swap (HTLC)
         │   └─ Final settlement on Bitcoin L1
         │
         ├─ Solana Adapter (bridge)
         │   ├─ Wormhole bridge to EVM
         │   ├─ Serialize debts on Solana side
         │   └─ Anchor final state on Solana
         │
         └─ Cosmos Adapter (IBC bridge)
             ├─ CosmWasm contract on Cosmos
             ├─ IBC packets to EVM hub
             └─ Bilateral accounts span chains
```

### Example: Bitcoin Integration

```
Alice (EVM entity) ↔ Bob (Bitcoin UTXO holder)

Adapter Flow:
1. Bob locks BTC in HTLC (Bitcoin L1)
2. Adapter mints wrapped BTC on EVM
3. Alice ↔ Bob bilateral account (EVM side)
4. Off-chain settlement via XLN (instant)
5. Final anchor: Periodic HTLC claims on Bitcoin

Result:
✅ Bob uses Bitcoin
✅ Alice uses EVM
✅ Settlement happens on XLN (EVM)
✅ Final proof on Bitcoin (if needed)
```

### Why Adapters, Not Native Support?

**Design Philosophy:**
```
Core XLN: EVM-only (optimize for 80% use case)
Adapters: Bridge to other chains (handle 20% edge cases)

Benefits:
✅ Simple core (easier to audit, maintain)
✅ Flexible edges (add adapters as needed)
✅ Clear responsibility (EVM = source of truth)
```

**Analogy:**
```
XLN : EVM  ::  Linux : x86

Linux is optimized for x86.
But runs on ARM via emulation/adapters.

XLN is optimized for EVM.
But supports UTXO via bridges/adapters.
```

---

## Conclusion

**XLN is EVM-native because:**

1. **Technical necessity** - FIFO debts require mutable state + loops
2. **Strategic inevitability** - CBDCs will standardize on EVM
3. **Ecosystem maturity** - 90% of DeFi is already on EVM

**Other chains are not supported natively because:**

1. UTXO: Fundamentally incompatible (no mutable state)
2. Solana: Wrong optimization target (parallel vs sequential)
3. Move/Cosmos: Technically possible, strategically irrelevant

**But future adapters can bridge XLN to any chain:**

- UTXO chains via wrapped tokens + HTLCs
- Solana via Wormhole + serialized debts
- Cosmos via IBC + cross-chain anchors

**The core stays EVM. The edges stay flexible.**

This is not a limitation. It's a design principle.

---

## References

- [FIFO Debt Enforcement](/docs/readme.md#rcpe-primitive)
- [J-Machine Architecture](/docs/jea.md)
- [Prior Art: Why Not Lightning?](/docs/priorart.md)
- [Depository.sol Implementation](/jurisdictions/contracts/Depository.sol)
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
if (!demoJurisdiction) {
  demoJurisdiction = {
    name: 'Demo (BrowserVM)',
    chainId: 31337,
    entityProviderAddress: '0x5FbDB...',
    depositoryAddress: '0xe7f17...',
    // For production: use Base L2
    // rpc: 'https://sepolia.base.org' (chainId: 84532)
    // rpc: 'https://mainnet.base.org' (chainId: 8453)
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
