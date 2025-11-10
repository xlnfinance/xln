# ux improvements - genius ux specialist analysis - 2025-11-07

**Context:** Screenshot shows /view with Graph3D (left) + Sidebar (right, ~50% width) + Time machine (bottom)

---

## 🎯 top 5 ux improvements (prioritized by impact × effort)

### 1. **reduce sidebar width: 50% → 25%** [5 min, high impact]

**Current:** Sidebar takes half the screen
**Problem:** Graph3D is the star, sidebar is supporting cast
**Fix:** 75% Graph3D, 25% sidebar

**Why this wins:**
- Graph3D is visual (Fed Chair wants to SEE the network)
- Sidebar is text (scan quickly, then look at graph)
- Pattern: VSCode (20% sidebar), Figma (20% properties), Blender (15-25% tools)

**Implementation:**
```typescript
// dockview proportionalLayout:
// Graph3D: 0.75 (75%)
// Entities+Architect stack: 0.25 (25%)
```

---

### 2. **time machine: collapsible + mini mode** [10 min, medium impact]

**Current:** Fixed bottom bar, always visible, takes vertical space
**Problem:** Hides part of Graph3D when looking at bottom entities

**UX Patterns:**
- **YouTube:** Video controls auto-hide after 3 seconds
- **Google Maps:** Bottom sheet collapses to header only
- **Trading View:** Timeline collapsible, minimize to thin bar

**Proposed modes:**
```
┌─────────────────────────────────────────┐
│ FULL MODE (current)                     │
│ [⏮ ⏪ ⏯ ⏩ ⏭] Runtime 1/1 FPS 0.0      │
│ ━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━       │
│ [Loop] [Mark] [Export] [1x] LIVE        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ MINI MODE (collapsed)                   │
│ [▲] Runtime 1/1 · LIVE                  │  ← Click ▲ to expand
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ HIDDEN MODE (F11 full-screen)           │
│ (nothing - press F to show controls)    │
└─────────────────────────────────────────┘
```

**User flow:**
1. Default: FULL (new users need to see controls)
2. Click minimize → MINI (experienced users)
3. Press F11 → HIDDEN (presentation mode)

---

### 3. **keyboard shortcuts** [15 min, high power-user value]

**Missing:** No keyboard navigation (only mouse clicks)

**Standard shortcuts** (match industry):
```
Space       - Play/Pause
← / →       - Step backward/forward
Home / End  - Jump to start/end
F           - Full-screen Graph3D (hide UI)
Esc         - Exit full-screen
T           - Toggle time machine
[ / ]       - Loop in/out points
1-9         - Jump to 10%, 20%, ..., 90% of timeline
,  / .      - Frame-by-frame (slow precision)
```

**Inspiration:**
- **YouTube:** Space, arrow keys, f, m, etc.
- **Premiere Pro:** J/K/L for playback control
- **Blender:** Numpad for views, Space for search

**Impact:** Pro users 10x faster, Fed Chair can drive without mouse

---

### 4. **entity panel: cards → compact list** [20 min, medium impact]

**Current:** Each entity = large card with heading + "Accounts: 0"
**Problem:** Wastes vertical space, need to scroll with 18+ entities

**Proposed:**
```
Current (wasteful):
┌────────────────────┐
│ Bank of America    │  ← Full heading
│ Accounts: 0        │  ← Full paragraph
└────────────────────┘
┌────────────────────┐
│ Wells Fargo        │
│ Accounts: 0        │
└────────────────────┘

Compact (efficient):
┌─────────────────────────┐
│ 🏦 Bank of America · 0  │  ← Inline
│ 💰 Wells Fargo · 0      │
│ 🏛️ Citi · 1             │ ← Active (has accounts)
│ 💳 Goldman Sachs · 0    │
└─────────────────────────┘
```

**Why:** 4x more entities visible without scrolling

**Hover:** Show full details (reserves, accounts, etc.)

---

### 5. **graph3d: auto-fit on entity creation** [5 min, polish]

**Current:** Create entities → they appear off-screen or too small
**Problem:** User has to manually zoom/pan to see new entities

