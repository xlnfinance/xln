# MVP checklist — top 10

Status: **pre-MVP**. Runtime scenarios pass (BrowserVM). No E2E on real chain.

Last verified: 2026-02-16. Baseline commit: `7e199a46`.

---

## 1. Contract integration tests (BLOCKER)

Account.sol + Depository.sol were rewritten in `c5762313` ("new-ops").
Contracts compile but `Depository.integration.ts` is **describe.skip** with TODO
"Update to current Depository API". No test covers `unsafeProcessBatch` with
settlements, disputeStarts, disputeFinalizations on current ABI.

**Exit:** `bunx hardhat test` — all green, covers: deposit, R2R, settle batch,
dispute start, dispute finalize, counter-dispute.

**Current:** FAIL (integration tests skipped)
**Files:** `jurisdictions/test/Depository.integration.ts`, `jurisdictions/contracts/`

---

## 2. RPC settle E2E scenario (BLOCKER)

Settlement only tested on BrowserVM. No scenario runs settle_execute →
j_broadcast → JAdapter.submitTx() → anvil chain → event back → workspace clear
on a real RPC provider.

**Exit:** `bun runtime/scenarios/settle.ts --rpc` or equivalent — passes on
local anvil. Propose → approve → execute → on-chain event → holds released.

**Current:** FAIL (no RPC settlement scenario exists)
**Files:** `runtime/scenarios/settle.ts` (BrowserVM only), `runtime/jadapter/rpc.ts`

---

## 3. Dispute E2E scenario (BLOCKER)

dispute.ts handlers are implemented (start, finalize, counter-dispute) but
there's no scenario that exercises the full force-close path:
entity goes offline → counterparty starts dispute → timeout → finalize → funds.

**Exit:** dedicated scenario — unilateral dispute + counter-dispute both green.
On BrowserVM first, then RPC.

**Current:** FAIL (no dispute scenario, cooperative mode is stub)
**Files:** `runtime/entity-tx/handlers/dispute.ts:128-402`

---

## 4. Nonce / replay safety audit (BLOCKER)

Batch replay on-chain is the #1 fintech risk. Need to verify:
- Nonce increments correctly after each batch
- Replayed batch reverts on contract
- Signature covers nonce + all ops (no partial replay)
- Hash→nonce map in dispute.ts:202 is consistent

**Exit:** hardhat test that submits batch, replays it, gets revert.
Plus: scenario that verifies nonce increment after settle.

**Current:** UNKNOWN (no explicit test)
**Files:** `runtime/j-batch.ts`, `jurisdictions/contracts/Depository.sol`

---

## 5. Hub restart recovery (HIGH)

Server has `POST /api/reset` with `preserveHubs=1` but no automatic
crash recovery. PM2 restarts process but env state is lost unless
explicitly saved. `loadEnvFromDB` exists but unclear if it works
after unclean shutdown.

**Exit:** kill -9 hub process → PM2 restarts → hub reconnects to peers →
pending payments drain → no silent fund loss.

**Current:** PARTIAL (manual reset works, automatic crash recovery untested)
**Files:** `runtime/server.ts:769-896` (resetServerDebugState)

---

## 6. Hub soak test (HIGH)

Hub needs to run for hours under load without:
- Memory leaks (gossip spam, growing mempools)
- Silent message drops (relay disconnect → reconnect → queue flush)
- State drift between bilateral peers

**Exit:** 4-hour soak with periodic payments. Zero dropped payments,
zero consensus failures, stable memory.

**Current:** FAIL (never tested)
**Files:** `runtime/server.ts`, `runtime/networking/`

---

## 7. Multi-token collateral (MEDIUM)

Hardcoded `tokenId = 1` in:
- `server.ts:1877` (faucet default)
- `entity-tx/apply.ts:377` (openAccount default)
- Collateral sync (MEMORY: runtime.ts:~1340)
- All scenarios use `const USDC = 1`

MVP can ship USDC-only with explicit limit, but the hardcoding must
be documented and guarded (reject tokenId != 1 at API boundary).

**Exit:** either multi-token works, or single-token is enforced with
clear error if user tries tokenId != 1.

**Current:** PARTIAL (works for USDC, silent failure for others)

---

## 8. stateRoot per jReplica on RPC (MEDIUM)

BrowserVM captures stateRoot per snapshot. RPC adapter doesn't
(`JReplica.stateRoot` initialized to zeros). This breaks time-travel
debugging and dispute proof verification on real chains.

**Exit:** RPC JAdapter captures block-level state commitment after each
batch. Dispute proof includes correct stateRoot.

**Current:** FAIL on RPC (zeros), OK on BrowserVM
**Files:** `runtime/runtime.ts:1356`, `runtime/jadapter/rpc.ts`

---

## 9. Gossip baseline polling (MEDIUM)

Gossip polling disabled → stale crypto keys → HTLC onion encryption
can't find peer keys → falls back to cleartext. For MVP, need at
minimum a 60s polling interval.

**Exit:** hub advertises cryptoPublicKey, peer picks it up within 60s,
HTLC uses encrypted onion (not cleartext fallback).

**Current:** FAIL (polling off, cleartext fallback)
**Files:** `runtime/networking/gossip-helper.ts`

---

## 10. Minimal UX pass (LOW)

Current frontend works for: connect → faucet → send → view bar.
Missing for MVP demo: settlement status in UI, dispute initiation
button, clear "funds on chain" confirmation.

**Exit:** user can do connect → fund → send → settle → see "settled"
status → verify on-chain balance. No extra polish needed.

**Current:** PARTIAL (send works, settle UX incomplete)

---

## Summary

| #  | Item                        | Status   | Severity |
|----|-----------------------------|----------|----------|
| 1  | Contract integration tests  | FAIL     | BLOCKER  |
| 2  | RPC settle E2E              | FAIL     | BLOCKER  |
| 3  | Dispute E2E scenario        | FAIL     | BLOCKER  |
| 4  | Nonce/replay audit          | UNKNOWN  | BLOCKER  |
| 5  | Hub restart recovery        | PARTIAL  | HIGH     |
| 6  | Hub soak test               | FAIL     | HIGH     |
| 7  | Multi-token collateral      | PARTIAL  | MEDIUM   |
| 8  | stateRoot on RPC            | FAIL     | MEDIUM   |
| 9  | Gossip polling              | FAIL     | MEDIUM   |
| 10 | Minimal UX                  | PARTIAL  | LOW      |

**Order of attack:** 1 → 4 → 2 → 3 → 5 → 6 → 7-10 in parallel.
Contract tests and nonce audit first — if the L1 layer is wrong,
nothing above it matters.
