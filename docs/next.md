# XLN Next Development Session

## 🚨 **IMMEDIATE PRIORITIES**

### **🔥 Priority 1: Dual Hover Tooltips**
On connection hover, show TWO tooltips (one for each side):

```
LEFT Entity View               RIGHT Entity View
┌─────────────────────┐       ┌─────────────────────┐
│ Their credit: 500k  │       │ Our credit: 300k    │
│ Collateral: 100k    │       │ Collateral: 100k    │
│ Our credit: 300k    │       │ Their credit: 500k  │
│ Net: -200k (owe)    │       │ Net: +200k (owed)   │
└─────────────────────┘       └─────────────────────┘
```

- Use `deriveDelta()` for proper perspective calculation
- Show credit/collateral/net from each entity's viewpoint
- Position tooltips on either side of the connection
- Include token symbol and formatted amounts

### **🔥 Priority 2: Ripples on J-Events**
Visual feedback for jurisdictional events (reserve/collateral changes):

- Detect j-events in server frames when rendering
- Create radial ripple effect originating from entity
- Broadcast-style animation (expanding ring)
- Show when reserve state changes (deposits/withdrawals)

### **🔥 Priority 3: H-Layout Position Persistence**
Default to clean H-shaped layout on fresh start:

- 2 columns (left/right bars of H)
- Hubs at top of each column
- Users spread vertically
- Proper spacing to prevent bar overlap
- Save positions after user adjustments

---

## 🚀 **ADVANCED FEATURES ROADMAP**

### **🎨 Visual Enhancements**

1. **Entity Identicon Integration**
   - Replace spheres with actual avatar textures from EntityProfile
   - Geometric patterns based on entity ID
   - Consistent visual identity across UI

2. **Connection Glow Animations**
   - Lines pulse during active transactions
   - Thickness proportional to transaction volume
   - Particle effects traveling along paths

3. **Network Health Heatmap**
   - Color-code entities by risk/congestion
   - Connection stress visualization
   - Real-time capacity utilization

### **🧠 Intelligence & Analytics**

4. **Entity Classification**
   - Auto-detect hub vs leaf vs bridge entities
   - Visual indicators for network roles
   - Hub centrality scoring

5. **Multi-hop Route Visualization**
   - Dijkstra pathfinding through network graph
   - Route comparison UI (cost/speed trade-offs)
   - Animated flow along multi-hop paths
   - Alternative route suggestions

6. **Bottleneck Detection**
   - Identify congested nodes in real-time
   - Capacity utilization warnings
   - Rerouting recommendations

### **📊 Network Analytics**

7. **Liquidity Flow Tracking**
   - Real-time value movement visualization
   - Flow velocity and volume metrics
   - Historical pattern analysis

8. **Risk Assessment**
   - Systemic risk scoring per entity
   - Concentration risk detection
   - Credit exposure heat mapping

9. **Network Optimization**
   - AI-powered connection recommendations
   - Capacity rebalancing suggestions
   - Route efficiency analysis

### **🎮 Interaction Improvements**

10. **Smart Zoom System (LOD)**
    - Far zoom: Major hubs only
    - Mid zoom: All entities, simplified bars
    - Close zoom: Full detail with all visualizations

11. **Timeline Scrubbing**
    - Drag timeline to see network evolution
    - Frame-by-frame playback controls
    - Speed controls for time travel

---

## 🎯 **NEXT ACTIONS**

1. **Add j-event ripples** - Visual feedback for reserve/collateral changes
2. **Test payment flows end-to-end** - Verify consensus and UI updates
3. **Implement reserve-to-collateral flow** - See detailed plan below

---

## 🏦 **RESERVE-TO-COLLATERAL IMPLEMENTATION PLAN**

### **Context**
Need to implement entity-level reserve → collateral funding using `Depository.settle()` with the 4-diff invariant.

**⚠️ CRITICAL**: Must use `settle()` NOT `prefundAccount()` - collateral funding requires bilateral invariant.

### **Understanding the 4-Diff Invariant**

The `settle()` function uses a conservation-of-value invariant:

```solidity
struct SettlementDiff {
  uint tokenId;
  int leftDiff;        // Change for left entity's reserve
  int rightDiff;       // Change for right entity's reserve
  int collateralDiff;  // Change in shared collateral
  int ondeltaDiff;     // Change in on-chain delta (4th parameter, separate from invariant)
}

// INVARIANT: leftDiff + rightDiff + collateralDiff == 0
```

