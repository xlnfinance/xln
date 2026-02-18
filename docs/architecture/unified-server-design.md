# Unified Server Architecture (P2P + Relay Merge)

## Problem
Currently duplicating:
- `ws-server.ts` - Pure relay (routes messages between runtimes)
- `ws-client.ts` - P2P client (connects to other relays)
- `p2p.ts` - P2P orchestration (gossip + entity inputs)

## Solution: Unified Server

**Single server that:**
1. **Relay function** - Routes messages between OTHER runtimes
2. **P2P function** - Receives messages FOR THIS runtime's entities
3. **Connection storage** - Stores active WS connections by runtimeId

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Unified Server                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ WS Listener  │  │ Connection   │  │ Message      │      │
│  │ (port 9000)  │→│ Registry     │→│ Router       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                           │                  │              │
│                           │                  │              │
│                    runtimeId → WS     ┌──────┴──────┐       │
│                                       │             │       │
│                              ┌────────▼──┐   ┌─────▼─────┐ │
│                              │ Relay Msg │   │ Local Msg │ │
│                              │ (forward) │   │ (to env)  │ │
│                              └───────────┘   └───────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Message Flow

### 1. Relay Messages (forward to other runtime)
```typescript
{
  type: 'entity_input',
  from: 'runtime-abc',
  to: 'runtime-xyz',     // Different runtime
  payload: { entityId, entityTxs }
}
→ Lookup connection[to]
→ Forward via WS
```

### 2. Local Messages (deliver to this runtime)
```typescript
{
  type: 'entity_input',
  from: 'runtime-abc',
  to: 'runtime-hub',     // THIS runtime
  payload: { entityId, entityTxs }
}
→ Deliver to env.networkInbox
→ Runtime processes
```

### 3. Gossip Messages
```typescript
{
  type: 'gossip_announce',
  from: 'runtime-abc',
  to: 'runtime-hub',
  payload: { profiles: [...] }
}
→ Store in gossip layer
→ Forward to subscribers
```

---

## Connection Registry

```typescript
// Store connections by runtimeId
const connections = new Map<string, {
  ws: WebSocket;
  runtimeId: string;
  lastSeen: number;
  entityIds: string[];  // Entities advertised by this runtime
}>();

// On hello message
connections.set(runtimeId, { ws, runtimeId, lastSeen: now(), entityIds: [] });

// On gossip_announce
connections.get(runtimeId).entityIds = profiles.map(p => p.entityId);

// Routing logic
function route(msg: Message) {
  if (msg.to === thisRuntimeId) {
    deliverLocal(msg);
  } else {
    const conn = connections.get(msg.to);
    if (conn) {
      conn.ws.send(msg);
    } else {
      queue(msg); // Store for later delivery
    }
  }
}
```

---

## Hub Entity Creation (Generic)

**Hub = normal entity + gossip metadata**

```typescript
// 1. Create hub entity (like any entity)
await applyRuntimeInput(env, {
  runtimeTxs: [{
    type: 'importReplica',
    entityId: hubEntityId,
    signerId: 'hub-validator',
    data: {
      config: { /* normal entity config */ },
      isProposer: true,
      position: { x: 0, y: 0, z: 0 },
    },
  }],
  entityInputs: [],
});

// 2. Mark as hub in gossip (ONLY difference)
env.gossip.announce({
  entityId: hubEntityId,
  runtimeId: env.runtimeId,
  capabilities: ['routing', 'hub'],  // ← This makes it a "hub"
  metadata: {
    name: 'Main Hub',
    isHub: true,                     // ← Advertises hub status
    relayUrl: 'wss://xln.finance/relay',  // ← Where to connect
    routingFeePPM: 100,
  },
});

// 3. Fund hub reserves (like any entity)
await j.debugFundReserves(hubEntityId, tokenId, amount);
```

**That's it. No special hub code. Just normal entity + gossip metadata.**

---

## Frontend J-Machine Import

**Frontend decides which J to import:**

```typescript
// Scenario mode (local dev)
if (isScenario) {
  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        mode: 'browservm',
        chainId: 31337,
        name: 'Local',
      },
    }],
  });
}

// Regular user mode (testnet)
else {
  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        mode: 'rpc',
        chainId: 31337,
        rpcUrl: 'https://xln.finance/rpc',
        name: 'Testnet',
      },
    }],
  });
}
```

---

## Implementation Plan

### Phase 1: Merge P2P + Server
- [ ] Combine `ws-server.ts` + `p2p.ts` into `runtime/networking/unified-server.ts`
- [ ] Connection registry with runtimeId → WS mapping
- [ ] Route messages: local delivery vs relay forwarding
- [ ] Keep gossip layer (just integrate, don't rewrite)

### Phase 2: Remove Special Hub Logic
- [ ] Delete `createMainHub()` from server.ts
- [ ] Create `scripts/create-hub.ts` that imports normal entity + marks as hub
- [ ] Hub gets funded like any entity (via faucet or manual)

### Phase 3: Frontend J Import
- [ ] Add logic in frontend to detect scenario vs regular mode
- [ ] Import browservm for scenarios, anvil for users
- [ ] Add testnet J to jurisdiction dropdown

### Phase 4: Testing
- [ ] Multi-hub test: Hub1 ↔ Hub2 ↔ Hub3 with accounts between them
- [ ] User → Hub1 → Hub2 → User2 routing
- [ ] Verify hubs are truly "normal entities"

---

## Success Criteria

✅ Hub code = 0 special cases
✅ Hub = normal entity + gossip metadata
✅ Any entity can become a hub (just announce in gossip)
✅ Hubs can have accounts with other hubs
✅ Connection registry stores all runtimes by ID
✅ Messages route correctly (local vs relay)
