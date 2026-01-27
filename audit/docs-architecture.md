# Documentation Audit

**Protocol:** xln (Cross-Local Network)
**Audit Date:** 2026-01-27
**Auditor:** Claude Opus 4.5
**Scope:** /docs, /frontend/static/docs-static, readme.md, CLAUDE.md

---

## Executive Summary

The xln documentation is **comprehensive for a pre-mainnet protocol** with strong architectural coverage and clear design philosophy. However, there are critical gaps in security documentation, API documentation, and operational runbooks that must be addressed before mainnet launch.

**Overall Readiness:** 650/1000 (Testnet-ready, needs work for mainnet)

**Strengths:**
- Excellent architectural explanation (RJEA model clearly documented)
- Strong theoretical foundation (UFT whitepaper, RCPAN invariant)
- Good developer onboarding (CLAUDE.md, debugging guide)
- Realistic roadmap with honest limitations

**Critical Gaps:**
- No formal security documentation
- Missing API reference documentation
- No incident response/runbook documentation
- Inconsistent terminology between docs and code

---

## Missing Documentation (P0 - Critical)

### Security Documentation (BLOCKING for Mainnet)

- [ ] **Threat Model Document** - No documented threat model for the protocol
  - Hub compromise scenarios not documented
  - Key theft response procedures missing
  - Network-level attack vectors not analyzed
  - Griefing attack mitigations not formalized

- [ ] **Security Audit Report** - docs/mainnet.md mentions Trail of Bits audit required but no scope document
  - Which contracts in scope?
  - Which runtime code in scope?
  - What are security assumptions?

- [ ] **Key Management Guide** - docs/mainnet.md mentions HSM but no implementation guide
  - BrainVault documented only as "prototype exists, not documented" (10_UFT.md line 119)
  - No key rotation procedures
  - No social recovery documentation

- [ ] **Dispute Resolution Procedures** - Contract supports disputes but no operational guide
  - When should users initiate disputes?
  - What evidence needed?
  - Timeout parameters and their implications?

### API Documentation (HIGH Priority)

- [ ] **Runtime API Reference** - No formal API documentation for:
  - `EntityTx` types and their handlers
  - `AccountTx` types and their effects
  - `JTx` types and J-machine interactions
  - types.ts has good inline comments but needs proper API docs

- [ ] **Contract API Reference** - No documentation for:
  - `Depository.sol` public functions
  - `EntityProvider.sol` public functions
  - `processBatch` call format
  - Event signatures and their meanings

- [ ] **WebSocket/Network Protocol** - No documentation for:
  - P2P message formats
  - Gossip protocol
  - Network discovery

### Operational Documentation (HIGH Priority)

- [ ] **Incident Response Runbook** - No procedures for:
  - Consensus failure recovery
  - Hub insolvency handling
  - Network partition recovery
  - Emergency pause procedures

- [ ] **Monitoring Setup Guide** - docs/mainnet.md mentions Prometheus/Grafana needed but no guide
  - Which metrics to collect?
  - What alerts to set?
  - Dashboard recommendations?

- [ ] **Backup/Recovery Procedures** - No documentation for:
  - State backup format
  - Recovery from backup
  - Database migration procedures

---

## Inaccuracies Found

### Code vs Documentation Mismatches

- [ ] **Payment Spec Terminology** - `/docs/implementation/payment-spec.md` uses "S-Machine" (Server Machine) but code uses "Runtime" terminology
  - Spec says "S-Machine: Routes inputs, ticks every 100ms"
  - Code has `applyRuntimeInput` and `RuntimeInput` types
  - **Recommendation:** Update payment-spec.md to use RJEA terminology

- [ ] **Hashlock vs HTLC Naming** - payment-spec.md uses "hashlock" terminology but types.ts uses "htlc" consistently
  - Spec: `HashlockPaymentEntityTx`, `AddHashlockAccountTx`
  - Code: `HtlcLock`, `htlc_lock`, `htlc_reveal`
  - **Recommendation:** Align payment-spec.md with actual type names

- [ ] **Account Key Format** - Multiple docs mention different formats
  - RJEA architecture doc mentions canonical keys "left:right"
  - Code uses `counterpartyEntityId` as key per entity
  - Both are valid but confusing
  - **Recommendation:** Add clarification section in rjea-architecture.md

