# XLN - Cross-Local Network

![XLN Network Visualization](frontend/static/img/preview.png)

**Unified Layer-2 for EVM jurisdictions.** Reserve-credit network combining full-credit banking with payment channel architectures.

---

## 🚀 **One-Liner Install** (Recommended)

```bash
bunx github:xlnfinance/xln
```

**Or traditional:**
```bash
git clone https://github.com/xlnfinance/xln
cd xln
bun run dev
```

Both auto-install everything (bun, Foundry, dependencies, contracts).

**First run:** ~2-3 minutes (downloads Foundry)  
**After:** ~10 seconds

**Opens:** http://localhost:8080

---

## What It Does

```
✅ Checks if bun installed (installs if needed)
✅ Checks if Foundry/anvil installed (auto-installs)
✅ Installs all dependencies (root, frontend, contracts)
✅ Starts local blockchain (anvil)
✅ Deploys smart contracts
✅ Validates TypeScript (fail-fast on errors)
✅ Starts dev server with hot reload
```

**Zero manual steps. Just works.**

---

## Project Structure

```
/src                    # Core TypeScript (runs in browser!)
  server.ts             # S→E→A coordinator (100ms ticks)
  entity-consensus.ts   # BFT consensus (E-machine)
  account-consensus.ts  # Bilateral consensus (A-machine)
  evm.ts                # Blockchain integration
  types.ts              # All interfaces

/frontend               # Svelte UI
  src/routes/+page.svelte      # Main app
  src/lib/components/          # UI components
  src/lib/stores/xlnStore.ts   # State management

/contracts              # Solidity smart contracts
  Depository.sol        # Reserve/collateral/batch processing
  EntityProvider.sol    # Entity registration

/scenarios              # Declarative test scenarios
  diamond-dybvig.scenario      # Bank run simulation
  phantom-grid-*.scenario      # Stress tests (100-1000 entities)

/reference              # Original implementations (2019)
  2019src.txt           # Production-tested patterns
  2019vue.txt           # Original UI reference

/scripts                # Organized utilities
  /dev                  # Development helpers
  /debug                # Debug scripts
  /deployment           # Server deployment
```

---

## Common Commands

```bash
# Development
bun run dev              # Full dev (auto-installs everything)
bun run check            # Type check + build

# Testing  
bun test                 # Unit tests
bun run test:e2e         # E2E tests
bun run tutorial         # Interactive demo

# Blockchain
./reset-networks.sh      # Reset chain + redeploy
./deploy-contracts.sh    # Redeploy contracts

# Production
bun run build            # Build static bundle
```

---

## Architecture (J/E/A Machines)

**Three-layer state machine hierarchy:**

- **J-machine (Jurisdiction):** Public registry. Anchors state on-chain (Ethereum, etc.)
- **E-machine (Entity):** BFT consensus for organizations. Quorum-based governance.
- **A-machine (Account):** Bilateral channels. Frame-based off-chain settlement.

**Flow:** Server → Entity → Account (S→E→A)  
**Paradigm:** Pure functional `(prevState, input) → {nextState, outputs}`

---

## Key Features

✅ **Browser-native:** Core logic runs client-side (no server)  
✅ **Time machine:** Replay consensus frame-by-frame  
✅ **Multi-hop routing:** Lightning-style payment paths  
✅ **BFT consensus:** Byzantine fault tolerant governance  
✅ **EVM integration:** Deploy to any EVM chain  
✅ **VR support:** Oculus Quest compatible  

---

## Documentation

- 📖 **Architecture:** `/docs/JEA.md`
- 💸 **Payments:** `/docs/payment-spec.md`
- 🎓 **Philosophy:** `/docs/philosophy/`
- 🔐 **HTTPS:** `frontend/HTTPS.md`
- 🥽 **VR:** `OCULUS-SETUP.md`

---

## Troubleshooting

**Foundry install hangs?**
```bash
# Install manually
curl -L https://foundry.paradigm.xyz | bash
source ~/.bashrc
foundryup
bun run dev
```

**Port 8545 in use?**
```bash
./scripts/dev/stop-networks.sh
bun run dev
```

**TypeScript errors?**
```bash
bun run check  # Shows errors
# Fix, then: bun run dev
```

---

**License:** MIT  
**Status:** Active development (2025)