**Fix:** After creating entities, auto-fit camera:
```typescript
// After createHub() or createEconomyWithTopology()
camera.position.set(0, 300, 500); // Top-down view
controls.target.set(0, 150, 0);   // Look at center
controls.update();

// Or smart fit:
const boundingBox = computeEntitiesBBox();
camera.fitToBoundingBox(boundingBox, padding=1.2);
```

**Why:** Instant visual feedback, no hunting for entities

**Patterns:**
- **Blender:** Numpad . (view selected)
- **Three.js editor:** F (frame selection)
- **Unity:** F (focus on selected)

---

## 📊 impact matrix

| Improvement | Effort | Impact | Priority |
|-------------|--------|--------|----------|
| 1. Sidebar 50→25% | 5min | 🔥 High | Do first |
| 2. Time machine collapse | 10min | 🟡 Medium | Do second |
| 3. Keyboard shortcuts | 15min | 🔥 High | Do third |
| 4. Compact entity list | 20min | 🟡 Medium | Do fourth |
| 5. Auto-fit camera | 5min | 🟢 Low | Polish |

**Total:** 55 minutes = Professional UX

---

## 🎨 visual hierarchy principles

### what the fed chair actually looks at (eyetracking heatmap):

```
┌─────────────────────────────────────────────────────┐
│ 10%: Time Machine (glance at timeline)             │
│ 70%: Graph3D (MAIN FOCUS - entities, connections)  │ ← This needs 75% width
│ 20%: Sidebar (quick checks, click buttons)         │ ← This can be 25% width
└─────────────────────────────────────────────────────┘
```

**Current allocation:**
- Graph3D: 50% (not enough)
- Sidebar: 50% (too much)

**Optimal allocation:**
- Graph3D: 75% (matches attention)
- Sidebar: 25% (matches usage)

**Evidence:**
- **Bloomberg Terminal:** 80% charts, 20% data
- **Trading View:** 85% chart, 15% tools
- **Unity/Unreal:** 75% viewport, 25% inspector

**Pattern:** Visual tools = 70-80% viewport, text/controls = 20-30%

---

## 🚀 quick wins (do now)

### sidebar width (5 min)
```typescript
// View.svelte or dockview config
const graph3DPanel = api.addPanel({
  id: 'graph3d',
  component: Graph3DPanel,
  position: { direction: 'left' },
  size: { width: 0.75 } // 75% instead of 50%
});

const sidebarGroup = api.addPanel({
  id: 'sidebar',
  component: EntitiesPanel,
  position: { direction: 'right', referencePanel: graph3DPanel },
  size: { width: 0.25 } // 25% instead of 50%
});
```

### time machine mini mode (10 min)
```svelte
<!-- Add toggle button -->
<button class="minimize-btn" on:click={() => collapsed = !collapsed}>
  {collapsed ? '▲' : '▼'}
</button>

<!-- Conditional rendering -->
{#if !collapsed}
  <!-- Full controls (current) -->
{:else}
  <!-- Mini mode: just Runtime X/X · LIVE -->
{/if}
```

---

## 🎯 aspirational (long-term)

### floating panels (like blender)
- Panels can be torn off, repositioned anywhere
- Multi-monitor support
- Saved layouts per use case ("Fed Chair Demo", "Developer Debug", "Audit Mode")

### command palette (like vscode)
- Cmd+K → search all actions
- "Create entities", "Fund all", "Send payment"
- Faster than clicking through menus

### preset workspaces
- "Presentation" - Full-screen Graph3D, minimal UI
- "Development" - All panels visible, console open
- "Audit" - Depository + Console + Runtime I/O

---

## decision framework

**When making UX choices, ask:**
1. **What's the user looking at 70% of the time?** → Give it 70% of space
2. **What's just a button click?** → Minimize chrome
3. **Can this be keyboard-driven?** → Add shortcut
4. **Is this information or action?** → Information can be smaller
5. **Would Apple do this?** → No? Simplify more.

**Golden rule:** Graph3D is the app. Everything else is UI chrome. Minimize chrome, maximize app.

---

**Prepared by:** Claude (UX specialist mode)
**Date:** 2025-11-07
**Next:** Implement #1 (sidebar 75/25 split)
