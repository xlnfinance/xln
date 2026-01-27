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
bunx playwright test            # E2E tests
bunx playwright test tests/ahb-smoke.spec.ts  # AHB smoke test
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
  CLAUDE.md              AI assistant instructions
  changelog.md           Version history

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
  ├── planning/          Active & historical planning
  │   ├── active/
  │   │   └── next.md           Current priority tasks
  │   ├── completed/            Finished refactors
  │   └── launch-checklist.md   Pre-launch verification
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
- New to XLN? Start with [docs/about/homakov.md](docs/about/homakov.md)
- Want to contribute? Read [docs/contributing/workflow.md](docs/contributing/workflow.md)
- Current priorities? Check [docs/planning/active/next.md](docs/planning/active/next.md)
- Architecture deep-dive? See [docs/docs/rjea.md](docs/docs/rjea.md)

---

## 🔥 Recent Updates (Oct 2025)

- ✅ **Repository restructure** - Essence-driven naming (docs, runtime, jurisdictions, worlds)
- ✅ **BrowserVM integration** - Offline simnet with @ethereumjs/vm
- ✅ **Panel workspace** - Dockview-based Bloomberg Terminal UX
- ✅ **WebGPU/WebGL switch** - Runtime renderer toggle (future-proof)
- ✅ **IDepository interface** - Standardizable ERC for reserve management
- ✅ **Depository** - 69% smaller, self-contained (6.6KB vs 21KB)

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

### Simnet (Now - Oct 2025)
**Browser-only simulation. Zero infrastructure.**
- **Engine:** @ethereumjs/vm (in-browser blockchain)
- **Contracts:** Depository.sol (6.6KB, implements IDepository)
- **State:** 500 prefunded entities, USDC + ETH
- **Reset:** Refresh page = new universe
- **Use:** Scenario rehearsals, VR demos, tutorials

### Testnet (Q1 2026)
**Base Sepolia. Multi-user coordination.**
- **Network:** Base L2 Sepolia (chainId: 84532)
- **Contracts:** Full suite (EntityProvider, Depository, DeltaTransformer)
- **RPC:** https://sepolia.base.org
- **Use:** Integration testing, onboarding flows, load testing

### Mainnet (Q4 2026)
**Production deployment. Real value.**
- **Chains:** Base L2 (primary), Ethereum L1 (bridge)
- **Governance:** Multi-sig + timelock
- **Audits:** Trail of Bits + OpenZeppelin
- **Use:** Live settlement network

---

## 📖 Learn More

**Start here:**
1. [docs/contributing/workflow.md](docs/contributing/workflow.md) - Daily dev commands
2. [docs/docs/xlnview.md](docs/docs/xlnview.md) - Panel architecture + BrowserVM
3. [docs/docs/rjea.md](docs/docs/rjea.md) - R→E→A→J flow explanation
4. [simnet/readme.md](simnet/readme.md) - Offline blockchain setup

**For deep dives:** [docs/docs/](docs/docs/)

---

**License:** AGPL-3.0
**Status:** Active development (2025)
**Website:** xln.finance (coming soon)
