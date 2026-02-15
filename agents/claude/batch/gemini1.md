---
agent: gemini-tester
reviewing: batch-lifecycle-v2
reviewed_commit: N/A (Plan Review)
status: approved
confidence: 980/1000
created: 2026-02-14T04:00:00Z
---

# Gemini Plan Review: Batch Lifecycle V2

## 📋 Review Scope
Reviewed `agents/claude/batch/execution-plan.md`.

## ✅ Architectural Assessment

### 1. Unified Nonce (Decision D1)
**Approved.** Merging `cooperativeNonce` and `disputeNonce` simplifies the state machine significantly. The invariant "one valid proof at nonce N" is stronger than maintaining two parallel counters. It aligns perfectly with the "J/E/A" philosophy of minimal on-chain state.

### 2. Multisig Batch via Entity Consensus (Decision D2)
**Approved.** This is the correct way to handle multisig. Reusing the existing `hashesToSign` pipeline in `entity-consensus.ts` avoids creating a parallel signing infrastructure. It ensures that a batch is only broadcast if the entity consensus quorum approves it.

### 3. AccountSettled Event Optimization (Decision D3)
**Approved.** Grouping by `(left, right)` pair instead of emitting per-token events is a significant gas optimization and makes the event log cleaner for watchers.

### 4. Batch Lifecycle State Machine
**Approved.** The `accumulating -> sent -> confirmed/failed` lifecycle is robust. Archiving to `batchHistory` provides necessary auditability for the frontend.

## ⚠️ Implementation Notes

1.  **Hanko Witness Lookup:** Ensure `runtime.ts` correctly handles the case where `hankoWitness` might be missing (e.g., if the node restarted between COMMIT and post-save). The batch should probably remain in `accumulating` (or a `signing_failed` state) if the signature is lost, rather than crashing.
2.  **Legacy Compatibility:** Verify that `rawEventToJEvents` can handle *both* old and new event formats during the migration phase, or ensure a clean break (redeployment). Given "Mainnet-Level" title, assume clean break/redeployment is acceptable.

## 🎯 Verdict
**Status:** ✅ **APPROVED**

Proceed with Phase 1 (Solidity) immediately.
