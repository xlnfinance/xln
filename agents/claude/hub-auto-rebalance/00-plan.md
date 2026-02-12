---
agent: claude-sonnet-4.5
session_id: 2026-02-13-hub-rebalance
feature: hub-auto-rebalance
status: planned
created: 2026-02-13T00:00:00Z
branch: claude/hub-auto-rebalance
worktree: ~/.claude-worktrees/xln/hub-auto-rebalance
reviewers: [codex, gemini]
---

# Feature: Hub Automatic Rebalancing

## 🎯 Goal

**Problem:** Hubs run out of reserves → faucet fails with 409 error

**Current state:**
- ✅ `request_rebalance` AccountTx exists (users can request)
- ✅ Crontab detects rebalance opportunities (logs chatMessage)
- ✅ Tested in scenarios (ahb.ts, lock-ahb.ts)
- ❌ Hub doesn't AUTO-RESPOND to rebalance requests
- ❌ No periodic reserve monitoring
- ❌ No automatic reserve replenishment

**Solution:** Hubs automatically detect + execute rebalancing

---

## 📊 Existing Infrastructure

### Already Implemented ✅

**1. Request Mechanism:**
```typescript
// runtime/account-tx/handlers/request-rebalance.ts
accountMachine.requestedRebalance.set(tokenId, amount);
// User can request: "Please fund my account with $X collateral"
```

**2. Detection System:**
```typescript
// runtime/entity-crontab.ts:560-604
// Periodic task detects rebalance opportunities:
// - Net spenders (debt > 0)
// - Net receivers (requestedRebalance > 0)
// - Matches them up
// Currently: Just logs chatMessage ⚠️
```

**3. Manual Execution:**
```typescript
// scenarios/ahb.ts:1718-1720
// Manual settlement with rebalance diffs
// Works, but not automatic
```

### Missing Pieces ❌

**1. Hub Auto-Response to Requests**
```typescript
// When user requests rebalance:
// Hub should AUTO-SEND:
// - R2C (reserve → collateral) to fund their account
// - Settlement (convert credit → collateral)
```

**2. Periodic Reserve Monitoring**
```typescript
// Hub should CHECK every N minutes:
// "Do I have enough reserves for faucet?"
// If hubReserve < threshold → auto-rebalance from external
```

**3. Rebalance Strategy**
```typescript
// Smart matching:
// - Net spender (Alice owes $100) ↔ Net receiver (Bob needs $100 collateral)
// - Hub facilitates: Alice's debt → Bob's collateral (no reserves needed!)
```

---

## 📋 Implementation Plan

### Phase 1: Hub Auto-Response to Rebalance Requests

**When:** User sends `request_rebalance`
**Hub should:** Automatically respond with R2C deposit

**Files to modify:**
- [ ] `runtime/entity-crontab.ts` (lines 560-604)
  - Change: Log chatMessage → Execute R2C
  - Add: `executeRebalanceHandler()` function
  - Logic: Match net spenders ↔ net receivers, execute settlements

**Pseudocode:**
```typescript
// entity-crontab.ts
async function executeRebalanceHandler(env, replica) {
  const opportunities = detectRebalanceOpportunities(replica);

  for (const opp of opportunities) {
    // Option A: Direct rebalance (if hub has reserves)
    if (hubReserve >= opp.amount) {
      return [{
        entityId: replica.entityId,
        signerId: proposerId,
        entityTxs: [{
          type: 'reserve_to_collateral',  // R2C
          data: {
            counterpartyId: opp.receiver,
            tokenId: opp.tokenId,
            amount: opp.amount,
          }
        }]
      }];
    }

    // Option B: Debt-to-collateral swap (if matching spender exists)
    if (opp.matchedSpender) {
      // Execute settlement that converts spender's debt → receiver's collateral
      // No reserves needed! Pure netting.
    }
  }
}
```

### Phase 2: Periodic Reserve Monitoring

**When:** Every 60 seconds (crontab periodic task)
**Hub should:** Check if reserves < threshold, auto-replenish

**Files to create:**
```typescript
// runtime/entity-crontab-tasks/check-hub-reserves.ts
export async function checkHubReservesHandler(env, replica) {
  const MIN_RESERVE_THRESHOLD = 1000n * 10n**18n; // $1000 per token

  for (const [tokenId, reserve] of replica.state.reserves) {
    if (reserve < MIN_RESERVE_THRESHOLD) {
      // Option A: Request from external faucet (testnet)
      await fetch('/api/faucet/erc20', {
        method: 'POST',
        body: JSON.stringify({ entityId: replica.entityId, tokenId })
      });

      // Option B: Trigger on-chain withdrawal (mainnet)
      // Call contract to withdraw from hub's main wallet
    }
  }
}
```

