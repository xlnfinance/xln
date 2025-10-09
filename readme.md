# XLN - Cross-Local Network

![XLN Network Visualization](frontend/static/img/preview.png)

**Unified Layer-2 for EVM jurisdictions.** Reserve-credit network combining full-credit banking with payment channel architectures.

## 🚀 Quick Start (One Command!)

```bash
bun run dev
```

**That's literally it!** The command automatically:
- ✅ Checks prerequisites (bun, anvil)
- ✅ Installs all dependencies (root, frontend, contracts)
- ✅ Deploys smart contracts to local blockchain
- ✅ Validates TypeScript (fail-fast on errors)
- ✅ Starts dev server → http://localhost:8080

**First time:** ~2 minutes (downloads deps)  
**Subsequent runs:** ~10 seconds

---

## Prerequisites (Auto-Checked)

**Required:**
- [bun](https://bun.sh) - JavaScript runtime
- [Foundry/anvil](https://getfoundry.sh) - Local blockchain

**Install (if missing):**
```bash
# bun
curl -fsSL https://bun.sh/install | bash

# Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

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

/scripts                # Organized utility scripts
  /debug                # Debug helpers
  /dev                  # Development scripts
  /deployment           # Server deployment
```

---

## Common Commands

```bash
# Development
bun run dev              # Full dev (with blockchain)
bun run check            # Type check + build verification

# Testing
bun test                 # Unit tests
bun run test:e2e         # E2E tests (Playwright)
bun run tutorial         # Interactive tutorial

# Blockchain
./reset-networks.sh      # Reset local chain + redeploy
./deploy-contracts.sh    # Redeploy contracts only

# Production
bun run build            # Build static bundle → frontend/build/
```

---

## Architecture (J/E/A Machines)

**Three-layer state machine hierarchy:**

- **J-machine (Jurisdiction):** Public registry of entities, reserves, dispute outcomes. Anchors final state on-chain (Ethereum, etc.)
- **E-machine (Entity):** BFT consensus for organizations. Quorum signs proposals to commit actions.
- **A-machine (Account):** Bilateral channels between entities. Frame-based consensus for off-chain settlement.

**Flow:** Server → Entity → Account (S→E→A)  
**Paradigm:** Pure functional state machines `(prevState, input) → {nextState, outputs}`

---

## Key Features

✅ **Browser-native:** Core logic runs in browser (no server needed)  
✅ **Time machine:** Navigate consensus history frame-by-frame  
✅ **Multi-hop routing:** Lightning-style payment routing  
✅ **BFT consensus:** Byzantine fault tolerant entity governance  
✅ **EVM integration:** Deploy to any EVM chain  
✅ **VR support:** Oculus Quest compatible (see OCULUS-SETUP.md)  

---

## Documentation

- 📖 **Architecture:** `/docs/JEA.md` - Jurisdiction/Entity/Account model
- 💸 **Payments:** `/docs/payment-spec.md` - Payment flow specification
- 🎓 **Philosophy:** `/docs/philosophy/` - Design principles
- 🔐 **HTTPS Setup:** `frontend/HTTPS.md` - Local HTTPS development
- 🥽 **VR Setup:** `OCULUS-SETUP.md` - Oculus Quest setup

---

## Troubleshooting

### "anvil: command not found"
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### "Port 8545 already in use"
```bash
./scripts/dev/stop-networks.sh
bun run dev
```

### TypeScript errors block startup
```bash
# Fix errors first
bun run check

# Then restart
bun run dev
```

---

## Contributing

**Development flow:**
1. `bun run dev` - Start environment
2. Make changes (auto-rebuilds)
3. `bun run check` - Verify before commit
4. Commit with descriptive message

**Code style:** Functional, immutable, type-safe TypeScript. See `CLAUDE.md` for full guidelines.

---

**License:** MIT  
**Status:** Active development (Q4 2025)
