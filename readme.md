# xln — Cross-Local Network


**Instant off-chain settlement with on-chain finality.**

Byzantine consensus meets Bloomberg Terminal meets VR. Run complete economic simulations in your browser—no backend needed.

---

## Repository map

```
xln/
├── runtime/
│   ├── runtime/        Runtime input, frame, WAL boundary, and output routing
│   ├── entity/         Entity transactions, candidates, and Hanko consensus
│   ├── account/        Bilateral consensus and all financial mutation
│   ├── jurisdiction/   Deterministic jurisdiction protocol and event facts
│   ├── jadapter/       External chain observation and submission
│   ├── storage/        WAL, current state, history views, and recovery
│   ├── networking/     Runtime-to-Runtime transport
│   ├── relay/          Discovery and market relay services
│   ├── api/            Public Runtime API
│   ├── server/         HTTP/WebSocket delivery
│   └── orchestrator/   Process startup and service composition
├── jurisdictions/      Solidity settlement and dispute contracts
├── frontend/           xln.finance client; display and input only
├── tests/              Browser and full-stack E2E evidence
├── docs/               Live protocol specifications and audit guides
├── scripts/            Build, release, audit-context, and operator tools
└── .archive/           Historical implementations; never current authority
```

`runtime.ts` is intentionally a narrow public facade. Core behavior belongs to
the owning Runtime, Entity, or Account folder; physical I/O stays outside those
state-machine folders.

---

## 🚀 Quick Start

```bash
# Install + start everything
bun run dev

# Open browser
open http://localhost:8080
```

**First run:** ~2-3min (installs Foundry)
**After:** ~10sec

---

## 🎯 What is xln?

Cross-Local Network enables entities to:
- Exchange value **instantly off-chain** (BFT consensus)
- Anchor final state **on-chain** (Ethereum, Polygon, Arbitrum)
- Run complete **economic simulations in browser** (BrowserVM - no backend!)
- Visualize in **VR** (Quest/Vision Pro compatible)

**Think:** Lightning Network + Byzantine consensus + Bloomberg Terminal + Blender.

### Finance is physics of trust

---

## 🏗️ Architecture: nested R → E → A replicas

xln is three deterministic state machines nested inside one another. The
fourth layer, Jurisdiction, is the on-chain settlement boundary.

```text
EXTERNAL WORLD
  │ actions / peer messages / finalized J events
  ▼
┌──────────────────────────── RuntimeReplica ─────────────────────────────┐
│ RuntimeInput[RuntimeTx, routed EntityInput]                             │
│   applyRuntimeInput → RuntimeFrame → WAL commit                         │
│                                                                        │
│   ┌──────────────────────── EntityReplica ──────────────────────────┐   │
│   │ EntityInput[EntityTx, proposal, precommit, certificate]         │   │
│   │   applyEntityInput → EntityFrame → EntityOutput                 │   │
│   │                                                                 │   │
│   │   ┌────────────────── AccountReplica ────────────────────────┐   │   │
│   │   │ AccountInput                                             │   │   │
│   │   │   ├─ txs[AccountTx]                    local admission   │   │   │
│   │   │   └─ frame/ack/dispute/...              peer consensus  │   │   │
│   │   │   applyAccountInput → AccountFrame → AccountOutput       │   │   │
│   │   └───────────────────────────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ RuntimeOutput → dispatch only after WAL                               │
└────────────────────────────────────────────────────────────────────────┘
  │ settlement batches                              ▲ finalized events
  ▼                                                 │
┌──────────────────────── Jurisdiction ──────────────────────────────────┐
│ Depository contracts: reserves, collateral, disputes and final truth  │
└────────────────────────────────────────────────────────────────────────┘
```

The same vocabulary repeats at every off-chain layer:

