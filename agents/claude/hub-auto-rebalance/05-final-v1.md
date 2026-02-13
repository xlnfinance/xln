---
agent: claude-sonnet-4.5
feature: hub-auto-rebalance
status: ready-to-implement
updated: 2026-02-13T22:00:00Z
incorporating: [codex3.md, gemini2.md, user-final-requirements]
confidence: 990/1000
---

# Final V1: Ultra-Simplified Rebalancing

## ✅ AGENT CONSENSUS + USER REQUIREMENTS

**Both agents approved:** Codex (approved_with_notes) + Gemini (980/1000)

**Guidance:** Maximum simplification for V1

---

## 🎯 V1 SCOPE (Final)

### Policies (2 modes only)

**1. Manual:**
```typescript
mode: 'manual'

// User explicitly clicks "Request Rebalance"
// Or sends directPayment with message
```

**2. Absolute:**
```typescript
mode: 'absolute'
config: {
  softLimit: $500,   // Auto-trigger when below this
  hardLimit: $10,000 // Never exceed this
}

// Crontab (every 30s):
if (currentCollateral < softLimit) {
  requestRebalance(softLimit - currentCollateral)
}

// Special case: If softLimit == hardLimit
// → Effectively manual mode (no auto-trigger zone)
```

**Defaults (per user requirement):**
```typescript
DEFAULT_HARD_LIMIT = 10_000n * 10n**18n  // $10k
DEFAULT_SOFT_LIMIT = 500n * 10n**18n     // $500

// After 5+ faucets (~$500 received):
// → Hits soft limit
// → Auto-rebalances to $500 collateral
// → User sees green collateral bar ✅
```

---

## 💰 FEE PAYMENT (2 Options)

### Option A: directPayment (User's suggestion)

```typescript
// User sends payment to hub with memo:
{
  type: 'directPayment',
  data: {
    recipientEntityId: hubEntityId,
    tokenId: 1, // USDT (reference token)
    amount: 5n * 10n**6n, // $5 fee
    description: "Rebalance fee: please collateralize USDC to $5000"
  }
}

// Hub sees payment + description:
// → Parses: "collateralize USDC to $5000"
// → Executes rebalance (deposit_collateral)
// → Hub already received $5 fee ✅
```

**Pros:**
- ✅ Simple (just directPayment, no settlement complexity)
- ✅ User chooses payment token (USDT, or offdelta in another token)
- ✅ Explicit (user sees fee payment separate from rebalance)

**Cons:**
- ⚠️ Requires parsing description (fragile)
- ⚠️ Two separate transactions (payment, then rebalance)

### Option B: Settlement Diff (Gemini's suggestion)

```typescript
// Single settlement with 2 diffs:
settlement = {
  diffs: [
    // Fee payment (USDT)
    {
      tokenId: 1, // USDT
      leftDiff: -5n * 10n**6n,  // User pays $5
      rightDiff: +5n * 10n**6n, // Hub receives $5
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    },
    // Actual rebalance (USDC)
    {
      tokenId: 2, // USDC
      leftDiff: -5000n * 10n**18n,     // Hub reserve decreases
      rightDiff: 0n,
      collateralDiff: +5000n * 10n**18n, // User collateral increases
      ondeltaDiff: 0n,
    }
  ]
}
```

**Pros:**
- ✅ Atomic (fee + rebalance in one tx)
- ✅ Clean (no description parsing)
- ✅ Efficient (one on-chain tx)

**Cons:**
- ⚠️ More complex (settlement workspace flow)

**My recommendation:** **Start with Option A (directPayment)**, add Option B in V2

**Why:**
- Simpler to implement
- User's suggestion (they understand the UX)
- Can pay with any token (flexible)

---

## 🎨 UI REQUIREMENTS

### 1. Symmetric Display

**Current:** Settings might only show "my" side
**New:** Show BOTH sides symmetrically

```svelte
<div class="bilateral-settings">
  <div class="side left-side">
    <h5>My Settings</h5>
    <label>Soft Limit: <input bind:value={mySoftLimit} /> USDC</label>
    <label>Hard Limit: <input bind:value={myHardLimit} /> USDC</label>
  </div>

  <div class="divider">↔</div>

  <div class="side right-side">
    <h5>Their Settings</h5>
    <div class="readonly">
      <span>Soft Limit: {theirSoftLimit} USDC</span>
      <span>Hard Limit: {theirHardLimit} USDC</span>
    </div>
  </div>
</div>
```

**Shows:** Both parties' limits side-by-side (symmetrical)

### 2. Per-Delta Settings