**Files to modify:**
- [ ] `runtime/entity-crontab.ts`
  - Add: `checkHubReserves` periodic task (every 60s)
  - Register in `initCrontab()`

### Phase 3: Smart Matching Algorithm

**Logic:** Match debt with rebalance requests

**Example:**
```
Hub's view:
├── Alice account: owes $100 (net spender)
└── Bob account: requests $100 collateral (net receiver)

Smart rebalance:
→ Execute settlement: Alice pays $100 → Hub → Bob receives collateral
→ Result: Alice's debt cleared, Bob collateralized, Hub reserves unchanged!
```

**Files to create:**
```typescript
// runtime/rebalance-matcher.ts
export function findRebalanceMatches(
  accounts: Map<string, AccountMachine>,
  tokenId: number
): RebalanceMatch[] {
  const spenders = []; // Entities with debt
  const receivers = []; // Entities requesting collateral

  // Match by amount, optimize for minimal reserve usage
  return greedyMatch(spenders, receivers);
}
```

---

## 🧪 Testing Plan

### Unit Tests
```typescript
// tests/unit/rebalance-matcher.test.ts
test('matches single spender with single receiver', () => {
  // Alice owes $100, Bob wants $100 → perfect match
});

test('handles partial matches', () => {
  // Alice owes $50, Bob wants $100 → partial fill
});

test('prioritizes by amount', () => {
  // Multiple receivers → fund largest request first
});
```

### Integration Tests (Scenarios)
```typescript
// runtime/scenarios/hub-rebalance.ts (NEW)
export async function hubRebalanceScenario(env: Env) {
  // 1. Alice accumulates debt to Hub
  // 2. Bob requests rebalance
  // 3. Hub AUTOMATICALLY executes rebalance
  // 4. Verify: Alice debt cleared, Bob collateralized
}
```

### E2E Tests
```typescript
// tests/e2e-hub-rebalance.spec.ts
test('hub auto-rebalances when reserve low', async () => {
  // 1. Drain hub reserves via faucet calls
  // 2. Faucet fails with 409
  // 3. Hub crontab detects low reserves
  // 4. Hub auto-replenishes from external
  // 5. Faucet succeeds again
});
```

---

## 🔍 Review Criteria

### For Codex

**Security:**
- [ ] Rebalance can't be abused (rate limits?)
- [ ] Hub can't be drained via rebalance spam
- [ ] Matching algorithm is fair (no front-running)
- [ ] Reserve replenishment is authenticated

**Correctness:**
- [ ] RCPAN invariant maintained during rebalance
- [ ] Debt accounting correct
- [ ] Collateral updates atomic
- [ ] No race conditions in crontab

### For Gemini

**Architecture:**
- [ ] Crontab is correct layer for this feature
- [ ] Rebalance logic cleanly separated
- [ ] Hub-specific vs entity-general logic clear
- [ ] Extensible (other entities can use rebalance too)

**Performance:**
- [ ] Crontab interval appropriate (60s? 300s?)
- [ ] Matching algorithm O(n²) acceptable for hub scale?
- [ ] No blocking operations in crontab

---

## ⏱️ Estimated Time

- **Research:** 1 hour (understand existing rebalance code)
- **Implementation:** 4-6 hours
  - Phase 1: Auto-response (2 hours)
  - Phase 2: Reserve monitoring (1 hour)
  - Phase 3: Smart matching (2 hours)
  - Integration: 1 hour
- **Testing:** 2 hours
  - Unit tests (matching)
  - Scenario (hub-rebalance.ts)
  - E2E (if needed)
- **Review cycles:** 1-2 days
- **Total:** 3-4 days

---

## 🔗 Related

**Fixes:** Faucet 409 error (insufficient hub reserves)

**Context:**
- Existing code: runtime/entity-crontab.ts:560-604
- Existing handler: account-tx/handlers/request-rebalance.ts
- Tested in: scenarios/ahb.ts:1683-1827

**Future:**
- Multi-hub rebalancing (triangular)
- Automatic liquidity management
- Reserve optimization algorithms

---

## 📝 Success Criteria

**Feature complete when:**
- [x] Hub detects rebalance requests automatically
- [x] Hub executes rebalance (R2C or settlement)
- [x] Hub monitors own reserves periodically
- [x] Hub auto-replenishes when reserves low
- [x] Faucet 409 errors eliminated
- [x] All tests pass
- [x] Codex + Gemini approve (≥950/1000)

**Metrics:**
- Faucet success rate: >95%
- Hub reserve uptime: >99%
- Rebalance latency: <30 seconds

---

**Confidence: 850/1000**

**Why not higher?**
- Need to study existing crontab code more
- Need to understand faucet reserve requirements
- Need to design rate limiting (anti-spam)

**Ready to start:** After reviewing existing rebalance code in detail
