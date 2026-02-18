# XLN MVP: Full E2E Testnet Specification

**Last Updated:** 2026-02-01
**Status:** In Progress
**Goal:** Production testnet on xln.finance with multi-hub routing and encrypted P2P

---

## 🎯 Core Requirements

### 1. Architecture Principles

**Hub = Normal Entity**
- NO special hub code anywhere
- Hub is just an entity that accepts account requests
- Hub marked in gossip with `metadata.isHub = true`
- Any entity can become a hub by:
  1. Having reserves funded
  2. Running relay server
  3. Announcing in gossip with hub metadata

**Runtime-to-Runtime Encryption**
- All messages between runtimes encrypted to target runtime's public key
- Relay server cannot read message content (privacy)
- Only target runtime can decrypt (authenticity)
- Multi-hop routing: User→Hub1→Hub2→User2 encrypted per hop
- Even compromised relay cannot spoof or read messages

**Thousands of Hubs**
- Hubs can have accounts with other hubs
- Hub-to-hub routing enables network scaling
- No single point of failure
- Discovery via gossip layer (seed nodes return hub list)

---

## 🏗️ System Components

### 1. Jurisdiction Layer (J-Machine)

**Production:** Anvil on xln.finance
```bash
# Persistent state storage
anvil --host 0.0.0.0 --port 8545 \
      --dump-state /root/xln/data/anvil-state.json \
      --load-state /root/xln/data/anvil-state.json
```

**Local Dev:** BrowserVM (scenarios/testing)
```bash
# Frontend imports BrowserVM for local scenarios
# No server needed, fully offline
```

**Contract Stack:**
- Depository.sol - Reserve management + settlements
- EntityProvider.sol - Entity registration
- Account.sol - Bilateral account library
- DeltaTransformer.sol - HTLC + swap transformations

**Access:**
- Direct: `http://localhost:8545` (on server)
- Proxied: `https://xln.finance/rpc` (nginx reverse proxy)

---

### 2. Relay Server (Message Router)

**Purpose:** Routes messages between runtimes (dumb pipe)

**Location:** `runtime/networking/ws-server.ts` (standalone process)

**Functions:**
- Accept WebSocket connections from runtimes
- Store connection registry: `runtimeId → WebSocket`
- Route encrypted messages to target runtime
- Store gossip profiles (peer discovery)
- NO decryption, NO validation (relay is untrusted)

**Deployment:**
```bash
pm2 start runtime/networking/ws-server.ts \
  --name xln-relay \
  --interpreter bun \
  -- --port 9000 --host 0.0.0.0
```

**Protocol:**
```typescript
// Message format (encrypted)
{
  type: 'entity_input' | 'gossip_announce' | 'gossip_request',
  from: 'runtime-abc',    // Source runtime
  to: 'runtime-xyz',      // Target runtime
  encrypted: true,
  payload: '0x...'        // Encrypted with target's public key
}
```

---

### 3. Hub Runtime

**What it is:** Normal XLN runtime + relay server + funded entity

**NOT special code** - just configuration:
```typescript
// 1. Import entity (normal)
await applyRuntimeInput(env, {
  runtimeTxs: [{
    type: 'importReplica',
    entityId: hubEntityId,
    signerId: 'hub-validator',
    data: {
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: ['hub-validator'],
        shares: { 'hub-validator': 1n },
        jurisdiction: 'testnet',
      },
      isProposer: true,
    },
  }],
});

// 2. Mark as hub in gossip (ONLY difference from normal entity)
env.gossip.announce({
  entityId: hubEntityId,
  runtimeId: env.runtimeId,
  capabilities: ['hub', 'routing', 'faucet'],
  metadata: {
    isHub: true,                          // ← Makes it discoverable as hub
    name: 'Main Hub',
    region: 'global',
    relayUrl: 'wss://xln.finance/relay',  // ← Where to connect
    routingFeePPM: 100,                   // ← Fee for routing payments
  },
});

// 3. Fund reserves (normal entity operation)
await j.debugFundReserves(hubEntityId, tokenId=1, amount=1_000_000_000n * 10n**18n);
```

