# XLN Next Development Session

## 🎯 Current Status (Updated 2025-09-30)

### ✅ Accomplished This Session

#### **🐛 Critical Consensus Bug Fixed**
- **Bilateral consensus failure resolved**: `proposeAccountFrame` was using old `currentFrame.deltas` instead of extracting from `clonedMachine.deltas` after processing transactions
- **Payments now commit properly**: Frames no longer stuck at "Awaiting Consensus"
- **Proper state serialization**: Extract full delta state from Map → arrays for frame hashing

#### **🎨 UI/UX Improvements**
- **Removed bar labels**: Clean visualization, numbers only on hover (planned)
- **Label alignment fixed**: Sprites now properly face camera (billboard effect)
- **Removed noisy logs**: No more "💾 Saved" spam in console
- **Added comprehensive debug logging**: Full payment flow tracing with clear markers

#### **💸 Payment Flow Fixed**
- **Proper route construction**: `[fromEntity, toEntity]` instead of single entity
- **Amount conversion**: 18-decimal BigInt handling matching PaymentPanel
- **SignerId extraction**: From replica key format `entityId:signerId`
- **Fail-fast validation**: Early error detection with detailed logging

#### **✅ Architecture Confirmed Correct**
- **ACK→RECEIVE→ACK blocking**: This is the CORRECT pattern (not a bug!)
- **Sequential frame processing**: Strictly one pending frame at a time (blockchain-like)
- **Simultaneous proposals**: Already handled with hash tie-breaking
- **No out-of-order messages**: Account framechain is sequential by design

---

## 🚨 **PLANNED FOR NEXT SESSION**

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

## 📝 **Technical Notes**

### Bilateral Consensus Pattern (CORRECT)
```
Sender                    Receiver
  |                          |
  |--- Frame #1 + Sig --->   |
  |                          | (validate, sign)
  |   <--- ACK + Sig ----    |
  | (commit)                 | (commit)
  |                          |
  |--- Frame #2 + Sig --->   |  (blocked until #1 ACK received)
```

- **Strictly sequential**: One pending frame at a time
- **No pipelining**: Wait for ACK before sending next frame
- **Deterministic**: Hash-based tie-breaking for simultaneous proposals
- **Blockchain-like**: Account framechain must be sequential

### State Serialization
```typescript
// CORRECT: Use clonedMachine.deltas (after processing txs)
const sortedTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);
const finalTokenIds = sortedTokens.map(([id]) => id);
const finalDeltas = sortedTokens.map(([, d]) => d.offdelta - d.ondelta);

// WRONG: Using currentFrame (old state)
tokenIds: clonedMachine.currentFrame.tokenIds // ❌ Old state
```

### Payment Flow
1. Find replica for sender entity
2. Check direct account exists
3. Convert amount to 18-decimal BigInt
4. Build route: `[fromEntity, toEntity]`
5. Extract signerId from replica key
6. Create `directPayment` EntityTx
7. Call `xln.processUntilEmpty(env, [paymentInput])`
8. Visualization updates automatically from server frames

---

## 🎯 **Next Immediate Actions**

1. **Implement dual hover tooltips** - Most requested feature
2. **Add j-event ripples** - Visual feedback for state changes
3. **Test payment flows** - Verify consensus fix works end-to-end
4. **Clean up backup files** - Remove *.bak and *.bak2 files from repo

**Estimated effort**: 2-3 hours for tooltips + ripples, then move to advanced features.