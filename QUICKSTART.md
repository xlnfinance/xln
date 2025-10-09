# 🚀 XLN Quickstart for New Developers

## Prerequisites

```bash
# Install bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# macOS/Linux - Install Foundry (for local blockchain)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Verify installation
bun --version
forge --version
```

## First-Time Setup (5 minutes)

```bash
# 1. Clone repo
git clone https://github.com/xlnfinance/xln.git
cd xln

# 2. Install dependencies
bun install
cd frontend && bun install && cd ..

# 3. Start development (auto-deploys contracts, starts dev server)
bun run dev
```

**That's it!** 🎉

- Frontend: http://localhost:8080 (or https if you have certs)
- Auto-watch: Changes rebuild automatically
- Time machine: Navigate history with slider

## What `bun run dev` Does

1. ✅ Starts local blockchain (anvil)
2. ✅ Deploys smart contracts (EntityProvider, Depository)
3. ✅ Validates TypeScript (blocks on errors)
4. ✅ Builds server.js in browser-compatible mode
5. ✅ Starts Vite dev server with HMR
6. ✅ Auto-rebuilds on file changes

**Fully automated - zero manual steps!**

## Optional: HTTPS for Local Development

```bash
# Install mkcert
brew install mkcert
mkcert -install

# Generate certs
cd frontend
./generate-certs.sh

# Restart dev server
bun run dev  # Now runs at https://localhost:8080
```

See `frontend/HTTPS.md` for details.

## Common Commands

```bash
# Development
bun run dev              # Full dev environment (recommended)
bun run dev:quick        # Skip some checks (faster restarts)

# Building
bun run build            # Build production bundle
bun run check            # Type check + build verification

# Testing
bun test                 # Run unit tests
bun run test:e2e         # Playwright E2E tests
bun run tutorial         # Interactive tutorial test

# Contracts
./deploy-contracts.sh    # Redeploy contracts (manual)
./reset-networks.sh      # Reset blockchain + redeploy
```

## Project Structure

```
/src                     # Core TypeScript (runs in browser)
  server.ts              # Main coordinator (S→E→A routing)
  entity-consensus.ts    # BFT consensus (E-machine)
  account-consensus.ts   # Bilateral consensus (A-machine)
  evm.ts                 # Blockchain integration
  types.ts               # All interfaces

/frontend                # Svelte UI
  src/routes/+page.svelte      # Main app
  src/lib/components/          # UI components
  src/lib/stores/xlnStore.ts   # State management

/contracts               # Solidity smart contracts
  contracts/Depository.sol     # Reserve/collateral management
  contracts/EntityProvider.sol # Entity registration

/scenarios               # Test scenarios (declarative DSL)
  diamond-dybvig.scenario      # Bank run simulation
  phantom-grid-*.scenario      # Stress tests
```

## Troubleshooting

### "Port 8545 already in use"
```bash
# Kill existing blockchain
./stop-networks.sh
bun run dev
```

### "Contract not found" errors
```bash
# Redeploy contracts
./reset-networks.sh
```

### TypeScript errors block development
```bash
# Fix errors first
bun x tsc --noEmit

# Or check specific issues
bun run check
```

### Frontend not updating
```bash
# Hard refresh: Cmd+Shift+R (macOS) / Ctrl+Shift+R (Windows)
# Or clear browser cache
```

## Development Workflow

**Typical flow:**

```bash
# Morning: Start dev environment
bun run dev

# Code changes auto-rebuild
# Edit src/account-consensus.ts → server.js rebuilds → browser reloads

# Run tests before committing
bun run check  # Ensures 0 errors

# Commit changes
git add .
git commit -m "feat: add cooperative close"
```

## Need Help?

- 📖 Full docs: `/docs` directory
- 🏗️ Architecture: `docs/JEA.md`
- 💸 Payments: `docs/payment-spec.md`
- 🎓 Philosophy: `docs/philosophy/`

**First commit should just be:** `bun install && bun run dev` ✅
