---
agent: claude-sonnet-4.5
session_id: 2026-02-12-remove-insurance
feature: remove-insurance
status: planned
created: 2026-02-12T16:00:00Z
branch: claude/remove-insurance
worktree: ~/.claude-worktrees/xln/remove-insurance
reviewers: [codex, gemini]
---

# Feature: Remove Insurance Functionality

## 🎯 Goal

Remove insurance feature from contracts, runtime, and frontend due to:

**Security issues (7 bugs found):**
1. **CRITICAL:** Unilateral settlement with forced insurance registration
2. **HIGH:** Insurance cursor skips partially-used lines forever
3. **HIGH:** No reserve escrow - hollow coverage promises
4. **MEDIUM:** Global coverage (not scoped to counterparty)
5. **MEDIUM:** Runtime ABI mismatch (uint64 vs uint256)
6. **LOW:** Hash helper mismatch for settlement debugging
7. **GAP:** Zero test coverage for insurance paths

**Market timing:**
- Insurance markets require KYC/identity (5-10 years minimum)
- No premium payment mechanism exists
- Sybil attacks trivial without reputation system
- Feature premature by 3-5 years

**Verdict:** Delete now, rebuild with DeltaTransformer approach when market ready.

## 📊 Scope

### Files to Modify

#### Contracts (~385 lines removed)
- [ ] `jurisdictions/contracts/Depository.sol` (-370 lines)
  - Remove `insuranceCursor` mapping (line 73)
  - Remove `insuranceLines` mapping (line 531)
  - Remove `_claimFromInsurance()` function (lines 970-1008)
  - Remove `_handleSettlementDebtAndInsurance()` (lines 917-946)
  - Remove insurance events (lines 533-534)
  - Remove insurance claim logic from `_enforceDebts()` (lines 808-813)
  - Clean up `_applyAccountDelta()` insurance refs (line 1179)

- [ ] `jurisdictions/contracts/Types.sol` (-15 lines)
  - Remove `InsuranceLine` struct (lines 49-54)
  - Remove `InsuranceRegistration` struct (lines 56-62)
  - Remove `insuranceRegs` from `Settlement` struct
  - Remove `insuranceRegs` from batch processing

- [ ] `jurisdictions/contracts/Account.sol` (verify no impact)
  - Check settlement verification doesn't depend on insurance
  - Verify signature checking handles removed field

#### Runtime (~50 lines removed)
- [ ] `runtime/evm.ts` (-50 lines)
  - Remove insurance ABI definitions (lines 94-99)
  - Remove `getInsuranceLines()` calls
  - Remove `getAvailableInsurance()` calls
  - Update Settlement type encoding (uint64 → uint256 elsewhere)

- [ ] `runtime/jadapter.ts` (check for references)
  - Remove any insurance helper functions
  - Clean up insurance-related types

#### Frontend (~250 lines removed)
- [ ] Delete `frontend/src/lib/view/panels/InsurancePanel.svelte` (200 lines)
- [ ] `frontend/src/lib/view/View.svelte`
  - Remove InsurancePanel import
  - Remove from panel registry
- [ ] `frontend/src/lib/stores/*.ts` (check for insurance refs)

#### Tests (~45 lines removed/updated)
- [ ] `jurisdictions/test/Depository.test.ts`
  - Remove "should claim from insurance on shortfall" test
  - Update "should process settlement" test (remove insuranceRegs)
  - Update test fixtures
- [ ] `jurisdictions/test/fixtures/settlements.ts`
  - Remove insuranceRegs from test data

#### Documentation
- [ ] `docs/settlements.md` - Remove insurance section
- [ ] `docs/architecture.md` - Add note about future transformer approach
- [ ] `CHANGELOG.md` - Document breaking change

### Files to Keep (No Changes)

- ✅ Debt enforcement logic (still works correctly)
- ✅ `_enforceDebts()` core logic (just remove insurance claim section)
- ✅ Settlement flows (insurance was optional)
- ✅ All other Depository functions
- ✅ All Account.sol settlement verification

