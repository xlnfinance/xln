# top 10 most urgent tasks - 2025-11-07

**Context:** xln.finance is live. Landing page public. /view stealth (MML code). Need to secure, test, SEO, and scale.

---

## 🔴 CRITICAL (Do First - 4 hours total)

### 1. **Verify Server Deployment Security** [30 min]
**Problem:** Server pulls from github.com/xlnfinance/xln but reports/scripts/research might leak
**Fix:**
```bash
# Verify gitignore working
git status --ignored | grep reports/

# Test what would be pushed
git ls-files | grep -E "(reports|scripts|research)"
# Should return NOTHING

# Push test
git add . && git commit -m "test: verify private files ignored"
git push origin main

# Check server doesn't have private files
ssh root@xln.finance "ls -la /root/xln/ | grep -E '(reports|scripts|research)'"
```
**Why Critical:** Private strategy documents could leak to competitors

---

### 2. **Fix SEO (Meta Tags + Sitemap)** [2 hours]
**Problem:** Google can't index xln.finance (no meta tags, no OG, SSR disabled)
**Fix:**
1. Add meta tags to `frontend/src/app.html`
2. Enable prerender for landing (`+page.ts: export const prerender = true`)
3. Generate sitemap.xml
4. Add robots.txt

**Impact:** Visible in Google within 1 week → investors/CBDCs find you

**Full plan:** See `reports/2025-11-07-seo-audit.md`

---

### 3. **Run Fed Chair Demo Tests** [30 min]
**Problem:** We wrote tests but haven't verified demo works
**Fix:**
```bash
cd frontend
npm run test:fed

# Fix any failures immediately
# Document results in reports/2025-11-08-test-results.md
```
**Why Critical:** Fed Chair demo is the "holy shit" moment - must work flawlessly

---

### 4. **Verify Current Deployment Works** [1 hour]
**Problem:** Uncertain if server auto-deploy is working correctly
**Fix:**
```bash
# Make trivial change
echo "<!-- test -->" >> frontend/src/routes/+page.svelte

# Commit and push
git add . && git commit -m "test: verify auto-deploy"
git push origin main

# Wait 3 minutes, check live site
curl https://xln.finance/ | grep "<!-- test -->"

# If not working, debug auto-deploy.sh
```
**Why Critical:** If deployment broken, all other work is invisible

---

## 🟡 HIGH PRIORITY (This Week - 8 hours total)

### 5. **Setup Continuous Testing** [2 hours]
**Problem:** Tests exist but don't run automatically
**Fix:**
1. Create `.github/workflows/test.yml` (GitHub Actions)
2. Run `npm run test:landing` on every push
3. Block merge if tests fail
4. Send alerts to Telegram/Discord

**Why Important:** Catch bugs before they reach production

---

### 6. **Bilateral Consensus Verification Test** [2 hours]
**Problem:** Core XLN feature (state convergence) not tested
**Fix:**
```typescript
// Create tests/runtime/bilateral-consensus.spec.ts
test('Left and right compute identical state', async () => {
  const accountAB = createAccount(entityA.id, entityB.id);
  const accountBA = createAccount(entityB.id, entityA.id);

  // Apply same txs from both perspectives
  applyTransactions(accountAB, txs, 'left');
  applyTransactions(accountBA, txs, 'right');

  // States MUST match
  expect(encode(accountAB.deltas)).toEqual(encode(accountBA.deltas));
});
```
**Why Important:** If this fails, entire protocol is broken

---

### 7. **Fix TypeScript Errors (45 found)** [2 hours]
**Problem:** `bun run check` reports 45 errors (mostly Svelte 5 runes typing)
**Fix:**
```bash
# Get errors
bun run check 2>&1 | grep "error TS" > /tmp/ts-errors.txt

# Fix top 10 most critical
# Document in reports/2025-11-08-typescript-cleanup.md
```
**Why Important:** Type safety prevents runtime bugs

---

