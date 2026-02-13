---
agent: claude-sonnet-4.5
feature: hub-auto-rebalance
status: clarification-needed
updated: 2026-02-13T02:30:00Z
requesting_review: [codex, gemini, @zigota]
confidence: 920/1000
---

# Understanding Check - Rebalance Policies & Fees

## 🎯 Purpose

Document my understanding of user requirements for agent audit.
Need confirmation before implementing.

---

## 📋 MY UNDERSTANDING: 3 Rebalance Policies

### Policy 1: Manual ✅ (Confident)

```typescript
mode: 'manual'

// User explicitly clicks "Request Target Collateral"
// Provides amount
// Hub executes if approved
// No automation
```

**Use case:** Power users, specific one-off needs

---

### Policy 2: Absolute Limit ✅ (Confident)

```typescript
mode: 'absolute'
config: {
  minCollateral: $5,000 USDC
  maxCollateral: $10,000 USDC
}

// Auto-rebalance when:
if (currentCollateral < minCollateral) {
  requestRebalance(minCollateral - currentCollateral)
}

if (currentCollateral > maxCollateral) {
  requestWithdrawal(currentCollateral - maxCollateral)
}
```

**Use case:** Businesses, predictable liquidity needs

---

### Policy 3: Relative Limit ⚠️ (Need Confirmation)

**My interpretation:**
```typescript
mode: 'relative'
config: {
  targetCollateralizationPercent: 80  // Keep 80% of capacity collateralized
  acceptableFeePercent: 1             // Only rebalance if fee ≤ 1% of amount
}

// Logic:
const totalCapacity = inCapacity + outCapacity
const targetCollateral = (totalCapacity × 80) / 100
const shortfall = targetCollateral - currentCollateral

const rebalanceCost = calculateCost(shortfall, numTokens, gasPrice)
const feePercent = (rebalanceCost / shortfall) × 100

// Execute only if fee is acceptable:
if (shortfall > 0 && feePercent <= acceptableFeePercent) {
  requestRebalance(shortfall)
} else {
  // Wait for shortfall to grow until fee% acceptable
  console.log(`⏸️ Deferring: fee ${feePercent}% > acceptable ${acceptableFeePercent}%`)
}
```

**Example:**
```
Target: 80% of capacity
Acceptable fee: 1%

Scenario 1 (Small drift):
- Capacity: $10k
- Target: $8k
- Current: $7.9k
- Shortfall: $100
- Cost: $5
- Fee %: $5/$100 = 5% ❌ Too expensive!
→ WAIT (let it drift to $500+ shortfall, then 1% is acceptable)

Scenario 2 (Large drift):
- Current: $7k
- Shortfall: $1,000
- Cost: $5
- Fee %: $5/$1000 = 0.5% ✅ Acceptable!
→ EXECUTE rebalance
```

**Use case:** Passive users, "set and forget", auto-management

**❓ QUESTION:** Is this interpretation correct?

---

## 💰 FEE STRUCTURE

### Fee Calculation Formula

**My understanding:**
```typescript
function calculateRebalanceCost(
  collateralAmount: bigint,    // How much collateral requested
  numTokens: number,           // How many tokens in this rebalance
  gasPrice: bigint,            // Current chain gas price
  config: HubFeeConfig
): bigint {
  // 1. Gas cost (variable)
  const GAS_PER_DELTA = 50_000n; // SSTORE + settlement overhead
  const gasWei = GAS_PER_DELTA × BigInt(numTokens) × gasPrice;
  const gasCostUSD = weiToUSD(gasWei); // Convert to USD

  // 2. Base fee (flat)
  const baseFee = config.baseFee; // e.g., $1

  // 3. Liquidity fee (% of amount)
  const liquidityFee = (collateralAmount × BigInt(config.liquidityFeeBPS)) / 10000n;
  // e.g., $1000 × 10 BPS (0.1%) = $1

  // Total
  return gasCostUSD + baseFee + liquidityFee;
}

interface HubFeeConfig {
  baseFee: bigint;           // $1 flat fee
  liquidityFeeBPS: number;   // 10 = 0.1% (configurable, can be 0)
  gasPriceSource: 'oracle' | 'static'; // How to get gas price
}
```

**❓ QUESTIONS:**

1. **Hub profitability:**
   ```
   If gasCost = $3.50, baseFee = $1, liquidityFee = $1
   → Hub pays $3.50, receives $2 → LOSS!

   Should liquidityFee be higher to cover gas?
   Or baseFee should be higher?
   Or add profit margin: totalFee = max(fees, gasCost × 1.5)?
   ```

2. **Gas cost in USD:**
   ```
   How to convert ETH gas to USD cost?
   - Oracle price feed?
   - Static config (e.g., $3500/ETH)?
   - User provides in request?
   ```

3. **Multi-token rebalance:**
   ```
   User requests:
   - $500 USDC
   - $300 USDT

   Is cost:
   A) (50k × 2 tokens × gasPrice) = shared overhead?
   B) (50k × gasPrice) × 2 = separate costs?

   I assume A (shared overhead, cheaper for multi-token)
   ```

---

## 🏗️ DATA STRUCTURES

### Entity-Level Config

