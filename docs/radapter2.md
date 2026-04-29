# radapter2: minimal runtime adapter for mainnet

Replaces `docs/radapter.md` (v1). v1 was 1100 lines proposing FrameView push,
assembleFrameView, ViewState, ClientSortCache, phase-2 KV storage, and 11-method
interface — all written before the storage layer in `runtime/storage/` shipped.

This doc is the production target: a 3-method adapter that ships embedded,
remote, and mobile from one Svelte codebase, reuses existing storage projections,
and is small enough to harden for mainnet.

## premise

The runtime is the source of truth. Frontends are dumb readers. The minimum
viable contract between them is:

- **read** — fetch a piece of state by path
- **send** — submit an input (admin only)
- **onChange** — wake me up when something changed

Every other concept in v1 (ViewState, FrameView, subscription filters, sort
caches, push-every-frame) is convenience that the storage layer + Svelte
component reactivity already provide. We deleted them.

## interface

```ts
// runtime/radapter/types.ts (new file, ~40 LOC)

export interface RuntimeAdapter {
  readonly mode: 'embedded' | 'remote'
  readonly status: 'connected' | 'connecting' | 'disconnected' | 'error'
  readonly currentHeight: number
  readonly authLevel: 'inspect' | 'admin' | null

  connect(config: RuntimeAdapterConfig): Promise<void>
  disconnect(): void

  read<T = unknown>(path: string, query?: ReadQuery): Promise<T>
  send(input: RuntimeInput): Promise<{ height: number }>     // admin only
  onChange(cb: (height: number) => void): () => void
  onStatus(cb: (s: RuntimeAdapter['status']) => void): () => void
}

export interface RuntimeAdapterConfig {
  mode: 'embedded' | 'remote'
  wsUrl?: string                  // remote only — wss://hub.example.com/rpc
  authKey?: string                // remote only — HMAC-SHA256(seed, 'xln-radapter-v1:<level>')
  seed?: string                   // embedded only — runtime seed
  reconnectMaxMs?: number         // remote only — default 30_000
}

export interface ReadQuery {
  atHeight?: number               // historical read; omitted = current
  cursor?: string                 // pagination cursor (last key from prior page)
  limit?: number                  // pagination size, default 50, max 500
  sortBy?: string                 // path-specific (e.g. 'balance' for accounts)
  sortDir?: 'asc' | 'desc'
}
```

That is the full surface. No `ViewState`, no `subscribeView`, no `getEntity`,
no `getAccounts`, no `getCheckpoints`, no `seekHeight`, no `setView`, no
`AccountSortKey`, no `FrameView`, no `EntitySummary`, no `EntityReplicaFull`,
no `AccountView`, no `AccountPage`, no `TickPayload`, no `ClientSortCache`.

## paths

The path string is the read API. Server validates against a closed allowlist.
Each path returns an existing storage type — we do not introduce new
projections.

| Path                                       | Returns                                | Source                                                    |
|--------------------------------------------|----------------------------------------|-----------------------------------------------------------|
| `head`                                     | `StorageHead`                          | `runtime/storage/index.ts` `readStorageHead`              |
| `entities`                                 | `Array<{ entityId, label, height }>`   | scan `KEY_LIVE_ENTITY` prefix                             |
| `entity/:id`                               | `StorageEntityCoreDoc`                 | `KEY_LIVE_ENTITY` get, or `projectEntityCoreDoc` on live  |
| `entity/:id/accounts`                      | `{ items: StorageAccountDoc[], nextCursor }` | `KEY_LIVE_ACCOUNT` prefix scan + cursor               |
| `entity/:id/account/:cp`                   | `StorageAccountDoc`                    | `KEY_LIVE_ACCOUNT` direct get                             |
| `entity/:id/books`                         | `BookState[]`                          | `KEY_LIVE_BOOK` prefix scan                               |
| `frame/:height`                            | `StorageFrameRecord`                   | `readStorageFrameRecord`                                  |
| `frame/latest`                             | `StorageFrameRecord`                   | `readStorageFrameRecord(head.latestHeight)`               |
| `checkpoints`                              | `Array<{ height, timestamp }>`         | `listStorageSnapshotHeights`                              |

