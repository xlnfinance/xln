# XLN Mainnet Readiness Audit

**Date**: 2026-01-27
**Auditor**: Claude Opus 4.5 (Automated Security Analysis)
**Protocol Version**: Pre-mainnet
**Total Files Analyzed**: ~200+ TypeScript & Solidity files
**Total Lines of Code**: ~50,000+

---

## Executive Summary

XLN implements a sophisticated off-chain bilateral payment channel system with on-chain settlement via the RJEA (Runtime → Jurisdiction → Entity → Account) architecture. The protocol shows strong architectural design and good separation of concerns, but **is NOT ready for mainnet deployment with real funds**.

### Overall Readiness Score: 52/100

| Category | Score | Status |
|----------|-------|--------|
| Solidity Contracts | 65/100 | Needs admin key timelock, unbounded loop fixes |
| Runtime Core | 55/100 | Determinism violations, validation gaps |
| Frontend Security | 30/100 | **CRITICAL**: Plaintext mnemonic in localStorage |
| Cryptography | 80/100 | BrainVault solid, but weak password warning needed |
| P2P Networking | 10/100 | **NOT IMPLEMENTED** - stubs only |
| Documentation | 65/100 | Good architecture docs, missing security/API docs |
| Deployment | 50/100 | Hardcoded IPs, no mainnet confirmation |

### Top 10 Critical Issues (Blocking Mainnet)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **Plaintext mnemonic in localStorage** | frontend-stores | Complete fund theft via XSS |
| 2 | **Hardcoded private key in RPC path** | runtime/evm.ts:186 | Fund loss if used on mainnet |
| 3 | **MockEntityProvider bypasses signatures** | mocks/MockEntityProvider.sol | Complete fund theft if deployed |
| 4 | **No signature verification in gossip profiles** | runtime/name-resolution.ts | Profile spoofing, phishing |
| 5 | **Non-deterministic operations in consensus** | runtime/runtime.ts, htlc-utils.ts | State divergence between nodes |
| 6 | **P2P layer not implemented** | runtime/p2p.ts, gossip.ts | Cannot deploy multi-node |
| 7 | **Admin can drain all reserves** | Depository.sol:271,309 | Centralization risk |
| 8 | **Price truncation in orderbook** | orderbook/core.ts:396 | Systematic value extraction |
| 9 | **State deserialization without integrity** | runtime/browservm.ts:1822 | Malicious state injection |
| 10 | **Missing threat model documentation** | docs/ | Unknown attack surface |

---

## Issue Summary by Priority

### Critical (P0) - 23 Issues
Must fix before ANY production use. Fund loss or complete compromise possible.

### High (P1) - 31 Issues
Should fix before mainnet. Security degradation or operational risk.

### Medium (P2) - 47 Issues
Plan to fix. Defense in depth, best practices.

### Low (P3) - 12 Issues
Nice to have. Code quality, performance.

---

## Detailed Findings by Area

### 1. Frontend Stores (CRITICAL - Score: 30/100)

The frontend stores are the **most critical vulnerability**. Raw mnemonics and private keys are:
- Stored unencrypted in `localStorage`
- Exposed to `window.XLN` global for debugging
- Passed through multiple store layers as plain strings
- Derivable via public functions like `getActiveSignerPrivateKey()`

**P0 Issues:**
- [P0-FS1] `vaultStore.ts:132` - Raw mnemonic in localStorage
- [P0-FS2] `xlnStore.ts:28-47` - Runtime exposed to window.XLN
- [P0-FS3] `vaultStore.ts:453-472` - Private key derivation functions exposed
- [P0-FS4] `runtimeStore.ts:77` - API key sent over unencrypted WebSocket

**Immediate Actions:**
1. Implement Web Crypto API for mnemonic encryption at rest
2. Remove all `window.XLN` exposure in production builds
3. Implement secure memory handling for private keys
4. Require HTTPS/WSS for all network communications

### 2. Solidity Contracts (Score: 65/100)

Contracts implement bilateral reserve management with Hanko signature system. Core logic is sound but operational security is weak.

**P0 Issues:**
- [P0-SC1] `MockEntityProvider.sol:11` - Bypasses ALL signature verification
- [P0-SC2] `Depository.sol:271,309` - Admin can drain reserves via mintToReserve
- [P0-SC3] `Depository.sol:68,192` - Immutable admin with no transfer mechanism

