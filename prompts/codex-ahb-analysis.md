# Deep Analysis Request: XLN AHB Scenario & R→E→A→J Flow

## Context
You're analyzing XLN (Cross-Local Network), a financial settlement protocol that combines:
- BFT consensus (entity-level)
- Bilateral consensus (account-level)
- EVM integration (jurisdiction-level)
- Real-time event emission

## Your Task (1+ hour deep dive)

Perform **forensic-level analysis** of the Alice-Hub-Bob scenario and underlying R→E→A→J architecture. This is NOT a code review - this is **architecture validation for a financial protocol**.

## Files to Analyze (Read in Order)

### Phase 1: Understand the Flow (20 min)
1. `runtime/types.ts` (lines 1-165) - R→E→A→J message flow documentation
2. `runtime/scenarios/ahb.ts` (full file, ~1561 lines) - The scenario implementation
3. `runtime/runtime.ts` (lines 372-784, 1517-1650) - applyRuntimeInput + process() tick

### Phase 2: Trace Execution Paths (30 min)
4. `runtime/entity-consensus.ts` (lines 180-674) - E-layer BFT consensus
5. `runtime/account-consensus.ts` (lines 112-613) - A-layer bilateral consensus
6. `runtime/entity-tx/apply.ts` - Entity transaction dispatcher
7. `runtime/account-tx/apply.ts` - Account transaction dispatcher
8. `runtime/entity-tx/handlers/j-broadcast.ts` - E→J mempool queuing
9. `runtime/j-batch.ts` (lines 1-150) - Batch accumulation system

### Phase 3: J-Layer Integration (20 min)
10. `runtime/runtime.ts` (lines 1565-1650) - J-machine block processor
11. `runtime/evms/browser-evm.ts` - BrowserVM execution
12. `runtime/j-event-watcher.ts` - J→E event routing

