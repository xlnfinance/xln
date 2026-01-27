# Test Coverage Audit

**Date**: 2026-01-27
**Auditor**: Claude Opus 4.5
**Protocol Status**: Pre-mainnet financial protocol

---

## Executive Summary

The XLN protocol has **moderate test coverage with significant gaps in critical security paths**. While scenario-based integration tests exist for happy paths, there is a **critical absence of dedicated security/attack tests** and **insufficient edge case coverage** for a financial protocol approaching mainnet.

### Coverage Status

| Category | Status | Risk Level |
|----------|--------|------------|
| Smart Contract Tests | Partial | HIGH |
| Runtime Unit Tests | Minimal | HIGH |
| E2E/Integration Tests | Good | MEDIUM |
| Determinism Tests | Good | LOW |
| Attack Scenario Tests | **MISSING** | CRITICAL |
| Edge Case Tests | Minimal | HIGH |
| Bilateral Consensus | Partial | HIGH |

---

## Critical Missing Tests (P0)

### Attack Scenarios (CRITICAL - None Exist)

- [ ] **Replay attack tests** - No tests for nonce replay protection in account frames
- [ ] **Double-spend tests** - No tests for same HTLC being claimed twice
- [ ] **Griefing attack tests** - No tests for griefing via dispute spam or lock exhaustion
- [ ] **Front-running tests** - No tests for settlement front-running protection
- [ ] **State desync attacks** - No tests for bilateral state divergence exploitation
- [ ] **Overflow/underflow tests** - No explicit BigInt boundary tests in financial operations
- [ ] **Credit limit bypass tests** - No tests for credit limit enforcement under concurrent payments

### Dispute Resolution (HIGH PRIORITY)

- [ ] **Dispute timeout enforcement** - No tests for dispute window expiration
- [ ] **Counter-dispute flow** - No tests for newer-state counter-dispute success
- [ ] **Invalid proof rejection** - No tests for malformed dispute proof handling
- [ ] **Dispute during HTLC** - No tests for dispute interaction with pending HTLCs
- [ ] **Cooperative vs unilateral finalization** - No comparison tests

### HTLC Security (HIGH PRIORITY)

- [ ] **HTLC timeout tests** - No tests for expired HTLC handling
- [ ] **Hashlock collision tests** - No tests for hash collision resistance
- [ ] **Secret reveal timing** - No tests for premature/late reveal handling
- [ ] **Multi-hop failure cascade** - No tests for partial route failure recovery
- [ ] **Concurrent HTLC stress** - Limited (only 4 sequential in htlc-4hop.ts)

### Financial Invariants (HIGH PRIORITY)

- [ ] **Zero amount transfer tests** - No explicit zero-amount handling tests
- [ ] **Max uint256 overflow tests** - No boundary tests for large values
- [ ] **Negative balance prevention** - No explicit tests (relies on implicit BigInt)
- [ ] **Collateral conservation tests** - Only basic solvency check in scenarios
- [ ] **Fee rounding tests** - No tests for fee calculation precision

---

## Test Quality Issues

### Smart Contract Tests (jurisdictions/test/)

**EntityProvider.test.cjs** (289 lines)
- [x] Foundation setup
- [x] Entity registration with governance
- [x] Token ID system
- [x] ERC1155 transfers
- [x] Signature recovery
- [ ] Missing: Reentrancy tests
- [ ] Missing: Gas limit attack tests
- [ ] Missing: Batch overflow tests

**HankoAuthorization.test.cjs** (333 lines)
- [x] Test mode bypass
- [x] Production mode enforcement
- [x] Nonce tracking (basic)
- [ ] Missing: Nonce replay attack tests
- [ ] Missing: Cross-entity signature tests
- [ ] Missing: Invalid signature edge cases
- [ ] **TODO in code**: "Add test with actual Hanko signature generation"

**ControlShares.test.cjs** (555 lines)
- [x] Entity registration
- [x] Control share release
- [x] Depository integration
- [x] Reserve transfers
- [x] Series A funding simulation
- [ ] Missing: Share dilution attack tests
- [ ] Missing: Governance threshold bypass tests

**Depository.ts** (incomplete review)
- [x] Basic deployment
- [x] Mock token integration
- [ ] Missing: Settlement proof verification tests
- [ ] Missing: Multi-token operation tests

### Runtime Tests

**runtime/__tests__/ids.test.ts** (280 lines)
- [x] Type constructors
- [x] Validators (basic)
- [x] ReplicaKey operations
- [x] URI operations
- [x] Edge cases for entity #0
- [ ] Missing: Malformed input fuzzing
- [ ] Missing: Unicode/special character handling