**Example - Fund 100 USDC from my reserve to account collateral:**
- My reserve: `-100` (debit)
- Their reserve: `0` (no change)
- Collateral: `+100` (credit)
- Ondelta: `0` (no on-chain delta change)
- **Invariant check**: `-100 + 0 + 100 = 0` ✅

**Example - Withdraw 50 USDC from collateral to my reserve:**
- My reserve: `+50` (credit)
- Their reserve: `0` (no change)
- Collateral: `-50` (debit)
- Ondelta: `0` (no on-chain delta change)
- **Invariant check**: `+50 + 0 + (-50) = 0` ✅

**Example - Bilateral collateral increase (both fund 50 each):**
- My reserve: `-50` (debit)
- Their reserve: `-50` (debit)
- Collateral: `+100` (credit)
- Ondelta: `0` (no on-chain delta change)
- **Invariant check**: `-50 + (-50) + 100 = 0` ✅

### **Step 1: EntityTx Type Definition**

Add to `src/types.ts` in the `EntityTx` union:

```typescript
| {
    type: 'settleDiffs';
    data: {
      counterpartyEntityId: string;
      diffs: Array<{
        tokenId: number;
        leftDiff: bigint;   // Positive = credit, Negative = debit
        rightDiff: bigint;
        collateralDiff: bigint;
        ondeltaDiff: bigint;
      }>;
      description?: string; // e.g., "Fund collateral from reserve"
    };
  };
```

### **Step 2: Handler Implementation**

Add handler in `src/entity-tx/apply.ts`:

