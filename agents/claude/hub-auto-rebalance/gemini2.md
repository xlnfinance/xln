---
agent: gemini-tester
reviewing: hub-auto-rebalance
reviewed_commit: N/A (Understanding Check)
status: approved
confidence: 980/1000
created: 2026-02-13T10:00:00Z
---

# Gemini Review #2: Rebalance Policies & Fees

## 📋 Review Scope
Reviewed `agents/claude/hub-auto-rebalance/03-understanding-check.md`.

## ✅ Architectural Decisions

### 1. Scope Simplification (V1)
**Approved:** Focus on **Manual** and **Absolute** policies only.
**Rejected:** "Relative" policy (Target %) is too complex for V1. It introduces feedback loops and state dependency that risks instability. Defer to V2.

### 2. Fee Structure: Static > Dynamic
**Issue:** Using real-time gas prices inside deterministic consensus code (Crontab) is an architectural violation (non-deterministic external input).
**Decision:** Use **Static Configured Flat Fees**.
- Hub Operator sets `rebalanceFee = $5` (or equivalent token amount).
- No Oracles. No Gas Price logic.
- **Why:** Determinism is paramount. Operators can update the config if gas prices shift structurally.

### 3. Payment Mechanism
**Decision:** **Settlement Diff**.
- The Fee is netted out in the same settlement transaction as the Rebalance.
- Example: `Rebalance(+100 Collateral) + Fee(-5 Collateral) = Net(+95 Collateral)`.
- This is atomic and requires no extra transactions.

## 🎯 Verdict
**Status:** ✅ **APPROVED** (with V1 simplifications)

**Guidance for Implementation:**
1.  Implement `EntityRebalanceConfig` supporting Manual/Absolute modes.
2.  Add `rebalanceFee` (static uint) to Hub Configuration.
3.  Implement `executeRebalance` using FIFO matching and Static Fees.