**Bootstrap Script:** `scripts/bootstrap-hub.ts`
- Creates hub entity if doesn't exist
- Idempotent: safe to run multiple times
- Checks gossip for existing hub, skips if found

**Deployment:**
```bash
# On xln.finance
export ANVIL_RPC=http://localhost:8545
export USE_ANVIL=true

# Bootstrap hub (one-time or on restart)
bun scripts/bootstrap-hub.ts

# Start unified server
pm2 start runtime/server.ts \
  --name xln-server \
  --interpreter bun \
  -- --port 8080
```

---

### 4. Faucet System

**Three faucet types** (all open access on testnet):

#### Faucet A: External ERC20 → Wallet
```bash
POST /api/faucet/erc20
{
  "userAddress": "0x...",
  "tokenSymbol": "USDC",
  "amount": "100"
}
```
**Result:** Hub's wallet transfers ERC20 to user's wallet address
**Use case:** User wants to deposit into reserves themselves

#### Faucet B: Hub Reserve → User Reserve
```bash
POST /api/faucet/reserve
{
  "userEntityId": "0x...",
  "tokenId": 1,
  "amount": "100"
}
```
**Result:** On-chain reserve transfer via `processBatch`
**Use case:** Skip wallet step, fund entity reserve directly

#### Faucet C: Hub → User Offchain Payment
```bash
POST /api/faucet/offchain
{
  "userEntityId": "0x...",
  "tokenId": 1,
  "amount": "100"
}
```
**Result:** Bilateral account payment (tests full consensus)
**Use case:** User has account with hub, wants offchain balance

**Faucet Discovery:**
```typescript
// Frontend queries gossip for hubs with faucet capability
const hubs = env.gossip.getProfiles().filter(p =>
  p.capabilities?.includes('faucet') && p.metadata?.isHub
);
```

---

### 5. Message Encryption (P2P Layer)

**Encryption Flow:**

```
┌─────────────┐                    ┌─────────────┐
│  Runtime A  │                    │  Runtime B  │
│             │                    │             │
│  1. Get     │                    │             │
│  target PK  │◄──────────────────►│  Gossip     │
│  from       │    Gossip query    │  Profile    │
│  gossip     │                    │  (pubKey)   │
│             │                    │             │
│  2. Encrypt │                    │             │
│  message    │                    │             │
│  with B's   │                    │             │
│  pubKey     │                    │             │
│             │                    │             │
│  3. Send    │    ┌─────────┐    │  4. Receive │
│  encrypted  │───►│  Relay  │───►│  encrypted  │
│  message    │    │ (blind) │    │  message    │
│             │    └─────────┘    │             │
│             │                    │  5. Decrypt │
│             │                    │  with own   │
│             │                    │  privKey    │
└─────────────┘                    └─────────────┘
```

**Implementation:**

```typescript
// runtime/networking/encrypted-messaging.ts

import { deriveEncryptionKeyPair, encryptMessage, decryptMessage } from './p2p-crypto';

class EncryptedMessaging {
  private keyPair: P2PKeyPair;

  constructor(runtimeSeed: Uint8Array) {
    // Derive X25519 keypair from runtime seed
    this.keyPair = deriveEncryptionKeyPair(runtimeSeed);
  }

  // Encrypt message for target runtime
  async encrypt(message: EntityInput, targetRuntimeId: string): Promise<string> {
    // 1. Get target's public key from gossip
    const targetProfile = env.gossip.getProfile(targetRuntimeId);
    if (!targetProfile?.metadata?.runtimePublicKey) {
      throw new Error('Target runtime public key not found');
    }

    // 2. Encrypt message
    const plaintext = JSON.stringify(message);
    const encrypted = encryptMessage(
      plaintext,
      targetProfile.metadata.runtimePublicKey,
      this.keyPair.secretKey
    );

    return encrypted; // Base64 or hex
  }

  // Decrypt message from source runtime
  async decrypt(encrypted: string, sourceRuntimeId: string): Promise<EntityInput> {
    // 1. Decrypt with our secret key
    const plaintext = decryptMessage(encrypted, this.keyPair.secretKey);

    // 2. Parse and validate
    const message = JSON.parse(plaintext);

    // 3. Verify source (optional: signature check)
    // ...

    return message;
  }

  // Get our public key for gossip announcement
  getPublicKey(): string {
    return pubKeyToHex(this.keyPair.publicKey);
  }
}
```

