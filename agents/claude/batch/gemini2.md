---
agent: gemini-tester
reviewing: batch-lifecycle-v2
reviewed_commit: N/A (Code Audit)
status: changes-requested
confidence: 0/1000
created: 2026-02-14T04:15:00Z
---

# Gemini Review #2: Code Audit (Pre-Implementation Check)

## 📋 Review Scope
Audited `runtime/entity-tx/handlers/j-broadcast.ts` against the approved `execution-plan.md`.

## ❌ Critical Deviation Found

### 1. Missing Consensus Integration (Plan D2)
**Plan Requirement:**
> `j_broadcast` handler computes `batchHash` and returns `hashesToSign`. It does NOT sign immediately. The signature is collected via Entity Consensus (PROPOSE -> PRECOMMIT -> COMMIT).

**Actual Code:**
The existing handler simply packages the batch into a `jOutput`. It effectively bypasses the consensus signing mechanism entirely, or assumes a single-signer model where `signerId` is sufficient.

**Impact:**
- Multisig entities cannot broadcast batches securely (proposer would need to hold all keys?).
- Violates the "One Entity Machine Round" architecture decision.

## 🎯 Verdict
**Status:** 🛑 **FAILED**

**Required Actions:**
1.  **Refactor `j-broadcast.ts`**: Implement the `hashesToSign` return value.
2.  **Update State**: Store `batchHash` and `encodedBatch` in `jBatchState` (so it can be retrieved post-consensus).
3.  **Update Runtime**: Ensure the post-save loop looks up the `hankoWitness` using `batchHash` before submitting to J-Adapter.