```typescript
interface EntityRebalanceConfig {
  // Global default for this entity
  defaultPolicy: {
    mode: 'manual' | 'absolute' | 'relative';

    // For absolute:
    minCollateral?: bigint;
    maxCollateral?: bigint;

    // For relative:
    targetPercent?: number;        // 80 = 80% of capacity
    acceptableFeePercent?: number; // 1 = 1% max fee
  };

  // Per-account overrides
  accountPolicies: Map<string, {  // counterpartyId → policy
    mode?: 'manual' | 'absolute' | 'relative';
    minCollateral?: bigint;
    maxCollateral?: bigint;
    targetPercent?: number;
    acceptableFeePercent?: number;
  }>;

  // Per-token overrides
  tokenPolicies: Map<string, Map<number, {  // accountId → tokenId → policy
    mode?: 'manual' | 'absolute' | 'relative';
    minCollateral?: bigint;
    maxCollateral?: bigint;
    targetPercent?: number;
    acceptableFeePercent?: number;
  }>>;
}
```

### Account-Level Fees

```typescript
interface AccountRebalanceFees {
  // What I charge for rebalancing (as responder)
  myFeeBPS: {
    baseFee: bigint;           // $1 USDT flat
    liquidityFeeBPS: number;   // 10 = 0.1%
  };

  // What they charge (from gossip)
  theirFeeBPS: {
    baseFee: bigint;
    liquidityFeeBPS: number;
  };

  // Fee denomination
  feeDenominationTokenId: number; // 1 = USDT
}

// Add to AccountMachine:
interface AccountMachine {
  ...
  rebalanceFees: AccountRebalanceFees;
}
```

### Gossip Broadcasting

```typescript
// Each entity gossips their rebalance fees
interface GossipProfile {
  metadata: {
    ...
    rebalanceFee: {
      baseFee: string;         // "$1" in USDT
      liquidityFeeBPS: number; // 10 = 0.1%
      minAmount: string;       // "$100" minimum
      maxAmount: string;       // "$100,000" maximum
    };
  };
}
```

---

## 🔄 Fee Resolution

**When Alice requests rebalance from Hub:**

```typescript
// 1. Get Hub's published fee (from gossip)
const hubProfile = getProfile(hub.entityId);
const hubFee = hubProfile.metadata.rebalanceFee;

// 2. Calculate cost
const amount = $1,000 USDC;
const numTokens = 1;
const gasPrice = getCurrentGasPrice();

const cost = calculateRebalanceCost(amount, numTokens, gasPrice, hubFee);
// Returns: $1,005.25

// 3. Check Alice's policy
const policy = getPolicy(alice.entityId, hub.entityId, tokenId);

if (policy.mode === 'relative') {
  const feePercent = (cost - amount) / amount × 100;
  // $5.25 / $1000 = 0.525%

  if (feePercent > policy.acceptableFeePercent) {
    // Too expensive, defer
    return 'DEFERRED';
  }
}

// 4. Alice pays Hub's fee (not her own!)
// Requester pays responder's published rate
```

---

## ❓ QUESTIONS FOR REVIEW

### @codex - Security & Determinism

1. **Gas price in formula:**
   - Can crontab read current gas price? (You said no before)
   - Should fee be static config instead?
   - Or calculated outside consensus, stored in state?

2. **Fee payment:**
   - How to deduct fee from user reserve (deterministic)?
   - Settlement diffs for fee transfer?
   - Or separate R2R transaction?

3. **Profit margin:**
   - Formula ensures hub profits? (cost > gas × 1.5)
   - Or can hub lose money on small rebalances?

### @gemini - Architecture

1. **Hierarchical config:**
   - Entity → Account → Token override pattern OK?
   - Better alternative?

2. **Policy complexity:**
   - 3 modes too many? Start with 2?
   - Relative policy well-designed?

3. **Fee structure:**
   - baseFee + liquidityFee sufficient?
   - Missing any cost components?

### @zigota - Requirements

1. **Liquidity fee:**
   - 0.1% of amount correct?
   - Or should be dynamic (higher when hub reserves low)?

2. **Profit margin:**
   - Should formula guarantee hub profit?
   - Or OK if hub loses on small rebalances?

3. **Multi-token:**
   - Gas cost shared or per-token?
   - Liquidity fee per-token or total?

4. **Relative policy:**
   - My interpretation correct?
   - Target% of capacity + acceptable fee% threshold?

---

## 🎯 CONFIDENCE BREAKDOWN

| Aspect | Confidence | Blocker? |
|--------|------------|----------|
| Policy 1 (Manual) | 1000/1000 | No |
| Policy 2 (Absolute) | 990/1000 | No |
| Policy 3 (Relative) | 850/1000 | Need confirmation |
| Fee formula | 820/1000 | Need gas price solution |
| Hierarchical config | 980/1000 | No |
| Hub profitability | 750/1000 | Need confirmation |

**Overall: 920/1000**

**Blockers:**
- Clarify relative policy mechanism
- Resolve gas price determinism
- Confirm fee math (hub profitable?)

---

## 🚀 NEXT STEPS

**After agent review:**
1. Address any misunderstandings
2. Revise fee formula if needed
3. Create final implementation plan
4. Build it!

**Estimated time after clarifications:** 4-5 hours

---

**Requesting review from @codex, @gemini, @zigota**

**Ready for feedback!** 🎯