**Gossip Integration:**
```typescript
// Include runtime public key in gossip profile
env.gossip.announce({
  entityId: myEntityId,
  runtimeId: env.runtimeId,
  metadata: {
    runtimePublicKey: encryption.getPublicKey(), // ← For E2E encryption
    // ... other metadata
  },
});
```

---

### 6. Frontend Integration

**J-Machine Import (Auto-detect):**

```typescript
// frontend/src/lib/stores/xlnStore.ts

async function initializeXLN(): Promise<Env> {
  const xln = await getXLN();
  const env = await xln.main();

  // Auto-import J-Machine based on environment
  const isProduction = window.location.hostname === 'xln.finance';
  const isScenario = window.location.pathname.startsWith('/scenarios');

  if (isScenario) {
    // Scenario mode: BrowserVM (offline)
    await xln.applyRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          mode: 'browservm',
          chainId: 31337,
          name: 'Local',
        },
      }],
    });
  } else if (isProduction) {
    // Production: Anvil testnet
    await xln.applyRuntimeInput(env, {
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
  } else {
    // Local dev: Manual selection
    // User chooses via UI
  }

  return env;
}
```

**Hub Discovery UI:**

```svelte
<!-- frontend/src/lib/components/Hub/HubSelector.svelte -->
<script lang="ts">
  import { xlnEnvironment } from '$lib/stores/xlnStore';

  $: hubs = $xlnEnvironment?.gossip?.getProfiles()
    .filter(p => p.metadata?.isHub === true) || [];

  function selectHub(hubEntityId: string) {
    // Open account with selected hub
    // User extends credit to hub
  }
</script>

<div class="hub-list">
  <h3>Available Hubs</h3>
  {#each hubs as hub}
    <div class="hub-card">
      <span class="hub-name">{hub.metadata.name}</span>
      <span class="hub-region">{hub.metadata.region}</span>
      <span class="hub-fee">{hub.metadata.routingFeePPM / 10000}%</span>
      <button on:click={() => selectHub(hub.entityId)}>Connect</button>
    </div>
  {/each}
</div>
```

**Testnet Badge:**

```svelte
<!-- Show testnet indicator when connected to testnet J -->
{#if $xlnEnvironment?.jReplicas?.values().next().value?.name === 'Testnet'}
  <div class="testnet-badge">
    🧪 TESTNET
  </div>
{/if}
```

---

## 📋 Implementation Phases

### Phase 1: Remove Hub Special Logic (BLOCKER)
**Time:** 1-2 hours
**Priority:** P0

**Tasks:**
- [ ] Create `scripts/bootstrap-hub.ts` - idempotent hub creation
- [ ] Delete `createMainHub()` from `runtime/server.ts`
- [ ] Update faucet endpoints to query gossip instead of hardcoded hub ID
- [ ] Test: Hub behaves like normal entity (can be recreated, deleted, etc.)

**Success Criteria:**
- ✅ No `(env as any).mainHubEntityId` in codebase
- ✅ Hub entity visible in gossip like any entity
- ✅ Faucets work by querying gossip for hubs
- ✅ Can run multiple hubs simultaneously

---

### Phase 2: Runtime Message Encryption
**Time:** 1 hour
**Priority:** P1

**Tasks:**
- [ ] Create `runtime/networking/encrypted-messaging.ts`
- [ ] Integrate with existing `p2p-crypto.ts` (X25519)
- [ ] Add `runtimePublicKey` to gossip profiles
- [ ] Encrypt messages before sending to relay
- [ ] Decrypt messages on receive from relay
- [ ] Test: Relay cannot read message content

**Success Criteria:**
- ✅ All runtime-to-runtime messages encrypted
- ✅ Relay sees only encrypted blobs
- ✅ Only target runtime can decrypt
- ✅ Invalid decryption fails gracefully

---

### Phase 3: Gossip Hub Discovery
**Time:** 30 minutes
**Priority:** P2

