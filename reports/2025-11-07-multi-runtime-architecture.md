# multi-runtime architecture design - 2025-11-07

**User Question:** How to handle multiple runtimes (local/remote), state persistence, session locking?

---

## 🎯 current situation (what exists)

### single isolated runtime per /view
```
/view instance → localEnvStore → BrowserVM
```

**Works for:** One economy in one tab
**Breaks for:**
- Multiple tabs → multiple BrowserVMs (data loss)
- Multiple xlnomies → all share same env
- No persistence → reload = fresh start

---

## 🚀 proposed architecture: multi-runtime manager

### concept: runtime selector dropdown

```
┌─────────────────────────────────────┐
│ Runtime: [Simnet (Local) ▼]        │
│   Options:                          │
│   • Simnet (Local)    - BrowserVM   │
│   • Testnet (Remote)  - WS to bun   │
│   • Mainnet (Remote)  - WS to bun   │
│   • Custom...                       │
└─────────────────────────────────────┘
```

**Each runtime:**
- Has own xlnomies
- Has own entities
- Has own state (env, history)
- Saves to separate localStorage key

---

## 🔐 session locking (prevent conflicts)

### problem: two tabs, same runtime

```
Tab A: Opens Simnet → creates entities
Tab B: Opens Simnet → creates DIFFERENT entities
Result: Data conflict, both think they own Simnet
```

### solution 1: tab locking (simple)

```typescript
// On /view mount:
const lockKey = `xln-runtime-lock:${runtimeId}`;
const existingLock = sessionStorage.getItem(lockKey);

if (existingLock && existingLock !== myTabId) {
  // Show warning: "Runtime 'Simnet' is open in another tab"
  // Option 1: View as read-only
  // Option 2: Force take control (other tab becomes read-only)
  // Option 3: Clone runtime (create Simnet-2)
}

sessionStorage.setItem(lockKey, myTabId);

// On tab close:
window.addEventListener('beforeunload', () => {
  sessionStorage.removeItem(lockKey);
});
```

**Pros:** Simple, prevents conflicts
**Cons:** annoying if you want multiple views

### solution 2: broadcast channel sync (complex)

```typescript
const channel = new BroadcastChannel(`xln-runtime:${runtimeId}`);

channel.onmessage = (event) => {
  if (event.data.type === 'state-update') {
    // Sync state from other tab
    localEnvStore.set(event.data.env);
  }
};

// On state change:
channel.postMessage({ type: 'state-update', env: $localEnvStore });
```

**Pros:** Tabs stay in sync
**Cons:** Complex, race conditions

### solution 3: single-writer, multi-reader (recommended)

```
Tab A: Read-write (has lock)
Tab B: Read-only (watches via BroadcastChannel)
Tab C: Read-only

"Want to edit? Click 'Take Control' (steals lock from Tab A)"
```

**This is how Google Docs works.**

---

## 💾 full state persistence

### what to save

```typescript
interface PersistedRuntime {
  id: string;              // 'simnet', 'testnet', 'mainnet', etc.
  type: 'local' | 'remote';

  // If local:
  env: XLNEnvironment;     // Full runtime state
  history: ServerFrame[];  // Time machine data
  xlnomies: Map<string, Xlnomy>;

  // If remote:
  wsUrl: string;           // wss://xln.finance/runtime/testnet
  lastSyncedHeight: number;

  // UI state:
  cameraPosition: {x, y, z};
  cameraTarget: {x, y, z};
  selectedEntity?: string;
  timeIndex: number;
  isLive: boolean;

  // Metadata:
  lastUpdated: number;
  autoSave: boolean;
}
```

### storage strategy

**localStorage** (5-10MB limit):
- Current runtime state (compressed)
- UI preferences
- Recent runtimes list

**IndexedDB** (unlimited):
- Full history (all ServerFrames)
- Xlnomy snapshots
- Large datasets

