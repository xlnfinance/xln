# radapter: runtime adapter

decoupling frontend from runtime daemon. same pattern as jadapter (browservm | rpc) but for the runtime layer.

## problem

frontend currently imports runtime.ts as a browser bundle and runs the full runtime in-process. this means:

- **can't inspect server hubs** — hub H1 runs in server.ts, frontend only sees its own browser-side env
- **can't scale to 1M accounts** — hub entity's full accounts Map in browser memory is too big
- **tight coupling** — xlnStore.ts calls `xln.main()`, holds full env, time machine is in-memory `env.history[]`
- **no auth model** — no way to give read-only access to a hub's state from another browser

the browser runtime is only for demo webapp and extensions. real architecture: runtime is always a daemon (desktop user or server hub). browser is a dumb reactive viewer.

## core principle: push what's on screen

every frame, daemon pushes a `FrameView` — exactly what the frontend needs to render:

1. **runtime summary** — height, timestamp, totals
2. **entity list** — all 10-50 entities as short summaries (sidebar, network visual)
3. **selected entity** — full detail for whichever entity is expanded
4. **account page** — sorted, paginated slice of accounts for the selected entity

frontend calls `setView()` to tell daemon what it's looking at. daemon includes that data in every push. no extra round-trips.

## required corrections for production

1. **FrameView always must stay projected**
   - Keep `FrameView` schema, but avoid serializing the full `Env`.
   - 1M-account hub: payload per frame should stay at page scale (`selected entity` + one `accounts` page), not full account maps.

2. **Cursor pagination for accounts**
   - Use `cursor` (`nextKey`) instead of `offset`.
   - Offset breaks under churn and concurrent mutations; cursor gives stable pages under heavy updates.

3. **Versioned WS protocol**
   - Wrap ws payloads with a versioned envelope: `{v, type, id, inReplyTo, payload}`.
   - This avoids silent compatibility breaks and makes RPC retries deterministic.

4. **Checkpoint index endpoint, not key scan**
   - `getCheckpoints` should read a dedicated compact index.
   - Avoid iterating all `snapshot:*` keys per request.

5. **Replay-safe reconnect**
   - Push messages should include `{height, seq}`.
   - On reconnect, client sends `fromHeight`; if server detects a gap, it replies with a fresh full `FrameView` snapshot.

6. **Configurable checkpoint interval**
   - `interval=5` is fine for local testing.
   - Hubs should default to bigger intervals and track write amplification.

7. **No immediate full KV rewrite**
   - Keep phase 1 on current snapshot+WAL.
   - Add `getFrameAt` by replaying from nearest snapshot to target.

8. **Error discipline + ACL**
   - Unauthorized `sendInput/rpc` must return `E_UNAUTHORIZED` explicitly.
   - Treat malformed requests and failed writes as structured errors (`code`, `message`, `retryable`).

### what's big, what's small

```
env.eReplicas: 10-50 entities      → always tiny, always push all summaries
  └─ entity.state.accounts: 1M     → THIS is where a hub gets big
```

a runtime has 10-50 entities max (registered participants on that machine). the scaling concern is **accounts per entity** — a hub connected to 1M users has 1M bilateral accounts in one entity.

entity summaries for 50 entities: ~5KB. one page of 100 accounts: ~50KB. total FrameView per push: ~55KB. works at any scale.

## goal

- runtime daemon is single source of truth (localhost or remote)
- frontend is stateless viewer: receives FrameView, sends commands via internal_rpc
- identical frontend code for 3-entity local user and 1M-account remote hub
- time machine via checkpoint + WAL, works at any scale
- one interface (RAdapter), two implementations (embedded | rpc), like jadapter
- option A: both modes produce FrameView. raw env only on `window.xlnEnv` for F12 debug.

## design decisions

### 1. jadapter parallel

```
jadapter/types.ts    → unified interface for jurisdiction layer
jadapter/browservm.ts → emulated EVM in browser (demo/test)
jadapter/rpc.ts      → real EVM via WebSocket/HTTP (production)

radapter/types.ts    → unified interface for runtime layer
radapter/embedded.ts → runtime.ts running in-process (demo/extension)
radapter/rpc.ts      → daemon via WebSocket (desktop/server/remote)
```

frontend imports RAdapter, never knows which implementation. same svelte stores, same components, same UX.

### 2. dumb pipe — no diffs, no subscriptions

on every frame, daemon assembles FrameView for each connected client and pushes it. frontend replaces its store entirely. no diffing, no merging, no conflict resolution.

why:
- impossible to have stale state — every push is the complete truth
- reconnect is trivial — just push current FrameView, client is caught up
- frontend code is trivial — `store.set(view)`, done

### 3. commands via internal_rpc

all state-changing inputs go back to daemon as RPC:

```typescript
adapter.rpc('pay', { to: '0xBOB', amount: 100n })
adapter.rpc('setCreditLimit', { entityId, limit: 1000n })
adapter.rpc('openAccount', { counterpartyId })
```

frontend does NOT optimistically update. waits for next FrameView push. what you see = what daemon has.

### 4. height IS the sequence number

