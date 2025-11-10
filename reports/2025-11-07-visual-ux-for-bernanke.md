# visual ux for bernanke (fed chair) - 2025-11-07

**Problem:** Entities clustered in tight circle, J-Machine dominates, hard to grab entities

---

## 🎯 what fed chair needs to see

**Bernanke's mental model:**
```
Federal Reserve (top) - THE BOSS
    ↓
Big Four Banks (middle tier) - LIEUTENANTS
    ↓
Community Banks (lower tier) - LOCAL BRANCHES
    ↓
Customers (bottom) - THE PEOPLE
```

**Current visualization:** Tight circle, no hierarchy visible = CONFUSING

---

## ⚡ optimizations (priority order)

### 1. **j-machine pyramid: 2x smaller** [instant fix]
**Current:** Dominates the view
**Fix:** Scale pyramid 0.5x
**Why:** J-Machine is infrastructure, not the story

### 2. **entity size: 2-3x bigger** [instant fix]
**Current:** size: 0.5 - 1.5 (tiny, hard to click)
**Fix:** size: 1.0 - 4.0 (easy to grab)
**Why:** Fed Chair has old eyes, big fingers, needs BIG targets

### 3. **vertical spread: actual Y-position visible** [medium effort]
**Current:** All entities roughly same Y (hard to see layers)
**Fix:** Exaggerate Y-spacing
```
Federal Reserve: y=300 (way up high)
Big Four:        y=200 (middle)
Community:       y=100 (lower)
Customers:       y=0   (ground level)
```
**Why:** Visual hierarchy = instant understanding

### 4. **radial spoke pattern (not tight circle)** [medium effort]
**Current:** Entities cluster in circle
**Fix:** Spread like spokes of a wheel
```
        Fed (center, top)
       / | | | \
    Bank Bank Bank Bank  (radial, middle tier)
    / |    |    |  \
Cust Cust...Cust Cust  (radial, bottom tier)
```
**Why:** Shows connections clearly

### 5. **remove emoji labels for non-VR** [optional]
**Current:** Every entity has canvas texture with emoji
**Fix:** Only show emoji in VR, use simple spheres in desktop
**Why:** Texture rendering is expensive, spheres are instant

---

## 🚀 implementation

### quick wins (5 minutes)

```typescript
// ArchitectPanel.svelte - HYBRID topology

// 1. J-Machine smaller (in createHub or wherever J-Machine is created)
jMachine.scale.set(0.5, 0.5, 0.5); // 2x smaller

// 2. Entity sizes bigger
{ name: 'Federal Reserve', size: 4.0 },      // was 10.0 (actually REDUCE Fed, was too big)
{ name: 'Big Four Banks', size: 2.5 },       // was 1.5
{ name: 'Community Banks', size: 1.5 },      // was 0.8
{ name: 'Customers', size: 1.0 },            // was 0.5

// 3. Y-positions exaggerated
{ name: 'Federal Reserve', yPosition: 300 },  // was 220
{ name: 'Big Four Banks', yPosition: 200 },   // was 140
{ name: 'Community Banks', yPosition: 100 },  // was 80
{ name: 'Customers', yPosition: 0 },          // same

// 4. Radial spread (instead of circular clustering)
// Change xzSpacing to create radial spokes
// OR manually position in spoke pattern
```

---

## 🎨 visual hierarchy principles

**Rule:** Importance = Size + Height + Center proximity

### current (broken)
```
Everything clustered → Can't tell who's important
J-Machine huge → Distracts from entities
Tiny entities → Hard to interact
```

### after fix (ideal)
```
Fed: BIG, HIGH, CENTER → "This is the boss"
Big Banks: Medium, middle, around Fed → "These are the lieutenants"
Community: Small-medium, lower, spread out → "These are local branches"
Customers: Small, ground level, periphery → "These are the people"
J-Machine: Small, corner → "This is just infrastructure"
```

---

## 📊 before/after comparison

| Element | Before | After | Why |
|---------|--------|-------|-----|
| J-Machine size | 1.0 | 0.5 | Don't distract from entities |
| Fed size | 10.0 | 4.0 | Was comically huge |
| Big Bank size | 1.5 | 2.5 | Need to be grabbable |
| Community size | 0.8 | 1.5 | Need to be visible |
| Customer size | 0.5 | 1.0 | Need to be clickable |
| Fed Y-position | 220 | 300 | Emphasize hierarchy |
| Big Bank Y | 140 | 200 | Clear separation |
| Community Y | 80 | 100 | Clear tier |
| Grid lines | 200 | 20 | 10x faster rendering |

---

## 🔥 aspirational (long-term)

### 1. **camera presets**
- "Fed View" - Top-down, see all layers
- "Bank View" - Eye-level with Big Four
- "Flow View" - Side view, see payment flows

### 2. **color-coded connections**
- Green = healthy (sufficient reserves)
- Yellow = warning (low reserves)
- Red = critical (approaching limits)

### 3. **entity labels always face camera** (billboard)
- Currently: Labels rotate with entities
- Better: Always readable from any angle

### 4. **auto-arrange on create**
- Currently: Entities spawn in pattern
- Better: Animate into position (satisfying)

---

## 🎯 what to implement NOW

**Priority 1 (do now):**
1. J-Machine 2x smaller
2. Entity sizes 2-3x bigger
3. Y-positions exaggerated (300/200/100/0)

**Priority 2 (next session):**
4. Radial spoke pattern
5. Remove emoji textures in desktop mode

**Priority 3 (polish):**
6. Camera presets
7. Color-coded connections
8. Billboard labels

---

**Estimated time:** 15 minutes for Priority 1

**Impact:** Fed Chair goes "WOW" instead of "где все?"

---

**Prepared by:** Claude (UX specialist mode)
**For:** Bernanke demo
**Date:** 2025-11-07
