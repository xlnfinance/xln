# Next Session Tasks

## Completed (2025-11-28)

### TypeScript Refactoring - 42 errors → 0 errors
- Fixed undefined array access in `handGesturePayments.ts` (raycast intersects)
- Fixed Map.keys() type cast in `Graph3DPanel.svelte`
- Fixed GrabbableEntity type assertions in `Graph3DPanel.svelte`
- Fixed Uint8Array to ArrayBuffer conversion in `BrainVaultView.svelte`
- Fixed async onMount pattern in `BrainVaultView.svelte` (wrap in IIFE, return sync cleanup)
- Fixed null coalescing in `Tutorial.svelte` and `XLNTutorial.svelte`
- Fixed function name `startPaymentLoop` → `startFedPaymentLoop` in `ArchitectPanel.svelte`
- Fixed type-only import for Page in `fed-chair-demo.spec.ts`
- Added Window.XLN declaration for Playwright tests

### /vault Layout Fix
- Removed padding from vault page container
- Fixed BrainVaultView scroll: `overflow: hidden` → `overflow-y: auto`
- Changed `height: 100vh` → `min-height: 100vh`

---

## Split-Screen Broadcast vs Unicast Visualization

### Goal
Painfully obvious visual proof that Broadcast O(n) dies at scale, Unicast O(1) doesn't.

### Visual Concept

#### LEFT: Broadcast O(n) - "What Everyone Else Does"
```
[Blockchain growing at top - visible chain of blocks]
        ↓
[J-Machine Square - "Global Consensus Layer"]
  Every 5 sec: New block → RAY-CAST to ALL nodes below
        ↓ ↓ ↓ ↓ ↓ ↓ ↓ (literal rays/connections to every node)

[Hardware Tiers - Bottom]
📱 Phones (10 nodes)      - Max capacity: 10 TPS
💻 Laptops (20 nodes)     - Max capacity: 100 TPS
🏢 Datacenters (5 nodes)  - Max capacity: 1000 TPS

TPS Ramping:
• 1 TPS:   All green ✓
• 10 TPS:  Phones yellow (struggling), some go offline → "syncing..."
• 100 TPS: Phones RED (dead/pruned), Laptops yellow
• 1K TPS:  Only datacenters survive → CENTRALIZATION
• 1M TPS:  💥 Complete failure, all nodes dead

Offline behavior:
- Node goes gray, shows "syncing..."
- Must catch up on all missed blocks
- Phones/laptops give up (can't sync fast enough) → "pruned node"
```

#### RIGHT: Unicast O(1) - "What xln Does"
```
[Same blockchain at top - only 1 TPS always]
        ↓
[Hub-Spoke Layer - Netting]
  L2 bilateral txs (fast dots between users+hubs)
  Only periodic rebalancing hits J-layer
        ↓ (single ray - constant rate)
[J-Machine Square]

[Same Hardware Tiers]
📱💻🏢 All stay GREEN regardless of L2 TPS

TPS Ramping:
• 1 L2 TPS:    → 1 L1 TPS    ✓
• 1M L2 TPS:   → 1 L1 TPS    ✓ (still!)
• ∞ L2 TPS:    → 1 L1 TPS    ✓

Key message: L1 rate is CONSTANT (netting layer absorbs all L2 traffic)
```

### Implementation Details

#### Hardware Primitives (COMPLETED)
✅ Created all 4 device SVGs with embedded EVM logos:
- 📱 `phone.svg` - ~10 TPS capacity
- 💻 `laptop.svg` - ~100 TPS capacity
- 🖥️ `server.svg` - ~1K TPS capacity
- 🏢 `datacenter.svg` - ~100K TPS capacity

✅ All use `fill="currentColor"` for dynamic theming
✅ EVM logo embedded inside each device (scaled, centered)

#### J-Machine Block Representation
- Square block (like in screenshot)
- Shows block number: #204
- Ray-cast animation: Lines shoot from block to all nodes below
- On LEFT: Rays multiply with TPS
- On RIGHT: Single ray, constant rate

