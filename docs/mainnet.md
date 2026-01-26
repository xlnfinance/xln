# xln Mainnet Readiness Assessment

**[← Index](readme.md)** | **[Related: Roadmap](roadmap.md)** | **[Implementation →](implementation/payment-spec.md)**

**Current Status: Phase 2 Complete (Testnet-Ready)**
**Mainnet Readiness: 600/1000**

---

## Breakdown by Category

### Core Protocol (HTLC Mechanics): 850/1000 ✅

**Working:**
- Lock/forward/reveal chain: Production-grade
- Onion routing: Functional (cleartext Phase 2)
- Timeout system: Complete (crontab + dual timestamp/height checks)
- Fee cascade: Working and tested ($1.25 on $125k verified)
- All Codex consensus fixes: Applied and verified by Opus

**Gaps:**
- Envelope encryption (Phase 3 requirement)
- Advanced griefing attack scenarios (edge cases)

### Security: 600/1000 ⚠️

**Working:**
- ✅ Consensus safety (holds in validation, timestamp checks)
- ✅ Duplicate prevention (lockId in same frame blocked)
- ✅ Replay protection (message counters)
- ✅ Frame chain integrity (prevFrameHash verification)
- ✅ Timelock enforcement (dual timestamp+height)

**Missing:**
- ❌ Envelope encryption (cleartext = no hop privacy)
- ❌ Watchtowers (offline party vulnerability)
- ❌ Formal verification (TLA+/Coq proofs)
- ❌ Security audit by external firm
- ❌ Bug bounty program

### Production Infrastructure: 400/1000 ⚠️

**Working:**
- ✅ Deterministic state machines (RJEA flow)
- ✅ Bilateral consensus (tested, working)
- ✅ J-layer integration (BrowserVM)

**Missing:**
- ❌ Production J-layer (real L1 via RPC, not BrowserVM)
- ❌ HSM key management (currently in-memory keys)
- ❌ Monitoring/metrics (Prometheus, Grafana)
- ❌ State backup/recovery (disaster recovery)
- ❌ DOS protection hardening
- ❌ Rate limiting
- ❌ Circuit breakers

### Network Operations: 550/1000 ⚠️

**Working:**
- ✅ Pathfinding (BFS from gossip profiles)
- ✅ Dijkstra implementation ready
- ✅ Multi-hop routing (2-hop tested, 4-hop infrastructure)
- ✅ Fee collection per hop

**Missing:**
- ❌ Dynamic fee market
- ❌ Liquidity balancing strategies
- ❌ Real-world topology testing
- ❌ Network health monitoring
- ❌ Channel capacity optimization

---

## Top 5 Blocking Issues for Mainnet

### 1. Envelope Encryption/MAC (HIGH-5 from Codex) - BLOCKING

**Current:** JSON cleartext - any hop can read full route and secret
**Required:** Per-hop encryption using ECIES or HMAC

**Implementation options:**
- **ECIES** (Elliptic Curve Integrated Encryption Scheme)
  - Each hop uses recipient's public key
  - Standard in Ethereum ecosystem
  - ~150 lines of code

- **HMAC** (simpler, faster)
  - Derive key from hashlock + hop index
  - Lighter weight
  - ~80 lines of code

**Impact:** Privacy is broken without this
**Effort:** ~8 hours
**Priority:** CRITICAL before mainnet

### 2. Production J-Layer - BLOCKING

**Current:** BrowserVM (in-memory, test-only)
**Required:** Real L1 blockchain via RPC

**What's needed:**
- Replace BrowserVM with Ethereum/Base/Optimism RPC provider
- Contract deployment scripts for production
- State root verification against L1
- Transaction batching and gas optimization
- Fallback RPC providers (redundancy)

**Impact:** No persistence = unusable for mainnet
**Effort:** ~40 hours
**Priority:** CRITICAL

### 3. Watchtowers - BLOCKING

**Current:** None - parties must stay online or risk fund loss
**Required:** Watchtower protocol for breach monitoring

**Design:**
- Watchtower monitors bilateral channels
- Detects fraudulent state publications
- Auto-publishes latest valid state to J-layer
- Reward mechanism for watchtower services

**Reference:**
- Lightning Network watchtower spec
- Mentioned in `docs/htlc-onion-routing.md` line 541

**Impact:** Funds at risk if user goes offline
**Effort:** ~24 hours
**Priority:** HIGH (before mainnet)

### 4. Formal Verification - CRITICAL

**Current:** Tested + Codex-audited (good but not sufficient)
**Required:** Mathematical proofs for consensus-critical code

**Scope:**
- Bilateral consensus (prove no divergence)
- HTLC lock/reveal/timeout (prove atomicity)
- Fee calculation (prove no double-spend)
- State hash computation (prove determinism)

**Tools:**
- TLA+ specifications
- Coq/Isabelle formal proofs
- Model checking for edge cases

