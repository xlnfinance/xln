# 04: Recover the interrupted financial journey without duplicate effects

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: 03 - Cover the target claim and withdraw at least 0.85 USDC

**What to build:** demonstrate that the same headless financial journey survives
process interruption, reconstructs accepted work from production storage and
reaches the correct financial outcome. The operator can distinguish successful
completion from canonical recovery of a remaining obligation.

## Acceptance criteria

- [x] Reuse the real-node journey from ticket 03 with production durable
  checkpoint, Runtime WAL and committed outbox behavior.
- [x] Exercise named interruption points before and after partial fill and
  reveal. Retain the exact committed amounts, signed deadlines and first
  unfinished financial boundary at each interruption.
- [x] Restore from the canonical checkpoint plus ordered Runtime WAL and
  redeliver the committed outbox in its canonical order. Reports, sidecar
  queues or a second financial state representation are not recovery authority.
- [x] Verify duplicate delivery and restart preserve exact financial amounts.
  Include in-flight deposit, cover-fee and withdrawal effects in the recovery
  assertions so an accepted operation cannot be charged or executed twice.
- [x] Complete recoverable full-execution cases with the same external-payout
  and terminal-state criteria as ticket 03, using the original accepted source
  deposit rather than starting another financial attempt.
- [x] Exercise existing clear/dispute for the exact remainder when expiry or
  an interrupted route requires it. Preserve executed amounts and identify the
  recovery result separately; cancellation or an outstanding claim is not a
  successful full-source PoC.
- [x] Keep deadline/reveal semantics canonical and account for advancing chain
  time while processes are stopped. Assert no new recovery-time guarantee or
  pause of either chain's deadlines.
- [x] Retain the smallest meaningful interruption/idempotence regressions and
  recorded owning verification evidence for the executable candidate. Follow
  the repository's stand and verification policies.

## Verification

Completed locally on 2026-11-16. The [recovery matrix report](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#interrupted-recoveryjson)
retains three isolated real-node cases and eight SIGKILL/restore pairs. Each
case keeps its original user vault, accepted one-USDC deposit and canonical
stores across all of its process replacements. Every restored Runtime matches
the pre-crash Runtime/Entity hashes, Account heads and cached Hanko, and ordered
outbox digest. Production loading also verifies the complete persisted post-state
and each replayed frame from checkpoint plus ordered WAL.

Four cuts cover deposit acceptance, prepared Cross-J admission, the prepaid
cover fee and accepted withdrawal. Two cuts cover half-size book execution and
the later full hash-ladder close. Two cover partial execution through signed
book TTL expiry and the partial close. The final matrix committed 17 repeated
signed Account inputs (ACK and proposal), preserving complete positional cohorts.
The two full cases externally paid 899,801 and 899,900 units. Source E2R/R2C
nonces remain exactly 2 and target C2R/R2E nonce exactly 1; seven receipts per
full case and native payer balances reconcile without duplicate effects.

The clear case is classified separately: 499,993 source collateral units and a
500,007-unit target claim remain, without open user Pulls or pending bilateral
ACK. Its book execution was 500,000; the signed uint16 ratio projects the claim
to 500,007 under existing ladder authority. Both observations are retained.
Cancellation and this outstanding claim do not satisfy full-source PoC success.
Both chains advance while the user is stopped; no deadline extension or fresh
late Source-close authority is introduced. This demonstrates the existing clear
path, not a forced public L1 dispute after a missed deadline.

Recovery decisions read committed Account/request/settlement/J-batch amounts;
they do not recompute or charge the accepted fee from a later tariff. Twelve
closed stores and three private vaults are retained under the ignored job root.
Reports are observations, never a recovery queue or financial-state authority.

Final owning checks: 158 tests, zero failures, 1,793 assertions across 13 files,
including actual RPC process crashes after node acceptance/mining and before a
durable result. Final `bun run check`: 3 short gates, 38 source gates and 10
soundcheck gates passed, including frozen-core and runtime types. The report
binds the dirty base SHA to 22 source/test hashes. No commit or public financial
execution is claimed. See the [operator guide](../../../docs/runtime/usdc-poc.md)
for the complete reproducible command and scope.