### 8. **Documentation Cleanup** [1 hour]
**Problem:** docs/ and docs/ overlap, some files outdated
**Fix:**
1. Move all architecture docs to docs/
2. Delete docs/ or repurpose for API docs
3. Update README.md with current state
4. Add FREQUENTLY_ASKED.md (reduce Claude re-explaining)

**Why Important:** External contributors need clear docs

---

## 🟢 MEDIUM PRIORITY (This Month)

### 9. **Nonce Replay Protection Test** [1 hour]
**Problem:** 18-year-old hacker standard = test attack vectors
**Fix:**
```typescript
test('Cannot replay transaction with same nonce', async () => {
  const signedTx = await entity.signTransaction({...tx, nonce: 1});

  await runtime.submitTransaction(signedTx);  // ✅ First time succeeds
  await expect(runtime.submitTransaction(signedTx)).rejects.toThrow('nonce already used');
});
```
**Why Important:** Prevents double-spend attacks

---

### 10. **Setup Monitoring + Alerts** [2 hours]
**Problem:** If xln.finance goes down, you don't know until someone tells you
**Fix:**
1. UptimeRobot (free): Ping xln.finance every 5 min
2. Sentry (error tracking): Catch JS errors in production
3. Telegram bot: Alert on downtime
4. Weekly report: Traffic, errors, performance

**Why Important:** Professional ops = investor confidence

---

## 📊 SUMMARY

| Priority | Task | Time | Impact |
|----------|------|------|--------|
| 🔴 #1 | Verify deployment security | 30min | Prevent leaks |
| 🔴 #2 | Fix SEO | 2hr | Google visibility |
| 🔴 #3 | Run Fed Chair tests | 30min | Demo quality |
| 🔴 #4 | Verify auto-deploy | 1hr | Ship confidence |
| 🟡 #5 | Continuous testing | 2hr | Catch bugs early |
| 🟡 #6 | Bilateral consensus test | 2hr | Core protocol |
| 🟡 #7 | Fix TS errors | 2hr | Type safety |
| 🟡 #8 | Doc cleanup | 1hr | External contributors |
| 🟢 #9 | Nonce replay test | 1hr | Security |
| 🟢 #10 | Monitoring/alerts | 2hr | Ops maturity |

**Total:** 14 hours work = Production-ready launch

---

## EXECUTION ORDER

### Today (4 hours)
1. Verify deployment security (30min)
2. Fix SEO (2hr)
3. Run Fed Chair tests (30min)
4. Verify auto-deploy (1hr)

### Tomorrow (4 hours)
5. Setup continuous testing (2hr)
6. Bilateral consensus test (2hr)

### This Weekend (6 hours)
7. Fix TS errors (2hr)
8. Doc cleanup (1hr)
9. Nonce replay test (1hr)
10. Monitoring/alerts (2hr)

---

## DEPENDENCIES

- #1 blocks #4 (need security before deployment)
- #2 blocks investor outreach (no SEO = no discovery)
- #3 blocks Fed Chair presentations (must verify works)
- #6 blocks mainnet (consensus must be verified)
- #10 enables sleep (know when things break)

---

## NOT ON LIST (Deliberately)

**Why not included:**
- **Public repo setup** - Current private→public via gitignore is fine for now
- **Multi-model orchestration** - Overkill until 10+ tasks/day
- **Presentation-driven development** - Nice-to-have, not urgent
- **WAL implementation** - Important but not blocking launch
- **Contract audits** - Need internal tests first

---

## DECISION FRAMEWORK

**When deciding what to work on:**
1. **Security** > Performance > Features
2. **Public-facing** (landing) > Private (stealth /view)
3. **Core protocol** (consensus) > UI polish
4. **Automated** (tests, CI) > Manual (code review)
5. **Reversible** experiments in research/ first

---

**Prepared by:** Claude
**For:** Egor Homakov
**Date:** 2025-11-07
**Next review:** 2025-11-08 (daily during launch phase)