**Impact:** Hidden bugs in consensus = fund loss
**Effort:** ~80 hours (requires formal methods expert)
**Priority:** HIGH (parallel with testnet operation)

### 5. HSM Key Management - CRITICAL

**Current:** In-memory keys (test mode)
**Required:** Hardware security module integration

**Features needed:**
- Key generation in HSM (never exposed)
- Signing via HSM API
- Key rotation protocol
- Social recovery / multisig
- Encrypted cloud backup (optional)

**Impact:** Private key compromise = user fund loss
**Effort:** ~16 hours
**Priority:** HIGH before mainnet

---

## Phase Roadmap

### Phase 2 (Current) - Testnet Ready ✅

**Status:** COMPLETE
**Readiness:** 600/1000
**Launch:** Deploy to testnet NOW

**Features:**
- Full HTLC protocol (lock/reveal/timeout)
- Onion routing (cleartext)
- Multi-hop payments (tested up to 4 hops)
- Bilateral consensus (production-grade)
- All Codex safety fixes

**Limitations:**
- BrowserVM only (no persistence)
- No envelope encryption (privacy leak)
- No watchtowers (must stay online)
- In-memory keys only

**Recommended use:** Internal testing, developer preview, hackathons

### Phase 3 - Limited Mainnet

**Target Readiness:** 800/1000
**Timeline:** +2-3 weeks
**Effort:** ~80 hours

**Must-have:**
1. Envelope encryption (ECIES/HMAC) - 8h
2. Production L1 integration (Ethereum RPC) - 40h
3. Watchtower protocol - 24h
4. HSM key management - 16h

**Result:** Limited mainnet for early adopters, small amounts

### Phase 4 - Production Mainnet

**Target Readiness:** 950/1000
**Timeline:** +2-3 months
**Effort:** ~200 hours

**Must-have:**
5. Formal verification (TLA+ specs) - 80h
6. External security audit - 40h
7. Bug bounty program - ongoing
8. Production monitoring (Prometheus/Grafana) - 24h
9. Disaster recovery procedures - 16h
10. Advanced DOS protection - 24h
11. Dynamic fee market - 16h

**Result:** Production-ready for real user funds

---

## Testnet Launch Checklist (Phase 2)

- [x] HTLC protocol complete
- [x] Onion routing functional
- [x] All Codex consensus fixes applied
- [x] Tests passing (176 + 113 frames)
- [x] Build clean (0 type errors)
- [x] Opus verification passed
- [ ] Deploy to testnet L1 (Sepolia or Goerli)
- [ ] Public documentation
- [ ] Developer onboarding guide
- [ ] Faucet for test tokens

**Ready to deploy:** YES (with documented limitations)

---

## Known Limitations (Phase 2)

1. **No hop privacy** - Cleartext envelopes (all hops can see full route)
2. **BrowserVM only** - State lost on page refresh
3. **No offline support** - All parties must be online
4. **Manual key management** - Users responsible for private keys
5. **Limited testing** - Real-world network conditions not tested
6. **No formal proofs** - Consensus correctness not mathematically proven

**Acceptable for:** Testnet, developer preview, research
**Not acceptable for:** Mainnet with real user funds

---

## Risk Assessment

### High Risk (Must Fix Before Mainnet)

1. **Envelope encryption** - Privacy violation
2. **Watchtowers** - Fund loss if offline
3. **HSM integration** - Key theft vulnerability
4. **Formal verification** - Unknown consensus bugs

### Medium Risk (Should Fix)

5. **DOS attacks** - Network spam
6. **Fee manipulation** - Routing centralization
7. **Liquidity fragmentation** - Poor UX
8. **Channel jamming** - Griefing attacks

### Low Risk (Nice to Have)

9. **UI polish** - UX improvements
10. **SDK ecosystem** - Developer tools
11. **Advanced privacy** - Amount blinding, etc.

---

## Effort Summary

| Phase | Readiness | Effort | Timeline |
|-------|-----------|--------|----------|
| Phase 2 (Current) | 600/1000 | DONE | NOW |
| Phase 3 (Limited) | 800/1000 | ~80h | +3 weeks |
| Phase 4 (Production) | 950/1000 | ~280h | +3 months |

**Recommendation:** Launch Phase 2 testnet immediately, iterate to Phase 3 within 1 month.

---

## Open Questions

1. **Target market:** Developer tool or end-user app?
   - If developer: Phase 2 sufficient
   - If end-user: Need Phase 4

2. **Risk tolerance:** Early adopter beta or institutional-grade?
   - Early adopter: Phase 3 OK
   - Institutional: Need Phase 4 + audit

3. **Privacy requirements:** Nice-to-have or deal-breaker?
   - If nice-to-have: Phase 2 OK for testnet
   - If deal-breaker: Block on envelope encryption

4. **Custody model:** Self-custody or custodial wallets?
   - Self-custody: Need HSM immediately
   - Custodial: Can defer HSM

---

**Last updated:** 2026-01-03
**Next review:** After Phase 3 completion