### Total Impact

**Code removal:**
- Contracts: -385 lines
- Runtime: -50 lines
- Frontend: -250 lines
- Tests: -45 lines (obsolete)
- **Total: -730 lines**

**Benefits:**
- 7 security bugs eliminated
- Attack surface reduced
- Clearer codebase
- No misleading "feature" that doesn't work

## 🧪 Testing Plan

### Contract Tests
```bash
bun test jurisdictions/test/Depository.test.ts
bun test jurisdictions/test/Account.test.ts
bun test jurisdictions/test/Depository.integration.ts
```

**Focus:**
- Debt enforcement still works (FIFO order)
- Settlement flows unaffected
- No references to removed code
- ABI changes don't break existing functionality

### Runtime Tests
```bash
bun test runtime/entity-tx/handlers/account.test.ts
bun test runtime/entity-tx/handlers/dispute.test.ts
```

**Focus:**
- Settlement encoding correct
- No stray insurance references
- Type safety maintained

### Integration Tests
```bash
bun test tests/e2e-settlement.spec.ts
```

**Focus:**
- End-to-end settlement works
- Debt creation/enforcement works
- No insurance-related errors

### Build Verification
```bash
bun run check
```

**Must pass:**
- TypeScript compilation
- Contract compilation
- Linting
- All tests

### Coverage Target
- Maintain or improve coverage (removing untested code = +coverage)
- All affected modules: 100% tested

## 🔍 Review Criteria

### For Codex

**Security:**
- [ ] No regressions in debt enforcement
- [ ] Settlement signature verification intact
- [ ] No new vulnerabilities introduced
- [ ] ABI changes backward compatible

**Gas:**
- [ ] Settlement gas costs (should improve slightly)
- [ ] No regressions in other operations

**Testing:**
- [ ] All existing tests still pass
- [ ] No gaps in test coverage
- [ ] Edge cases handled

**ABI Compatibility:**
- [ ] Existing Settlement calls still work
- [ ] Migration path clear
- [ ] No silent failures

### For Gemini

**Architecture:**
- [ ] Clean removal (no dead code)
- [ ] Debt system remains coherent
- [ ] Future transformer path clear
- [ ] No tight coupling introduced

**Design:**
- [ ] Follows existing patterns
- [ ] Maintains separation of concerns
- [ ] Alternative approaches viable

**Long-term:**
- [ ] Easy to add back (if needed)
- [ ] No burned bridges
- [ ] Extensibility maintained

## ⏱️ Estimated Time

- **Implementation:** 2 hours
  - Contract changes: 45 min
  - Runtime changes: 30 min
  - Frontend changes: 15 min
  - Test updates: 30 min

- **Testing:** 1 hour
  - Run full test suite
  - Verify build
  - Check integration tests

- **Documentation:** 30 min
  - Update docs
  - Add CHANGELOG entry

- **Review cycles:** 1-2 days
  - Codex security review
  - Gemini architecture review
  - Address feedback

- **Total:** 2-3 days (including reviews)

## 📝 Migration Notes

**Breaking change:**
- `Settlement` struct no longer has `insuranceRegs` field
- Existing on-chain insurance lines become inaccessible (no migration)
- No action required (feature was never production-ready)

**Future path:**
- Insurance will be rebuilt using `DeltaTransformer` architecture
- Private KYC verification (off-chain)
- Escrow/collateral at registration (on-chain)
- Scoped coverage (counterparty-specific)
- Premium payment mechanism
- Estimated timeline: 3-5 years

**Deployment:**
No special deployment steps required. Standard contract upgrade.

## 🔗 Related

- **Context:** User conversation 2026-02-12
- **Security audit:** Codex findings (7 bugs, 2 critical)
- **Architecture discussion:** Transformer-based insurance design
- **Market analysis:** KYC/insurance market timing (5-10 years)

---

**Confidence:** 980/1000

**Why not 1000?**
- Need Codex to verify settlement ABI compatibility
- Need to confirm all insurance references removed
- Need integration test verification

**Ready to proceed:** ✅
