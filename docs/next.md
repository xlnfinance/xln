# Next Steps & Strategic Context

**Last Updated:** 2025-10-09

---

## 🎯 Strategic Vision

### **XLN Scope: B2B + B2E + E2E**

**NOT just wholesale settlement.** XLN is the complete payment stack:

- **B2B:** Corporate treasury, cross-border, wholesale settlement
- **B2E:** Payroll, expenses (employees get credit limits from employer)
- **E2E:** Personal payments, rent, friend IOUs, subscriptions

**One person, one account with:**
- Employer (salary + expense credit)
- Landlord (rent + security deposit as collateral)
- Friends (trust-based credit limits)
- Businesses (subscriptions with credit terms)

**All using same protocol. All sovereign. All with credit+collateral hybrid.**

### **Target: 51% of Electronic Payment Volume**

**Not 51% of wholesale. 51% of EVERYTHING:**
- Visa/MC ($10T+/year)
- PayPal/Venmo/Zelle ($1.5T+/year)
- Remittances ($800B/year)
- Personal credit relationships (unmeasured)

**Timeline: ~2042-2045** (20 years from 2017 idea publication)

**Path:**
- 2025-2027: Developer adoption (Lightning integrations)
- 2027-2030: Consumer fintech apps
- 2030-2035: Network effects
- 2035-2045: Becomes payment infrastructure

**Like TCP/IP:** Users won't know XLN exists. Apps just use it.

---

## 🔴 Critical TODOs (Block Production)

### **1. cooperativeClose - Account Lifecycle**

**Status:** Missing (2019 had it, current doesn't)
**Impact:** Can't deploy without graceful account closure

**Implementation:**
1. Add AccountTx types: `request_close`, `approve_close`
2. Create `src/account-tx/handlers/close-account.ts`
3. Bilateral flow:
   - Requester → Counterparty: request_close
   - Counterparty signs approval
   - Both call cooperativeUpdate with forgiveDebtsInTokenIds
   - Mark account.status = 'CLOSED'
4. UI: Close button in AccountPanel.svelte

**Contract support:** Already exists (cooperativeUpdate with forgiveDebts)
**Reference:** `reference/2019src.txt` lines 263-285
**Estimate:** 4-6 hours

---

### **2. Transaction Failure Tracking**

**Status:** Failed txs disappear silently
**Impact:** Poor UX, hard to debug

**Implementation:**
```typescript
// Add to EntityState
failedTxs: Array<{
  tx: EntityTx;
  error: string;
  timestamp: number;
  retryCount: number;
}>;

// In entity-tx/apply.ts
catch (error) {
  addFailedTx(state, tx, error.message);
}

// Helper with 10-tx cap (like messages)
export function addFailedTx(state: EntityState, tx: EntityTx, error: string) {
  state.failedTxs.push({ tx, error, timestamp: Date.now(), retryCount: 0 });
  if (state.failedTxs.length > 10) state.failedTxs.shift();
}
```

**UI:** ErrorDisplay component already exists, just wire it
**Reference:** `reference/2019src.txt` line 337 (receivedAndFailed)
**Estimate:** 2 hours

---

## 🟡 Important TODOs (Post-Launch)

### **3. Client-Side Dispute System**

**Status:** Contract has full dispute logic, client doesn't use it
**Impact:** Can't challenge fraud without this

**Implementation:**
1. EntityTx type: `start_dispute`
2. Handler: `src/entity-tx/handlers/dispute.ts`
3. Construct dispute proof from AccountMachine state
4. Call Depository dispute functions
5. UI: Dispute panel in AccountPanel
6. Track dispute timeline (challenge window, evidence submission)

**Contract:** Depository.sol lines 685-755 (cooperativeDisputeProof, etc.)
**Reference:** `reference/2019src.txt` line 165 (startDispute)
**Estimate:** 6-8 hours
**Priority:** Needed before mainnet, can wait for testnet

---

### **4. Withdrawal Pre-Approvals** (UX Improvement)

**Status:** Only request_withdrawal flow exists
**Need:** Pre-sign withdrawal permissions (like 2019)

**Implementation:**
```typescript
// AccountTx type
type: 'pre_approve_withdrawal'
data: {
  tokenId: number;
  maxAmount: bigint;
  expiresAt: number;
}

// Store in AccountMachine
preApprovals: Map<number, {
  maxAmount: bigint;
  expiresAt: number;
  signature: string;
}>

// Auto-execute when conditions met
```

**Reference:** `reference/2019src.txt` line 753 (getWithdrawalSig)
**Estimate:** 4 hours
**Priority:** Low (nice-to-have UX)

---

## 🔵 Optional TODOs (Future)

### **5. Encrypted Messaging** (Privacy)

**Status:** All messages plaintext
**Need:** E2E encryption for sensitive data

**Implementation:**
- Install: `bun add tweetnacl tweetnacl-util`
- Add to AccountMachine: `{ encryptionPubkey, sharedSecret }`
- Encrypt chat.data before sending
- Key exchange during account opening

**Reference:** `reference/2019src.txt` line 1999 (encryptJSONBox)
**Estimate:** 4 hours
**Priority:** Low (privacy feature, not critical for MVP)

---

### **6. Orderbook System** (DEX Features)

**Status:** Not implemented (2019 had it)
**Need:** Only if XLN becomes DEX platform

**Implementation:**
- EntityTx types: `create_order`, `cancel_order`
- OrderbookState in EntityState
- Matching engine
- Orderbook UI component

**Reference:** `reference/2019src.txt` lines 159, 739 (createOrder, Orderbook array)
**Estimate:** 8+ hours
**Priority:** Very Low (out of current scope?)

---

## 🛠️ Development Tooling

### **Foundry Migration** (Optional High-ROI)

**When:** After cooperativeClose (not urgent)
**Why:** Better debugging, 100x faster tests
**Effort:** 2-3 hours

**Steps:**
1. Install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. Init: `cd contracts && forge init --force`
3. Update start-networks.sh: `anvil --port 8545`
4. Convert tests: Hardhat JS → Foundry Solidity tests
5. Deploy: `forge script` instead of Hardhat Ignition

**Quick win without full migration:**
```bash
cd contracts && bun add -d hardhat-tracer
# Shows internal calls/storage changes
```

---

## 📋 Feature Parity Status

**Current vs 2019 Reference:** ~85% complete

**What's Better in Current:**
- EVM integration (multi-chain)
- Gossip layer (P2P networking)
- Scenario system (automated testing)
- Type safety (runtime validation)
- Time machine (historical debugging)
- Multi-hop routing (pathfinding)

**What's Missing:**
- cooperativeClose (critical)
- Dispute UI (important)
- Encrypted messages (nice-to-have)
- Orderbook (questionable fit)

---

## 🚀 Deployment Decision

### **Current Status:**

**Code quality:** ✅ Production-ready (type-safe, tested, clean)
**Feature completeness:** ⚠️ 85% (missing cooperativeClose)
**Documentation:** ⚠️ Technical only (no user-facing explainer)

### **Options:**

**A) Deploy Now (Technical Preview)**
- Label as "Developer Preview"
- Document missing features
- Get early feedback
- Risk: Incomplete perception

