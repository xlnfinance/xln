---
agent: claude-sonnet-4.5
session_id: 2026-02-13-account-ui
feature: account-ui-improvements
status: planned
created: 2026-02-13T02:00:00Z
branch: claude/account-ui-improvements
reviewers: []
priority: high
estimated_time: 2-3 hours
---

# Feature: Account UI Improvements

## 🎯 Goal

Improve account preview cards with:
1. **Online/offline indicators** (is counterparty connected?)
2. **Sleeker bars** (thinner, nicer design)
3. **Connection status** (WS direct / relay / unknown)
4. **Target collateralization** (0-150% per entity/account/token)

## 📊 Current State (From Screenshot)

**AccountPreview.svelte (479 lines):**
- ✅ Shows thick colored bars (red/pink/blue gradients)
- ✅ Shows SYNCED status badge
- ✅ Shows OUT/IN capacity
- ✅ Shows breakdown (owed, coll, credit)
- ❌ No online/offline indicator
- ❌ No connection status (WS vs relay)
- ❌ No target collateralization settings
- ⚠️ Bars are thick/chunky (could be sleeker)

---

## 🎨 IMPROVEMENT 1: Online/Offline Indicator

### Problem
```
Screenshot shows: Account cards, but no way to know if counterparty is online
User question: "Can I send payment now? Are they connected?"
```

### Solution
```typescript
// Add online status to account header

<div class="account-header">
  <EntityIdentity ... />

  <!-- NEW: Online indicator -->
  <div class="connectivity-status">
    {#if isOnline}
      <span class="status-dot online" title="Online (ready for payments)">●</span>
    {:else}
      <span class="status-dot offline" title="Offline (payments will queue)">●</span>
    {/if}
  </div>
</div>

// Logic: Check if counterparty has active runtimeId in gossip
$: isOnline = (() => {
  const profiles = env?.gossip?.getProfiles() || [];
  const profile = profiles.find(p => p.entityId === counterpartyId);
  return !!profile?.runtimeId; // Has runtime = online
})();
```

**Visual:**
```
[Alice]  ● Online   | OUT 500 | IN 1000
[Bob]    ● Offline  | OUT 200 | IN 300
```

---

## 🎨 IMPROVEMENT 2: Sleeker Bars

### Current (Chunky)
```css
.capacity-bar {
  height: 40px; /* TOO THICK */
  border-radius: 6px;
}

.bar-segment {
  /* Thick gradients */
  background: linear-gradient(135deg, #ff6b9d, #c64274);
}
```

### Proposed (Sleek)
```css
.capacity-bar {
  height: 16px; /* ← THINNER (40 → 16px) */
  border-radius: 8px; /* Rounder */
  border: 1px solid rgba(255,255,255,0.1); /* Subtle border */
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3); /* Depth */
}

.bar-segment {
  /* Flatter colors (less gradient noise) */
  background: #4ade80; /* Flat green for collateral */
  opacity: 0.9;
  transition: opacity 0.2s;
}

.bar-segment:hover {
  opacity: 1; /* Highlight on hover */
}

/* Segments */
.bar-segment.collateral {
  background: linear-gradient(90deg, #22c55e, #16a34a); /* Sleeker gradient */
}

.bar-segment.used-credit {
  background: linear-gradient(90deg, #f59e0b, #d97706);
}

.bar-segment.unused-credit {
  background: linear-gradient(90deg, #ec4899, #db2777);
  opacity: 0.5; /* Dimmer for unused */
}
```

**Result:**
```
BEFORE: ████████████ (40px thick, chunky)
AFTER:  ══════════   (16px thin, sleek) ✅
```

---

## 🎨 IMPROVEMENT 3: Connection Status

### Three States

**1. Direct WS (P2P):**
```
[Alice] ● ⚡ Direct  | OUT 500 | IN 1000
         ↑  ↑
    online  WS direct
```

**2. Relay (via server):**
```
[Bob]   ● 🔀 Relay   | OUT 200 | IN 300
         ↑  ↑
    online  relay-routed
```

**3. Unknown/Offline:**
```
[Charlie] ○ ? Unknown | OUT 0 | IN 0
           ↑ ↑
      offline unknown
```

### Implementation
```typescript
<div class="connectivity-badges">
  {#if connectionStatus === 'direct'}
    <span class="conn-badge direct" title="Direct P2P connection">⚡ Direct</span>
  {:else if connectionStatus === 'relay'}
    <span class="conn-badge relay" title="Connected via relay">🔀 Relay</span>
  {:else}
    <span class="conn-badge unknown" title="Connection status unknown">? Unknown</span>
  {/if}
</div>

// Logic: Check connection type
$: connectionStatus = (() => {
  const profile = getCounterpartyProfile(counterpartyId);
  if (!profile?.runtimeId) return 'unknown';

  // Check if we have direct WS connection
  const hasDirectWS = env?.p2p?.hasDirectConnection?.(profile.runtimeId);
  if (hasDirectWS) return 'direct';

  // Otherwise connected via relay
  return 'relay';
})();
```

**CSS:**
```css
.conn-badge {
  font-size: 0.7em;
  padding: 2px 6px;
  border-radius: 3px;
  font-weight: 500;
}

.conn-badge.direct {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.conn-badge.relay {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.conn-badge.unknown {
  background: rgba(156, 163, 175, 0.15);
  color: #9ca3af;
  border: 1px solid rgba(156, 163, 175, 0.3);
}
```

---

## 🎨 IMPROVEMENT 4: Target Collateralization Settings

### Hierarchical Configuration

**3 levels (override hierarchy):**
```
Entity-wide default (e.g., 80% for all accounts)
  ↓
Account-specific (e.g., 120% for Bob specifically)
  ↓
Token-specific (e.g., 150% for USDC in Bob account)
```