```typescript
if (entityTx.type === 'settleDiffs') {
  console.log(`🏦 SETTLE-DIFFS: Processing settlement with ${entityTx.data.counterpartyEntityId}`);

  const newState = cloneEntityState(entityState);
  const { counterpartyEntityId, diffs, description } = entityTx.data;

  // Step 1: Validate invariant for all diffs
  for (const diff of diffs) {
    const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
    if (sum !== 0n) {
      console.error(`❌ INVARIANT-VIOLATION: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
      throw new Error(`Settlement invariant violation: ${sum} !== 0`);
    }
  }

  // Step 2: Determine canonical left/right order
  const isLeft = entityState.entityId < counterpartyEntityId;
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

  console.log(`🏦 Canonical order: left=${leftEntity.slice(0,10)}, right=${rightEntity.slice(0,10)}`);

  // Step 3: Get jurisdiction config
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    throw new Error('No jurisdiction configured for this entity');
  }

  // Step 4: Call Depository.settle()
  const { depositoryAddress } = jurisdiction;

  // Convert diffs to contract format
  const contractDiffs = diffs.map(d => ({
    tokenId: d.tokenId,
    leftDiff: d.leftDiff.toString(),
    rightDiff: d.rightDiff.toString(),
    collateralDiff: d.collateralDiff.toString(),
    ondeltaDiff: d.ondeltaDiff.toString(),
  }));

  try {
    const txHash = await callDepositorySettle(
      depositoryAddress,
      leftEntity,
      rightEntity,
      contractDiffs
    );

    console.log(`✅ Settlement transaction sent: ${txHash}`);

    // Add message to chat
    newState.messages.push(
      `🏦 ${description || 'Settlement'} transaction sent: ${txHash.slice(0, 10)}...`
    );

  } catch (error) {
    console.error(`❌ Settlement transaction failed:`, error);
    newState.messages.push(`❌ Settlement failed: ${(error as Error).message}`);
  }

  return { newState, outputs: [] };
}
```

### **Step 3: EVM Integration Function**

Add to `src/evm.ts`:

```typescript
export async function callDepositorySettle(
  depositoryAddress: string,
  leftEntity: string,
  rightEntity: string,
  diffs: Array<{
    tokenId: number;
    leftDiff: string;
    rightDiff: string;
    collateralDiff: string;
    ondeltaDiff: string;
  }>
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
  const signer = await provider.getSigner();

  const depository = new ethers.Contract(
    depositoryAddress,
    ['function settle(bytes32 leftEntity, bytes32 rightEntity, (uint tokenId, int leftDiff, int rightDiff, int collateralDiff, int ondeltaDiff)[] diffs) returns (bool)'],
    signer
  );

  // Convert entity IDs to bytes32
  const leftEntityBytes = ethers.zeroPadValue(leftEntity, 32);
  const rightEntityBytes = ethers.zeroPadValue(rightEntity, 32);

  // Call settle
  const tx = await depository.settle(leftEntityBytes, rightEntityBytes, diffs);
  await tx.wait();

  return tx.hash;
}
```

### **Step 4: UI Component**

Create `frontend/src/lib/components/Entity/SettlementPanel.svelte`:

```svelte
<script lang="ts">
  import { getXLN, xlnEnvironment, replicas } from '../../stores/xlnStore';

  export let entityId: string;

  // Form state
  let counterpartyEntityId = '';
  let tokenId = 2; // Default USDC
  let leftDiff = '0';
  let rightDiff = '0';
  let collateralDiff = '0';
  let ondeltaDiff = '0';
  let description = '';
  let sending = false;

  // Computed invariant validation
  $: invariantSum = BigInt(leftDiff || 0) + BigInt(rightDiff || 0) + BigInt(collateralDiff || 0);
  $: invariantValid = invariantSum === 0n;

  // Get all entities for dropdown
  $: allEntities = $replicas ? Array.from($replicas.keys())
    .map(key => key.split(':')[0]!)
    .filter((id, index, self) => self.indexOf(id) === index && id !== entityId)
    .sort() : [];

  // Preset templates
  function fundFromReserve(amount: string) {
    const isLeft = entityId < counterpartyEntityId;
    leftDiff = isLeft ? `-${amount}` : '0';
    rightDiff = isLeft ? '0' : `-${amount}`;
    collateralDiff = amount;
    ondeltaDiff = '0';
    description = `Fund ${amount} from reserve to collateral`;
  }

  function withdrawToReserve(amount: string) {
    const isLeft = entityId < counterpartyEntityId;
    leftDiff = isLeft ? amount : '0';
    rightDiff = isLeft ? '0' : amount;
    collateralDiff = `-${amount}`;
    ondeltaDiff = '0';
    description = `Withdraw ${amount} from collateral to reserve`;
  }

  async function sendSettlement() {
    if (!invariantValid) return;

    sending = true;
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('Environment not ready');

      // Find signer ID
      let signerId = 's1';
      for (const key of env.replicas.keys()) {
        if (key.startsWith(entityId + ':')) {
          signerId = key.split(':')[1]!;
          break;
        }
      }

      const settlementInput = {
        entityId,
        signerId,
        entityTxs: [{
          type: 'settleDiffs' as const,
          data: {
            counterpartyEntityId,
            diffs: [{
              tokenId,
              leftDiff: BigInt(leftDiff),
              rightDiff: BigInt(rightDiff),
              collateralDiff: BigInt(collateralDiff),
              ondeltaDiff: BigInt(ondeltaDiff),
            }],
            description: description || undefined,
          },
        }],
      };

      await xln.processUntilEmpty(env, [settlementInput]);
      console.log(`✅ Settlement sent`);

      // Reset form
      leftDiff = '0';
      rightDiff = '0';
      collateralDiff = '0';
      ondeltaDiff = '0';
      description = '';
    } catch (error) {
      console.error('Failed to send settlement:', error);
      alert(`Failed: ${(error as Error)?.message}`);
    } finally {
      sending = false;
    }
  }
</script>