`atHeight=N` rewrites any path to read at a historical snapshot. Implementation
calls `loadEntityStateFromStorage(db, entityId, N)` from
`runtime/storage/index.ts:2537` and reads from the materialized state.

For `accounts` pagination: cursor is the last `counterpartyId` from the previous
page. Server scans `KEY_LIVE_ACCOUNT_<entityId>_<cursor>..` with `limit` and
returns `nextCursor = items.last.counterpartyId` or `null`.

For `sortBy`: omitted = lexicographic on counterparty (cheapest, native KV order).
Sorted reads (`balance`, `inbound`, `outbound`) are deferred. They require a
separate sort index; we only add them when a real hub crosses ~10K accounts and
profiling shows latency. Until then, sorting in the frontend is fine
(O(n log n) on 1K accounts is sub-50ms).

## wire protocol (remote only)

Versioned envelope. Every message has `v`. Bumps require migration period.

```
client → server (request):
  { v:1, id:'r-42', op:'read', path:'entity/0xabc', query?:{...} }
  { v:1, id:'r-43', op:'send', input:{...} }
  { v:1, id:'r-44', op:'auth', key:'<hmac>' }

server → client (response):
  { v:1, inReplyTo:'r-42', ok:true, payload:{...} }
  { v:1, inReplyTo:'r-43', ok:false, error:{ code:'E_UNAUTHORIZED', message:'admin required', retryable:false } }

server → client (push, single type):
  { v:1, op:'tick', height: 1234 }
```

That is the entire protocol. No `frame`, no `subscribe`, no `set_view`. The
client decides what to re-read on tick by inspecting which routes/components
are mounted.

Errors are structured: `{ code, message, retryable }`. Codes are a closed enum:
`E_UNAUTHORIZED`, `E_NOT_FOUND`, `E_BAD_PATH`, `E_BAD_QUERY`, `E_RATE_LIMITED`,
`E_INTERNAL`. No string matching anywhere.

## embedded implementation

```
runtime/radapter/embedded.ts (~150 LOC)

class EmbeddedAdapter implements RuntimeAdapter {
  private env: Env
  private changeCbs = new Set<(h: number) => void>()
  private unregister?: () => void

  async connect(config) {
    if (config.seed) this.env = await main()           // for extension/standalone
    else this.env = getCurrentEnv()                    // for demo where env already exists
    this.unregister = registerEnvChangeCallback(this.env, (e) => {
      for (const cb of this.changeCbs) cb(e.height)
    })
  }

  async read<T>(path, query): Promise<T> {
    return resolveRead(this.env, path, query) as T     // pure local function — no IO
  }

  async send(input) {
    enqueueRuntimeInput(this.env, input)
    return { height: this.env.height }                 // local, no admin gate (it's your own runtime)
  }

  onChange(cb) {
    this.changeCbs.add(cb)
    return () => this.changeCbs.delete(cb)
  }
}
```

`resolveRead(env, path, query)` is the shared dispatch. It is the SAME
function used on the server side — embedded and remote produce bit-identical
output by construction.

```
runtime/radapter/resolve.ts (~200 LOC)

resolveRead(env, path, query):
  match path:
    'head'                       → readStorageHead-style summary from env
    'entities'                   → env.eReplicas.values().map(toBriefSummary)
    'entity/:id'                 → projectEntityCoreDoc(replica.state, replica)   // existing storage/index.ts:767
    'entity/:id/accounts'        → for each entry in entity.accounts, projectAccountDoc(account); paginate; sort if requested
    'entity/:id/account/:cp'     → projectAccountDoc(entity.accounts.get(cp))     // existing storage/index.ts:882
    'entity/:id/books'           → Array.from(entity.orderbookExt?.books?.values() ?? [])
    'frame/:h'                   → loadStorageFrameRecord(db, h) on storage layer
    'frame/latest'               → loadStorageFrameRecord(db, env.height)
    'checkpoints'                → listStorageSnapshotHeights(db)
  apply atHeight: if set, swap env for replayed env from loadEntityStateFromStorage
  validate: throw E_BAD_PATH / E_NOT_FOUND on miss
```