### Phase 4: Frontend Visualization (15 min)
13. `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 762-936) - Yellow cube rendering
14. `frontend/src/lib/view/panels/JurisdictionPanel.svelte` (lines 327-363) - Mempool table
15. `frontend/src/lib/view/panels/RuntimeIOPanel.svelte` (lines 195-258) - Event stack viewer

## Critical Questions to Answer

### Architecture Correctness
1. **No State Injection?** Verify AHB scenario uses ZERO manual state mutations. Every change must flow through:
   - `process(env, [{entityId, signerId, entityTxs}])` for E-layer
   - ~~`jReplica.mempool.push()`~~ ❌ FORBIDDEN
   - ~~`browserVM.reserveToReserve()`~~ ❌ FORBIDDEN
   - All J-operations via `j_broadcast` EntityTx

2. **Solvency Conservation?** Track `reserves + collateral` across all 24 frames. Must be constant (10M). Check:
   - Frame 1-5: 10M in reserves, 0 in collateral
   - Frame 6+: reserves + collateral = 10M
   - Any frame where sum ≠ 10M = money creation bug

3. **J-Block Counter Correctness?** Should increment ONLY when processing mempool:
   - NOT on every runtime tick
   - ONLY when `elapsed >= blockDelayMs` AND `mempool.length > 0`
   - Expected: 3 J-blocks (not 24)

4. **Deterministic Time?** Verify scenarios use:
   - `env.timestamp += delay` (manual advance)
   - NO `await sleep()` or `Date.now()` after initial setup
   - Time must be reproducible across runs

### Flow Integrity

5. **R2R Flow (Reserve-to-Reserve):**
   ```
   Hub sends reserve_to_reserve EntityTx
   → Handler adds to Hub.jBatchState
   → Hub sends j_broadcast EntityTx
   → jBatch queues to jReplica.mempool (YELLOW CUBE)
   → J-processor executes after blockDelayMs
   → BrowserVM emits ReserveUpdated events
   → j-watcher routes to Alice/Bob entities
   → Entity state updated
   ```
   **Verify:** Each step uses proper APIs, no shortcuts.

6. **R2C Flow (Reserve-to-Collateral):**
   ```
   Alice sends deposit_collateral EntityTx
   → Handler adds to Alice.jBatchState
   → Alice sends j_broadcast EntityTx
   → Batch queues to J-mempool
   → J-processor executes
   → BrowserVM emits AccountSettled event
   → Account collateral updated
   ```
   **Verify:** Collateral appears in `delta.collateral`, not manually set.

7. **Settlement Flow (Rebalancing):**
   ```
   Hub creates unified batch (2 settlements):
     - Alice-Hub: collateralDiff = -200K (withdraw)
     - Hub-Bob: collateralDiff = +200K (deposit)
   → batchAddSettlement() for BOTH
   → j_broadcast sends SINGLE batch
   → J-processor executes atomically
   → Hub reserve net zero (pulled 200K, deposited 200K)
   ```
   **Verify:** ONE batch, TWO settlements, atomic execution.

### Event System

8. **Event Emission:** Find all `env.emit()` calls. Should cover:
   - RuntimeTick
   - EntityFrameCommitted
   - BilateralFrameCommitted
   - JEventReceived
   - JBatchQueued
   - JBlockProcessing
   - JBlockFinalized
   - ReserveUpdated (with old/new/delta)
   - AccountOpening
   - PaymentInitiated

   **Verify:** Events stored in `env.frameLogs[]`, travel with snapshots.

9. **Event Accessibility:** Check if events are queryable/filterable in RuntimeIOPanel.

### Bilateral Consensus

10. **Counter-Based Replay Protection:**
    ```typescript
    accountInput.counter = accountMachine.ackedTransitions + 1
    ```
    **Verify:** Counter is SEQUENTIAL (no gaps), validated on receive.

11. **Left/Right Determinism:**
    ```typescript
    const isLeft = entityId < counterpartyId;
    const side = isLeft ? 'right' : 'left'; // Credit I extend to THEM
    ```
    **Verify:** Canonical ordering consistent, credit limits set correctly.

12. **Frame Chain Linkage:**
    ```typescript
    frame.prevFrameHash = accountMachine.currentFrame.stateHash || 'genesis';
    ```
    **Verify:** Frames form chain (prevents reordering).

### Visual Feedback

13. **Yellow Cube Labels:** Should show:
    - `E2: 2R2R` - Hub batch with 2 R2R transfers (yellow text)
    - `E1: +1R2C` - Alice R2C deposit (GREEN text)
    - `E2: -1W +1D` - Rebalancing: 1 withdrawal (RED), 1 deposit (GREEN)

    **Verify:** Color coding in `createTxLabelSprite()` function.

14. **Mempool Timing:** Yellow cubes should:
    - Appear when `j_broadcast` executes
    - Persist for `blockDelayMs` (300ms)
    - Disappear when J-processor runs
    - NOT appear if batch executes immediately

## Output Format

Provide:

1. **Executive Summary** (5 bullet points max)
   - Overall architecture assessment
   - Critical flaws found (if any)
   - Security concerns (if any)

2. **Flow Validation Matrix**
   ```
   R2R Flow:      ✅/❌  [reason if fail]
   R2C Flow:      ✅/❌
   Settlement:    ✅/❌
   Solvency:      ✅/❌
   J-Blocks:      ✅/❌
   Determinism:   ✅/❌
   Events:        ✅/❌
   Bilateral:     ✅/❌
   Visualization: ✅/❌
   ```

3. **Code Smells Found** (if any)
   - Manual state mutations
   - Hardcoded values that should be dynamic
   - Race conditions
   - Missing validations

4. **Brilliant Patterns** (highlight 3-5 things done RIGHT)

5. **Suggested Improvements** (ranked by priority)
   - P0: Breaks correctness
   - P1: Hurts auditability
   - P2: Nice-to-have

## Success Criteria

Your analysis passes if you can answer:

- **Can an 18-year-old hacker steal money?** (Where/how?)
- **Can the system create/destroy tokens?** (Prove conservation law holds)
- **Can entities fork bilateral state?** (How is fork prevented?)
- **Can J-blocks be reordered?** (What ensures causal ordering?)
- **Can you replay the scenario byte-for-byte?** (Is it deterministic?)

## Time Budget

- **20 min:** Read flow documentation + AHB scenario
- **30 min:** Trace R2R, R2C, Settlement execution paths
- **15 min:** Validate J-layer integration + event system
- **15 min:** Check frontend visualization correctness
- **10 min:** Write findings

Total: ~90 minutes for thorough analysis.

## Constraints

- Assume you have NO prior knowledge of XLN
- Read code as if auditing for financial institution
- Flag ANYTHING that looks like a shortcut/hack
- Verify EVERY assertion in ahb.ts actually validates what it claims
- Check if visual feedback matches reality (yellow cubes = actual mempool state)

## Deliverables

1. Markdown report with validation matrix
2. List of every `env.emit()` call found (with line numbers)
3. Proof that solvency holds (show calculation for 3 random frames)
4. Assessment: "Would you trust $1B on this?" (yes/no + why)

---

**Start with types.ts message flow diagram. End with "Would you deploy this to mainnet?"**
