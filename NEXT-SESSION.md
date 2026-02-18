# Next Session: Complete Testnet E2E

## 🎯 Goal
Get alice → testnet → faucet → balance working E2E.

## ✅ What's Done (38 commits)
- Anvil on xln.finance with contracts
- Hub = normal entity  
- Runtime encryption
- JAdapter abstraction
- Faucet API endpoints
- Auto-login as alice
- VaultStore uses testnet RPC

## ⚠️ Remaining Blockers

### 1. xlnomy1 Still Appears
**Logs show:**
```
[Runtime] Importing J-machine "xlnomy1" (chain 31337)...
[BrowserVM] Deploying...
[Runtime] ✅ JReplica "xlnomy1" ready
```

**After all these fixes:**
- entityFactory.ts → uses Testnet
- ArchitectPanel → disabled auto-import
- View.svelte → uses VaultStore env
- VaultStore → imports Testnet only

**Where is it?** Unknown. Binary search needed.

### 2. CORS Blocking Faucet
**Error:** "content-type is not allowed by Access-Control-Allow-Headers"  

**Nginx shows:** Duplicate headers still

**Fix:** Check if relay server (port 8080) adds CORS headers

### 3. jMachines Query Returns Empty
**Logs say:** "JReplica Testnet ready"  
**Query says:** `env.jReplicas = []`

**Cause:** Multiple env instances or timing issue

## 📋 TODO (Priority Order)

1. **Find xlnomy1 source** (30min)
   ```bash
   # Binary search:
   git diff HEAD~10 -- frontend/src/lib/view/View.svelte
   # Revert agent's changes if buggy
   # OR comment out ArchitectPanel completely
   ```

2. **Fix CORS** (15min)
   ```bash
   ssh xln.finance
   # Check server.ts handleApi CORS headers
   # Update nginx to NOT add if server already adds
   ```

3. **Test E2E** (30min)
   - alice login
   - Testnet visible
   - Faucet button works
   - Balance updates

4. **Add faucet buttons** (45min)
   - EntityPanelTabs: 3 buttons
   - External/Reserves/Accounts

**Total: 2 hours to complete.**

## 🎓 Lessons

- Multiple env sources = chaos (took 20 commits to fix)
- BrowserVM deeply coupled (19 refs found)
- Vite caching aggressive (runtime.js changes not reflected)
- Need binary search for phantom bugs (xlnomy1)

## 💾 State Saved

All changes committed. Can resume tomorrow:
```bash
cd /Users/zigota/xln
git log --oneline -10  # See recent work
cat docs/SESSION-SUMMARY-2026-02-02.md
cat NEXT-SESSION.md  # This file
```