We do not write `toEntitySummary`, `toEntityFull`, `toAccountView`,
`assembleAccountPage`, `sortAccountViews`. The only new builders are
`toBriefSummary` (~5 fields per entity for the `entities` listing) and
the dispatch table. Total new code in resolve.ts: ~200 LOC. Total of all
existing projection code reused: ~600 LOC.

## remote implementation

```
runtime/radapter/remote.ts (~250 LOC)

class RemoteAdapter implements RuntimeAdapter {
  private ws: WebSocket
  private pending = new Map<string, { resolve, reject }>()
  private nextId = 1

  async connect(config) {
    this.ws = new WebSocket(config.wsUrl)
    await this.handshake()
    await this.request({ op: 'auth', key: config.authKey })  // sets authLevel
  }

  read(path, query) { return this.request({ op: 'read', path, query }) }
  send(input)        { return this.request({ op: 'send', input }) }

  private request(msg) {
    const id = `r-${this.nextId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ v: 1, id, ...msg }))
    })
  }

  private onMessage(raw) {
    const msg = JSON.parse(raw)
    if (msg.op === 'tick') { for (const cb of this.changeCbs) cb(msg.height); return }
    const p = this.pending.get(msg.inReplyTo); this.pending.delete(msg.inReplyTo)
    msg.ok ? p.resolve(msg.payload) : p.reject(new RuntimeError(msg.error))
  }

  // reconnect: exponential backoff 1s → 30s, replays auth, no state to restore
}
```

Reconnect: WS close → backoff → reconnect → re-send auth. No state to replay
because the adapter is stateless. Components remount under the existing
Svelte error-boundary pattern and refetch what they show. Last-seen-height
tracking is per-component, not in the adapter.

## server-side wiring

Modify `runtime/server.ts` `/rpc` handler. ~250 LOC added.

```
on connection:
  client = { ws, authLevel: null, rateLimit: new TokenBucket(...) }

on message (parsed envelope):
  enforce v === 1
  enforce rateLimit.tryConsume(1)
  switch msg.op:
    'auth':
      level = verifyHmac(msg.key, env.runtimeSeed)  // 'inspect' | 'admin' | null
      if !level: respond E_UNAUTHORIZED
      client.authLevel = level
      respond ok
    'read':
      payload = await resolveRead(env, msg.path, msg.query)  // SAME function as embedded
      respond ok payload
    'send':
      if client.authLevel !== 'admin': respond E_UNAUTHORIZED
      enqueueRuntimeInput(env, msg.input)
      respond ok { height: env.height }
    default:
      respond E_BAD_PATH

on env change (single hook):
  height = env.height
  for client in clients: ws.send({ v:1, op:'tick', height })
```

Total per-client state: `{ ws, authLevel, rateLimit }`. No subscription state,
no view state, no sort cache. Server can hold thousands of inspectors at
~150 bytes each.

## auth

HMAC-derived keys, generated by the hub once on boot:

```
inspectKey = HMAC-SHA256(runtimeSeed, 'xln-radapter-v1:inspect')
adminKey   = HMAC-SHA256(runtimeSeed, 'xln-radapter-v1:admin')
```

Hub UI displays both keys. Operator gives `inspectKey` to anyone, holds
`adminKey` close. URLs:

```
https://xln.finance/app?ws=wss://hub.example.com/rpc&key=<inspectKey>
```

Frontend reads `key` from URL, passes to adapter `connect()`. Server validates
on `auth` message — constant-time comparison against expected HMAC.

For mainnet: rotate `runtimeSeed` invalidates all keys. Hub config has
`adminKeySalt` so admin URLs survive seed rotation if intentional.

## mainnet hardening

Five concerns that v1 ignored:

### 1. rate limiting

Token bucket per WS connection. Default: 50 reads/sec, 5 sends/sec, burst
100. Configurable via env. `E_RATE_LIMITED` is structured + `retryable: true`
+ `retryAfterMs`. Frontend honors backoff; missing this opens trivial DoS.

```
runtime/radapter/rate-limit.ts (~80 LOC)