no separate counter. runtime height is monotonic. reconnect uses `lastSeenHeight`.

### 5. reconnect = connect

with full FrameView push, reconnect is: re-send auth + viewState → daemon pushes current FrameView. no gap replay. dumb pipe beauty.

### 6. account sorting + pagination

accounts within an entity are the only thing that needs pagination and sorting.

**page sizes:** 10, 20, 50, or 100 accounts per page (user-configurable in UI).

**pagination:** page numbers (1, 2, 3...) not infinite scroll. total pages = ceil(accountCount / pageSize).

**sort keys:**
- `inbound` — inbound capacity (what counterparty can send us)
- `outbound` — outbound capacity (what we can send them)
- `collateral` — total collateral locked in this bilateral
- `balance` — net balance (our perspective)
- `created` — account creation height (immutable, cheap)
- `updated` — last frame height that touched this account
- `counterparty` — counterparty entityId alphabetical

**sort direction:** ascending / descending toggle.

**sorting strategy:**

for embedded mode (3-50 accounts): sort on the fly. Array.sort() on 50 items is instant.

for rpc mode (1M accounts): server maintains a **sorted index** — an array of account keys sorted by current sort key. this is built once when sort key changes, then sliced per page. between sort changes, the index is reused (just re-slice for new page).

```typescript
// server-side sort cache per client
interface ClientSortCache {
  sortBy: AccountSortKey
  sortDir: 'asc' | 'desc'
  sortedKeys: string[]              // account keys in sorted order
  builtAtHeight: number             // when this index was last rebuilt
}

// on frame push:
// if client's sort key changed OR cache is stale (>10 frames old):
//   rebuild sortedKeys from accounts Map (O(n log n), ~200ms for 1M)
// else:
//   reuse existing sortedKeys
// then slice page from sortedKeys
```

rebuilding sort index for 1M accounts: O(n log n) = ~20M comparisons. with BigInt: ~200-500ms. acceptable because it only happens when user changes sort key, not every frame.

for the common case (user watching page 1 sorted by balance): same sortedKeys reused, just slice [0..pageSize] from cached index. O(pageSize).

## interface

```typescript
type RAdapterMode = 'embedded' | 'rpc'

interface RAdapterConfig {
  mode: RAdapterMode
  // rpc mode
  wsUrl?: string                    // ws://localhost:8080/rpc or wss://hub.example.com/rpc
  authKey?: string                  // HMAC(seed, 'inspect') for read, HMAC(seed, 'admin') for write
  // embedded mode
  seed?: string                     // runtime seed for in-process runtime
  // shared
  snapshotInterval?: number         // checkpoint frequency (5 dev, 50 prod hub)
}

type AccountSortKey = 'inbound' | 'outbound' | 'collateral' | 'balance' | 'created' | 'updated' | 'counterparty'

interface ViewState {
  selectedEntityId: string | null
  accountPage: number               // 1-indexed page number
  accountPageSize: 10 | 20 | 50 | 100
  accountSortBy: AccountSortKey
  accountSortDir: 'asc' | 'desc'
}

interface FrameView {
  // runtime level
  height: number
  timestamp: number
  runtimeId: string
  checkpointInterval: number

  // all entities — short summaries for sidebar / network visual
  // always complete (10-50 entities, always tiny)
  entities: EntitySummary[]

  // selected entity — full detail minus accounts Map (null if nothing selected)
  selectedEntity: EntityReplicaFull | null

  // accounts for selected entity — sorted, paginated
  accounts: AccountPage | null
}

interface EntitySummary {
  entityId: string
  label: string
  accountCount: number              // might be 1M for hub
  totalBalance: bigint
  pendingHTLCs: number
  stateRoot: string                 // for change detection
}

interface EntityReplicaFull {
  entityId: string
  height: number
  lockBook: any
  // all entity-level fields, but NOT the accounts Map
}

interface AccountPage {
  accounts: AccountView[]           // page of sorted accounts
  page: number                      // current page (1-indexed)
  pageSize: number                  // 10 | 20 | 50 | 100
  totalAccounts: number             // total for this entity
  totalPages: number                // ceil(totalAccounts / pageSize)
  sortBy: AccountSortKey
  sortDir: 'asc' | 'desc'
}

interface AccountView {
  counterpartyId: string
  counterpartyLabel: string
  inbound: bigint                   // inbound capacity
  outbound: bigint                  // outbound capacity
  collateral: bigint                // total collateral
  balance: bigint                   // net balance (our perspective)
  pendingHTLCs: number
  createdAtHeight: number
  updatedAtHeight: number
  // full delta/account detail available via selectAccount drill-down
}

interface CheckpointInfo {
  height: number
  timestamp: number
}

interface RAdapter {
  readonly mode: RAdapterMode
  readonly status: 'connected' | 'connecting' | 'disconnected'
  readonly currentHeight: number

  // lifecycle
  connect(config: RAdapterConfig): Promise<void>
  disconnect(): void

  // tell daemon what you're looking at
  setView(view: ViewState): void

  // reactive push — dumb pipe, every frame
  onFrame(cb: (view: FrameView) => void): () => void
  onStatusChange(cb: (s: string) => void): () => void

  // time machine
  getCheckpoints(): Promise<CheckpointInfo[]>
  getFrameAt(height: number): Promise<FrameView>  // uses current ViewState

  // commands → internal_rpc
  sendInput(input: RuntimeInput): Promise<{ height: number }>
  rpc(method: string, params: any): Promise<any>
}
```

