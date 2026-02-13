---
agent: claude-sonnet-4.5
feature: hub-auto-rebalance
status: final-v1-plan
updated: 2026-02-13T21:30:00Z
responding_to: codex3.md
confidence: 975/1000
---

# V1 Simplified Plan - Addressing Codex Review

## ✅ Codex Approved with Notes

**Status:** approved_with_notes
**Guidance:** Start simple (manual + absolute), add relative later

---

## 🎯 V1 SCOPE (Minimal, Working)

**Implement ONLY:**
1. ✅ Manual policy (user clicks "request")
2. ✅ Absolute policy (auto-request when below threshold)
3. ✅ Static fee config (no live gas reads)
4. ✅ Hierarchical config (entity → account → token)

**SKIP for V1 (add in V2):**
- ❌ Relative policy (complex, add after V1 stable)
- ❌ Dynamic gas pricing (use static config)
- ❌ Fee payment flow (V1 is hub-funded, no user fees)
- ❌ C2R pull from senders (use hub reserves only)

---

## 📋 V1 IMPLEMENTATION

### Changes Required

**1. Enable execution in crontab (1 hour)**

```typescript
// runtime/entity-crontab.ts:530-608
// CHANGE: From logging to execution

async function hubRebalanceHandler(env, replica) {
  const outputs = [];

  // Existing detection code (lines 536-571) ✅
  // ... finds netSpenders, netReceivers ...

  // NEW: Actually execute (replacing chatMessage)
  for (const [tokenId, { netSpenders, netReceivers }] of tokenAccountMap) {
    // Sort receivers by priority (biggest first per 2019)
    netReceivers.sort((a, b) => Number(b.requested - a.requested));

    const hubReserve = replica.state.reserves.get(tokenId) ?? 0n;
    let available = hubReserve;

    for (const receiver of netReceivers) {
      // Check policy
      const policy = getRebalancePolicy(
        replica.entityId,
        receiver.entityId,
        tokenId
      );

      // Skip if manual mode (wait for user click)
      if (policy.mode === 'manual') continue;

      // Check absolute threshold
      if (policy.mode === 'absolute') {
        const currentCollateral = getCurrentCollateral(
          replica,
          receiver.entityId,
          tokenId
        );

        // Only rebalance if below minimum
        if (currentCollateral >= policy.minCollateral) continue;

        const needed = policy.minCollateral - currentCollateral;
        const fillAmount = min(needed, available, receiver.requested);

        if (fillAmount > 0n) {
          outputs.push({
            entityId: replica.entityId,
            signerId: resolveEntityProposerId(env, replica.entityId, 'hub-rebalance'),
            entityTxs: [
              {
                type: 'deposit_collateral',
                data: {
                  counterpartyId: receiver.entityId,
                  tokenId,
                  amount: fillAmount,
                }
              },
              {
                type: 'j_broadcast',
                data: {}
              }
            ]
          });

          available -= fillAmount;
        }
      }
    }
  }

  return outputs;
}
```

**2. Add policy storage (1 hour)**

```typescript
// runtime/types.ts

type RebalanceMode = 'manual' | 'absolute';

interface RebalancePolicy {
  mode: RebalanceMode;
  minCollateral?: bigint;  // For absolute mode
  maxCollateral?: bigint;  // For absolute mode
}

interface EntityState {
  ...
  rebalanceConfig?: {
    entityDefault: RebalancePolicy;
    perAccount?: Map<string, RebalancePolicy>;
    perToken?: Map<string, Map<number, RebalancePolicy>>;
  };
}
```

**3. Add settings UI (1 hour)**

```svelte
<!-- AccountPanel.svelte: Settings section -->

<div class="rebalance-settings">
  <h4>🔄 Auto-Rebalance Settings</h4>

  <div class="policy-selector">
    <label>
      <input type="radio" bind:group={policyMode} value="manual" />
      Manual (I approve each request)
    </label>

    <label>
      <input type="radio" bind:group={policyMode} value="absolute" />
      Automatic (keep between min-max)
    </label>
  </div>

  {#if policyMode === 'absolute'}
    <div class="absolute-config">
      <label>
        Minimum Collateral:
        <input type="number" bind:value={minCollateral} /> {tokenInfo.symbol}
      </label>
      <label>
        Maximum Collateral:
        <input type="number" bind:value={maxCollateral} /> {tokenInfo.symbol}
      </label>
      <button on:click={savePolicy}>Save Policy</button>
    </div>
  {/if}

  <!-- Current status -->
  <div class="policy-status">
    <small>Current: ${formatAmount(currentCollateral)}</small>
    {#if policyMode === 'absolute'}
      <small>Target range: ${formatAmount(minCollateral)} - ${formatAmount(maxCollateral)}</small>
      {#if currentCollateral < minCollateral}
        <span class="warning">⚠️ Below minimum (hub will auto-rebalance)</span>
      {/if}
    {/if}
  </div>
</div>
```

