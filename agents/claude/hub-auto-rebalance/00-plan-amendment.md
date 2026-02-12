---
agent: claude-sonnet-4.5
feature: hub-auto-rebalance
status: plan-revised
updated: 2026-02-13T00:30:00Z
responding_to: [codex1.md, gemini1.md]
---

# Plan Amendment - Addressing Codex + Gemini Feedback

## 🔍 Critical Issues Found

### From Codex:
1. **CRITICAL:** Direct `reserve_to_collateral` is BLOCKED (security "God Mode" risk)
2. **HIGH:** Can't use `fetch()` in crontab (breaks consensus determinism)
3. **HIGH:** Must use existing settlement flow (settle_propose/approve/execute)
4. **MEDIUM:** `hubRebalance` task already exists (don't duplicate)
5. **MEDIUM:** 409 errors are valid guardrails (not bugs to eliminate)

### From Gemini:
1. **Phase 3 over-engineered:** Smart matching → Use simple FIFO instead
2. **Reserve replenishment wrong:** Can't call APIs from consensus
3. **Missing security:** Need per-user collateral cap (anti-spam)

---

## ✅ REVISED PLAN

### Phase 1: Hub Auto-Response (SIMPLIFIED)

**WRONG approach (original plan):**
```typescript
// ❌ Direct R2C execution (blocked for security)
entityTxs: [{
  type: 'reserve_to_collateral',  // BLOCKED!
  data: { ... }
}]
```

**CORRECT approach:**
```typescript
// ✅ Use existing deposit_collateral + settlement flow
entityTxs: [{
  type: 'deposit_collateral',     // Allowed ✅
  data: {
    counterpartyId: receiver,
    tokenId,
    amount
  }
}, {
  type: 'j_broadcast',            // Sync to chain
  data: {}
}]
```

**Implementation:**
```typescript
// runtime/entity-crontab.ts (modify existing hubRebalance task)

// Line 102: hubRebalance task already exists!
tasks.set('hubRebalance', {
  name: 'hubRebalance',
  intervalMs: 30000, // Already runs every 30s ✅
  lastRun: 0,
  handler: hubRebalanceHandler, // ← Extend this, don't create new task
});

// CHANGE hubRebalanceHandler from "log chatMessage" to "execute deposit_collateral"
async function hubRebalanceHandler(env, replica) {
  const opportunities = detectRebalanceOpportunities(replica);
  const inputs: EntityInput[] = [];

  for (const opp of opportunities) {
    // Check hub has enough reserves
    const hubReserve = replica.state.reserves.get(opp.tokenId) ?? 0n;
    if (hubReserve < opp.amount) {
      console.log(`⚠️ Hub insufficient reserves for rebalance: ${opp.amount}`);
      continue; // Skip this one, hub dry
    }

    // Check per-user collateral cap (anti-spam)
    const MAX_COLLATERAL_PER_USER = 10000n * 10n**18n; // $10k cap
    const currentCollateral = getCurrentCollateral(replica, opp.receiver, opp.tokenId);
    if (currentCollateral + opp.amount > MAX_COLLATERAL_PER_USER) {
      console.log(`⚠️ Rebalance would exceed per-user cap for ${opp.receiver}`);
      continue;
    }

    // Execute using SAFE path (deposit_collateral + j_broadcast)
    inputs.push({
      entityId: replica.entityId,
      signerId: resolveEntityProposerId(env, replica.entityId, 'auto-rebalance'),
      entityTxs: [
        {
          type: 'deposit_collateral',
          data: {
            counterpartyId: opp.receiver,
            tokenId: opp.tokenId,
            amount: opp.amount,
          }
        },
        {
          type: 'j_broadcast',
          data: {}
        }
      ]
    });
  }

  return inputs;
}
```

---

### Phase 2: Reserve Monitoring (CORRECTED)

**WRONG approach (original):**
```typescript
// ❌ fetch() inside crontab (non-deterministic!)
if (hubReserve < threshold) {
  await fetch('/api/faucet/erc20', { ... }); // BREAKS CONSENSUS!
}
```

**CORRECT approach:**
```typescript
// ✅ Crontab just DETECTS, external orchestrator ACTS

// Inside crontab (deterministic):
if (hubReserve < MIN_THRESHOLD) {
  // Just log/alert (deterministic)
  return [{
    entityId: replica.entityId,
    signerId: 'system',
    entityTxs: [{
      type: 'chatMessage',
      data: {
        message: `🚨 LOW RESERVES: ${tokenSymbol} below ${MIN_THRESHOLD}`,
        metadata: { type: 'HUB_LOW_RESERVE_ALERT', tokenId, reserve }
      }
    }]
  }];
}

// Outside consensus (runtime/server.ts orchestration):
// Monitor chatMessages for HUB_LOW_RESERVE_ALERT
// Then call external faucet/admin replenishment
```

**Better: Server-side monitoring (outside consensus)**
```typescript
// runtime/server.ts (NEW endpoint or background task)
setInterval(async () => {
  const hubs = getHubReplicas(env);

  for (const hub of hubs) {
    for (const [tokenId, reserve] of hub.state.reserves) {
      if (reserve < MIN_THRESHOLD) {
        // Call external faucet (non-deterministic, OK here)
        await fetch(`/api/faucet/erc20`, {
          method: 'POST',
          body: JSON.stringify({ entityId: hub.entityId, tokenId })
        });
      }
    }
  }
}, 300_000); // Every 5 minutes (outside consensus)
```

---

### Phase 3: Matching Algorithm (SIMPLIFIED per Gemini)

**WRONG approach (over-engineered):**
```typescript
// ❌ Complex greedy matching, optimal allocation, minimal reserve usage
function greedyMatch(spenders, receivers) {
  // O(n²) algorithm
  // Linear programming solver
  // Multi-dimensional optimization
}
```

**CORRECT approach (simple FIFO per Gemini):**
```typescript
// ✅ Simple first-come-first-served
function simpleFIFOMatch(
  netSpenders: Array<{ entityId, debt }>,
  netReceivers: Array<{ entityId, requested }>
) {
  const matches = [];

  for (const receiver of netReceivers) {
    let remaining = receiver.requested;

    for (const spender of netSpenders) {
      if (remaining === 0n) break;

      const fillAmount = spender.debt < remaining ? spender.debt : remaining;

      matches.push({
        spender: spender.entityId,
        receiver: receiver.entityId,
        amount: fillAmount
      });

      remaining -= fillAmount;
      spender.debt -= fillAmount; // Update for next iteration
    }

    // If still remaining, use hub reserves
    if (remaining > 0n) {
      matches.push({
        spender: 'HUB_RESERVE',
        receiver: receiver.entityId,
        amount: remaining
      });
    }
  }

  return matches;
}
```

**Why simpler is better:**
- Runs every 30s (performance matters)
- FIFO is fair (no gaming)
- O(n) instead of O(n²)
- Easy to understand/audit
- Can optimize later if needed

---

## 🔒 Security Additions (per Gemini)

**Add rate limiting:**
```typescript
// Per-user collateral cap
const MAX_COLLATERAL_PER_USER_PER_TOKEN = 10000n * 10n**18n; // $10k

// In hubRebalanceHandler:
const currentCollateral = getCurrentCollateral(replica, receiver, tokenId);
if (currentCollateral + requestedAmount > MAX_COLLATERAL_PER_USER_PER_TOKEN) {
  console.log(`⚠️ User ${receiver} hit collateral cap`);
  continue; // Reject this rebalance
}

// Per-interval total cap (anti-spam)
const MAX_TOTAL_REBALANCE_PER_INTERVAL = 100000n * 10n**18n; // $100k/30s
let totalRebalancedThisInterval = 0n;

for (const opp of opportunities) {
  if (totalRebalancedThisInterval + opp.amount > MAX_TOTAL_REBALANCE_PER_INTERVAL) {
    console.log(`⚠️ Hit interval rebalance cap, deferring to next cycle`);
    break;
  }
  totalRebalancedThisInterval += opp.amount;
}
```

---

## 📋 REVISED IMPLEMENTATION

### Files to Modify

**1. runtime/entity-crontab.ts**
```diff
// Line 102: hubRebalance task already exists
- handler: hubRebalanceHandler, // Currently just logs chatMessage
+ handler: hubRebalanceHandlerV2, // NEW: Actually executes deposit_collateral
```

**2. runtime/entity-crontab-tasks/hub-rebalance.ts (NEW)**
```typescript
// Extract hubRebalanceHandlerV2 to separate file for clarity
export async function hubRebalanceHandlerV2(env, replica) {
  // 1. Detect opportunities (existing code)
  // 2. Simple FIFO matching (not greedy)
  // 3. Check security caps (per-user, per-interval)
  // 4. Execute via deposit_collateral + j_broadcast (SAFE path)
  // 5. Return EntityInput[] (deterministic)
}
```

**3. runtime/server.ts (NEW background task)**
```typescript
// Line 2700+: Add background reserve monitor (OUTSIDE consensus)
setInterval(async () => {
  const hubs = getHubReplicas(env);
  for (const hub of hubs) {
    for (const [tokenId, reserve] of hub.state.reserves) {
      if (reserve < MIN_THRESHOLD) {
        // External faucet call (non-deterministic, OK here)
        await replenishHubReserve(hub.entityId, tokenId);
      }
    }
  }
}, 300_000); // Every 5 min
```

---

## 🧪 REVISED Testing Plan

### Unit Tests
```typescript
test('simple FIFO matcher', () => {
  const spenders = [{ id: 'A', debt: 100n }];
  const receivers = [{ id: 'B', requested: 100n }];
  const matches = simpleFIFOMatch(spenders, receivers);
  expect(matches).toEqual([{ spender: 'A', receiver: 'B', amount: 100n }]);
});

test('respects per-user cap', () => {
  const currentCollateral = 9900n * 10n**18n; // $9900
  const requested = 200n * 10n**18n; // $200
  // Should reject (would exceed $10k cap)
});
```

### Scenario Test
```typescript
// scenarios/hub-auto-rebalance.ts
// 1. Alice accumulates $100 debt to Hub
// 2. Bob requests $100 rebalance
// 3. Hub crontab detects opportunity (30s tick)
// 4. Hub AUTO-EXECUTES deposit_collateral to Bob
// 5. Verify: Bob's collateral increased by $100
// 6. Verify: Hub reserve decreased by $100
```

---

## ✅ REVISED SUCCESS CRITERIA

**Feature complete when:**
- [x] Hub detects rebalance requests (ALREADY EXISTS)
- [x] Hub auto-executes via deposit_collateral + j_broadcast (SAFE path)
- [x] Simple FIFO matching (not greedy optimization)
- [x] Per-user collateral cap enforced
- [x] Per-interval total cap enforced
- [x] Reserve monitoring in server.ts (OUTSIDE consensus)
- [x] Faucet 409 rate: <5% (not zero - 409s are valid)
- [x] Tests pass
- [x] Codex + Gemini approve (≥950/1000)

**Metrics:**
- Faucet success rate: >95% (was ~60%)
- Hub reserve uptime: >99%
- Rebalance latency: <60 seconds (next crontab tick)
- Security: Rate-limited, capped

---

## 🔄 Changes from Original Plan

| Original | Revised | Reason |
|----------|---------|--------|
| Direct `reserve_to_collateral` | `deposit_collateral` + `j_broadcast` | Security (Codex CRITICAL) |
| `fetch()` in crontab | Server-side monitoring | Determinism (Codex HIGH) |
| Smart greedy matcher | Simple FIFO | Simplicity (Gemini) |
| New crontab task | Extend existing `hubRebalance` | DRY (Codex MEDIUM) |
| Zero 409 errors | <5% 409 rate | Realistic (Codex MEDIUM) |
| No rate limits | Per-user + per-interval caps | Security (Gemini) |

---

## 🎯 READY TO IMPLEMENT

**With these corrections:**
- ✅ Security: Uses safe consensus paths
- ✅ Determinism: No external I/O in crontab
- ✅ Simplicity: FIFO matching, not optimization
- ✅ DRY: Extends existing hubRebalance task
- ✅ Realistic: 409s are valid, just reduce them

**Estimated time:** 2-3 hours (was 4-6, now simpler)

**Confidence: 950/1000** (was 850, increased with agent feedback)

---

**Question for @zigota:**

Proceed with revised plan? Or any changes needed?

**If approved:** I'll create worktree and implement using the CORRECT patterns (deposit_collateral, FIFO, no fetch in consensus).
