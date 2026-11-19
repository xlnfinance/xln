# 12: Restore the original funded PoC Runtimes

Type: implementation
Category: bug
Completed: no
Status: ready-for-human
Blocked by: 09 - Start and restore funded PoC Runtimes without replacing identities or state

## Problem

Ticket 11's six authorized public transactions are confirmed. The source/target
Hub reserves contain 1/5 USDC and their signer wallets received 0.001/0.0001 ETH.
No additional prefunding is required to resolve this blocker.

The original Hub/MM Runtimes have not yet committed authenticated observations
of those deposits. Retained attempts encountered unavailable historical state
proofs, upstream 429 responses and batch timeouts, then stopped during catch-up.
The protected archive supplied the tested old proof. One null deployment-receipt
response does not establish that receipts generally require archive state.

Owner decision, 2026-11-17: record this separate RPC blocker, keep ticket 11
open, and incur no new expenses. No RPC subscription purchase, new financial
transfer or user journey is authorized by this ticket.

Owner decision, 2026-11-17: narrow this ticket to restoring the original funded
PoC Runtimes. General RPC capacity and synchronization optimization are outside
its completion criteria. Discuss the execution approach below before proceeding;
this scope update does not start a Runtime or change financial authority.

## Acceptance criteria

- [ ] Restore the original Hub/MM vaults and stores through ticket 09, without
      conflicting owners. Stop their Runtime owners before changing RPC bindings.
      Keep the gateway read-only and the user store unchanged.
      Explicitly bind existing RPCs with the historical-proof and receipt
      capabilities required by the canonical restore path; retain chain IDs and
      endpoint fingerprints without keys.
- [ ] Complete authenticated catch-up for these Runtimes. Record initial/final
      committed and authenticated frontiers and the captured chain targets,
      distinguishing live scan progress from WAL commits. Preserve proof,
      finality and history-completeness checks. Never reset stores, skip history
      or substitute a latest balance query for authenticated observation.
- [ ] Commit authenticated observations of the 1/5-USDC Hub reserves to their
      original WALs and compare exact roots, Accounts, cached Hankos and ordered
      outbox across a subsequent restore. Keep the user store unchanged.
- [ ] Reconcile current backing, reserves/debts, six signer balances and funder
      nonces against the six existing receipts. Funding slots 106-108 / 30-32
      must not be reused or replaced with another deposit.
- [ ] Retain the public evidence and the applicable focused/full verification
      for the observation candidate, then return it to 11. Ticket 05 still owns
      executable quotes, exact user credit and complete journey/recovery gas.

## Execution approach