| Layer | Live instance | Committed data | Entry | Requested change | Commitment | Result |
|---|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` | `RuntimeOutput` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` | `EntityOutput` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` | `AccountOutput` |

`*Replica` is a live instance. `*State` is only the deterministic data
committed by a frame. `*Machine` names transition logic, never a data type.

An application `EntityOutput` certifies only its destination Entity and exact
payload. It does not certify validator topology. Runtime resolves that output
to an exact signer replica, records the routed `EntityInput` in its candidate
frame, commits WAL, and only then permits delivery. Validator-to-validator
consensus messages may already name their exact signer.

```mermaid
flowchart TB
  EXT["External actions<br/>peer messages<br/>finalized J events"]

  subgraph R["RuntimeReplica — single writer"]
    RI["RuntimeInput<br/>RuntimeTx[] + routed EntityInput[]"]
    AR["applyRuntimeInput(replica, input)"]
    RF["RuntimeFrame<br/>next RuntimeState"]
    WAL[("WAL<br/>only Runtime commit point")]
    RO["RuntimeOutput<br/>post-commit effects"]
    RI --> AR --> RF --> WAL --> RO

    subgraph E["EntityReplica — validator consensus"]
      EI["EntityInput<br/>EntityTx[] + consensus evidence"]
      AE["applyEntityInput(replica, input)"]
      EF["EntityFrame<br/>candidate → certificate"]
      EO["EntityOutput"]
      EI --> AE --> EF --> EO

      subgraph A["AccountReplica — bilateral consensus"]
        AI{"AccountInput"}
        AT["txs<br/>AccountTx[]<br/>local only"]
        AP["frame / ack / frame_ack<br/>dispute / reseal / settle<br/>peer evidence"]
        AA["applyAccountInput(replica, input)"]
        AF["AccountFrame<br/>candidate → bilateral ACK"]
        AO["AccountOutput"]
        AI --> AT --> AA
        AI --> AP --> AA
        AA --> AF --> AO
      end
    end
  end

  J["Jurisdiction contracts<br/>reserves · collateral · disputes · final truth"]

  EXT --> RI
  EO -- "Runtime resolves signer<br/>before RuntimeFrame commit" --> AR
  AR -- "route exact EntityInput" --> EI
  AE -- "EntityTx.accountInput<br/>commits exact peer input" --> AI
  EO -- "deterministic child outputs" --> AR
  AO -- "deterministic child outputs" --> AE
  RO -- "dispatch settlement batch" --> J
  J -- "authenticated finalized event" --> EXT
```

### The transition law

```text
(previous replica, input) → { next replica, outputs }
```

- An input controls exactly one replica and contains that layer's transactions
  plus any consensus evidence.
- `EntityTx.accountInput` is the parent wrapper that commits the exact child
  `AccountPeerInput` inside the Entity frame. Entity-owned financial txs create
  the local `AccountInput.txs` branch without exposing it to P2P.
- Every Account path enters `applyAccountInput`: local `txs` builds a future
  Account frame; peer variants advance bilateral consensus.
- Outputs move upward as deterministic data. External I/O starts only after
  the enclosing Runtime frame is durable.
- Runtime has one writer and WAL; Entity keeps a candidate until validator
  certification; Account keeps a candidate until bilateral ACK.

The detailed protocol guide is
[Runtime → Entity → Account → Jurisdiction](docs/core/rjea-architecture.md).

---

## 💻 Key Commands

```bash
# Development
bun run dev              # Full stack (jurisdictions + runtime + frontend)
bun run check            # TypeScript + Svelte validation
bun run build            # Build runtime.js for browser

# Jurisdictions (Contracts)
bun run env:build        # Compile Solidity
bun run env:deploy       # Deploy to local network
bun run dev:reset        # Reset all networks + redeploy

# Frontend
cd frontend && bun run dev      # Vite dev server
cd frontend && bun run build    # Production build

# Testing
bun run test:e2e          # Fast E2E: 8 core scenarios in parallel
bun run test:e2e:fast     # Same fast bar, explicit name
bun run test:e2e:full     # Full E2E: every tests/e2e*.spec.ts target
bun run test:e2e:parallel:isolated  # Raw isolated E2E runner for custom targets