**Not just per-account, but per-token in that account:**

```svelte
{#each tokenDeltas as td}
  <div class="token-settings">
    <h5>{td.tokenInfo.symbol} Settings</h5>

    <label>Soft Limit: <input bind:value={softLimits[td.tokenId]} /></label>
    <label>Hard Limit: <input bind:value={hardLimits[td.tokenId]} /></label>

    {#if softLimits[td.tokenId] === hardLimits[td.tokenId]}
      <small class="info">⚠️ Manual mode (soft == hard, no auto-rebalance)</small>
    {:else}
      <small class="info">✓ Auto mode (triggers at ${softLimits[td.tokenId]})</small>
    {/if}
  </div>
{/each}
```

### 3. Animated Stripes (Pending Collateralization)

**Visual feedback on unsecured credit:**

```svelte
<div
  class="bar-segment unused-credit"
  class:pending-collateral={currentCollateral < softLimit}
  style="width: {unusedCreditPercent}%"
></div>
```

**CSS:**
```css
.bar-segment.unused-credit {
  background: linear-gradient(90deg, #ec4899, #db2777);
}

/* Animated stripes when pending rebalancing */
.bar-segment.unused-credit.pending-collateral {
  background:
    repeating-linear-gradient(
      45deg,
      #ec4899,
      #ec4899 10px,
      #db2777 10px,
      #db2777 20px
    );
  background-size: 200% 200%;
  animation: moveStripes 2s linear infinite;
}

@keyframes moveStripes {
  0% { background-position: 0% 0%; }
  100% { background-position: 100% 100%; }
}

/* Tooltip explains */
.bar-segment.unused-credit.pending-collateral::after {
  content: '⏳ Rebalancing soon...';
  /* ... tooltip styling ... */
}
```

**Visual:**
```
Before rebalance:
[collateral ===] [credit ///] ← Animated stripes
                         ⏳ "Will become collateral"

After rebalance:
[collateral ========] [credit =] ← Solid, more green
                ✓ "Collateralized"
```

---

## 🎯 KEY INSIGHTS

### 1. softLimit == hardLimit → Manual Mode ✅

```typescript
if (softLimit === hardLimit) {
  // No auto-rebalance zone
  // User must manually request
  // Effectively "manual" policy
}

Example:
soft = $10k, hard = $10k
→ No auto-trigger (would need to be < $10k AND > $10k simultaneously!)
→ Manual only ✅
```

**This is elegant!** Policy mode determined by limit equality.

### 2. USDT as Reference Token ✅

```typescript
const REFERENCE_TOKEN_ID = 1; // USDT (stable)

// All fees denominated in USDT:
rebalanceFee: 5n * 10n**6n // $5 USDT

// User can pay in other tokens:
// - Send $5 USDT (1:1)
// - OR send $5 worth of ETH (price conversion)
// - OR move offdelta in non-reference token (cheaper!)
```

**Question:** How to price non-USDT payments?
```
User wants to pay $5 fee in ETH:
Option A: Oracle price (ETH = $3500 → send 0.00143 ETH)
Option B: User specifies equivalent
Option C: Hub rejects non-USDT payments (simplest)
```

**My suggestion for V1:** Only accept USDT fees (simplest, no pricing needed)

### 3. Manual Rebalance with directPayment ✅

```typescript
// User flow:
1. Click "Manual Rebalance" in UI
2. Enter amount: $5000 USDC
3. UI shows: "Fee: $5 USDT"
4. User approves
5. Send directPayment:
   {
     recipientEntityId: hub,
     tokenId: 1, // USDT
     amount: 5n * 10n**6n,
     description: "rebalance:token2:5000" // Machine-readable
   }
6. Hub parses description
7. Hub executes deposit_collateral(user, token2, $5000)
```

**Description format:**
```
"rebalance:tokenId:amount"
"rebalance:2:5000" = "Please collateralize token 2 to $5000"
```

**Pros:**
- Simple (directPayment already exists)
- Explicit (user sees fee payment)
- Flexible (user chooses payment token)

---

## 📋 FINAL V1 IMPLEMENTATION

### Files to Modify

**1. runtime/types.ts**
```typescript
interface EntityState {
  rebalanceConfig: {
    // Per-token limits (hierarchical later)
    perTokenLimits: Map<number, {
      softLimit: bigint;  // Auto-trigger threshold
      hardLimit: bigint;  // Never exceed
    }>;

    // Static fee (USDT-denominated)
    rebalanceFeeUSDT: bigint; // $5 USDT default
  };
}

// Defaults
const DEFAULT_SOFT_LIMIT = 500n * 10n**6n;   // $500
const DEFAULT_HARD_LIMIT = 10000n * 10n**6n; // $10k
const DEFAULT_REBALANCE_FEE = 5n * 10n**6n;  // $5
```