## assembleFrameView — the shared core function

both embedded and rpc implementations use the same pure function to build FrameView from env + ViewState. this guarantees identical output regardless of transport.

```typescript
function assembleFrameView(env: Env, view: ViewState): FrameView {
  // 1. entity summaries — always all entities, always cheap
  const entities = Array.from(env.eReplicas.values()).map(toEntitySummary)

  // 2. selected entity detail (minus accounts Map)
  const selectedEntity = view.selectedEntityId
    ? toEntityFull(env, view.selectedEntityId)
    : null

  // 3. sorted + paginated account page
  let accounts: AccountPage | null = null
  if (view.selectedEntityId) {
    const accountsMap = getEntityAccounts(env, view.selectedEntityId)
    const sorted = sortAccounts(accountsMap, view.accountSortBy, view.accountSortDir)
    const start = (view.accountPage - 1) * view.accountPageSize
    const pageSlice = sorted.slice(start, start + view.accountPageSize)
    accounts = {
      accounts: pageSlice.map(toAccountView),
      page: view.accountPage,
      pageSize: view.accountPageSize,
      totalAccounts: accountsMap.size,
      totalPages: Math.ceil(accountsMap.size / view.accountPageSize),
      sortBy: view.accountSortBy,
      sortDir: view.accountSortDir,
    }
  }

  return {
    height: env.height,
    timestamp: env.timestamp,
    runtimeId: env.runtimeId,
    checkpointInterval: env.runtimeConfig?.snapshotIntervalFrames ?? 100,
    entities,
    selectedEntity,
    accounts,
  }
}
```

for embedded (small): sortAccounts sorts 3-50 items in microseconds. no caching needed.

for rpc (1M accounts): server wraps sortAccounts with a cache. sorted index is rebuilt only when sort key changes or every N frames. page slice is O(pageSize) from cached sorted array.

## implementations

### radapter/embedded.ts

wraps runtime.ts running in the same process. for demo webapp and browser extensions.

```
connect()         → xln.main() → env in memory
setView()         → store ViewState locally
onFrame()         → registerEnvChangeCallback → on each: assembleFrameView(env, viewState) → cb
sendInput()       → env.mempool.push(input) → process()
getFrameAt()      → loadEnvFromDB checkpoint + WAL replay → assembleFrameView
disconnect()      → cleanup callbacks
```

no serialization, no network. direct function calls. produces identical FrameView to rpc mode.

### radapter/rpc.ts

WebSocket client connecting to daemon's `/rpc` endpoint.

```
connect()         → new WebSocket(wsUrl) + { type: 'auth', key } handshake
setView()         → ws.send({ type: 'set_view', ...viewState })
                    server remembers per-client, includes in every push
onFrame()         → server pushes { type: 'frame', view: FrameView } every frame
sendInput()       → ws.send({ type: 'send_input', input }) → await ack
getFrameAt()      → ws.send({ type: 'get_frame_at', height }) → await FrameView
disconnect()      → ws.close()
```

reconnect: ws close → exponential backoff → reconnect → re-send auth + viewState → server pushes current FrameView → instant catch-up.

auth:
- `HMAC(seed, 'inspect')` → read-only (receive frames, time machine)
- `HMAC(seed, 'admin')` → read + write (sendInput, rpc)
- hub generates inspector URLs: `xln.finance/app?mode=inspect&ws=wss://hub:8080/rpc&key=abc`

## server-side: what to add to handleRpcMessage

in server.ts, expand the existing `/rpc` WS handler:

```typescript
// per-client state:
//   viewState: ViewState
//   sortCache: { sortBy, sortDir, sortedKeys[], builtAtHeight }

// on auth: store default ViewState
// on set_view: update client.viewState, invalidate sortCache if sort key changed
// on notifyEnvChange: for each client → assembleFrameView(env, client.viewState) → push

'set_view'              → update client.viewState (+invalidate sort cache if needed)
'get_frame_at'          → getEnvAtHeight(h) → assembleFrameView(tmpEnv, client.viewState) → send
'get_checkpoints'       → scan DB for snapshot:{h} keys → send [{h, ts}...]
'send_input'            → push to env.mempool → respond after next process()
'rpc'                   → dispatch method (pay, setCreditLimit, etc.)
```

total: ~5 case branches. assembleFrameView is the same function used by embedded adapter.

sort cache per client: rebuild sorted index when sort key changes or cache is >10 frames stale. for 1M accounts, rebuild takes ~200-500ms but only happens on sort change, not every frame. page slicing from cached index is O(pageSize).

## state persistence: 3-tier KV + diff + WAL

### the problem with full JSON snapshots

current `saveEnvToDB` writes a full JSON blob per checkpoint. for 1M accounts this is ~200MB per checkpoint. at interval=50, that's 4GB per 1000 frames. unacceptable.