# Production-scale runtime adapter benchmarks
bun run bench:radapter:hub1m         # 1M saved hub accounts, 1% hot set, real /rpc WebSocket
bun run bench:radapter:hub1m:allmem  # Same, but materialize all 1M accounts into runtime memory
```

---

## 🎨 XLNView Panel System

**Bloomberg Terminal-style workspace. Drag, dock, float, tab - full Chrome DevTools UX.**

### Core 4 Panels (Open by Default)
1. **🌐 Graph3D** - Force-directed network viz (WebGL/WebGPU toggle)
2. **🏢 Entities** - Live entity list (reserves, accounts, activity)
3. **💰 Depository** - On-chain J-state viewer (BrowserVM queries)
4. **🎬 Architect** - God-mode controls (5 modes: Explore/Build/Economy/Governance/Resolve)

### Layouts
- **Default**: 4-panel workspace
- **Analyst**: Graph3D + Depository + Console (research mode)
- **Builder**: Architect + Graph3D + Entities (creation mode)
- **Embed**: Graph3D only (for docs/blog posts)

**Tech:** Dockview (2.8k stars), Svelte reactivity, localStorage persistence

**Source:** `/frontend/src/lib/components/` + `/docs/xlnview.md`

---

## 🧪 Simnet (Offline Blockchain in Browser)

**No localhost:8545. No cloud RPC. Pure browser.**

- **Engine:** @ethereumjs/vm v10 (official Ethereum Foundation implementation)
- **Deployed:** Depository.sol + 500 prefunded entities
- **Tokens:** USDC (id=1), ETH (id=2)
- **Reset:** Refresh page = new universe
- **Persistent:** Optional IndexedDB (resume sessions)

**Config:** Genesis configs in `runtime/evms/browser-evm.ts`

**Demo:** Load any scenario (AHB, Grid) - BrowserVM deploys contracts automatically

---

## 🎮 VR/Quest Support

- **WebXR:** Enabled by default (WebGL renderer)
- **Offline:** Simnet works without network (perfect for VR demos)
- **Performance:** 72fps in Quest 3
- **Future:** Hand tracking, voice commands, spatial UI

---

## Auditor reading path

The shortest reliable path from protocol vocabulary to one committed unit of
value is:

1. [R → E → A → J architecture](docs/core/rjea-architecture.md)
2. [Payment and HTLC flow](docs/implementation/payment-spec.md)
3. `runtime/runtime/frame/process.ts` — Runtime transition and WAL ordering
4. `runtime/entity/consensus/input-consensus.ts` — Entity entry point
5. `runtime/account/consensus/index.ts` — Account entry point and collision
6. `runtime/account/tx/apply.ts` — financial validation
7. `runtime/account/tx/mutation.ts` — financial mutation
8. `runtime/storage/commit.ts` — the only durable Runtime commit point

Then read [the documentation index](docs/readme.md), [active release
blockers](todo.md), and [the mainnet acceptance bar](docs/mainnet.md). Files
under `docs/archive/` and `docs/releases/` are historical evidence, never
current protocol authority.

---

## 🔥 Recent Updates (`0.1.5` - May 2026)

- ✅ **Official watchtower** - Same-origin `/api/tower/*`, standalone daemon, scheduled sweep, and no public `/api/watchtower/*` sweep exposure
- ✅ **Encrypted recovery** - Tower backup bundles and delayed-last-resort remedies are encrypted; plaintext last-resort remedies are rejected
- ✅ **Recovery E2E** - Wiped-browser tower restore and post-restore channel payments are covered by browser tests
- ✅ **Prod health** - Market maker/reset recovery and prod payment smoke passed in the `0.1.5` release pass
- ✅ **Planning cleanup** - Live TODO/NEXT work is consolidated into [todo.md](todo.md)

---

## 🛠️ Tech Stack

**Runtime:** TypeScript + Bun
**Frontend:** Svelte + Vite + Three.js
**Contracts:** Solidity + Hardhat
**Blockchain:** @ethereumjs/vm (simnet) → Hardhat (local) → Ethereum/L2s (prod)
**Panels:** Dockview (2.8k⭐)
**Tests:** Playwright

---

## 🗺️ Network Roadmap

The current release line is production-demo/public-testnet grade, not
mainnet-ready. The active blocker order is in [todo.md](todo.md), current
status is in [docs/status.md](docs/status.md), and the real-user-fund bar is in
[docs/mainnet.md](docs/mainnet.md).

Current focus:

- keep local and prod-like E2E green for payments, swaps, disputes, recovery,
  and watchtower action;
- finish Peer State Refresh and account-level recovery coverage UX;
- run release-duration soak/gates before any mainnet-candidate claim;
- make chain/RPC, operator keys, tower gas policy, and monitoring explicit;
- prepare external audit material before real funds.

---

## 📖 Learn More

**Start here:**
1. [docs/readme.md](docs/readme.md) - Documentation index
2. [todo.md](todo.md) - Active TODO/NEXT backlog
3. [docs/status.md](docs/status.md) - Current launch state
4. [docs/mainnet.md](docs/mainnet.md) - Mainnet release bar
5. [docs/recovery-watchtower-protocol.md](docs/recovery-watchtower-protocol.md) - Recovery and watchtower protocol

**For deep dives:** [docs/readme.md](docs/readme.md)

---

**License:** AGPL-3.0
**Status:** Active development, pre-mainnet `0.1.5`
**Website:** https://xln.finance