**2. runtime/entity-crontab.ts (lines 530-608)**
```typescript
// Change from logging to execution:

async function hubRebalanceHandler(env, replica) {
  const outputs = [];

  for (const [counterpartyId, accountMachine] of replica.state.accounts) {
    for (const [tokenId, delta] of accountMachine.deltas) {
      // Get limits (with defaults)
      const limits = replica.state.rebalanceConfig
        ?.perTokenLimits.get(tokenId) ?? {
        softLimit: DEFAULT_SOFT_LIMIT,
        hardLimit: DEFAULT_HARD_LIMIT,
      };

      // Check if auto-rebalance enabled
      if (limits.softLimit === limits.hardLimit) {
        // Manual mode (no auto-trigger)
        continue;
      }

      const currentCollateral = delta.collateral;

      if (currentCollateral < limits.softLimit) {
        // Trigger rebalance
        const needed = limits.softLimit - currentCollateral;

        outputs.push({
          entityId: replica.entityId,
          signerId: resolveEntityProposerId(env, replica.entityId, 'auto-rebalance'),
          entityTxs: [{
            type: 'deposit_collateral',
            data: {
              counterpartyId,
              tokenId,
              amount: needed,
            }
          }, {
            type: 'j_broadcast',
            data: {}
          }]
        });
      }
    }
  }

  return outputs;
}
```

**3. runtime/entity-tx/handlers/direct-payment.ts**
```typescript
// Add rebalance request parsing:

if (description?.startsWith('rebalance:')) {
  // Parse: "rebalance:tokenId:amount"
  const [_, tokenIdStr, amountStr] = description.split(':');
  const tokenId = parseInt(tokenIdStr);
  const targetAmount = BigInt(amountStr) * 10n**18n;

  // Store rebalance request
  accountMachine.requestedRebalance.set(tokenId, targetAmount);

  // Log
  console.log(`💰 Received rebalance fee payment: ${formatAmount(amount)} + request for ${formatAmount(targetAmount)} token ${tokenId}`);
}
```

**4. frontend/src/lib/components/Entity/AccountPanel.svelte**
```svelte
<!-- Rebalance Settings Section -->
<div class="rebalance-settings">
  <h4>🔄 Rebalance Configuration</h4>

  {#each tokenDeltas as td}
    <div class="token-config">
      <h5>{td.tokenInfo.symbol}</h5>

      <div class="limits-row">
        <label>
          Soft Limit (auto-trigger):
          <input type="number" bind:value={softLimits[td.tokenId]} />
        </label>

        <label>
          Hard Limit (max):
          <input type="number" bind:value={hardLimits[td.tokenId]} />
        </label>
      </div>

      {#if softLimits[td.tokenId] === hardLimits[td.tokenId]}
        <div class="mode-indicator manual">
          ⚙️ Manual mode (limits equal, no auto-rebalance)
        </div>
      {:else}
        <div class="mode-indicator auto">
          ⚡ Auto mode (triggers at ${softLimits[td.tokenId]})
        </div>
      {/if}

      <!-- Current status with target -->
      <div class="status-vs-target">
        <span>Current: ${formatAmount(td.derived.collateral)}</span>
        <span>Target: ${softLimits[td.tokenId]}</span>
        {#if td.derived.collateral < softLimits[td.tokenId]}
          <span class="warning">⚠️ Below soft limit (will auto-rebalance)</span>
        {/if}
      </div>
    </div>
  {/each}

  <!-- Manual rebalance button -->
  <button class="manual-rebalance-btn" on:click={openManualRebalance}>
    💰 Manual Rebalance (pay with directPayment)
  </button>
</div>

<!-- Manual rebalance modal -->
{#if showManualRebalanceModal}
  <div class="modal">
    <h3>Manual Rebalance Request</h3>

    <label>
      Token:
      <select bind:value={selectedToken}>
        {#each tokenDeltas as td}
          <option value={td.tokenId}>{td.tokenInfo.symbol}</option>
        {/each}
      </select>
    </label>

    <label>
      Target Collateral:
      <input type="number" bind:value={targetCollateral} />
    </label>

    <div class="fee-display">
      Fee: $5 USDT (paid via directPayment)
    </div>

    <button on:click={sendRebalanceRequest}>
      Send Payment + Request
    </button>
  </div>
{/if}
```