### what already exists (runtime.ts)

```
saveEnvToDB():
  frame_input:{height}              → WAL journal (runtimeInput per frame)
  snapshot:{height}                 → full env JSON blob (every N frames)
  latest_checkpoint_height          → pointer to newest checkpoint
  latest_height                     → pointer to newest frame

loadEnvFromDB():
  1. load snapshot:{checkpoint}
  2. replay frame_input:{checkpoint+1} through frame_input:{latest}
  3. result: fully restored env
```

### 3-tier storage design

instead of monolithic JSON blobs, store state as individual KV entries with diff layers:

```
tier 1: FULL KV SNAPSHOT (every ~500 frames)
  every account as an individual key:
    fkv:{height}:E1:CP1     → serialized account state (~200 bytes)
    fkv:{height}:E1:CP2     → serialized account state
    ... (1M keys)
    fkv:{height}:_meta      → { entitySummaries, reserves, config... }
  written rarely. ~200MB for 1M accounts. this is the base layer.

tier 2: DIFF KV (every ~50 frames)
  only keys that changed since the last full or diff:
    dkv:{height}:E1:CP5     → new account state (this account changed)
    dkv:{height}:E1:CP99    → new account state
    dkv:{height}:_meta      → updated entity summaries
  typical frame touches 1-10 accounts → diff is ~2-20KB.
  cumulative: diff at frame 550 contains all changes since full KV at frame 500.

tier 3: WAL FRAMES (every frame)
  same as current frame_input:{height} — the runtimeInput that produced this frame.
    wal:{height}             → { runtimeInput, timestamp, gossipProfiles }
  ~5KB per frame. used for replay between diffs.
```

### reaching any historical state

to reach frame 573:

```
1. load nearest full KV ≤ 573         → fkv:500 (the base)
2. apply nearest cumulative diff ≤ 573 → dkv:550 (50 frames of changes)
3. replay WAL frames 551-573           → 23 frames of applyRuntimeInput

result: exact state at frame 573
```

for assembleFrameView, we don't even need to materialize the full env:
- entity summaries: read from `dkv:550:_meta` (or `fkv:500:_meta` + overlay)
- account page: sort index tells us which 100 accounts to read → 100 KV gets
- total: ~100 KV reads, not 1M

### storage math

```
user (3 entities × 5 accounts):
  full KV: ~5KB (rare, every 500 frames)
  diffs: ~500 bytes (every 50 frames)
  WAL: ~2KB/frame
  1000 frames: ~2MB total. no concern.

hub (20 entities, 1 hub entity × 1M accounts):
  full KV: ~200MB (every 500 frames = 2 per 1000 frames)
  diffs: ~10KB each (every 50 frames = 20 per 1000 frames)
  WAL: ~5KB/frame (1000 per 1000 frames)
  1000 frames: 400MB + 200KB + 5MB ≈ 405MB

  compare to old approach (full JSON every 50 frames):
  1000 frames: 4GB. that's 10x worse.
```

### phase 1 vs phase 2

**phase 1 (implement now):** use current JSON snapshot + WAL. already built, works. assembleFrameView reads from in-memory env after loadEnvFromDB replay. the RAdapter interface is identical regardless of storage backend.

**phase 2 (when scaling to 1M):** migrate saveEnvToDB to write individual KV entries + diffs. add KV-aware `getEnvAtHeight()` that reads only needed keys. assembleFrameView's output is identical — only the read path changes.

the key insight: assembleFrameView should use a `StateReader` abstraction, not raw env:

```typescript
// phase 1: reads from in-memory Env object
interface StateReader {
  getEntitySummaries(): EntitySummary[]
  getEntityFull(entityId: string): EntityReplicaFull
  getAccountsSorted(entityId: string, sortBy, sortDir): AccountView[]
}

class EnvStateReader implements StateReader {
  constructor(private env: Env) {}
  // reads directly from env.eReplicas, env.state.accounts
}

// phase 2: reads from KV store with diff overlay resolution
class KVStateReader implements StateReader {
  constructor(private db: Level, private height: number) {}
  // reads from fkv + dkv + wal overlay chain
}
```

assembleFrameView calls StateReader methods. switching from phase 1 to phase 2 = swap the reader. FrameView output unchanged. frontend unchanged.

### sort index for 1M accounts

sorting 1M accounts requires knowing the sort value for every account. with KV storage, we can maintain a separate sorted index:

```
sortidx:{entityId}:{sortKey}  → [counterpartyId1, counterpartyId2, ...]
```

this index is ~16MB for 1M accounts (16 bytes per entry: 8-byte counterpartyId prefix + 8-byte sort value). rebuilt when sort key changes. page slicing = array slice on the index, then 100 KV gets for the actual account data.

### configurable intervals

```
snapshotIntervalFrames:          // full KV snapshot
  500   for dev/demo (small state, fast)
  500   for production hubs (same — full KV is rare)

diffIntervalFrames:              // diff KV
  5     for dev/demo (instant time machine jumps)
  50    for production hubs

// stored in env.runtimeConfig, reported in FrameView.checkpointInterval
```

### historical query function