**Tasks:**
- [ ] Add `getHubs()` helper to gossip layer
- [ ] Frontend queries gossip for hub list
- [ ] Display available hubs in UI
- [ ] User can select hub to connect to

**Success Criteria:**
- ✅ Gossip returns all entities with `metadata.isHub === true`
- ✅ Frontend shows hub list with metadata (name, region, fee)
- ✅ User can click to open account with hub

---

### Phase 4: Frontend Auto-Import Testnet
**Time:** 30 minutes
**Priority:** P2

**Tasks:**
- [ ] Detect production domain (`xln.finance`)
- [ ] Auto-import testnet J-machine on production
- [ ] Show testnet badge in UI
- [ ] Add faucet panel UI (3 buttons for 3 faucet types)

**Success Criteria:**
- ✅ xln.finance auto-loads testnet J
- ✅ Localhost uses manual selection or BrowserVM
- ✅ Testnet badge visible when on testnet
- ✅ Faucet UI functional

---

### Phase 5: Clean Relay Duplication
**Time:** 30 minutes
**Priority:** P3

**Tasks:**
- [ ] Delete relay message handlers from `server.ts` (lines 125-190)
- [ ] Keep only: faucet endpoints, static serving, health checks
- [ ] Deploy relay as separate PM2 process
- [ ] Server connects to relay via `RuntimeP2P` client

**Success Criteria:**
- ✅ No duplicate routing logic
- ✅ Relay runs standalone (can restart independently)
- ✅ Server is pure application logic (no transport layer)

---

### Phase 6: Multi-Hub Routing Test
**Time:** 2 hours
**Priority:** P3

**Tasks:**
- [ ] Start relay server on :9000
- [ ] Bootstrap Hub1 (Main, region: US)
- [ ] Bootstrap Hub2 (Secondary, region: EU)
- [ ] Create account: Hub1 ↔ Hub2
- [ ] Test routing: User1 → Hub1 → Hub2 → User2
- [ ] Verify encryption per hop

**Success Criteria:**
- ✅ Two hubs running simultaneously
- ✅ Hubs have bilateral account with each other
- ✅ Payment routes through both hubs
- ✅ Each hop encrypted independently
- ✅ Relay cannot read any message content

---

## ✅ Success Criteria (MVP Complete)

### Functional Requirements
- [x] Anvil running on xln.finance with state persistence
- [x] 3 faucet types working (ERC20, reserve, offchain)
- [ ] Hub = normal entity (no special code)
- [ ] Runtime-to-runtime encryption (relay is blind)
- [ ] Multiple hubs interconnected via accounts
- [ ] User → Hub1 → Hub2 → User routing
- [ ] Frontend auto-imports testnet J on production
- [ ] Gossip-based hub discovery

### Architecture Requirements
- [ ] No special hub logic anywhere in codebase
- [ ] Relay server standalone (separate from business logic)
- [ ] Connection registry: runtimeId → WebSocket
- [ ] Gossip stores hub metadata (isHub, relayUrl, fee)
- [ ] All messages encrypted (relay sees encrypted blobs)

### Deployment Requirements
- [ ] Anvil deployed on xln.finance (:8545)
- [ ] Relay deployed on xln.finance (:9000)
- [ ] Server deployed on xln.finance (:8080)
- [ ] Nginx proxies: `/rpc` → anvil, `/relay` → relay (WSS)
- [ ] PM2 manages all processes (auto-restart)
- [ ] State persistence (anvil state, gossip profiles)

### User Flow (E2E Test)
1. User visits `https://xln.finance`
2. Frontend auto-imports testnet J-machine
3. User creates entity (auto-registered on anvil)
4. User sees available hubs in dropdown
5. User requests faucet (gets $100 USDC in reserve)
6. User opens account with Hub1
7. User extends $500k credit to Hub1
8. User sends $10 payment to User2 (routes through Hub1)
9. Payment encrypted, relay cannot read
10. User2 receives $10 (bilateral consensus complete)

---

## 🔐 Security Model

### Trust Assumptions

**Untrusted:**
- ❌ Relay servers (can drop, delay, reorder messages)
- ❌ Network (can be monitored, intercepted)
- ❌ Other hubs (can be malicious, collude)