- [ ] **Frame vs Block Terminology** - Some docs use "block" when code uses "frame"
  - Consensus debugging guide references "blocks"
  - Code consistently uses `AccountFrame`, `EntityFrame`
  - **Recommendation:** Search-replace "block" to "frame" in consensus docs

### Outdated Information

- [ ] **Contract Line Counts** - `/docs/architecture/contracts.md` states:
  - "EntityProvider.sol (605 lines)"
  - "Depository.sol (991 lines)"
  - These should be verified against current implementation

- [ ] **readme.md Recent Updates** - Listed as "Oct 2025" but current date is Jan 2026
  - Should update to reflect current state
  - Changelog.md references would be more maintainable

### Missing Code References

- [ ] **Delta Transformer Documentation** - Referenced in multiple places but no implementation doc
  - 10_UFT.md line 115: "3.0 Delta Transformers: Bilateral DeFi primitives (planned - not yet written)"
  - roadmap.md mentions `deltaTransformerAddress` in contracts
  - No implementation documentation exists

---

## Architecture Documentation Quality

### Excellent (Score: 9/10)

**RJEA Architecture** (`/docs/core/rjea-architecture.md`)
- Comprehensive 669-line document
- Clear pitfall documentation with code examples
- Validation/commit separation thoroughly explained
- Bilateral J-event consensus well documented
- Production readiness checklist included

**UFT Whitepaper** (`/docs/core/10_UFT.md`)
- Strong theoretical foundation
- RCPAN invariant clearly explained
- Good comparison with FCUAN/FRPAP alternatives
- Visual ASCII diagrams helpful

**Bilaterality Document** (`/docs/architecture/bilaterality.md`)
- Clear explanation of O(1) vs O(n) scalability
- Good comparison table
- "Hive effect" calculation illustrative

### Good (Score: 7/10)

**types.ts Header Comments**
- Excellent inline documentation (217 lines of comments before first code)
- Clear message flow explanation
- Naming conventions documented
- Example flow included

**Hanko Architecture** (`/docs/architecture/hanko.md`)
- Good TradFi/DeFi bridge explanation
- Cost comparison tables helpful
- BCD governance explained
- Missing: implementation details, error handling

**Mainnet Readiness** (`/docs/mainnet.md`)
- Honest assessment (600/1000)
- Clear blocking issues identified
- Phase roadmap realistic
- Missing: specific timelines, resource requirements

### Needs Improvement (Score: 5/10)

**Payment Spec** (`/docs/implementation/payment-spec.md`)
- Comprehensive but uses outdated terminology
- Code examples don't match actual implementation
- Missing: error codes, rate limits, fee calculation details
- Status section at bottom is helpful

**Contracts Documentation** (`/docs/architecture/contracts.md`)
- Good overview but lacks:
  - Function signatures
  - Event documentation
  - Storage layout
  - Upgrade procedures

**Debugging Guide** (`/docs/debugging/consensus-debugging-guide.md`)
- Useful patterns but outdated
  - References `xlnEnv.replicas` (old API)
  - Should reference `env.eReplicas`
- Missing: JSON dump procedures from CLAUDE.md

### Poor (Score: 3/10)

**Deployment Documentation** (`/docs/deployment/server-setup.md`)
- Only nginx config
- Missing:
  - Node.js/Bun setup
  - Database setup (if any)
  - SSL certificate renewal
  - Systemd service files
  - Log rotation
  - Monitoring setup

---

## Recommendations

### P0 - Before Mainnet (BLOCKING)

1. **Create `/docs/security/` directory with:**
   - `threat-model.md` - Formal threat model
   - `key-management.md` - HSM integration guide
   - `dispute-resolution.md` - User guide for disputes
   - `incident-response.md` - Runbook for operators

2. **Create `/docs/api/` directory with:**
   - `runtime-api.md` - Full EntityTx/AccountTx reference
   - `contract-api.md` - Solidity interface documentation
   - `network-protocol.md` - P2P message formats

3. **Update existing docs:**
   - Align payment-spec.md terminology with code
   - Update contract line counts
   - Fix "block" vs "frame" terminology

### P1 - Before Production (HIGH)

4. **Create `/docs/operations/` directory with:**
   - `monitoring.md` - Prometheus metrics and dashboards
   - `backup-recovery.md` - State persistence procedures
   - `upgrade-procedures.md` - Contract and runtime upgrades

5. **Add to existing docs:**
   - Error code reference in payment-spec.md
   - Rate limit documentation
   - Fee calculation formulas

### P2 - Nice to Have