```typescript
// phase 1 (current): load full env, replay WAL
async function getEnvAtHeight(targetHeight: number): Promise<Env> {
  const cpHeight = findNearestCheckpoint(targetHeight)
  const env = deserialize(await db.get(`snapshot:${cpHeight}`))
  env[ENV_REPLAY_MODE_KEY] = true  // prevent saveEnvToDB during replay
  for (let h = cpHeight + 1; h <= targetHeight; h++) {
    const wal = deserialize(await db.get(`frame_input:${h}`))
    await applyRuntimeInput(env, wal.runtimeInput)
  }
  return env
}

// phase 2 (future): KV-aware, no full env materialization
async function getStateReaderAtHeight(targetHeight: number): StateReader {
  const fullKVHeight = findNearestFullKV(targetHeight)
  const diffHeight = findNearestDiff(targetHeight)  // between fullKV and target
  // overlay chain: fullKV → diff → WAL replay for remaining frames
  return new KVStateReader(db, fullKVHeight, diffHeight, targetHeight)
}
```

WAL replay cost: O(txs_in_frame × frames_from_nearest_diff), NOT O(account_count). typically 1-50 frames × 1-10 txs = sub-millisecond.

## time machine

### current behavior
- `env.history[]` — in-memory array, all frames, all state
- slider iterates array index
- works for ~50 frames, unusable at 10K+

### new behavior

```
adapter.getCheckpoints() → [{h:1}, {h:6}, {h:11}, {h:16}, ...]

slider visualization:
|●····●····●····●····●····●····●|
1    6    11   16   21   26   31

● = checkpoint (instant jump, pre-computed snapshot on disk)
· = between checkpoints (small delay, WAL replay on server)
```

**user drags slider to frame 8:**
1. `adapter.getFrameAt(8)` — uses current ViewState (selected entity, sort, page)
2. daemon: load checkpoint:6 + replay WAL[7,8] → assembleFrameView → send
3. frontend renders. same FrameView shape as live mode. components don't know it's historical.

**LIVE mode (slider at rightmost):**
- automatic FrameView push every frame via onFrame callback
- no manual fetching

**client-side LRU cache:**
- cache last ~5 visited heights → FrameView
- scrubbing back to recently visited frame is instant
- invalidate on view change (sort/page/entity switch)

**prefetch:**
- at checkpoint N, prefetch N-1 and N+1 in background
- cheap, big UX win for scrubbing

## svelte integration

radapter produces identical FrameView for both modes. frontend has ONE code path.

```typescript
// xlnStore.ts — the only file that knows about RAdapter
import { writable } from 'svelte/store'

export const frameView = writable<FrameView | null>(null)
let adapter: RAdapter
let currentView: ViewState = {
  selectedEntityId: null,
  accountPage: 1,
  accountPageSize: 50,
  accountSortBy: 'balance',
  accountSortDir: 'desc',
}

export async function initRuntime(config: RAdapterConfig) {
  adapter = config.mode === 'embedded'
    ? new EmbeddedRAdapter()
    : new RpcRAdapter()
  await adapter.connect(config)
  adapter.onFrame((view) => frameView.set(view))
}

// view controls — just update ViewState, next push has new data
export function selectEntity(entityId: string) {
  currentView = { ...currentView, selectedEntityId: entityId, accountPage: 1 }
  adapter.setView(currentView)
}

export function setAccountPage(page: number) {
  currentView = { ...currentView, accountPage: page }
  adapter.setView(currentView)
}

export function setAccountPageSize(size: 10 | 20 | 50 | 100) {
  currentView = { ...currentView, accountPageSize: size, accountPage: 1 }
  adapter.setView(currentView)
}

export function setAccountSort(sortBy: AccountSortKey, sortDir: 'asc' | 'desc') {
  currentView = { ...currentView, accountSortBy: sortBy, accountSortDir: sortDir, accountPage: 1 }
  adapter.setView(currentView)
}

export async function pay(to: string, amount: bigint) {
  await adapter.rpc('pay', { to, amount })
  // no local update — wait for next frame push
}

export async function timeMachineSeek(height: number) {
  const view = await adapter.getFrameAt(height)
  frameView.set(view)
}
```

components subscribe to `frameView` — zero knowledge of embedded vs rpc:

```svelte
<script>
  import { frameView, selectEntity, setAccountPage, setAccountSort, setAccountPageSize } from '$lib/stores/xlnStore'

  $: entities = $frameView?.entities ?? []
  $: selected = $frameView?.selectedEntity
  $: accountPage = $frameView?.accounts
</script>

<!-- entity sidebar -->
{#each entities as entity}
  <EntityCard {entity} on:click={() => selectEntity(entity.entityId)} />
{/each}

<!-- selected entity detail -->
{#if selected}
  <EntityDetail entity={selected} />

  <!-- account list with sorting + pagination -->
  {#if accountPage}
    <div class="sort-controls">
      <select on:change={e => setAccountSort(e.target.value, accountPage.sortDir)}>
        <option value="balance">Balance</option>
        <option value="inbound">Inbound</option>
        <option value="outbound">Outbound</option>
        <option value="collateral">Collateral</option>
        <option value="created">Created</option>
        <option value="updated">Updated</option>
        <option value="counterparty">Counterparty</option>
      </select>
      <select on:change={e => setAccountPageSize(Number(e.target.value))}>
        <option value="10">10</option>
        <option value="20">20</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </div>

    {#each accountPage.accounts as account}
      <AccountRow {account} />
    {/each}

    <!-- pagination: 1, 2, 3... -->
    <Pagination
      page={accountPage.page}
      totalPages={accountPage.totalPages}
      on:goto={e => setAccountPage(e.detail)}
    />
  {/if}
{/if}
```