**Example:**
```typescript
// Save to localStorage (current state)
localStorage.setItem('xln-runtime:simnet', JSON.stringify({
  type: 'local',
  env: compressEnv($localEnvStore),
  cameraPosition: camera.position,
  lastUpdated: Date.now()
}));

// Save to IndexedDB (full history)
const db = await openDB('xln-runtimes');
await db.put('history', $localHistoryStore, 'simnet');
```

---

## 🌐 local vs remote runtimes

### local runtime (browservm)

```
Browser → BrowserVM (@ethereumjs/vm)
  ↓
Depository.sol (in-memory EVM)
  ↓
Entities (local only)
  ↓
No network latency ✅
No server costs ✅
Data loss on reload ❌ (unless we persist)
```

**Use case:** Development, demos, Fed Chair presentations

### remote runtime (websocket to bun server)

```
Browser ←WebSocket→ Bun Server → Runtime.ts
                         ↓
                    Reth/Erigon (real EVM)
                         ↓
                    Entities (multi-user)
                         ↓
Persisted ✅
Multi-user ✅
Latency ~50ms ❌
Server costs ❌
```

**Use case:** Production, multi-user, persistent state

### hybrid (cache + sync)

```
Browser (cache) ←→ Server (source of truth)
  ↓                    ↓
Local state      Persistent state
Fast reads       Slow writes
```

**Pattern:** Optimistic updates (like Firebase, Supabase)

---

## 🎛️ runtime switcher ui

### dropdown in top bar

```
┌──────────────────────────────────────┐
│ 🌐 Runtime: Simnet (Local) ▼         │
├──────────────────────────────────────┤
│ 📁 Recent Runtimes                   │
│   • Simnet (Local)      2 min ago    │
│   • Jamaica (Local)     1 hour ago   │
│   • Testnet (Remote)    Yesterday    │
├──────────────────────────────────────┤
│ ➕ New Local Runtime                 │
│ 🔗 Connect to Remote...              │
│ 📥 Import from File...               │
│ 💾 Export Current...                 │
└──────────────────────────────────────┘
```

**On switch:**
1. Save current runtime state
2. Load selected runtime state
3. Update all panels (Graph3D, Entities, etc.)
4. Restore camera position
5. Restore time index

---

## 📍 centering j-machine on grid

### current issue
J-Machine spawns at random/calculated position, not grid center

### fix: snap to grid intersections

```typescript
// When creating xlnomy, snap J-Machine to nearest grid cell center
const gridSize = 666; // For 3x3 grid
const snapToGrid = (pos: {x, y, z}) => ({
  x: Math.round(pos.x / gridSize) * gridSize,
  y: pos.y, // Keep Y as-is
  z: Math.round(pos.z / gridSize) * gridSize
});

// In jurisdiction-factory.ts:
jMachine: {
  position: snapToGrid(calculatedPosition)
}
```

**Result:** J-Machines at (0,300,0), (666,300,0), (-666,300,0), etc. (grid centers)

---

## 🔀 multi-xlnomy in same browser

### current architecture (broken)
```
env.xlnomies = Map {
  'simnet' => {...},
  'jamaica' => {...}
}

env.activeXlnomy = 'simnet'
```

**Problem:** All xlnomies share same `env.replicas` (entity IDs collide)

### proposed: isolated envs per xlnomy

```typescript
runtimes = Map {
  'simnet' => {
    env: {...},           // Isolated
    history: [...],
    xlnomies: Map { 'simnet' => {...} },
    type: 'local'
  },
  'jamaica' => {
    env: {...},           // Isolated
    history: [...],
    xlnomies: Map { 'jamaica' => {...} },
    type: 'local'
  },
  'testnet' => {
    wsConnection: WebSocket,
    type: 'remote'
  }
}

activeRuntime = 'simnet'
```

**Each runtime = separate world**

---

## 🌍 embedded /view with context

### use case: multiple views on same page

```html
<iframe src="/view?runtime=simnet"></iframe>
<iframe src="/view?runtime=jamaica"></iframe>
<iframe src="/view?runtime=testnet"></iframe>
```