<div class="settlement-panel">
  <h3>Settlement (Reserve ⇄ Collateral)</h3>

  <div class="form-group">
    <label>Counterparty</label>
    <select bind:value={counterpartyEntityId} disabled={sending}>
      <option value="">Select entity...</option>
      {#each allEntities as id}
        <option value={id}>Entity #{id.slice(0, 10)}...</option>
      {/each}
    </select>
  </div>

  <div class="form-group">
    <label>Token</label>
    <select bind:value={tokenId} disabled={sending}>
      <option value={1}>ETH</option>
      <option value={2}>USDC</option>
    </select>
  </div>

  <!-- 4-Diff Inputs -->
  <div class="diffs-section">
    <div class="form-group">
      <label>Left Diff</label>
      <input type="text" bind:value={leftDiff} disabled={sending} />
    </div>

    <div class="form-group">
      <label>Right Diff</label>
      <input type="text" bind:value={rightDiff} disabled={sending} />
    </div>

    <div class="form-group">
      <label>Collateral Diff</label>
      <input type="text" bind:value={collateralDiff} disabled={sending} />
    </div>

    <div class="form-group">
      <label>Ondelta Diff</label>
      <input type="text" bind:value={ondeltaDiff} disabled={sending} />
    </div>
  </div>

  <!-- Invariant Validation Display -->
  <div class="invariant-check" class:valid={invariantValid} class:invalid={!invariantValid}>
    <strong>Invariant Check:</strong>
    {leftDiff} + {rightDiff} + {collateralDiff} = {invariantSum.toString()}
    {#if invariantValid}
      <span class="badge valid">✅ Valid</span>
    {:else}
      <span class="badge invalid">❌ Must equal 0</span>
    {/if}
  </div>

  <!-- Preset Templates -->
  <div class="presets">
    <button on:click={() => fundFromReserve('1000000')} disabled={!counterpartyEntityId || sending}>
      Fund 1M from Reserve
    </button>
    <button on:click={() => withdrawToReserve('500000')} disabled={!counterpartyEntityId || sending}>
      Withdraw 500k to Reserve
    </button>
  </div>

  <div class="form-group">
    <label>Description</label>
    <input type="text" bind:value={description} placeholder="Optional description" disabled={sending} />
  </div>

  <button
    class="btn-send"
    on:click={sendSettlement}
    disabled={!counterpartyEntityId || !invariantValid || sending}
  >
    {#if sending}
      Sending Settlement...
    {:else}
      Send Settlement
    {/if}
  </button>
</div>

<style>
  .settlement-panel {
    padding: 16px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  .diffs-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }

  .invariant-check {
    padding: 12px;
    margin-bottom: 12px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.9em;
  }

  .invariant-check.valid {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    color: #10b981;
  }

  .invariant-check.invalid {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }

  .badge {
    margin-left: 8px;
    padding: 2px 6px;
    border-radius: 2px;
    font-size: 0.8em;
  }

  .presets {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .presets button {
    flex: 1;
    padding: 6px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #9d9d9d;
    font-size: 0.85em;
    cursor: pointer;
  }

  .presets button:hover:not(:disabled) {
    background: #333;
    border-color: #007acc;
  }

  .btn-send {
    width: 100%;
    padding: 8px;
    background: #10b981;
    border: none;
    border-radius: 4px;
    color: white;
    cursor: pointer;
  }

  .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
```

### **Step 5: Integration Flow**

The end-to-end flow:

```
1. User fills SettlementPanel form
   ↓
2. UI validates invariant (leftDiff + rightDiff + collateralDiff = 0)
   ↓
3. EntityTx 'settleDiffs' created and sent to entity replica
   ↓
4. Handler in apply.ts validates invariant again (fail-fast)
   ↓
5. Handler calls evm.callDepositorySettle()
   ↓
6. Blockchain processes Depository.settle() transaction
   ↓
7. SettlementProcessed event emitted
   ↓
8. j-event-watcher catches event (ALREADY WORKING - see line 333-356)
   ↓
9. j-event-watcher creates 'account_settle' AccountTx
   ↓
10. AccountTx processed → account.deltas.collateral updated
    ↓
11. UI automatically updates via server frames
```

**Critical**: No manual state updates needed in handler - j-watcher handles everything!

### **Step 6: Testing Plan**

1. **Unit test invariant validation**:
   - Valid: `-100 + 0 + 100 = 0` ✅
   - Invalid: `-100 + 0 + 50 = -50` ❌ Should throw

2. **Integration test fund from reserve**:
   - Entity 1 funds 1M USDC to collateral with Entity 2
   - Check reserve decreases by 1M
   - Check collateral increases by 1M
   - Verify j-watcher processes SettlementProcessed event

3. **Integration test withdraw to reserve**:
   - Entity 1 withdraws 500k USDC from collateral to reserve
   - Check collateral decreases by 500k
   - Check reserve increases by 500k

4. **Test bilateral settlement**:
   - Both entities fund 500k each (leftDiff=-500k, rightDiff=-500k, collateralDiff=+1M)
   - Verify both reserves decrease
   - Verify collateral increases by combined amount

### **Implementation Order**

1. ✅ Add `settleDiffs` EntityTx type to `types.ts`
2. ✅ Create `callDepositorySettle()` in `evm.ts`
3. ✅ Add handler in `entity-tx/apply.ts` with invariant validation
4. ✅ Create `SettlementPanel.svelte` UI component
5. ✅ Add SettlementPanel to EntityPanel tabs
6. ✅ Test end-to-end flow with local blockchain
7. ✅ Verify j-watcher integration works (should already work!)

**Estimated effort**: 3-4 hours for full implementation + testing.