## data flow

```
                      Frontend (Svelte)
                           │
                     ┌─────┴─────┐
                     │  xlnStore  │  frameView store
                     │  setView() │  selectEntity(), setAccountPage()...
                     └─────┬─────┘
                           │
                      ┌────┴────┐
                      │ RAdapter │  interface — same for both modes
                      └────┬────┘
                           │
             ┌─────────────┼─────────────┐
             │                           │
      embedded.ts                    rpc.ts
      (in-process)              (WebSocket client)
             │                           │
      runtime.ts                  ┌──────┴──────┐
      assembleFrameView()         │  server.ts   │
      (direct call)               │ handleRpc()  │
                                  │ assembleFrameView()
                                  │  runtime.ts  │
                                  │   LevelDB    │
                                  └──────────────┘
```

**desktop user (3 entities × 5 accounts):**
```
app → rpc radapter → localhost:8080 daemon
```

**admin inspecting hub remotely (1M accounts):**
```
browser → rpc radapter → wss://hub.example.com/rpc → server runtime
```

**demo webapp / browser extension:**
```
browser → embedded radapter → runtime.ts in-process → IndexedDB
```

all three: identical frontend code. only RAdapterConfig differs.

## auth model

```
hub seed → HMAC(seed, 'inspect') → read-only auth key
hub seed → HMAC(seed, 'admin')   → read + write auth key
```

permissions:
- inspect: receive FrameView, setView, time machine, getCheckpoints
- admin: all above + sendInput + rpc commands

hub generates inspector URLs:
```
https://xln.finance/app?mode=inspect&ws=wss://hub:8080/rpc&key=abc123
```

frontend detects `mode=inspect` → rpc adapter with read-only key.

## implementation plan

### files to create

```
runtime/radapter/
  types.ts              → RAdapter interface, ViewState, FrameView, AccountPage, AccountView, etc.
  assemble.ts           → assembleFrameView() + toEntitySummary, toEntityFull, toAccountView, sortAccountViews
  embedded.ts           → EmbeddedRAdapter class
  rpc.ts                → RpcRAdapter class (WebSocket client)
  index.ts              → createRAdapter() factory, re-exports
```

### files to modify

```
runtime/server.ts       → rpcClients Map, 5 new RPC handlers, registerEnvChangeCallback hook
runtime/runtime.ts      → export ENV_REPLAY_MODE_KEY, export enqueueRuntimeInput
runtime/types.ts        → add createdAtHeight?: number to AccountMachine
runtime/entity-tx/handlers/account.ts → set createdAtHeight on new account creation
frontend/src/lib/stores/xlnStore.ts   → frameView store, adapter wiring, view controls
frontend/src/lib/components/Entity/*  → migrate to $frameView (incremental)
```

---

### step 1: types + assembleFrameView (no behavior change)

**create `runtime/radapter/types.ts`:**
- RAdapterMode, RAdapterConfig, ViewState, FrameView
- EntitySummary, EntityReplicaFull, AccountPage, AccountView
- AccountSortKey (7 keys: inbound, outbound, collateral, balance, created, updated, counterparty)
- CheckpointInfo, ClientSortCache
- RAdapter interface (connect, disconnect, setView, onFrame, onStatusChange, getCheckpoints, getFrameAt, sendInput, rpc)

**create `runtime/radapter/assemble.ts`:**
- `assembleFrameView(env: Env, view: ViewState): FrameView` — the shared pure function
- `toEntitySummary(replica)` — uses `deriveDelta` from `account-utils.ts:30` to compute totalBalance
- `toEntityFull(replica)` — entity detail (lockBook, swapBook, reserves) minus accounts Map
- `toAccountView(myEntityId, counterpartyId, account)` — derives inbound/outbound/collateral/balance via `deriveDelta(delta, isLeft)`
- `sortAccountViews(views, sortBy, sortDir)` — BigInt-aware comparator for all 7 sort keys
- `assembleAccountPage(replica, viewState)` — sort all accounts → slice page

**create `runtime/radapter/index.ts`:**
- `createRAdapter(config)` factory → dispatches to EmbeddedRAdapter or RpcRAdapter
- re-exports all types

**modify `runtime/types.ts`:**
- add `createdAtHeight?: number` to AccountMachine (~line 1000)

**modify `runtime/entity-tx/handlers/account.ts`:**
- set `account.createdAtHeight = machine.currentHeight` when new AccountMachine created

**verify:** `bun run check` passes. no runtime behavior change.

---

### step 2: embedded adapter (no behavior change)