**brainvault/core.test.ts** (114 lines)
- [x] Deterministic salt generation
- [x] Single shard derivation
- [x] Multi-shard derivation (10 shards)
- [x] Full wallet derivation
- [x] CLI parity test
- **Quality**: Good - frozen test vectors for wallet compatibility

### Scenario Tests (runtime/scenarios/)

**determinism-test.ts** (198 lines)
- [x] Multi-run hash verification
- [x] Env state hashing
- [x] Seed consistency
- **Quality**: Good - critical for RJEA purity guarantee

**solvency-check.ts** (46 lines)
- [x] Reserve + collateral = expected
- [ ] Missing: Per-token solvency
- [ ] Missing: Account-level solvency
- [ ] Only used as helper, not standalone test

**settle.ts** (635 lines)
- [x] Conservation law validation
- [x] Auto-approve logic
- [x] Workspace propose/update/approve
- [x] Settlement execute
- [x] Settlement reject
- [x] Settlement holds verification
- [ ] Missing: Partial settlement tests
- [ ] Missing: Concurrent settlement tests

**htlc-4hop.ts** (100+ lines)
- [x] Multi-hop routing (4 hops)
- [x] Onion envelope creation
- [x] Fee cascade verification
- [x] Sequential payments (4 payments)
- [ ] Missing: Route failure recovery
- [ ] Missing: Concurrent payment stress

**lock-ahb.ts** (large file)
- [x] Alice-Hub-Bob topology
- [x] Lock/unlock flow
- [ ] Missing: Lock timeout tests
- [ ] Missing: Dispute during lock

### E2E Tests (Playwright)

**frontend/tests/fed-chair-demo.spec.ts** (287 lines)
- [x] 3x3 hub creation
- [x] Entity funding
- [x] Random payment animation
- [x] Scale test (100 entities, FPS verification)
- [x] Reset demo
- [x] Error handling (graceful degradation)
- **Quality**: Good UI/visual verification

**frontend/tests/landing.spec.ts** (108 lines)
- [x] Heading display
- [x] Slot machine contracts
- [x] MML unlock flow
- [x] 404 detection
- [x] Responsive design (3 viewports)
- **Quality**: Good smoke test

**tests/ahb-demo.spec.ts** (169 lines)
- [x] AHB preset loading
- [x] Frame stepping (9 frames)
- [x] Subtitle verification
- [x] 3D canvas rendering
- [x] History mode toggle
- **Quality**: Good demo flow verification

---

## Coverage Analysis

### What IS Tested

1. **Happy path fund flows** - Basic reserve transfers, settlements work
2. **Entity registration** - Smart contract registration verified
3. **Determinism** - Multi-run consistency verified
4. **UI rendering** - Visual verification via Playwright
5. **Demo scenarios** - AHB, 4-hop, settle scenarios run end-to-end
6. **Token operations** - ERC1155 transfers, batch operations
7. **Governance tokens** - Control/dividend token creation and transfer

### What is NOT Tested (Critical Gaps)

1. **Security attacks** - Zero attack scenario tests
2. **Concurrent operations** - Limited concurrent payment testing
3. **Edge cases** - Zero/max/overflow values
4. **Dispute resolution** - No dispute flow tests in smart contracts
5. **HTLC security** - Timeout, collision, failure scenarios
6. **State recovery** - No crash/restart recovery tests
7. **Network partitions** - No split-brain scenario tests
8. **Byzantine validators** - No malicious validator tests
9. **Capacity exhaustion** - No lock/credit exhaustion tests
10. **Cross-chain** - No multi-jurisdiction tests

### Code Without Tests

| File | Critical Functions | Test Status |
|------|-------------------|-------------|
| `runtime/entity-tx/handlers/dispute.ts` | handleDisputeStart, handleDisputeFinalize | NOT TESTED |
| `runtime/htlc-utils.ts` | HTLC timeout logic | NOT TESTED |
| `runtime/account-tx/handlers/htlc-timeout.ts` | Timeout handling | NOT TESTED |
| `runtime/routing/pathfinding.ts` | Route calculation | NOT TESTED |
| `runtime/account-consensus.ts` | Bilateral signing | MINIMAL |
| `runtime/entity-consensus.ts` | BFT consensus | MINIMAL |

---

## Recommended Test Additions

### P0 - Before Mainnet (Security Critical)

- [ ] **Attack scenario suite** (`tests/security/`)
  - Replay attack with stale nonces
  - Double-spend via concurrent claims
  - Griefing via lock exhaustion
  - Front-running settlement submission
  - State desync via delayed messages