**Each iframe:**
- Gets `runtime` param from URL
- Loads that runtime's state
- Isolated from others
- Can be local OR remote

**Already works** (View component is isolated)

**Need:** URL param parsing + runtime selection

---

## 🔥 critical questions for you

### 1. Runtime Isolation
**Q:** Should one browser tab support MULTIPLE runtimes simultaneously?
**Options:**
- A: One runtime per tab (simple, current design)
- B: Multiple runtimes, dropdown to switch (medium complexity)
- C: Multiple runtimes, tabs/windows UI (complex, like VSCode multi-root)

**My recommendation:** B (dropdown switcher)

### 2. Local vs Remote Default
**Q:** What's the default runtime type?
**Options:**
- A: Always local (BrowserVM) - fast, offline, no costs
- B: Always remote (WebSocket to server) - persistent, multi-user
- C: Local for dev, remote for production (auto-detect)

**My recommendation:** A for now (simpler), B later

### 3. State Persistence Scope
**Q:** What do we persist?
**Options:**
- A: Just env + xlnomies (minimal, fast)
- B: Full history (time machine works across reloads)
- C: Everything including camera position, UI state

**My recommendation:** C (best UX)

### 4. Multi-Tab Strategy
**Q:** What happens with multiple tabs?
**Options:**
- A: Lock (only one tab can edit)
- B: Sync (BroadcastChannel, all tabs update)
- C: Warn (show "another tab open", let user choose)

**My recommendation:** C (least surprising)

### 5. Remote Runtime Protocol
**Q:** How does browser ↔ server communicate?
**Options:**
- A: REST API (GET /runtime/testnet, POST /runtime/testnet/input)
- B: WebSocket (bidirectional, real-time)
- C: Server-Sent Events (server → browser only)

**My recommendation:** B (WebSocket, enables real-time multi-user)

---

## 📊 implementation phases

### phase 1: state persistence (1 hour)
1. Save env to localStorage on every change
2. Load on mount
3. Save camera position, UI state
4. Test: Reload → everything restored

### phase 2: runtime switcher (2 hours)
1. Add Runtime dropdown in top bar
2. List: Local runtimes from localStorage
3. Switch → save current, load selected
4. New/Import/Export buttons

### phase 3: session locking (1 hour)
1. Detect multiple tabs
2. Show warning
3. Read-only mode OR force take control

### phase 4: remote runtime (4 hours)
1. WebSocket connection to bun server
2. Stream ServerFrames
3. Send EntityInputs
4. Sync state

**Total:** ~8 hours for full multi-runtime system

---

## 🎯 immediate fixes (before architecture)

### 1. Center J-Machine on grid (15 min)
**File:** `runtime/jurisdiction-factory.ts`
**Change:** Snap position to grid intersections

### 2. Save camera position (10 min)
**File:** `Graph3DPanel.svelte`
**Add:** Save camera.position/target to localStorage on pan/zoom
**Restore:** On mount

### 3. Save UI state (5 min)
**File:** `View.svelte`
**Save:** Active panel, collapsed state, time index
**Restore:** On mount

---

## 🤔 my recommendations

### for next session (high confidence)
1. **Center J-Machine** (15min) - visual fix
2. **Save camera state** (10min) - UX improvement
3. **Speed up HYBRID** (15min) - performance critical

### for this week (medium confidence)
4. **Runtime switcher** (2hr) - enables multi-economy
5. **State persistence** (1hr) - reload doesn't lose work

### for later (design needed)
6. **Session locking** (1hr) - prevent conflicts
7. **Remote runtime** (4hr) - production feature

---

## ❓ questions for you

**Before I implement, need clarity:**

1. **Multiple xlnomies in one browser tab:**
   - Should we support? (I think yes)
   - How to visualize? (Dropdown OR 3D world with multiple J-Machines)