**create `runtime/radapter/embedded.ts`:**

```
class EmbeddedRAdapter implements RAdapter:
  mode = 'embedded'
  viewState: ViewState (local)
  frameCallbacks: Set<(FrameView) => void>
  env: Env | null
  unregisterEnvChange: (() => void) | null

  connect(config):
    → import runtime.ts
    → env = await main()
    → registerEnvChangeCallback(env, pushFrame)

  attachEnv(env):
    → skip main(), register callback on existing env
    → for xlnStore.ts which already called main()

  setView(view):
    → store locally
    → pushFrame() immediately (no network round-trip)

  onFrame(cb):
    → add to frameCallbacks
    → registerEnvChangeCallback → assembleFrameView(env, viewState) → cb

  getFrameAt(height):
    → check LRU cache (5 entries)
    → miss: getEnvAtHeight(height) → assembleFrameView → cache → return

  sendInput(input):
    → enqueueRuntimeInput(env, input)

  rpc(method, params):
    → dispatch to runtime-level handler (pay, setCreditLimit, etc.)

  pushFrame():
    → assembleFrameView(env, viewState) → call all frameCallbacks
```

**modify `runtime/runtime.ts`:**
- export `ENV_REPLAY_MODE_KEY` (currently module-private Symbol at line 367)
- ensure `enqueueRuntimeInput` or mempool access is available for embedded sendInput

**verify:** create EmbeddedRAdapter in test, verify FrameView produced on each frame, entities + accounts populated.

---

### step 3: frontend xlnStore integration (additive, no breaking changes)

**modify `frontend/src/lib/stores/xlnStore.ts`:**

keep ALL existing stores (`xlnEnvironment`, `history`, `currentHeight`). add:

```typescript
export const frameView = writable<FrameView | null>(null)
let _adapter: RAdapter
let _viewState: ViewState = { selectedEntityId: null, accountPage: 1, accountPageSize: 50, accountSortBy: 'balance', accountSortDir: 'desc' }

// called from initializeXLN after env is ready:
//   const adapter = new EmbeddedRAdapter()
//   await adapter.attachEnv(env)      // uses existing env, no double-main
//   adapter.onFrame(view => frameView.set(view))

// view control exports:
export function selectEntity(entityId)
export function setAccountPage(page)
export function setAccountPageSize(size: 10|20|50|100)
export function setAccountSort(sortBy, sortDir)
export async function timeMachineSeek(height)
export async function timeMachineGetCheckpoints()
```

**key detail — double-main guard:**
- `initializeXLN()` already calls `xln.main()` → env exists
- EmbeddedRAdapter uses `attachEnv(env)` instead of `connect()` → registers callback on existing env
- `connect()` calls `main()` → only used in standalone/extension mode where no env exists yet

**verify:** `bun run check` passes. browser shows same UI. F12: `window.$frameView` or subscribe to frameView store shows entities + accounts.

**ship checkpoint:** after step 3, demo webapp works unchanged AND `$frameView` is populated alongside existing stores. components can begin migrating.

---

### step 4: server RPC expansion

**modify `runtime/server.ts`:**

4a. **rpcClients registry:**
```typescript
interface RpcClientState {
  ws: any
  viewState: ViewState
  sortCache: ClientSortCache | null
  authLevel: 'inspect' | 'admin' | null
}
const rpcClients = new Map<any, RpcClientState>()
```
- add to rpcClients on 'auth' message
- remove from rpcClients in close(ws) handler (line ~2964)

4b. **hook registerEnvChangeCallback** after env initialization:
```typescript
registerEnvChangeCallback(env, (newEnv) => {
  for (const [ws, client] of rpcClients) {
    if (!client.authLevel) continue
    const view = assembleFrameViewCached(newEnv, client)
    ws.send(serializeTaggedJson({ type: 'frame', view }))
  }
})
```

4c. **sort cache** for 1M accounts:
- per-client: `{ sortBy, sortDir, sortedKeys[], builtAtHeight }`
- rebuild when sortBy/sortDir changes OR cache >10 frames stale
- rebuild = Array.from(accounts).map(toAccountView).sort() → extract keys
- O(n log n) for 1M = ~200-500ms, only on sort change
- page slice from cached sortedKeys = O(pageSize)

4d. **5 new message handlers** in handleRpcMessage:
- `auth` → validate HMAC(seed, 'inspect'|'admin'), register client, push initial FrameView
- `set_view` → update client.viewState, invalidate sort cache if needed, push FrameView
- `get_frame_at` → getEnvAtHeight(height) → assembleFrameView(tmpEnv, client.viewState) → send
- `get_checkpoints` → scan DB for checkpoint keys → send [{height, timestamp}...]
- `send_input` / `rpc` → admin auth check, dispatch to runtime

4e. **getEnvAtHeight(env, height)** utility:
- find nearest checkpoint ≤ height from LevelDB
- load checkpoint, set ENV_REPLAY_MODE_KEY on restored env
- replay WAL frames from checkpoint+1 to target height
- return temporary env (not persisted)

**verify:** connect to server /rpc via wscat, send auth + set_view, receive FrameView on each frame.