- [ ] **Dispute resolution suite** (`tests/dispute/`)
  - Dispute start/finalize full flow
  - Counter-dispute with newer state
  - Dispute timeout enforcement
  - Invalid proof rejection
  - Dispute during active HTLC

- [ ] **HTLC security suite** (`tests/htlc/`)
  - HTLC timeout (sender reclaim)
  - Hash collision resistance
  - Secret reveal timing attacks
  - Multi-hop failure recovery
  - Concurrent HTLC stress (100+ simultaneous)

- [ ] **Financial invariant suite** (`tests/invariants/`)
  - Zero amount operations
  - Max uint256 boundary
  - Negative balance prevention
  - Conservation law (reserves + collateral = constant)
  - Fee precision (rounding tests)

### P1 - Shortly After Mainnet

- [ ] **Stress/load tests** (`tests/stress/`)
  - 1000 concurrent payments
  - 100 simultaneous disputes
  - Network partition simulation

- [ ] **Recovery tests** (`tests/recovery/`)
  - Crash during settlement
  - State restore from snapshot
  - Partial sync recovery

- [ ] **Byzantine validator tests** (`tests/byzantine/`)
  - Malicious proposer
  - Equivocation detection
  - Threshold signature manipulation

### P2 - Ongoing

- [ ] **Fuzz testing** (property-based)
- [ ] **Formal verification** (TLA+ specs)
- [ ] **Chaos engineering** (random failure injection)

---

## Files Reviewed

### Active Test Files
- `/Users/zigota/xln/runtime/__tests__/ids.test.ts`
- `/Users/zigota/xln/brainvault/core.test.ts`
- `/Users/zigota/xln/jurisdictions/test/EntityProvider.test.cjs`
- `/Users/zigota/xln/jurisdictions/test/HankoAuthorization.test.cjs`
- `/Users/zigota/xln/jurisdictions/test/ControlShares.test.cjs`
- `/Users/zigota/xln/jurisdictions/test/Depository.ts`
- `/Users/zigota/xln/frontend/tests/fed-chair-demo.spec.ts`
- `/Users/zigota/xln/frontend/tests/landing.spec.ts`
- `/Users/zigota/xln/tests/ahb-demo.spec.ts`

### Scenario Files (Integration Tests)
- `/Users/zigota/xln/runtime/scenarios/determinism-test.ts`
- `/Users/zigota/xln/runtime/scenarios/solvency-check.ts`
- `/Users/zigota/xln/runtime/scenarios/settle.ts`
- `/Users/zigota/xln/runtime/scenarios/htlc-4hop.ts`
- `/Users/zigota/xln/runtime/scenarios/lock-ahb.ts`
- `/Users/zigota/xln/runtime/scenarios/insurance-cascade.ts`

### Archived Tests (Reference Only)
- `/Users/zigota/xln/.archive/2024_src/test/channel.test.ts`
- `/Users/zigota/xln/.archive/2024_src/test/directpayment.test.ts`
- `/Users/zigota/xln/.archive/2024_src/test/onionpayment.test.ts`
- `/Users/zigota/xln/.archive/2024_src/test/highload.test.ts`
- `/Users/zigota/xln/.archive/2024_src/test/stress.test.ts`

### Source Files Requiring Tests
- `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts`
- `/Users/zigota/xln/runtime/entity-tx/handlers/htlc-payment.ts`
- `/Users/zigota/xln/runtime/account-tx/handlers/htlc-timeout.ts`
- `/Users/zigota/xln/runtime/routing/pathfinding.ts`
- `/Users/zigota/xln/runtime/account-consensus.ts`
- `/Users/zigota/xln/runtime/entity-consensus.ts`

---

## Risk Assessment for Mainnet

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Replay attack | Medium | Critical | Add nonce tests immediately |
| Double-spend via HTLC | Low | Critical | Add HTLC security tests |
| Dispute griefing | Medium | High | Add dispute cost tests |
| State desync | Medium | High | Add bilateral consensus tests |
| Overflow in reserves | Low | Critical | Add boundary tests |

**Recommendation**: Do not proceed to mainnet without P0 test additions. Current coverage is insufficient for a financial protocol handling real funds.

---

## Appendix: Test Commands

```bash
# Smart contract tests
cd jurisdictions && bunx hardhat test

# Runtime unit tests
bun test runtime/__tests__/ids.test.ts

# BrainVault tests
bun test brainvault/core.test.ts

# E2E tests (requires dev server)
cd frontend && bunx playwright test

# Scenario tests
bun runtime/scenarios/determinism-test.ts
bun runtime/scenarios/settle.ts
bun runtime/scenarios/htlc-4hop.ts

# Full check
bun run check
```