class TokenBucket {
  constructor(capacity, refillPerSec) { ... }
  tryConsume(n): boolean
  retryAfterMs(n): number
}
```

### 2. payload caps

- max request size: 16KB (auth has tiny key, `read` has tiny path, `send`
  has bounded RuntimeInput)
- max response size: 4MB (single `entity/:id/accounts` page with `limit=500`
  is ~250KB; cap is generous)
- enforce both sides. Reject oversize with `E_INTERNAL` + close connection.

### 3. read isolation

`atHeight` reads must never block live writes. Storage layer already supports
this — `loadEntityStateFromStorage` does materialize-replay against an
overlay; live env writes continue to `KEY_LIVE_*`. Verify in soak test:
hub serving 100 historical reads/sec while processing live frames must
show no consensus delay.

### 4. backpressure

If client's WS write buffer exceeds 1MB, server drops the connection with
`E_INTERNAL`. Client reconnects and refetches. Cheaper than buffering.
Required because broadcasting `tick` to a slow client otherwise pins memory.

### 5. observability

Server logs every request as one structured line:
`{ ts, clientId, authLevel, op, path?, latencyMs, status, errCode? }`

Aggregated to Prometheus or equivalent. Mainnet hub without read-path
metrics is unship-able — first inspector that hangs takes the team an hour
to diagnose.

## frontend integration

```
frontend/src/lib/stores/runtimeStore.ts (~80 LOC, replaces large parts of xlnStore)

import { writable, derived } from 'svelte/store'

let adapter: RuntimeAdapter
export const runtimeHeight = writable(0)

export async function initRuntime(config: RuntimeAdapterConfig) {
  adapter = config.mode === 'embedded' ? new EmbeddedAdapter() : new RemoteAdapter()
  await adapter.connect(config)
  adapter.onChange((h) => runtimeHeight.set(h))
}

export function readStore<T>(path: string, query?: ReadQuery) {
  // Returns a Svelte store that auto-refetches on every height bump.
  const store = writable<T | null>(null)
  const refetch = async () => { try { store.set(await adapter.read<T>(path, query)) } catch {} }
  refetch()
  const unsub = runtimeHeight.subscribe(refetch)
  return { ...store, dispose: unsub }
}

export const send = (input: RuntimeInput) => adapter.send(input)
```

Components use `readStore`:

```svelte
<!-- EntityCard.svelte -->
<script>
  import { readStore } from '$lib/stores/runtimeStore'
  export let entityId: string
  const entity = readStore<StorageEntityCoreDoc>(`entity/${entityId}`)
</script>