---

### step 5: rpc adapter (WebSocket client)

**create `runtime/radapter/rpc.ts`:**

```
class RpcRAdapter implements RAdapter:
  mode = 'rpc'
  ws: WebSocket | null
  viewState: ViewState
  frameCallbacks: Set
  pendingRequests: Map<msgId, {resolve, reject}>
  frameCache: Map<height, FrameView> (LRU, 5 entries)

  connect(config):
    → new WebSocket(config.wsUrl)
    → onopen: send { type: 'auth', key: config.authKey }
    → await auth ack
    → send set_view with current viewState
    → status = 'connected'

  setView(view):
    → store locally
    → ws.send({ type: 'set_view', ...view })

  onFrame(cb):
    → add to frameCallbacks
    → server pushes { type: 'frame', view } → invoke all callbacks

  getFrameAt(height):
    → check frameCache → hit: return cached
    → miss: ws.send({ type: 'get_frame_at', height }) → await response → cache → return

  sendInput(input):
    → ws.send({ type: 'send_input', input }) → await ack

  rpc(method, params):
    → ws.send({ type: 'rpc', method, params }) → await result

  handleMessage(raw):
    → deserializeTaggedJson(raw)
    → if type='frame': update currentHeight, invoke frameCallbacks
    → if inReplyTo: resolve pending request

  reconnect:
    → ws.onclose → exponential backoff (1s, 2s, 4s... max 30s)
    → on reconnect: re-send auth + viewState → server pushes current FrameView
    → no gap tracking needed (full FrameView push = instant catch-up)

  serialization:
    → send: JSON.stringify (sort keys, page numbers are safe)
    → receive: deserializeTaggedJson (BigInt, Map preservation)
```

**verify:** start server, open browser with `?mode=inspect&ws=ws://localhost:8080/rpc`, verify FrameView received and rendered.

**ship checkpoint:** after step 5, remote hub inspection works end-to-end.

---

### step 6: frontend component migration

**migrate entity list** to `$frameView.entities`:
- entity sidebar reads `$frameView.entities` instead of iterating `$xlnEnvironment.eReplicas`
- click entity → `selectEntity(entityId)` → adapter.setView → next push has entity detail + accounts

**migrate account list** to `$frameView.accounts`:
- AccountPreview reads from `$frameView.accounts.accounts[i]` (AccountView) instead of raw AccountMachine
- AccountView has pre-computed inbound/outbound/collateral/balance — no deriveDelta needed in component

**add sort controls:**
- dropdown: balance, inbound, outbound, collateral, created, updated, counterparty
- asc/desc toggle button
- calls `setAccountSort(sortBy, sortDir)`

**add page size selector:**
- options: 10, 20, 50, 100
- calls `setAccountPageSize(size)`

**add pagination:**
- numbered page buttons: 1, 2, 3... totalPages
- calls `setAccountPage(page)`
- show: "Page X of Y (Z accounts)"

**keep AccountPanel settle/dispute tabs** on `xlnEnvironment` for now:
- these tabs use full AccountMachine deeply (per-token deltas, lock details, settlement workspace)
- separate `getAccountDetail` drill-down added later when needed

**verify:** sort accounts by each key, change page sizes, navigate pages. verify data matches between old and new views.

---

### step 7: time machine slider

**replace in-memory history with checkpoint-aware slider:**

```
old: env.history[] in memory → slider index → EnvSnapshot
new: adapter.getCheckpoints() → slider height → adapter.getFrameAt(height) → FrameView
```

**slider component:**
- range: 1 to currentHeight
- checkpoint dots (●) rendered at checkpoint heights — click for instant jump
- between dots (·) — small delay for WAL replay
- LIVE button — resume automatic frame push from onFrame callback
- height display: "h=48 / 100"

**LRU cache:** both adapters cache last 5 getFrameAt results. scrubbing back to recently visited frame is instant. cache invalidated on viewState change.

**prefetch:** at checkpoint N, prefetch N-1 and N+1 in background. cheap, big UX win.

**verify:** drag slider to checkpoint (instant), drag between checkpoints (short delay), click LIVE (resumes real-time). sort/page controls work in historical mode.

---

### future: step 8 — KV + diff storage (phase 2)

when scaling to 1M accounts, swap the storage backend:

- `saveEnvToDB` → write individual KV entries + cumulative diffs
- `getEnvAtHeight` → KV-aware reader, no full env materialization
- add `KVStateReader` implementing `StateReader` interface
- assembleFrameView works unchanged — just swap EnvStateReader → KVStateReader
- sorted index stored as separate KV key, rebuilt on sort change
- 10x storage reduction (405MB vs 4GB per 1000 frames)

this is a backend-only change. RAdapter interface, FrameView, frontend — all unchanged.

## migration safety

- steps 1-3: zero behavior change. demo works exactly as today. `$frameView` populated alongside existing stores.
- steps 4-5: additive capability. remote inspection works.
- steps 6-7: UI improvements. existing components can migrate incrementally.
- step 8: backend storage optimization. no interface changes.

embedded adapter is the fallback: if rpc fails, demo/extension runs in-process.
