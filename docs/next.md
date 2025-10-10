# Next Steps & Strategic Focus

**Last Updated:** 2025-10-10

---

## 🎯 Strategic Vision

### **XLN Scope: B2B + B2E + E2E**

**NOT just wholesale settlement.** XLN is the complete payment stack:

- **B2B:** Corporate treasury, cross-border, wholesale settlement
- **B2E:** Payroll, expenses (employees get credit limits from employer)
- **E2E:** Personal payments, rent, friend IOUs, subscriptions

**One person, one account with:**
- Employer (salary + expense credit)
- Landlord (rent + security deposit as collateral)
- Friends (trust-based credit limits)
- Businesses (subscriptions with credit terms)

**All using same protocol. All sovereign. All with credit+collateral hybrid.**

### **Target: 51% of Electronic Payment Volume**

**Not 51% of wholesale. 51% of EVERYTHING:**
- Visa/MC ($10T+/year)
- PayPal/Venmo/Zelle ($1.5T+/year)
- Remittances ($800B/year)
- Personal credit relationships (unmeasured)

**Timeline: ~2042-2045** (20 years from 2017 idea publication)

**Path:**
- 2025-2027: Developer adoption (Lightning integrations)
- 2027-2030: Consumer fintech apps
- 2030-2035: Network effects
- 2035-2045: Becomes payment infrastructure

**Like TCP/IP:** Users won't know XLN exists. Apps just use it.

---

## 🔥 PRIMARY FOCUS: Graph 3D/VR + Embeds

### **Strategic Decision (2025-10-10)**

**Focus ALL energy on:**
1. **Graph 3D visualization** - The "holy shit" moment
2. **VR experience** - Unique differentiator
3. **Embeddable scenarios** - Viral distribution

**Postpone:**
- ❌ Graph 2D (removed from codebase)
- ⏸️ Terminal view (developer tool, not growth lever)
- ⏸️ Panels view (useful but not hook)

**Why Graph 3D?**
- First 30 seconds matter - text doesn't convince
- "Credit where it scales, collateral where it secures" is abstract
- **Watching** value flow through 3D grid makes it visceral
- Embeds = distribution engine (blog posts, docs, Twitter)
- VR = unique positioning

---

## ✅ Completed (2025-10-10 Session)

### Documentation System
- ✅ Consolidated /docs (55→46 files, organized directories)
- ✅ Integrated DocsView into main app
- ✅ Markdown rendering with sidebar navigation
- ✅ Auto-copy docs on dev startup
- ✅ Search functionality

### Infrastructure
- ✅ HTTPS dev server (localhost:8080, valid certs until 2028)
- ✅ RPC proxy (/rpc/ethereum → HTTP Hardhat)
- ✅ Fixed mixed content issues (HTTPS ↔ HTTP)
- ✅ J-watcher connected via proxy

### Embeddable Scenarios
- ✅ IsolatedScenarioPlayer component (fully isolated state)
- ✅ YouTube-style playback controls
- ✅ Fast execution mode (tickInterval: 0)
- ✅ Multiple instances supported
- ✅ /embed route for external iframes
- ✅ Embedded in Docs intro page

### Time Machine Redesign
- ✅ Ultra-compact single-row layout
- ✅ Separate Time (m:ss.ms) / Runtime (frames) / FPS
- ✅ Loop modes (off/all/slice)
- ✅ Slice markers with visual indicators
- ✅ Speed dropdown (0.1x-10x)
- ✅ Export menu (JSON/URL/GIF)
- ✅ Keyboard shortcuts
- ✅ Apple liquid glass aesthetic

### Codebase Cleanup
- ✅ Removed Graph 2D from viewMode
- ✅ Renamed "Server" → "Runtime" in time machine
- ✅ Fixed time machine positioning (bottom of viewport)

---

## 🔴 Critical TODOs - Graph 3D Polish

### **1. Fix Grid Positioning**

**Status:** IsolatedScenarioPlayer shows circle, not cube
**Impact:** Main demo broken

