# XLN - Cross-Local Network


**Instant off-chain settlement with on-chain finality.**

Byzantine consensus meets Bloomberg Terminal meets VR. Run complete economic simulations in your browser—no backend needed.

---

## 🌐 Directory Structure

```
Core:
  /docs/                Philosophy, architecture, eternal specs
  /runtime/             Consensus engine (BFT entity + bilateral account state machines)
    /account-tx/        Account transaction handlers
    /entity-tx/         Entity transaction handlers
    /scenarios/         Economic simulations (ahb.ts, grid.ts, etc.)
    /evms/              EVM integrations (BrowserVM, remote)
  /jurisdictions/       Solidity contracts (Ethereum, Polygon, Arbitrum, ...)
  /frontend/            Main xln.finance app + 3D visualization
    /src/lib/components/   UI panels (Entity, Network, TimeMachine, etc.)
  /tests/               E2E tests (Playwright)

Dev:
  /scripts/             Utilities (playwright helpers, deployment, debug)
  /ai/                  AI integrations (STT server, telegram bot, council)
  bootstrap.sh          One-command setup
  CLAUDE.md             AI instructions
  .archive/             Old implementations (historical reference)

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

## 🎯 What is XLN?

Cross-Local Network enables entities to:
- Exchange value **instantly off-chain** (BFT consensus)
- Anchor final state **on-chain** (Ethereum, Polygon, Arbitrum)
- Run complete **economic simulations in browser** (BrowserVM - no backend!)
- Visualize in **VR** (Quest/Vision Pro compatible)

**Think:** Lightning Network + Byzantine consensus + Bloomberg Terminal + Blender.

### Finance is physics of trust

---

## 🏗️ Architecture (J-E-A Layers)

### J - Jurisdiction Layer (On-Chain)
- **What:** Solidity contracts managing reserves, collateral, settlements
- **Where:** `/jurisdictions/contracts/`
- **Contracts:**
  - `Depository.sol` - Implements `IDepository` (future ERC standard)
  - `EntityProvider.sol` - Entity registration + quorum verification
- **Deploy:** Ethereum, Polygon, Arbitrum, any EVM chain

### E - Entity Layer (Off-Chain BFT Consensus)
- **What:** Distributed organizations with threshold signatures
- **Flow:** ADD_TX → PROPOSE → SIGN → COMMIT
- **Source:** `/runtime/entity-consensus.ts`
- **Deterministic:** Nonce-based ordering, Merkle state roots

### A - Account Layer (Bilateral Channels)
- **What:** Payment channels between entity pairs
- **Perspective:** Left/right with canonical ordering (entityA < entityB)
- **Source:** `/runtime/account-consensus.ts`
- **Settlement:** Bilateral state verification with Merkle proofs

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

## 📚 Documentation Tree

```
Root:
  readme.md              This file - project overview
  todo.md                Active TODO/NEXT backlog
  CLAUDE.md              AI assistant instructions
  CHANGELOG.md           Version history

/docs/
  ├── contributing/      How to develop on XLN
  │   ├── workflow.md           Daily commands (bun run dev, etc)
  │   ├── bug-prevention.md     Pre-commit checklist
  │   ├── agentic.md            AI autonomous execution (80% rule)
  │   └── adhd-format.md        Response formatting guide
  │
  ├── research/          Explorations & specifications
  │   ├── insurance/            Insurance layer designs
  │   │   ├── claude-analysis.md
  │   │   ├── codex-analysis.md
  │   │   └── gemini-analysis.md
  │   ├── depository-core.md    Contract logic summary
  │   └── rollups-position.md   XLN vs rollups comparison
  │
  ├── status.md          Current launch state and blocker order
  ├── mainnet.md         Real-user-fund release bar
  ├── roadmap.md         Strategic rollout plan
  ├── recovery-watchtower-protocol.md
  │                       Recovery, tower backup, and last-resort dispute spec
  ├── deployment/        Deploy and ops runbooks
  ├── archive/           Historical snapshots only
  │
  ├── about/             Philosophy & origin
  │   ├── homakov.md            Founder's vision
  │   └── repo-structure.md     Private vs public repos
  │
  ├── testing/           Test procedures
  │   └── ahb-demo.md           AHB demo steps
  │
  └── docs/              Core architecture (existing)
      ├── rjea.md               R→E→A→J flow explanation
      ├── xlnview.md            Panel architecture
      ├── flow.md               Transaction flow
      └── ...                   (eternal specs)
```

**Quick links:**
- New to XLN? Start with [docs/readme.md](docs/readme.md)
- Current priorities? Check [todo.md](todo.md)
- Current launch state? Read [docs/status.md](docs/status.md)
- Mainnet bar? Read [docs/mainnet.md](docs/mainnet.md)

---

## 🔥 Recent Updates (`0.1.5` - May 2026)

- ✅ **Official watchtower** - Same-origin `/api/tower/*`, standalone daemon, scheduled sweep, and no public `/api/watchtower/*` sweep exposure
- ✅ **Encrypted recovery** - Tower backup bundles and delayed-last-resort active remedies are encrypted; plaintext active remedies are rejected
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