**Trusted:**
- ✅ Local runtime (user controls)
- ✅ Cryptography (X25519, secp256k1)
- ✅ Smart contracts (verified on-chain)
- ✅ Bilateral consensus (self-enforcing)

### Threat Model

**Attack:** Relay reads messages
- **Defense:** Runtime-to-runtime encryption (relay sees encrypted blobs)

**Attack:** Relay spoofs messages
- **Defense:** Messages signed by source runtime, verified by target

**Attack:** Relay drops messages
- **Defense:** Timeout + retry, gossip provides alternate routes

**Attack:** Hub steals funds
- **Defense:** Users extend credit (hub owes user), not reverse. Settlements on-chain.

**Attack:** Hub colludes with other hubs
- **Defense:** Each hop encrypted independently, bilateral consensus per account

**Attack:** State rollback (anvil reset)
- **Defense:** State persistence, users monitor on-chain state

---

## 📊 Metrics & Monitoring

### Health Checks

**Anvil:**
```bash
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
# Expected: {"result":"0xNNN"}
```

**Relay:**
```bash
curl http://localhost:9000/health
# Expected: {"status":"ok","connections":N}
```

**Server:**
```bash
curl https://xln.finance/api/health
# Expected: {"status":"ok","runtime":true,"clients":N}
```

### Key Metrics

**Relay:**
- Active connections (gauge)
- Messages routed/sec (counter)
- Encryption failures (counter)
- Queue depth by runtime (gauge)

**Hub:**
- Open accounts (gauge)
- Routing volume (counter)
- Faucet requests (counter)
- Failed transactions (counter)

**Anvil:**
- Block height (gauge)
- State file size (gauge)
- Transactions/sec (counter)

---

## 🚀 Deployment Checklist

### Initial Setup (One-Time)

```bash
# 1. Install dependencies
curl -L https://foundry.paradigm.xyz | bash
foundryup
curl -fsSL https://bun.sh/install | bash

# 2. Create directories
mkdir -p /root/xln/data /root/xln/logs

# 3. Clone repository
cd /root
git clone https://github.com/xlnfinance/xln.git
cd xln
bun install

# 4. Build contracts
cd jurisdictions
bun run compile
cd ..

# 5. Build runtime
bun build runtime/runtime.ts --target=browser --outfile=frontend/static/runtime.js

# 6. Build frontend
cd frontend
bun run build
cd ..
```

### Start Services

```bash
# 1. Start Anvil
pm2 start scripts/start-anvil.sh --name xln-anvil --interpreter bash

# 2. Bootstrap hub (idempotent)
export ANVIL_RPC=http://localhost:8545
export USE_ANVIL=true
bun scripts/bootstrap-hub.ts

# 3. Start relay
pm2 start runtime/networking/ws-server.ts --name xln-relay \
  --interpreter bun -- --port 9000 --host 0.0.0.0

# 4. Start server
pm2 start runtime/server.ts --name xln-server \
  --interpreter bun -- --port 8080

# 5. Save PM2 config
pm2 save

# 6. Enable auto-start on reboot
pm2 startup
```

### Nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name xln.finance;

    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    # Anvil RPC proxy
    location /rpc {
        proxy_pass http://localhost:8545;
        proxy_http_version 1.1;
        add_header Access-Control-Allow-Origin *;
    }

    # Relay WebSocket proxy
    location /relay {
        proxy_pass http://localhost:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }

    # API endpoints
    location /api/ {
        proxy_pass http://localhost:8080;
    }

    # Static files
    location / {
        root /root/xln/frontend/build;
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 📚 Reference Implementation

### Example: Opening Account with Hub

**Frontend:**
```typescript
// 1. Discover hubs
const hubs = env.gossip.getHubs();
const mainHub = hubs.find(h => h.metadata.name === 'Main Hub');

// 2. Open account
await xln.applyRuntimeInput(env, {
  entityInputs: [{
    entityId: myEntityId,
    signerId: mySignerId,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: mainHub.entityId },
    }],
  }],
});

// 3. Extend credit to hub (user trusts hub)
await xln.applyRuntimeInput(env, {
  entityInputs: [{
    entityId: myEntityId,
    signerId: mySignerId,
    entityTxs: [{
      type: 'extendCredit',
      data: {
        counterpartyEntityId: mainHub.entityId,
        tokenId: 1, // USDC
        amount: 500_000n * 10n ** 18n, // $500k credit limit
      },
    }],
  }],
});
```

### Example: Multi-Hub Routing

**Setup:**
```
User1 ↔ Hub1 ↔ Hub2 ↔ User2
```

**Payment:**
```typescript
// User1 sends $10 to User2
await xln.applyRuntimeInput(env, {
  entityInputs: [{
    entityId: user1EntityId,
    signerId: user1SignerId,
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: user2EntityId,
        tokenId: 1,
        amount: 10n * 10n ** 18n,
        route: [user1EntityId, hub1EntityId, hub2EntityId, user2EntityId],
      },
    }],
  }],
});
```

**Encryption per hop:**
1. User1 → Hub1: Encrypted with Hub1's runtime public key
2. Hub1 → Hub2: Encrypted with Hub2's runtime public key
3. Hub2 → User2: Encrypted with User2's runtime public key

**Relay sees:**
- 3 encrypted messages (cannot read any)
- Routing metadata (from/to runtimeIds)
- No payment amount, no entity IDs, no route info

---

## 🎓 Appendix: Key Concepts

### Hub vs Entity vs Runtime

**Entity:**
- Identifier: `entityId` (hash of board config)
- Has accounts with other entities
- Can send/receive payments
- Can be single-signer or multi-signer (board)

**Runtime:**
- Identifier: `runtimeId` (deterministic from seed)
- Hosts one or more entities
- Connects to relay for P2P
- Encrypts messages to other runtimes

**Hub:**
- Special case of entity with:
  - Large reserves (funded)
  - Gossip metadata: `isHub: true`
  - Relay server URL in metadata
  - Routing capability advertised
- NO special code - just configuration

### Credit vs Collateral

**Credit:**
- "I trust you for $X" (unsecured)
- Set via `extendCredit` entity tx
- Stored in `leftCreditLimit` / `rightCreditLimit`
- Users extend credit TO hubs (not reverse!)

**Collateral:**
- "I lock $X on-chain" (secured)
- Moved from reserve to account via `reserveToCollateral`
- Stored in delta.collateral
- Used when credit exhausted or for untrusted counterparties

**Hybrid:**
- Hub extends NO credit to users (too risky)
- Users extend credit to hub (users choose risk)
- Hub posts collateral for large routes (proves solvency)

### Gossip vs Blockchain

**Gossip Layer:**
- Off-chain profile announcement
- Stores: entity metadata, routing info, hub list
- Fast updates (instant)
- Eventually consistent
- Untrusted (verify signatures)

**Blockchain (J-Machine):**
- On-chain reserve storage
- Stores: entity registration, reserve balances, settlements
- Slow updates (block time)
- Strongly consistent
- Trusted (verified by EVM)

---

## ✨ Future Enhancements (Post-MVP)

### Short-Term (Next 3 Months)
- [ ] Rate limiting on faucets (per IP, per entity)
- [ ] Hub status dashboard (public page showing reserves, accounts, uptime)
- [ ] Multi-currency support (ETH, USDT, etc.)
- [ ] Mobile-friendly UI
- [ ] Dispute UI (challenge fraud, submit proofs)

### Medium-Term (Next 6 Months)
- [ ] Privacy: Onion routing (multi-hop obfuscation)
- [ ] Scalability: Sharded gossip (regional hubs)
- [ ] UX: One-click account opening with default hub
- [ ] Analytics: Payment graphs, network topology viz
- [ ] Testing: Chaos engineering (kill random hubs, test resilience)

### Long-Term (Next 12 Months)
- [ ] Production deployment (mainnet contracts)
- [ ] Insurance layer (hub insurance pools)
- [ ] Cross-chain bridges (Ethereum ↔ Polygon ↔ Arbitrum)
- [ ] Lightning integration (XLN ↔ Lightning routing)
- [ ] Mainnet launch 🚀

---

**END OF MVP SPECIFICATION**

This document serves as the canonical specification for XLN's MVP testnet deployment. All implementation should reference this document for architectural decisions, deployment procedures, and success criteria.
