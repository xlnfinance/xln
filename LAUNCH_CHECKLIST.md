# xln controlled launch checklist

**MISSION:** Verify everything works before public launch. "18-year-old hacker" security standard.

---

## 🔴 CRITICAL (Must pass 100%)

### **Security**
- [ ] **Nonce replay protection** - Try replaying signed transaction with same nonce (must fail)
- [ ] **Bilateral state convergence** - Apply same txs from left/right perspective (must match)
- [ ] **Transaction determinism** - Sort 100 random txs 1000 times (order must be identical)
- [ ] **Invalid signature rejection** - Submit tx with wrong signature (must reject)
- [ ] **Credit limit enforcement** - Try to exceed credit limit (must fail)

### **Landing Page (Public-Facing)**
- [ ] **Smoke tests pass** - `cd frontend && npm run test:landing` (all green)
- [ ] **Centering verified** - "Modular Contract System" heading centered
- [ ] **MML unlock works** - Enter "mml" → navigates to /view
- [ ] **No 404 errors** - All assets load (check network tab)
- [ ] **Responsive layout** - No horizontal overflow at 375px/768px/1920px
- [ ] **Slot machine visible** - All 3 contract cards render correctly

### **Core Consensus (The Whole Point)**
- [ ] **Entity creation** - Spawn 3 entities successfully
- [ ] **Multi-entity consensus** - 3 entities sign competing txs, verify convergence
- [ ] **Account frame history** - Apply txs, check frameHistory populates correctly
- [ ] **State root computation** - Verify keccak256(RLP(deltas)) matches between entities
- [ ] **Signature aggregation** - Collect sigs from N entities, verify threshold

---

## 🟡 HIGH PRIORITY (Should pass)

### **Smart Contracts**
- [ ] **Depository functions** - Run `scripts/verify-contract-functions.cjs` (all pass)
- [ ] **EntityProvider functions** - Verify registration, quorum checks work
- [ ] **Gas cost sanity** - Check typical tx costs <$5 USD equivalent
- [ ] **Contract addresses loaded** - `getAvailableJurisdictions()` returns valid addresses

### **Time Machine (Debugging Tool)**
- [ ] **Historical replay** - Record ServerFrames, replay from index 0, verify state matches
- [ ] **Time slider works** - Drag slider, verify UI updates to historical state
- [ ] **R→E→A flow visible** - Check logs show Replica/Entity/Account flow correctly

### **UI/UX Polish**
- [ ] **Graph3D renders** - Check force-directed layout displays entities/accounts
- [ ] **VR mode works** - Test in Vision Pro if available (emoji bank labels visible)
- [ ] **Panels functional** - Architect/Timeline/Graph3D panels all load without errors
- [ ] **No console errors** - Open F12, check for red errors (zero tolerance)

---

## 🟢 MEDIUM (Nice to have)

### **Performance**
- [ ] **100ms tick latency** - Verify server processes inputs every 100ms
- [ ] **1000 tx load test** - Submit 1000 txs, measure processing time
- [ ] **Memory leak check** - Run for 1 hour, check memory usage stable

### **Documentation**
- [ ] **README.md accurate** - Instructions match actual commands
- [ ] **next.md updated** - Move completed tasks to "Done" section
- [ ] **CHANGELOG.md exists** - Document what's in this release

### **DevOps**
- [ ] **Build succeeds** - `bun run check` in root (zero errors)
- [ ] **Deploy script works** - `./auto-deploy.sh` completes successfully
- [ ] **Rollback plan** - Document how to revert to previous version

---

## 🔵 OPTIONAL (Post-launch)

### **Advanced Features**
- [ ] **WAL implementation** - Crash recovery via Write-Ahead Log
- [ ] **/reviews page** - Complete audit/review system
- [ ] **SettingsPanel** - Wire into View.svelte
- [ ] **Multi-hop routing** - Enable payments through intermediaries

### **Marketing**
- [ ] **Demo video** - Record VR session showing bank emoji labels
- [ ] **Twitter announcement** - Craft launch tweet
- [ ] **Documentation site** - Deploy vibepaper docs to separate domain

---

## 📋 QUICK VERIFICATION COMMANDS

```bash
# Landing page tests
cd frontend && npm run test:landing

# Build check
cd /Users/egor/xln && bun run check

# Contract verification
bunx hardhat run scripts/verify-contract-functions.cjs --network ethereum

# Dev server (check for errors)
cd frontend && SKIP_TYPECHECK=1 bun run dev
# Open http://localhost:8080 in browser, check F12 console

# Deploy to production
cd /Users/egor/xln && ./auto-deploy.sh
```

---

## 🚨 LAUNCH BLOCKERS (Do NOT launch if any fail)

1. **Landing page broken** - Public face must be perfect
2. **Bilateral state divergence** - Core feature broken = no launch
3. **Nonce replay possible** - Security hole = no launch
4. **Console errors on load** - Unprofessional = no launch
5. **Smart contracts not verified** - Money at risk = no launch

---

## ✅ SIGN-OFF

- [ ] **Security verified** by: ___________  Date: _______
- [ ] **Functionality verified** by: ___________  Date: _______
- [ ] **UI/UX verified** by: ___________  Date: _______
- [ ] **Ready to launch** by: ___________  Date: _______

---

**Last updated:** 2025-11-07
**Next review:** Before every major release