**B) Complete cooperativeClose First (Recommended)**
- 4-6 hours to implement
- Then deploy as "Beta"
- Feature parity with 2019 for core flows
- More confident deployment

**C) Full Feature Parity (2-3 weeks)**
- cooperativeClose + disputes + failure tracking
- Remove "preview" label entirely
- Production-ready for institutions

**Recommendation:** **Option B** - cooperativeClose then deploy.

---

## 🧠 Context from Development Journey

**Background:**
- Idea published 2017 (Medium)
- 8 years of iteration
- 5 teams hired ($100k+), no results
- Building solo despite hating npm/TypeScript
- Only person doing credit-collateral channels globally
- No competition (still, 8 years later)

**Why it matters:**
- Not building for market pressure (there is none)
- Not building for funding round
- Building because correct solution needs to exist
- Standards matter (8 years = high standards)

**Implication:** Ship when it feels right, not when timeline says so.

---

## 🎯 Success Criteria (When to Deploy)

**Minimum viable (Technical Preview):**
- ✅ Account opening works
- ✅ Payments work (direct + multi-hop)
- ✅ Reserve ↔ Collateral works
- ❌ Account closing works (MISSING)
- ⚠️ Disputes work (contract yes, client no)

**Production ready (Beta):**
- ✅ All above
- ✅ cooperativeClose implemented
- ✅ Transaction failures tracked
- ⚠️ Dispute UI (can launch without, add later)

**Mainnet ready:**
- ✅ All above
- ✅ Dispute system complete
- ✅ Security audit
- ✅ Multi-jurisdiction tested

**Current target:** Beta deployment after cooperativeClose.

---

**Next session: Implement cooperativeClose, then deploy decision.**