{#if $entity}
  <h3>{$entity.entityId}</h3>
  <p>height: {$entity.height}</p>
{/if}
```

```svelte
<!-- AccountList.svelte -->
<script>
  import { readStore } from '$lib/stores/runtimeStore'
  export let entityId: string
  let cursor = ''
  $: page = readStore(`entity/${entityId}/accounts`, { cursor, limit: 50 })
</script>

{#if $page}
  {#each $page.items as account}
    <AccountRow doc={account} />
  {/each}
  <button on:click={() => cursor = $page.nextCursor} disabled={!$page.nextCursor}>Next</button>
{/if}
```

`AccountRow` consumes `StorageAccountDoc` directly. Existing `deriveDelta`
from `runtime/account-utils.ts:30` derives inbound/outbound/balance.
We do not introduce `AccountView` or any other intermediate type.

Time machine slider: a single store `viewHeight` (defaults to live).
`readStore` passes `{ atHeight: viewHeight }`. When user scrubs, every mounted
component refetches at that height. Live mode = `viewHeight = null`.

## migration from current frontend

Phase A: introduce adapter without removing anything.
- create `runtime/radapter/{types, resolve, embedded}.ts`
- `xlnStore.ts` initializes embedded adapter alongside existing env logic
- export `readStore` helper
- existing components unchanged, keep using `$xlnEnvironment`

Phase B: migrate one route as proof.
- pick `/radapter` or `/inspector/:entityId` (new route, no rewrite of existing UI)
- build it on `readStore` only
- demo embedded mode for local user, remote mode for hub inspection

Phase C: incrementally migrate live-app components.
- replace `$xlnEnvironment.eReplicas.get(id)` reads with `readStore('entity/' + id)`
- keep settle/dispute panels on `xlnEnvironment` until they explicitly need remote support
- delete `xlnEnvironment` derived data once unused (likely 8-12 weeks out)

Phase D: enable remote adapter for production hubs.
- ship server-side `/rpc` read handlers (currently only `send_input` exists)
- generate inspect/admin URLs in hub admin page
- validate with soak test

No big-bang. Each phase ships independently. Embedded keeps demo working at
every step.

## ship plan

| step | scope                                                | LOC  | depends on |
|------|------------------------------------------------------|------|------------|
| 1    | types.ts + resolve.ts dispatch (no IO)               | ~250 | -          |
| 2    | embedded.ts + readStore helper + one demo component  | ~200 | 1          |
| 3    | remote.ts WS client + envelope + reconnect           | ~250 | 1          |
| 4    | server.ts /rpc read handler + auth + rate limit      | ~330 | 1, 3       |
| 5    | inspector route /inspector/:entityId                 | ~150 | 2, 4       |
| 6    | mainnet hardening: payload caps, backpressure, metrics | ~200 | 4          |
| 7    | incremental component migration (per-component)      | varies | 2        |
| 8    | sort indexes (deferred until measured need)          | ~150 | profile    |

Step 1-5 = adapter is shippable for hub inspection. ~1180 LOC.
Step 6 = production-ready. ~1380 LOC.
Step 7-8 = optional polish, no architecture changes.

## explicit non-goals

These were proposed in v1 and are intentionally not built:

- `FrameView` monolithic snapshot type
- `EntitySummary`, `EntityReplicaFull`, `AccountView`, `AccountPage` projections
  (use existing `StorageEntityCoreDoc`, `StorageAccountDoc`)
- `assembleFrameView` / `toEntitySummary` / `toEntityFull` / `toAccountView` /
  `sortAccountViews` builders
- `ViewState` + `setView` + `subscribeView` (server holds none of this)
- `ClientSortCache` per-connection sort caches
- Push-every-frame `{ type: 'frame', view }` broadcasts
- `TickPayload` with `touchedEntities` / `touchedAccounts` filter sets
  (single integer height bump is enough)
- Phase-2 KV/diff storage rewrite (already shipped in `runtime/storage/`)
- `seekHeight` as adapter state (use per-call `atHeight` query instead)
- Separate `getCheckpoints` / `getFrameAt` methods (use `read('checkpoints')`,
  `read('frame/:h')`)
- Optimistic local updates (frontend always reflects what the runtime confirmed)

If a future change argues for any of these, that change must justify the
re-introduction against this list.

## open questions

1. **push tick vs poll head?** WS push is realtime, ~10 bytes per frame per
   client. Polling `read('head')` every 500ms is simpler (no WS push channel)
   but burns battery on mobile. Default: WS push. Mobile clients can opt out
   via `RuntimeAdapterConfig.pollIntervalMs`.

2. **sort indexes when?** Deferred until profiling shows a real hub crossing
   ~10K accounts with sort latency >100ms. Until then, frontend sorts the
   page slice in-memory. Premature indexing is the v1 mistake.

3. **batch reads?** Single round-trip for multiple paths. Probably needed for
   inspector dashboards that show 5-10 entity summaries at once. Not in v1
   scope. Add when measured: `read('batch', { paths: [...] })`.

4. **schema versioning of payloads?** `StorageEntityCoreDoc` schema can
   evolve. We rely on `StorageHead.schemaVersion` (already exists in
   `runtime/storage/index.ts:74`). Bump = breaking change, frontend pins
   compatible major. Document in CHANGELOG.

5. **read consistency at height boundary?** A client reads `entity/X` at
   height H; before the response arrives, the server processes frame H+1.
   Response reflects H+1. Acceptable: every read is at-or-after the request
   timestamp, never older. Sticky historical reads use `atHeight=H`
   explicitly.