**P1 Issues:**
- [P1-SC1] `EntityProvider.sol:375-384` - Unbounded loop in recoverEntity (O(n))
- [P1-SC2] `Depository.sol:175-181` - Unbounded loop in removeEntityProvider
- [P1-SC3] `Depository.sol:730-741` - Debt enforcement can be blocked via spam
- [P1-SC4] `DeltaTransformer.sol:9` - console.sol import in production

**Recommendations:**
1. Add 7-day timelock for admin functions
2. Implement admin transfer with governance
3. Use mapping-based lookups instead of loops
4. Create separate deployment package for mocks

### 3. Runtime Core (Score: 55/100)

RJEA architecture is well-designed but has determinism violations that will cause consensus failures in production.

**P0 Issues:**
- [P0-RC1] `runtime.ts:155` - `Date.now()` in fallback (non-deterministic)
- [P0-RC2] `htlc-utils.ts:67` - `crypto.getRandomValues()` for HTLC secrets
- [P0-RC3] `runtime.ts:597` - `setInterval` in consensus-critical path
- [P0-RC4] `constants.ts:41-42` - Payment limits exceed collateral limits
- [P0-RC5] `htlc-reveal.ts:45-51` - Off-by-one in reveal height validation

**P1 Issues:**
- [P1-RC1] `account-consensus.ts:130-144` - Counter wraps at 1M messages
- [P1-RC2] `account-consensus.ts:76-77` - Frame size limit not enforced
- [P1-RC3] `entity-tx/apply.ts:206-216` - J-events accepted without proof
- [P1-RC4] `entity-tx/apply.ts:882-888` - Settlement invariant not checked everywhere

**Recommendations:**
1. Audit ALL uses of Date.now(), Math.random(), crypto.getRandomValues()
2. Use `env.timestamp` and `env.runtimeSeed` exclusively for determinism
3. Add explicit negative amount checks at all entry points
4. Implement HTLC secret derivation from seeded RNG

### 4. Name Resolution (Score: 40/100)

Off-chain name resolution is fundamentally broken - anyone can claim any name.

**P0 Issues:**
- [P0-NR1] `name-resolution.ts:63` - Name index overwrites without collision check
- [P0-NR2] `name-resolution.ts:142-205` - Hanko signature passed but never verified

**P1 Issues:**
- [P1-NR1] No unicode/homograph attack mitigation
- [P1-NR2] `gossip.ts:91-103` - Same-timestamp allows profile override
- [P1-NR3] No rate limiting on name registration

**Recommendations:**
1. Verify hanko signatures before accepting profile updates
2. Check on-chain name ownership before updating name index
3. Implement unicode normalization (NFKC) and confusable detection

### 5. EVM Integration (Score: 60/100)

**P0 Issues:**
- [P0-EVM1] `evm.ts:186` - Hardcoded Hardhat private key in production path
- [P0-EVM2] `browservm.ts:1822-1928` - State restoration without integrity check

**P1 Issues:**
- [P1-EVM1] Insufficient error detail propagation
- [P1-EVM2] Transaction signing without chain ID verification
- [P1-EVM3] `browservm-ethers-provider.ts:82-83` - Fixed gas estimates

**Recommendations:**
1. Remove hardcoded private key, require signer injection
2. Add HMAC verification for persisted state
3. Implement proper gas estimation

### 6. Orderbook (Score: 60/100)

**P0 Issues:**
- [P0-OB1] `core.ts:396` - Integer truncation in price calculation
- [P0-OB2] Self-trade prevention bypass via owner string collision

**P1 Issues:**
- [P1-OB1] `types.ts:156` - Map iteration order could cause divergence
- [P1-OB2] `core.ts:91-93` - Uint32 overflow for large quantities
- [P1-OB3] Dynamic price grid vulnerable to manipulation
- [P1-OB4] `core.ts:341-343` - Weak hash function (bumpHash)

**Recommendations:**
1. Use higher precision for price calculation
2. Ensure ownerId is always canonical full entityId
3. Replace bumpHash with keccak256

### 7. BrainVault Cryptography (Score: 80/100)

BrainVault is the strongest component. Argon2id + BLAKE3 + BIP39 implementation is sound.

**P1 Issues:**
- [P1-BV1] `core.ts:25` - Argon2id time cost = 1 (should be 3+)
- [P1-BV2] `core.ts:29` - Minimum 6-char passphrase is too weak
- [P1-BV3] `core.ts:91-127` - Entropy estimation assumes random passwords
- [P1-BV4] `worker-browser.ts` - No rate limiting

**Recommendations:**
1. Integrate zxcvbn for real entropy estimation
2. Enforce minimum 40-bit entropy threshold
3. Display attack cost for chosen passphrase