2. **Remote runtime:**
   - Do you have bun server running already?
   - Should it be same server as xln.finance or separate?
   - Authentication needed? (Or public demo server)

3. **State persistence:**
   - Save EVERYTHING? (history, camera, UI)
   - Or just env? (minimal)
   - Auto-save or manual "Save" button?

4. **Session locking:**
   - Hard lock (only one tab)?
   - Soft warn (let user choose)?
   - No lock (YOLO, conflicts happen)?

5. **Priority:**
   - Most important: Speed up HYBRID? Center grid? Persistence?
   - Can defer: Remote runtime? Multi-tab?

---

## 🎨 visual: centered j-machines

**Current (wrong):**
```
[Grid]
  J-Machine at (200, 300, 0) - Random
```

**Proposed (right):**
```
3x3 Grid cells:
  (-666, *, -666) | (0, *, -666) | (666, *, -666)
  (-666, *,    0) | (0, *,    0) | (666, *,    0)  ← Center
  (-666, *,  666) | (0, *,  666) | (666, *,  666)

J-Machines snap to centers:
  Simnet:  (0, 300, 0)      ← Grid center
  Jamaica: (666, 300, 0)    ← Right cell center
  USA:     (-666, 300, 0)   ← Left cell center
```

**Fed within xlnomy:** Also snap to (0, yPos, 0) relative to J-Machine

---

## 🔧 implementation sketch (pseudo-code)

### runtime manager (new file)

```typescript
// frontend/src/lib/view/utils/runtimeManager.ts

export class RuntimeManager {
  private runtimes = new Map<string, RuntimeInstance>();
  private activeRuntimeId: string | null = null;

  async createLocal(name: string): Promise<string> {
    const id = `local:${name}`;
    const runtime = await initBrowserVM();
    this.runtimes.set(id, {
      id,
      type: 'local',
      env: runtime.env,
      history: [],
      state: 'active'
    });
    this.save(id);
    return id;
  }

  async connectRemote(url: string): Promise<string> {
    const ws = new WebSocket(url);
    const id = `remote:${url}`;
    this.runtimes.set(id, {
      id,
      type: 'remote',
      connection: ws,
      state: 'connecting'
    });
    return id;
  }

  switch(runtimeId: string) {
    // Save current
    if (this.activeRuntimeId) {
      this.save(this.activeRuntimeId);
    }

    // Load selected
    this.activeRuntimeId = runtimeId;
    this.load(runtimeId);
  }

  private save(id: string) {
    const runtime = this.runtimes.get(id);
    localStorage.setItem(`xln-runtime:${id}`, JSON.stringify(runtime));
  }

  private load(id: string) {
    const saved = localStorage.getItem(`xln-runtime:${id}`);
    if (saved) {
      const runtime = JSON.parse(saved);
      this.runtimes.set(id, runtime);
      return runtime;
    }
    return null;
  }
}
```

---

## 📋 action plan (sorted by value)

### immediate (this session if time)
1. ✅ Center J-Machine on grid (15min)
2. ✅ Save camera position (10min)
3. ⏸️ Speed HYBRID (deferred to next session)

### next session (high value)
4. State persistence (env + history + camera)
5. Runtime switcher dropdown (basic)
6. Session locking (warning only)

### later (nice to have)
7. Remote runtime support (WebSocket)
8. Multi-tab sync (BroadcastChannel)
9. Import/export .xln files

---

## 🎯 my recommendation

**Do now (25min):**
1. Center J-Machine on grid intersections
2. Save camera + UI state to localStorage
3. Auto-restore on reload

**Next session (3hr):**
4. Runtime switcher (dropdown, switch between local runtimes)
5. Full state persistence (env, history, camera)
6. Session lock warning

**Later (design first):**
7. Remote runtime (needs server-side work)

---

**Ready to implement #1-2 now if you want. Or defer everything to next session after reboot.**

**Your call.**

---

**Prepared by:** Claude
**Date:** 2025-11-07
**Status:** Design complete, awaiting decisions
