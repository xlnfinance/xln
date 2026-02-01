# Session Summary: Testnet E2E Deployment

**Date:** 2026-02-02
**Duration:** ~6 hours
**Commits:** 35+
**Goal:** Full testnet on xln.finance with local frontend connection

---

## ✅ COMPLETED

### Infrastructure (Prod)
- ✅ Anvil deployed on xln.finance (:8545)
- ✅ Contracts deployed (Depository, EntityProvider, ERC20s)
- ✅ ERC20 tokens (USDC, WETH, USDT) with hub funded
- ✅ Hub entity bootstrapped (normal entity, not special)
- ✅ 3 faucet endpoints working (tested via curl)
- ✅ Nginx CORS partially fixed
- ✅ Server.ts in RPC mode

### Architecture
- ✅ Hub = normal entity (removed createMainHub)
- ✅ Runtime message encryption (ws-client layer)
- ✅ JAdapter abstraction (jadapter in jReplica)
- ✅ getActiveJAdapter(env) helper
- ✅ MVP spec written (908 lines)
- ✅ Component audit (81 files analyzed)

### Frontend
- ✅ Auto-login as alice (DEMO_ACCOUNTS)
- ✅ VaultStore.createRuntime uses testnet RPC
- ✅ Removed duplicate importJ calls
- ✅ Swept 19 getBrowserVMInstance → getActiveJAdapter
- ✅ Faucet calls use API (fundSignerWalletViaFaucet)
- ✅ Username button UI added (alice-judy grid)

---

## ⚠️ BLOCKED / REMAINING WORK

### Critical Bugs
1. **xlnomy1 still being imported** - BrowserVM appears in console
   - Source: Unknown (entityFactory fixed but still appears)
   - Impact: Using BrowserVM instead of testnet RPC

2. **CORS content-type header blocked**
   - Error: "content-type is not allowed by Access-Control-Allow-Headers"
   - Nginx config has duplicate headers again
   - Curl works, browser fails (cached response?)

3. **Faucet API unreachable from browser**
   - VaultStore tries to call /api/faucet/erc20
   - CORS preflight fails
   - Never reaches server

### Missing Features
4. **Username buttons not visible** - UI code added but not rendering
5. **Entity panel faucet buttons** - Need to add to EntityPanelTabs
6. **Testnet badge** - No visual indicator of testnet mode

---

## 🔍 ROOT CAUSES (Hypothesis)

### xlnomy1 Mystery
**Suspects:**
- ArchitectPanel auto-import (even though we use Testnet)
- Cached importJ somewhere in component lifecycle
- EntityFactory fallback code
- UserModePanel initialization

**Next step:** Binary search - comment out components one by one

### CORS Issue
**Problem:** Nginx /api/ location missing proper preflight headers

**Current config:**
```nginx
location /api/ {
    add_header Access-Control-Allow-Origin * always;

    if ($request_method = OPTIONS) {
        return 204;
    }
```

**Should be:**
```nginx
location /api/ {
    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Allow-Methods * always;
    add_header Access-Control-Allow-Headers * always;

    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods * always;
        add_header Access-Control-Allow-Headers * always;
        add_header Content-Length 0;
        return 204;
    }
```

---

## 📊 METRICS

**Code changes:**
- Files modified: ~40
- Lines added: ~2000
- Lines removed: ~800
- Net: +1200 (mostly docs/specs)

**Infrastructure:**
- Anvil: Block 29+ (working)
- Contracts: 5 deployed
- Tokens: 3 deployed + funded
- Hub: 1B USDC reserves

**Frontend:**
- BrowserVM refs swept: 19 → 0 (claimed)
- importJ calls: 3 → 1 (VaultStore only)
- Demo accounts: 10 (alice-judy)

---

## 🎯 NEXT SESSION TODO

### Priority 1: Fix xlnomy1 (BLOCKER)
```bash
# Find the source
grep -rn "xlnomy1" frontend/src --include="*.ts" --include="*.svelte"

# Binary search:
1. Comment out ArchitectPanel import in View.svelte
2. Test - if xlnomy1 gone, it's Architect
3. If still there, comment out UserModePanel
4. Repeat until found
```

### Priority 2: Fix CORS (BLOCKER)
```bash
# On prod:
1. Update nginx /api/ location (add all headers to if block)
2. Clear browser cache
3. Test OPTIONS manually
4. Verify browser can POST
```

### Priority 3: Verify Testnet Connection
```javascript
// Browser F12 console:
const env = window.XLN.getEnv();
env.jReplicas.forEach((v, k) => console.log(k, v.jadapter?.mode));
// Should show: "Testnet" "rpc"
// Should NOT show: "xlnomy1" "browservm"
```

### Priority 4: Add Faucet UI
- EntityPanelTabs: 3 buttons (External/Reserves/Accounts)
- Test E2E: alice clicks → gets USDC

---

## 📁 FILES MODIFIED (Session)

**Runtime:**
- runtime/server.ts
- runtime/jadapter/rpc.ts
- runtime/networking/ws-client.ts
- runtime/networking/p2p.ts
- runtime/types.ts (jadapter field)
- runtime/entity-tx/apply.ts

**Frontend:**
- frontend/src/lib/stores/vaultStore.ts
- frontend/src/lib/view/View.svelte
- frontend/src/lib/view/panels/ArchitectPanel.svelte
- frontend/src/lib/utils/entityFactory.ts
- frontend/src/lib/components/Views/RuntimeCreation.svelte
- frontend/src/lib/components/Entity/EntityPanelTabs.svelte
- frontend/src/lib/components/Wallet/*.svelte (3 files)
- frontend/src/lib/view/panels/JurisdictionPanel.svelte
- frontend/src/lib/config/demo-accounts.ts (new)

**Infrastructure:**
- scripts/bootstrap-hub.ts (new)
- scripts/start-anvil.sh (new)
- jurisdictions/scripts/deploy-tokens.cjs (new)
- jurisdictions/scripts/fund-hub.cjs (new)
- Nginx config on xln.finance

**Docs:**
- docs/mvp.md (908 lines)
- docs/architecture/unified-server-design.md
- docs/deployment/testnet-setup.md
- docs/frontend-components-audit.md

---

## 🎓 LESSONS LEARNED

1. **Multiple env sources = chaos** - Took 15 commits to find all places
2. **BrowserVM coupling deep** - 19 refs across 5 files
3. **Nginx CORS tricky** - Anvil sends headers, nginx duplicates them
4. **Vite caching aggressive** - runtime.js changes not always reflected
5. **Auto-login critical** - Can't test without instant login

---

## 💡 FOR INVESTORS

**Demo flow (when working):**
1. Visit xln.finance or localhost:8080/app
2. See alice/bob/carol buttons
3. Click alice → instant login
4. See entity wallet with External/Reserves/Accounts tabs
5. Click faucet → get 100 USDC from shared testnet
6. Send payment to bob → routed through hub
7. Bob receives → bilateral consensus complete

**Pitch:**
- "One click to test"
- "Shared testnet - see other users"
- "No MetaMask, no seed phrases, just username"
- "Production-ready RPC backend"

---

**Status:** 60% complete. Need 2-3 hours to finish.