**5. AccountPreview.svelte (animated stripes)**
```svelte
<!-- Add pending state to bar segments -->
{#if td.derived.inPeerCredit > 0n}
  <div
    class="bar-segment unused-credit"
    class:pending-rebalance={isPendingRebalance(td.tokenId)}
    style="width: {unusedCreditPercent}%"
    title="Unsecured credit (will be collateralized)"
  ></div>
{/if}

<script>
function isPendingRebalance(tokenId) {
  const limits = getLimits(tokenId);
  const current = getCurrentCollateral(tokenId);

  // Pending if below soft limit (auto-rebalance will trigger)
  return current < limits.softLimit && limits.softLimit !== limits.hardLimit;
}
</script>

<style>
/* Animated stripes for pending collateralization */
.bar-segment.unused-credit.pending-rebalance {
  background:
    repeating-linear-gradient(
      -45deg,
      #ec4899,
      #ec4899 8px,
      #f472b6 8px,
      #f472b6 16px
    );
  animation: moveStripes 1.5s linear infinite;
}

@keyframes moveStripes {
  0% { background-position: 0 0; }
  100% { background-position: 32px 32px; }
}
</style>
```

**Visual:**
```
Below soft limit (pending rebalance):
[green collateral] [⟋⟋⟋ striped pink credit ⟋⟋⟋]
                    ↑ Animated, shows "becoming collateral"

After rebalance:
[====== green collateral ======] [pink credit]
                          ↑ Solid green, stable
```

---

## 💵 REFERENCE TOKEN (USDT)

**Your insight:** USDT is reference (stable price)

**Implementation:**
```typescript
const REFERENCE_TOKEN_ID = 1; // USDT

// All fees denominated in USDT:
const REBALANCE_FEE = 5n * 10n**6n; // $5 USDT (6 decimals)

// User can pay with:
// 1. USDT directPayment (1:1, simple)
// 2. Other token offdelta movement (cheaper for non-reference)

// Example:
// Option A: Pay $5 in USDT
directPayment({ tokenId: 1, amount: 5e6 })

// Option B: Move offdelta in ETH (if cheaper)
// If offdelta movement costs <$5 in fees
// Better to move offdelta than pay USDT
```

**Question:** For non-USDT payment, how to verify equivalence?
```
User sends 0.002 ETH as fee
Hub needs to verify: 0.002 ETH ≈ $5 USDT

Option A: Trust user (hub can reject if inadequate)
Option B: Oracle price check (complex)
Option C: Only accept USDT (simplest for V1)
```

**My recommendation for V1:** Only accept USDT fees (Option C)

---

## 🎯 DEFAULTS (Per Your Requirement)

```typescript
// On entity creation or first use:
const DEFAULTS = {
  hardLimit: 10_000n * 10n**6n,  // $10k USDT
  softLimit: 500n * 10n**6n,     // $500 USDT
  rebalanceFee: 5n * 10n**6n,    // $5 USDT
};

// User journey:
1. New user, no config → gets defaults
2. Receives faucet #1: +$100 collateral (below soft limit)
3. Receives faucet #2-5: +$400 more → total $500
4. Hits soft limit → Hub auto-rebalances ✅
5. User sees green collateral bar (no more stripes)
```

---

## ❓ FINAL QUESTIONS

**1. directPayment parsing:**
```
Format: "rebalance:tokenId:amount"
Example: "rebalance:2:5000"

Is this OK? Or different format?
```

**2. Non-USDT fee payment:**
```
V1: Only accept USDT fees? (simplest)
V2: Accept any token with price conversion?
```

**3. Soft/hard per-account or per-token?**
```
User has USDC + USDT account with Bob:
- USDC: soft=$500, hard=$10k
- USDT: soft=$1k, hard=$5k

Each token has own limits? Or account-wide?
```

**4. Animation trigger:**
```
Show stripes when:
A) currentCollateral < softLimit (will auto-rebalance soon)
B) requestedRebalance > 0 (manual request pending)
C) Both?
```

**5. Symmetric UI:**
```
Show BOTH sides' soft/hard limits?
Or just mine (theirs is read-only from gossip)?
```

---

## ✅ READY TO IMPLEMENT

**If you confirm:**
- ✅ directPayment with "rebalance:X:Y" format
- ✅ USDT-only fees for V1
- ✅ Per-token limits (each token independent)
- ✅ Stripes when below soft limit
- ✅ Show both sides symmetrically

**Then I can build in 3-4 hours!**

**Confidence: 985/1000** (just need minor confirmations)

All clear or more questions? 🎯