#### Node Death Behavior
```javascript
// Pseudocode
if (currentTPS > node.maxCapacity) {
  node.health -= (currentTPS - node.maxCapacity) / 10;
  if (node.health < 50) node.color = 'yellow'; // Struggling
  if (node.health < 20) node.color = 'red';    // Critical
  if (node.health <= 0) {
    node.status = 'offline';
    node.syncing = true; // Try to catch up
    if (node.type === 'phone' && currentTPS > 100) {
      node.status = 'pruned'; // Gave up, not a full node anymore
    }
  }
}
```

#### Syncing Animation
- Gray out node
- Show "syncing..." label
- Progress bar catching up on blocks
- Phones give up faster than laptops
- Datacenters persist longest

#### Blockchain at Top
- Horizontal chain of blocks growing left-to-right
- Each block shows number
- Every 5 seconds: New block appears + ray-cast animation
- LEFT: Ray count = node count (O(n))
- RIGHT: Ray count = 1 (O(1) to netting layer)

### Tech Stack Decision

**Option A: Pure Canvas API** (Recommended)
- Lightweight (~200 lines for each side)
- Full control over animations
- No dependencies
- Fast render

**Option B: Adapt .archive/visualization.js**
- 1000 lines of D3.js
- Already has hub-spoke working
- Would need LEFT side built from scratch anyway
- Heavy dependency

**Option C: SVG + CSS animations**
- Lightest bundle
- Limited particle effects
- Good enough for concept

**My recommendation: Option A (Canvas)** because:
- We're building LEFT from scratch either way
- RIGHT is simpler than archive (no controls needed)
- Can share rendering utilities between LEFT/RIGHT
- Total: ~300-400 lines for both sides

### RADIAL BROADCAST EVOLUTION (Next Implementation)

### Visual Design: The Centralization Death Spiral

**Layout:** Concentric circles radiating from center (J-Machine)

```
         [J-Machine Block at Center]
                ↓ Broadcasts to all ↓

   Ring 1 (closest): 🏢 Datacenters (4 nodes)
   Ring 2: 🖥️ Servers (8 nodes)
   Ring 3: 💻 Laptops (12 nodes)
   Ring 4 (outer): 📱 Phones (20 nodes)
```

### Evolution by TPS Stage:

**1 TPS (Stage 1):**
- All 44 nodes: Green, equal participants
- Full decentralization ✓
- Every node is a full J-machine validator

**10 TPS (Stage 2):**
- Phones (outer ring) turn gray → "RPC zombies"
- Dotted lines from zombies → point to datacenters
- Visual: Outer ring fades to 30% opacity
- Caption: "Phones give up, become RPC clients (trust datacenters)"

**100 TPS (Stage 3):**
- Laptops die → RPC zombies → lines to datacenters
- Servers/Datacenters still green
- Visual: Network radius shrinks (only inner 2 rings visible)
- Caption: "Consumer hardware eliminated"

**1K TPS (Stage 4):**
- Servers die → RPC zombies
- Only datacenters green (4 nodes in center)
- Visual: Tiny network, 4 nodes total
- Caption: "Datacenter-only = Centralization"

**10K+ TPS (Stage 5):**
- Jail grid overlay on datacenters (SVG pattern)
- All 4 datacenters: Red border, locked icon
- Caption: "Censorable, regulatable, game over"
- Visual: Prison bars over the only 4 remaining validators

### Technical Implementation:

**Radial Positioning:**
```javascript
const rings = [
  { tier: 'datacenter', count: 4, radius: 60, maxTPS: 100000 },
  { tier: 'server', count: 8, radius: 120, maxTPS: 1000 },
  { tier: 'laptop', count: 12, radius: 180, maxTPS: 100 },
  { tier: 'phone', count: 20, radius: 240, maxTPS: 10 },
];

rings.forEach(ring => {
  for (let i = 0; i < ring.count; i++) {
    const angle = (i / ring.count) * 2 * Math.PI;
    const x = centerX + ring.radius * Math.cos(angle);
    const y = centerY + ring.radius * Math.sin(angle);
    // Create node at (x, y)
  }
});
```

