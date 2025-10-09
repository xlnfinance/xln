# 🔧 Daily Development Workflow

## Command Cheatsheet (Use These)

### **Starting Fresh (Monday Morning)**
```bash
bun run dev
# = dev-full.sh
# Does: Reset blockchain + redeploy + validate + start everything
# Time: ~30 seconds
# Use: First start of day, after pulling main, when contracts change
```

### **Quick Restart (Most Common)**
```bash
bun run dev:quick
# = scripts/dev/dev-quick.sh  
# Does: Skip blockchain reset, just restart dev server
# Time: ~5 seconds
# Use: After fixing TypeScript errors, quick iterations
```

### **Just Frontend (UI Work)**
```bash
cd frontend && bun run dev
# Does: Vite only, no blockchain, no validation
# Time: ~2 seconds
# Use: CSS/UI tweaks, when blockchain already running
```

### **Reset Blockchain Only**
```bash
bun run dev:reset
# = ./reset-networks.sh
# Does: Stop networks, clear DB, redeploy contracts
# Time: ~15 seconds
# Use: After contract changes, when state is corrupted
```

### **Type Check Only**
```bash
bun run check
# Does: TypeScript validation + Svelte check + build test
# Time: ~10 seconds
# Use: Before committing, after big refactors
```

---

## Typical Day

```bash
# 1. Morning - Start fresh
bun run dev
# → Everything resets, opens localhost:8080

# 2. Code changes (auto-rebuilds)
# Edit src/account-consensus.ts
# → server.js rebuilds
# → Browser hot-reloads

# 3. Made a mistake, need restart
Ctrl+C
bun run dev:quick
# → Back up in 5 seconds

# 4. Before committing
bun run check
# → Ensure 0 errors

# 5. Commit
git add .
git commit -m "feat: add cooperative close"
git push
```

---

## When To Use What

| Situation | Command | Why |
|---|---|---|
| **First start of day** | `bun run dev` | Clean state |
| **After git pull** | `bun run dev` | Might have contract changes |
| **Quick fix restart** | `bun run dev:quick` | Don't reset blockchain |
| **UI-only work** | `cd frontend && bun run dev` | Fastest |
| **Contract changed** | `bun run dev:reset` | Redeploy only |
| **Before commit** | `bun run check` | Verify clean |
| **Blockchain stuck** | `./scripts/dev/stop-networks.sh` | Kill processes |

---

## Pro Tips

**Blockchain already running?**
```bash
# Don't reset - just start frontend
cd frontend && bun run dev
```

**TypeScript errors blocking?**
```bash
# Skip validation, start anyway (risky but fast)
cd frontend && bun run dev
# Fix errors while server runs
```

**Want to see what's happening?**
```bash
# Check blockchain logs
tail -f logs/ethereum-8545.log

# Check what's running
ps aux | grep -E "hardhat|vite"
```

**Clean slate (nuclear option):**
```bash
./scripts/dev/stop-networks.sh
rm -rf db node_modules frontend/node_modules contracts/node_modules
bun install
cd frontend && bun install && cd ..
cd contracts && bun install && cd ..
bun run dev
```

---

## My Recommendation

**Daily driver:**
```bash
# Alias this in your shell:
alias xln='bun run dev:quick'

# Then just:
xln  # → Up in 5 seconds
```

**Use `bun run dev` (full) only when:**
- Monday morning
- After git pull with contract changes
- Something feels broken

**Use `cd frontend && bun run dev` when:**
- Just CSS/UI tweaks
- Blockchain already running in another terminal