**Issue:**
```typescript
// Current: Radial layout (wrong)
const angle = (i / entities.size) * Math.PI * 2;
position = (cos(angle) * radius, 0, sin(angle) * radius);

// Needed: Use gridPosition from profile
position = profile.gridPosition || fallback;
```

**Implementation:**
1. Verify `grid 2 2 2` command populates `profile.gridPosition`
2. Update IsolatedScenarioPlayer renderFrame() to use gridPosition
3. Add fallback: if no gridPosition, use radial

**Estimate:** 1 hour
**Priority:** CRITICAL (main embed broken)

---

### **2. Build 10 Killer Scenarios**

**Status:** Only 3 scenarios exist (h-network, diamond-dybvig, phantom-grid)
**Impact:** Limited embed content

**Needed scenarios:**
1. ✅ Diamond-Dybvig (bank run)
2. ✅ Phantom Grid (cube demo)
3. ❌ Lightning Inbound Liquidity Failure
4. ❌ XLN Credit Extension Solution
5. ❌ Multi-Hop Routing
6. ❌ Hub Liquidity Crisis
7. ❌ Bilateral Settlement
8. ❌ Credit-Collateral Rebalancing
9. ❌ Collateral Backstop Demo
10. ❌ Multi-Jurisdiction Flow

**Each scenario:**
- ~30 lines DSL
- Clear narrative (title + description per frame)
- 10-30 frames
- Embeddable in docs

**Estimate:** 8 hours (all 10)
**Priority:** HIGH (needed for docs, blog posts, demos)

---

### **3. Entity Labels & Balance Display**

**Status:** Entities show as unlabeled spheres
**Impact:** Can't tell what's happening

**Implementation:**
```typescript
// Add to IsolatedScenarioPlayer renderFrame()
const label = createTextSprite(
  `${profile.name}\n${formatBalance(profile.balance)}`
);
label.position.set(mesh.position.x, mesh.position.y + 8, mesh.position.z);
scene.add(label);
```

**Show on labels:**
- Entity number/name
- Current balance (if >0)
- Hub indicator (⭐ emoji)

**Estimate:** 2 hours
**Priority:** HIGH (readability)

---

### **4. Account Connection Bars**

**Status:** No visual connection between entities
**Impact:** Can't see relationships/flows

**Implementation:**
- Use AccountManager from network3d/ (already extracted)
- Show bars with capacity visualization
- Color-code by delta (green=positive, red=negative)
- Animate on payment events

**Estimate:** 3 hours
**Priority:** MEDIUM (polish)

---

### **5. Camera Presets Per Scenario**

**Status:** Fixed camera angle, not optimized per scenario
**Impact:** Some scenarios show poorly

**Implementation:**
```typescript
// In scenario DSL:
0: Setup
grid 2 2 2
VIEW camera=isometric zoom=1.5

1: Payment
alice pay bob 100
VIEW camera=follow entity=alice
```

**Camera modes:**
- `orbital` - Default orbit around center
- `isometric` - 45° angle (best for cubes)
- `follow` - Track specific entity
- `overview` - Zoom out for full network

**Estimate:** 2 hours
**Priority:** MEDIUM (UX polish)

---

### **6. Narrative Subtitles**

**Status:** Exists but not used in embeds
**Impact:** Missing storytelling

**Implementation:**
- Enable NarrativeSubtitle in IsolatedScenarioPlayer
- Each scenario frame has `narrative` field
- Show as caption below 3D view

**Estimate:** 1 hour
**Priority:** MEDIUM (storytelling)

---

## 🚀 Next Feature: Multi-View Embeddable Player

### **Concept**

Instead of 3D-only, embed FULL xlnomy with view switching:

```
┌─────────────────────────────────────┐
│ 3D │ Panels │ Terminal │            │
├─────────────────────────────────────┤
│  [Current view synchronized to      │
│   same timeline]                    │
├─────────────────────────────────────┤
│ ⏮ ◀ ▶ ⏭ │ Time Machine │ 1.0x │ LIVE│
└─────────────────────────────────────┘
```

**Why:**
- **3D**: See topology
- **Panels**: See user's perspective (wallet balance)
- **Terminal**: See commands that generated this state
- **Same timeline**: All views sync to same frame