6. **Create integration guides:**
   - `hub-operator-guide.md` - How to run a hub
   - `wallet-integration.md` - How to integrate xln into wallets
   - `cex-integration.md` - How CEXes integrate

7. **Improve navigation:**
   - Add search functionality to docs site
   - Cross-reference related documents
   - Add glossary of terms

---

## Files Reviewed

### Primary Documentation (/docs/)

| File | Lines | Status |
|------|-------|--------|
| readme.md | 144 | Good - clear structure |
| roadmap.md | 588 | Good - realistic timeline |
| mainnet.md | 314 | Good - honest assessment |
| essay.md | 74 | Excellent - compelling vision |
| constraints.md | (referenced, not read) | - |
| core/00_QA.md | 135 | Good - founder context |
| core/10_UFT.md | 123 | Good - theoretical foundation |
| core/11_Jurisdiction_Machine.md | 45 | Partial - needs expansion |
| core/12_invariant.md | 90 | Good - core formula |
| core/rjea-architecture.md | 669 | Excellent - comprehensive |
| architecture/bilaterality.md | 112 | Good - clear explanation |
| architecture/contracts.md | 250 | Needs update |
| architecture/hanko.md | 261 | Good - governance model |
| architecture/why-evm.md | (referenced) | - |
| implementation/payment-spec.md | 944 | Needs terminology update |
| debugging/consensus-debugging-guide.md | 168 | Needs API update |
| deployment/server-setup.md | 157 | Incomplete |

### Root Documentation

| File | Lines | Status |
|------|-------|--------|
| readme.md (root) | 272 | Good - comprehensive overview |
| CLAUDE.md | 185 | Excellent - dev guide |

### Static Docs (/frontend/static/docs-static/)

| File | Status |
|------|--------|
| README.md | Good - navigation hub |
| rjea-architecture.md | Duplicate of /docs/core/ |
| payment-spec.md | Duplicate of /docs/implementation/ |
| Many archived files | Historical reference |

### Implementation Files Checked

| File | Purpose |
|------|---------|
| runtime/types.ts | Type definitions - excellent inline docs |
| jurisdictions/contracts/*.sol | Smart contracts |

---

## Summary Metrics

| Category | Score | Notes |
|----------|-------|-------|
| Architecture Clarity | 9/10 | RJEA well explained |
| Completeness | 5/10 | Missing security, API, ops docs |
| Accuracy | 7/10 | Some terminology drift |
| Security Guidance | 2/10 | Almost none |
| API Documentation | 3/10 | Inline only, no reference |
| Deployment Docs | 3/10 | Nginx only |
| Developer Experience | 8/10 | CLAUDE.md excellent |
| **Overall** | **650/1000** | **Testnet-ready** |

---

## Appendix: Document Structure Recommendation

```
/docs/
├── readme.md              (navigation hub)
├── quickstart.md          (new - 5-minute setup)
│
├── core/                  (theory - unchanged)
│   ├── 00_QA.md
│   ├── 10_UFT.md
│   ├── 11_Jurisdiction_Machine.md
│   ├── 12_invariant.md
│   └── rjea-architecture.md
│
├── architecture/          (design - unchanged)
│   ├── bilaterality.md
│   ├── contracts.md
│   ├── hanko.md
│   └── why-evm.md
│
├── implementation/        (building - update)
│   ├── payment-spec.md    (update terminology)
│   └── scenarios.md
│
├── api/                   (NEW - reference)
│   ├── runtime-api.md
│   ├── contract-api.md
│   └── network-protocol.md
│
├── security/              (NEW - critical)
│   ├── threat-model.md
│   ├── key-management.md
│   ├── dispute-resolution.md
│   └── incident-response.md
│
├── operations/            (NEW - production)
│   ├── monitoring.md
│   ├── backup-recovery.md
│   └── upgrade-procedures.md
│
├── deployment/            (expand)
│   ├── server-setup.md    (expand beyond nginx)
│   ├── hub-setup.md       (new)
│   └── testnet-deployment.md (new)
│
├── debugging/             (update)
│   └── consensus-debugging-guide.md (update API refs)
│
├── status/                (move)
│   ├── roadmap.md
│   └── mainnet.md
│
└── archive/               (unchanged)
```

---

**Report generated:** 2026-01-27
**Files reviewed:** 25+ documentation files
**Code files checked:** 5+ implementation files
**Total lines reviewed:** ~5,000+