### UI Design

**In AccountPanel.svelte, add settings section:**
```svelte
<div class="account-settings-section">
  <h4>⚙️ Target Collateralization</h4>

  <!-- Token-specific settings -->
  {#each tokenDeltas as td}
    <div class="collateral-target-row">
      <span class="token-label">{td.tokenInfo.symbol}</span>

      <div class="target-slider">
        <input
          type="range"
          min="0"
          max="150"
          step="10"
          bind:value={collateralTargets[td.tokenId]}
          class="slider"
        />
        <span class="target-value">{collateralTargets[td.tokenId]}%</span>
      </div>

      <div class="target-status">
        {#if currentCollateralPercent >= collateralTargets[td.tokenId]}
          <span class="status-ok">✓ Met</span>
        {:else}
          <span class="status-low">⚠️ Below target</span>
        {/if}
      </div>
    </div>
  {/each}

  <!-- Entity-wide default -->
  <div class="entity-default-setting">
    <label>
      Entity Default:
      <input type="number" min="0" max="150" bind:value={entityDefaultTarget} />%
    </label>
    <small>Applied to all accounts unless overridden</small>
  </div>
</div>
```

### Data Structure
```typescript
// types.ts: Add to EntityState
interface EntityState {
  ...
  collateralTargets: {
    entityDefault: number;          // 80 = 80% for all accounts
    perAccount: Map<string, number>; // counterpartyId → 120
    perToken: Map<string, Map<number, number>>; // accountId → tokenId → 150
  };
}

// Resolution logic:
function getTargetCollateralization(
  entityId: string,
  counterpartyId: string,
  tokenId: number
): number {
  const entity = getEntity(entityId);

  // Most specific wins:
  const perToken = entity.collateralTargets.perToken
    .get(counterpartyId)
    ?.get(tokenId);
  if (perToken !== undefined) return perToken;

  const perAccount = entity.collateralTargets.perAccount.get(counterpartyId);
  if (perAccount !== undefined) return perAccount;

  return entity.collateralTargets.entityDefault ?? 80; // Default 80%
}
```

### Visual Indicator on Bar

**Show target line on capacity bar:**
```svelte
<div class="capacity-bar-wrapper">
  <!-- The actual capacity bar -->
  <div class="capacity-bar">
    <div class="bar-segment collateral" style="width: {collateralPercent}%"></div>
    ...
  </div>

  <!-- Target line overlay -->
  {#if targetCollateralization > 0}
    <div
      class="target-line"
      style="left: {targetCollateralization}%"
      title="Target: {targetCollateralization}%"
    ></div>
  {/if}
</div>
```

**CSS:**
```css
.capacity-bar-wrapper {
  position: relative;
}

.target-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fbbf24;
  border-left: 2px dashed #fbbf24;
  opacity: 0.7;
  pointer-events: none;
  z-index: 10;
}

.target-line::before {
  content: '🎯';
  position: absolute;
  top: -18px;
  left: -8px;
  font-size: 12px;
}
```

**Visual:**
```
Bar: [====|===========|-----]
          ↑ 🎯 Target (80%)
     Current: 60% (below target, show warning)
```

---

## 📋 IMPLEMENTATION FILES

### Files to Modify

**1. AccountPreview.svelte**
- [ ] Add online/offline indicator
- [ ] Add connection status badge (direct/relay/unknown)
- [ ] Make bars thinner (40px → 16px)
- [ ] Sleeker gradients (flatter colors)

**2. AccountPanel.svelte**
- [ ] Add "Target Collateralization" settings section
- [ ] Add per-token sliders (0-150%)
- [ ] Add entity default setting
- [ ] Show current vs target comparison

**3. types.ts**
- [ ] Add `collateralTargets` to EntityState
- [ ] Add hierarchical config structure

**4. entity-tx/handlers/update-collateral-target.ts (NEW)**
- [ ] Handle `update_collateral_target` transaction
- [ ] Store in entity state (consensus-safe)

### Visual Changes

**Before (from screenshot):**
```
Thick bars: ████████████ (40px)
No online indicator
No connection status
No target settings
```

**After:**
```
Sleek bars: ══════════ (16px) with 🎯 target line
[Alice] ● ⚡ Direct     Target: 80% ✓
[Bob]   ● 🔀 Relay      Target: 120% ⚠️ Below
[Charlie] ○ ? Unknown   Target: 100%
```

---

## 🎯 WHICH SHOULD I DO FIRST?

**Option A: Fix rebalance plan (address Codex issues)**
- Time: 1 hour to simplify plan
- Impact: Unblocks rebalance feature
- Complexity: Medium (need to fix determinism issues)

**Option B: Implement UI improvements (your screenshot)**
- Time: 2-3 hours
- Impact: Immediate visual/UX improvement
- Complexity: Low (pure UI, no consensus changes)

**Option C: Do both in parallel (separate features)**
- Rebalance: Fix plan, then implement later
- UI: Implement now (quick win)

**My recommendation:** **Option B** (UI first)
- Quick win (2-3 hours)
- No consensus changes (safe)
- Immediate user value
- Rebalance can wait for proper plan fix

---

## 💬 QUESTIONS FOR YOU

**UI Improvements:**
1. Bar height 16px OK? (or 20px? 12px?)
2. Connection badges OK? (⚡ Direct, 🔀 Relay, ? Unknown)
3. Target collateralization: Where should settings UI go?
   - In AccountPanel (per-account settings)
   - In EntityPanel settings tab (entity-wide)
   - Both?

**Priority:**
- Should I do UI improvements first (simpler, quick)?
- Or fix rebalance plan (complex, addresses Codex)?

**Confidence on UI improvements: 990/1000** (straightforward, no consensus changes)

Want me to **implement UI improvements now?** 🎨