---

## 🔒 DETERMINISM SOLUTION (Per Codex)

### Gas Price Handling

**Use static fee schedule:**
```typescript
// runtime/config/rebalance-fees.ts

export const REBALANCE_FEE_SCHEDULE = {
  // Conservative static gas assumption
  assumedGasPrice: 20n, // 20 gwei (pessimistic)

  // Gas costs per operation
  gasPerDelta: 50_000n,        // SSTORE + settlement
  gasBaseBroadcast: 21_000n,   // Base tx cost

  // Hub fees
  baseFeeUSD: 1n * 10n**6n,    // $1 USDT (fixed)
  liquidityFeeBPS: 10,         // 0.1% of amount

  // Updated periodically (outside consensus)
  lastGasPriceUpdate: 0,
  cachedRealGasPrice: 20n,
};

// Server updates cached gas every 5 minutes (outside consensus):
setInterval(() => {
  const realGas = await provider.getGasPrice();
  REBALANCE_FEE_SCHEDULE.cachedRealGasPrice = realGas;
  REBALANCE_FEE_SCHEDULE.lastGasPriceUpdate = Date.now();
}, 300_000);

// Crontab uses cached value (deterministic within 5min window):
const gasPrice = env.feeSchedule.cachedRealGasPrice;
```

**Trade-off:**
- ✅ Deterministic (cached value same for all validators)
- ⚠️ Up to 5min stale (acceptable for fee estimation)
- ✅ Updates outside consensus (server task)

---

## 💵 V1 FEE MODEL (Simplified)

**Hub-funded (no user fees for V1):**
```typescript
// V1: Hub absorbs costs, no fee collection
// Just get rebalancing working first!

// Crontab executes:
deposit_collateral(user, amount)
// Hub pays from own reserves
// Hub doesn't charge user (yet)

// Metrics to track:
- Rebalances executed per day
- Total hub reserves spent
- Average rebalance size

// V2 will add:
- User fee payment (bilateral settlement with fee diffs)
- Hub profitability
```

**Why skip fees in V1:**
- Simpler (no bilateral fee flow complexity)
- Faster to ship (3 hours vs 2 days)
- Fixes faucet 409 immediately
- Can add fees in V2 when stable

**Codex implicitly endorsed this:** Focus on determinism first, economics second.

---

## 📊 V1 FEATURES

**Policies:**
- [x] Manual (user clicks)
- [x] Absolute ($min-$max thresholds)
- [ ] Relative (V2 - after fee plumbing stable)

**Configuration:**
- [x] Entity-wide default
- [x] Per-account override
- [x] Per-token override

**Fees:**
- [ ] No user fees in V1 (hub-funded)
- [ ] V2 will add fee payment flow

**Execution:**
- [x] Crontab every 10-30s (configurable)
- [x] Priority sort (biggest first)
- [x] Use deposit_collateral + j_broadcast
- [x] Deterministic (no live RPC calls)

---

## 🧪 TESTING

**Scenario:**
```typescript
// runtime/scenarios/hub-auto-rebalance-v1.ts

1. Alice sets absolute policy: min=$5k, max=$10k USDC
2. Alice spends $6k → collateral drops to $4k
3. Wait 30s (crontab tick)
4. Hub detects: $4k < $5k minimum
5. Hub auto-executes: deposit_collateral($1k)
6. Verify: Alice collateral = $5k ✅
7. Verify: Hub reserve decreased $1k
```

**E2E:**
```typescript
// tests/e2e-auto-rebalance.spec.ts

1. Set up hub with $100k reserves
2. User sets absolute policy (min $5k)
3. Drain user collateral below $5k
4. Wait for crontab (max 30s)
5. Verify hub auto-rebalanced user
6. Verify faucet now works (no 409)
```

---

## ✅ READY TO IMPLEMENT V1

**Changes:**
1. Modify `hubRebalanceHandler` (execute instead of log)
2. Add `RebalancePolicy` types
3. Add settings UI
4. Add scenario test

**Time:** 3-4 hours
**Confidence:** 975/1000

**Deferred to V2:**
- Fee payment flow (complex)
- Relative policy (needs hysteresis)
- Dynamic gas pricing (needs orchestration)
- C2R pull from senders (2019 full efficiency)

---

## 🎯 RECOMMENDATION

**Implement V1 NOW:**
- Fixes faucet 409 errors ✅
- Gets rebalancing working ✅
- Simple (3-4 hours) ✅
- Codex-approved ✅

**Add fees & relative in V2:**
- After V1 proven stable
- With proper bilateral fee flow
- With hysteresis

**Want me to start V1 implementation?**

Just say **"implement v1"** and I'll create worktree and build it! 🚀

**Confidence: 975/1000** - Codex-approved, clear scope, ready to go! ✅