The [restore launcher](../../../docs/runtime/usdc-poc-session.md#what-startup-verifies)
starts Hub first and waits for authenticated catch-up and reserve readiness
before starting MM. The two-chain local funded restore passed with 43 assertions.
With the Hub port occupied, the regression caught MM starting on the old order
and verified that MM stays stopped with the new order. The `--hub-only` local
check also verified a managed read-only gateway and a single Hub process.
Both operators must subsequently work together and restore through the canonical path.

Use existing RPC access first. Observe whether the gap shrinks before choosing
an implementation change. If a concrete transport failure prevents progress,
fix only that first boundary, add its owning regression and repeat the restore
artifact. Queue cancellation, deadlines or pacing are conditional fixes, not
mandatory deliverables to implement in advance. Preserve availability errors
and canonical stalled-drain behavior.

If the approach cannot progress, report the first failure and measured
frontiers for discussion. Do not broaden this ticket into a capacity project.

## Out of scope

Deferred candidates and their verification constraints are recorded in
[RPC catch-up optimization ideas](../../../docs/runtime/rpc-catchup-optimization.md).
They do not expand this ticket's acceptance criteria.

- Generalized throughput targets, large-scale RPC benchmarks or a new RPC plan.
- Fast sync, re-anchoring existing WAL state or changing restore trust guarantees.
- A shared history service or redesign of the two complete header observations.
- New funding, user deposits, Cross-J execution or public payouts.

## Evidence and boundaries

- [Public RPC catch-up results](../../../docs/evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md)
  records the profile comparison, rate-limit sources, WAL progress and startup
  budget calculation.
- [Executed operator funding](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson):
  six canonical receipts, at least twelve confirmations each, final funder nonces
  109 / 33, and identified before/after accounting.
- [Archive proof capability](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-rpc-capability.json):
  the original Arbitrum MM frontier is block 329895119. The protected archive
  supplies its verified proof; the original public Runtime endpoint does not.
- [Public endpoint capabilities](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-publicnode-capability.json):
  old headers match the independent reference, but Ethereum proof distance and
  Arbitrum historical-state restrictions prevent using them for old proofs.
- [Runtime attempt](../../../docs/evidence/ts-usdc-cross-j-poc/operator-funding-runtime-public.json):
  exact original store paths and the first incomplete observation boundary.
- [Hub-only diagnosis](../../../docs/evidence/ts-usdc-cross-j-poc/hub-only-public-diagnostic.json):
  stood up the original Hub alone, then stopped at the canonical watcher stall
  after 86 seconds. Both committed J cursors stayed at their original heights.
  The header endpoints returned 30 upstream HTTP 429 responses (16/14), and the
  watcher logged 5-second batch timeouts. No MM or user process was started.
  The only new Hub WAL frame was `importJ`; no funded reserve event was admitted.
  A longer timeout alone would not address the observed stall.
- [Gateway timing](../../../docs/evidence/ts-usdc-cross-j-poc/hub-header-queue-timing.json):
  39 of 74 range batches were sent after observed client cancellation. The
  median slot wait was 6253 ms. Both authenticated frontiers remained unchanged.
  This trace established the stale-dispatch boundary.
- [Queue cancellation retest](../../../docs/evidence/ts-usdc-cross-j-poc/hub-header-queue-after-cancel.json):
  36 batches were cancelled before dispatch and 0 of 62 were sent after the
  caller cancelled. Median slot wait among admitted batches was 611 ms. The
  original Hub still stalled without advancing either cursor. Public header
  endpoints returned 23 HTTP 429 responses. The Ethereum history RPC also
  returned JSON-RPC 429 for `eth_getBlockReceipts` during catch-up.
- [Paced Hub run](../../../docs/evidence/ts-usdc-cross-j-poc/hub-paced-rpc-public.json):
  existing history RPCs returned 39 receipt replies without a rate limit at
  one-second dispatch intervals per endpoint. The current header bindings still
  returned 22 HTTP 429 responses in 65 range batches at 500 ms intervals. The
  session ran out of its startup budget before confirming a funded reserve.
- [Endpoint comparison](../../../docs/evidence/ts-usdc-cross-j-poc/rpc-endpoint-comparison.json):
  Ethereum ethPandaOps passed all sampled headers, the original state proof and
  three receipt blocks. The Arbitrum official RPC served the three 32-header
  batches and both receipt blocks, then rejected the 128-header batch with HTTP
  429. The protected history RPC passed the old state proof on both chains.
  These serial samples establish capability at specific blocks and batch sizes.
- [Small-range Hub diagnosis](../../../docs/evidence/ts-usdc-cross-j-poc/hub-small-range-public.json):
  ethPandaOps Ethereum headers, Arbitrum PublicNode headers, 31 new blocks per
  page and the existing read pace completed 4 Ethereum and 24 Arbitrum ranges
  with no observed 429. Both networks recorded `observeJRange` in the original
  WAL. The funded deposit blocks are still ahead of the saved local scans.
- [Per-chain page and pace comparison](../../../docs/evidence/ts-usdc-cross-j-poc/hub-faster-profile-public.json):
  both 124-second attempts used the same RPC bindings, 31/127-block page limits
  and sequential batches capped at 32 headers. At 250/500 ms header/receipt
  intervals, the gateway saw 25 rate-limit replies. At 500/1000 ms it saw three
  Arbitrum header rate limits. The latter run authenticated 124 Ethereum and
  1,288 Arbitrum blocks from the original Entity-certified cursors, up from
  124 and 744 in the small-range run. The two attempts added 544 new Arbitrum
  blocks and zero Ethereum blocks to the original WAL. Both stopped at the
  startup deadline before observing either funding deposit.
- [Official Arbitrum RPC follow-up](../../../docs/evidence/ts-usdc-cross-j-poc/hub-official-arbitrum-rpc-public.json):
  the 250/1000 ms header/receipt profile authenticated 1,010 Arbitrum blocks
  and 68 Ethereum blocks in 124 seconds. It encountered seven Arbitrum header
  HTTP 429s and four Ethereum receipt 429s. Both ranges stayed inside the
  restored local suffix. The run appended only `importJ` to the WAL and
  reached the Hub startup deadline.
- [Continuous run estimate](../../../docs/evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#continuous-run-estimate):
  the best short-run rate projects about 8.8 hours for Hub and another 11.8
  hours for MM. This scenario uses each Runtime's fixed startup target and
  the observed head growth before MM starts. A one-hour Hub-only measurement
  fits the current launcher budget and can test the throughput assumption.

The source Hub frontier was 12149976 and the Arbitrum Hub/MM frontiers were
329895132 / 329895119 in the retained attempts. The source EntityProvider
deployment block is 12128807. Capture fresh head/finalized frontiers when
resuming; these numbers are identified historical observations, not cursors to
write into state.

The [current verification artifact](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-observation-verificationjson)
retains 54 passing owning tests / 300 assertions, including four real-node
financial scenarios, and the final green aggregate check (3 short, 38 source,
10 soundcheck gates; frozen core unchanged). The exact candidate binding also
records the subsequent test-only serializer correction and its seven green tests.
These private results do not close the public restore acceptance criteria.

Existing gateway backpressure and availability classification remain in place.
The queue removes cancelled waiters and checks cancellation again before
dispatch. After the earlier RPC-only comparison the saved local scan was
6,095 Ethereum blocks and 282,310 Arbitrum blocks short of the deposits.
With 32 calls per batch, a 500 ms interval and two full header observations,
the Arbitrum ceiling was 32 authenticated blocks/s before overhead. At that
rate, the remaining Arbitrum blocks alone required at least 2 h 27 min,
beyond the two-hour startup budget at the time. Both runs reauthenticated
the retained local suffix before extending the Arbitrum scan. The canonical
stalled-drain guard applies throughout startup.

## Dependency note

This ticket depends on the completed restore implementation in 09, not on
completion of 11. The funding portion of 11 already exists as immutable receipt
evidence. Ticket 11 waits for this ticket's observation proof; there is no
dependency cycle and no authority to repeat funding.

## Comments

The owner selected the narrower scope, then approved implementing and locally
verifying sequential Hub/MM startup. Public catch-up remains pending under the
existing authority and spending limits.

The 2026-11-18 original Hub run used HyperSync JSON for Arbitrum headers
and HyperRPC for Ethereum receipts. It authenticated 8,185 Arbitrum and
228 Ethereum blocks in 170.275 s. The Arbitrum WAL scan advanced 5,889
blocks with zero certified cursor advances. The Hub reached its readiness
deadline. MM and user stayed stopped. The fresh Arbitrum backlog requires
about 82.4 blocks/s to fit the two-hour startup cap. This run measured
48.1 blocks/s. The next restore decision is a longer continuous budget
or a verified faster profile under the existing budget.
[Original Hub resume evidence](../../../docs/evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#original-hub-with-hypersync-headers-and-hyperrpc-receipts)

The owner selected a continuous run with the existing RPC profile. At
17:54:50 UTC on 2026-11-18, the workstation started the managed read-only
operators-only session. Hub and MM each have a six-hour readiness
budget. The outer stand lease is capped at 12 h 5 min. Startup
inspection restored Hub at WAL frame 70 and MM at frame 29. The
two-chain local restore verification passed 43 assertions, including
a normal launcher start with the six-hour budget. Public operator
readiness, funded observations and exact subsequent restore are pending.
Local launcher log `.logs/ts-usdc-cross-j-poc/public/sessions/ticket-12-continuous-Ve43cB/launcher.log`.

The owner stopped the run at 18:09:56 UTC and deferred ticket 12.
The stand was released. At Hub WAL frame 96 the saved scan reaches
Ethereum block 12,151,302 and Arbitrum block 329,929,917.
The Entity-certified cursors are 12,149,976 and 329,895,132. MM stayed
at WAL frame 29. The funded reserve observations and subsequent
exact-restore evidence remain outstanding. Resume only when the owner
reopens the work.
[Stopped session evidence](../../../docs/evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#continuous-hubmm-run-stopped-by-the-owner)