**Use case:**
Tutorial scenario with narrative:
- Frame 0 [3D]: "Alice and Hub connect"
- Frame 1 [Panel]: "Alice's wallet shows 100 USDC"
- Frame 2 [Terminal]: `alice pay hub 30`
- Frame 3 [Panel]: "Alice now has 70 USDC"

**Implementation:**
1. Extract Panel + Terminal views into embeddable components
2. Add tab switcher to IsolatedScenarioPlayer
3. All views share same `localEnv` and `localHistory`
4. Time machine controls all views

**Estimate:** 6 hours
**Priority:** HIGH (killer feature for interactive docs)

---

## 🟡 Important TODOs (Post-Graph-3D)

### **Backend: cooperativeClose**

**Status:** Still missing (was critical, now lower priority)
**Impact:** Can't close accounts gracefully

**Why lower priority now:**
- Graph 3D polish more important for adoption
- Can launch "Visual Demo" without full functionality
- Add cooperativeClose before production deployment

**Estimate:** 4-6 hours
**Priority:** Important, not urgent

---

### **Backend: Transaction Failure Tracking**

**Status:** Failed txs disappear silently
**Impact:** Poor UX

**Estimate:** 2 hours
**Priority:** Medium

---

### **Backend: Client-Side Dispute System**

**Status:** Contract has it, client doesn't
**Impact:** Can't challenge fraud

**Estimate:** 6-8 hours
**Priority:** Needed before mainnet

---

## 📋 Graph 3D Roadmap

### Phase 1: Core Polish (Week 1)
1. ✅ Embeddable architecture (IsolatedScenarioPlayer)
2. ✅ Fast execution (tickInterval: 0)
3. ❌ Fix grid positioning
4. ❌ Entity labels
5. ❌ OrbitControls integration

### Phase 2: Visual Quality (Week 2)
6. ❌ Account connection bars
7. ❌ Balance animations
8. ❌ Camera presets
9. ❌ Narrative subtitles
10. ❌ Smooth transitions

### Phase 3: Content Creation (Week 3)
11. ❌ Build 10 killer scenarios
12. ❌ Embed in all comparison docs
13. ❌ Blog post: "Why Lightning Failed (Interactive)"
14. ❌ Twitter demos

### Phase 4: Multi-View Player (Week 4)
15. ❌ 3D + Panels + Terminal in one embed
16. ❌ View switching with shared timeline
17. ❌ Tutorial scenarios with multi-view narratives

---

## 🛠️ Development Tooling

### Dev Workflow
- ✅ HTTPS localhost:8080
- ✅ RPC proxy working
- ✅ Auto-rebuild with dev-full.sh
- ✅ Time machine with keyboard shortcuts

### Future Improvements
- ❌ Foundry migration (100x faster tests)
- ❌ Hardhat tracer (better debugging)

---

## 🎯 Success Criteria

### Visual Demo Ready (Next 2-3 weeks)
- ✅ Docs consolidated and accessible
- ✅ HTTPS + RPC proxy working
- ✅ Embeddable scenarios functional
- ❌ Grid positioning fixed
- ❌ 10 polished scenarios
- ❌ All comparison docs have embeds
- ❌ Multi-view player working

### Beta Deployment (After Graph 3D)
- All above +
- cooperativeClose implemented
- Transaction failures tracked
- Basic dispute UI

### Mainnet Ready (Later)
- All above +
- Full dispute system
- Security audit
- Multi-jurisdiction tested

---

## 🧠 Development Philosophy

**Current mode:** Not building for timeline - building for quality.

**8 years since idea publication.** No rush. Get Graph 3D **perfect** first.

**Why Graph 3D matters:**
- Can't explain "organizational layer" with text
- Can't show "credit+collateral hybrid" in static images
- Need people to **experience** value flowing through network
- Embeds = distribution without asking permission

**When Graph 3D is polished:**
- Every blog post has live demo
- Every comparison doc shows actual topology
- Every tweet can link to interactive example
- Docs become living tutorials

Then add backend features (cooperativeClose, disputes).

---

**Next session: Fix grid positioning + add entity labels → make first embed truly beautiful.**