**RPC Zombie Visual:**
```svg
<!-- Dead node pointing to datacenter -->
<circle cx={zombieX} cy={zombieY} r="6" fill="#666" opacity="0.4"/>
<line x1={zombieX} y1={zombieY} x2={datacenterX} y2={datacenterY}
      stroke="rgba(255,255,255,0.15)" stroke-dasharray="2 2" stroke-width="1"/>
```

**Jail Grid Pattern:**
```svg
<defs>
  <pattern id="jail-bars" width="10" height="30" patternUnits="userSpaceOnUse">
    <rect width="3" height="30" fill="#888"/>
  </pattern>
</defs>

<!-- Overlay on censored datacenters -->
<rect x={dcX - 20} y={dcY - 20} width="40" height="40"
      fill="url(#jail-bars)" opacity="0.6"/>
```

### Animation Sequence:
1. Start at 1 TPS - show full radial network (all green)
2. Auto-ramp every 8 seconds: 1 → 10 → 100 → 1K → 10K → 100K → 1M
3. As TPS increases:
   - Outer rings fade/die sequentially
   - Radius visually contracts (zoom in to center)
   - Living nodes grow slightly (emphasize remaining validators)
   - Dead nodes spawn dotted lines to datacenters
4. Final stage: Jail bars overlay on last 4 nodes
5. Loop back to 1 TPS, reset

### Tech Stack: SVG (Final Decision)
- Use our device SVG primitives directly
- CSS transitions for smooth fading
- SVG patterns for jail bars
- Lighter than Canvas, easier to maintain

### Questions for Next Session:

1. **Blockchain at top:** Horizontal chain showing finalized blocks? Or just current block number?
2. **Ray-cast visual:** Should we animate rays from J-Machine to all nodes on each block? Or just show dotted connections?
3. **Ghost vs disappear:** Keep dead nodes visible (educational) or remove them (cleaner)?
4. **Mobile layout:** Stack broadcast/unicast vertically or make single view switchable?

### Current Status (After Session):
- ✅ 100 nodes (70% phones, 24% laptops, 5% servers, 1% datacenter)
- ✅ TPS slider (manual 1-1000 + auto-ramp mode)
- ✅ Blockchain visualization (consensus block fills 0/10 → 10/10, then finalizes)
- ✅ Finalized blocks move to historical chain (left side)
- ✅ Device health degradation on broadcast side
- ✅ Jail bars pattern for datacenter censorship (at 10K+ TPS)
- ✅ RPC zombie lines (dead nodes → datacenter)
- ✅ Mirrored layout (broadcast/unicast identical starting positions)

### Low-Hanging Fruit (Next Session):

**Critical Missing Features:**
1. **Raycast O(n) animation** (15 min) - When block finalizes, ALL alive nodes raycast to it
   - Draw lines from each node to finalized block
   - Animate sequentially (show it's O(n) operations)
   - This PROVES the broadcast bottleneck visually

2. **Random tx submission** (10 min) - Nodes randomly send tx to consensus block
   - Small dots flying from random nodes → consensus block
   - Rate based on current TPS
   - Shows network activity

3. **Random uptime (16/5 vs 24/7)** (20 min)
   - Phones/laptops: Randomly go offline even at low TPS
   - Show "offline" → "syncing..." → back online (if can catch up)
   - Datacenters: Always online
   - This shows uptime is also a centralizing force

**Polish:**
4. **Remove netting visual from broadcast side** (2 min) - It's xln-only, confusing on broadcast
5. **Better jail bars** (5 min) - Only show when ONLY datacenters remain alive
6. **Consensus block position** (5 min) - Move to top-right (like sketch shows)
7. **Finalized chain scrolls** (5 min) - Horizontal scroll showing historical blocks

**Visual Improvements:**
8. **Device death animation** (10 min) - Fade out + shake when dying
9. **Health bars** (10 min) - Show device health as small bar below icon
10. **TPS impact zones** (5 min) - Color-code zones (green <10, yellow <100, red >100)

**Total Low-Hanging:** ~90 minutes for full polish

### Priority Order:
1. **Raycast animation** - This is THE killer feature (proves O(n) visually)
2. **Random tx submission** - Makes it feel alive
3. **Random uptime** - Shows second dimension of centralization
4. Remove netting from broadcast
5. Everything else is polish