### 8. P2P Networking (Score: 10/100)

**P0 Issue:**
- [P0-P2P1] **P2P layer is NOT IMPLEMENTED** - all files are empty stubs

**Impact:** Cannot deploy multi-node production system.

**Files that are stubs:**
- `runtime/p2p.ts` - empty namespace
- `runtime/gossip.ts` - empty
- `runtime/gossip-helper.ts` - empty
- `runtime/ws-client.ts` - minimal connection only
- `runtime/ws-server.ts` - no authentication
- `runtime/ws-protocol.ts` - empty

### 9. Documentation (Score: 65/100)

Good architecture documentation but missing critical security docs.

**Missing (P0):**
- Threat model document
- Security audit scope
- Key management guide
- Incident response runbook

**Missing (P1):**
- API reference documentation
- Contract function documentation
- WebSocket protocol spec
- Monitoring setup guide

### 10. Deployment (Score: 50/100)

**P0 Issues:**
- [P0-DP1] `deploy-to-vultr.sh:9` - Hardcoded production server IP
- [P0-DP2] All scripts use `root@server` SSH access
- [P0-DP3] No mainnet deployment confirmation prompt

**Recommendations:**
1. Add interactive confirmation for mainnet deployments
2. Use dedicated deploy user instead of root
3. Create `.env.example` documenting required variables

---

## Architecture Observations

### Strengths
- RJEA separation of concerns is well-designed
- Bilateral consensus with rollback handling
- Frame hash chaining for replay protection
- Hanko signature system for hierarchical governance
- BrainVault memory-hard key derivation

### Weaknesses
- P2P layer entirely missing
- Frontend stores have no encryption
- Many hardcoded values that should be configurable
- Insufficient input validation at system boundaries
- Missing formal verification for financial math

---

## Recommended Remediation Order

### Phase 1: Critical Security (2-4 weeks)
1. Encrypt mnemonics in localStorage using Web Crypto API
2. Remove hardcoded private key from evm.ts
3. Fix determinism violations (Date.now, Math.random, setInterval)
4. Add signature verification to name resolution
5. Move MockEntityProvider to separate test package

### Phase 2: Operational Security (2-4 weeks)
1. Implement admin timelock for contract functions
2. Fix unbounded loops in contracts
3. Add negative amount validation everywhere
4. Implement proper gas estimation
5. Add mainnet deployment confirmation

### Phase 3: Production Readiness (4-8 weeks)
1. Implement full P2P layer with authentication
2. Add TLS/WSS requirements
3. Implement monitoring and alerting
4. Create incident response runbook
5. Conduct formal security audit

### Phase 4: Polish (ongoing)
1. Fix all P2 issues
2. Add comprehensive API documentation
3. Implement rate limiting throughout
4. Add formal verification for critical math

---

## Files Analyzed

| Area | Files | Lines |
|------|-------|-------|
| Runtime Core | 45 | ~15,000 |
| Solidity Contracts | 15 | ~4,000 |
| Frontend Stores | 12 | ~3,000 |
| Frontend Components | 35 | ~12,000 |
| BrainVault | 7 | ~1,200 |
| Deployment Scripts | 20 | ~2,500 |
| Documentation | 25 | ~8,000 |

---

## Individual Audit Reports

Detailed findings available in `/audit/`:
- `contracts-solidity.md` - Smart contract audit
- `runtime-core.md` - RJEA runtime audit
- `runtime-evm.md` - EVM integration audit
- `runtime-orderbook.md` - Orderbook audit
- `runtime-names.md` - Name resolution audit
- `runtime-p2p.md` - P2P networking audit
- `frontend-stores.md` - Store security audit
- `frontend-components.md` - Component security audit
- `brainvault-crypto.md` - Cryptographic audit
- `deployment-scripts.md` - Deployment audit
- `docs-architecture.md` - Documentation audit
- `archive-patterns.md` - Archive code patterns

---

## Conclusion

XLN demonstrates strong architectural thinking with the RJEA model and bilateral consensus design. The BrainVault cryptography is well-implemented. However, **the protocol is NOT ready for mainnet** due to:

1. **Frontend stores exposing raw mnemonics** - Any XSS attack = complete fund theft
2. **Hardcoded private keys in production paths** - Immediate fund loss risk
3. **P2P layer not implemented** - Cannot run multi-node production
4. **Non-deterministic operations** - Will cause consensus failures

Estimated time to mainnet readiness: **3-6 months** with dedicated security focus.

---

*This audit is automated analysis. Manual review by security experts and formal verification of financial math is required before handling real funds.*
