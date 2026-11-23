# Public RPC catch-up results for the TS USDC PoC

The original Hub authenticated **1,288 Arbitrum Sepolia blocks in 124 seconds**
with a 127-block page limit and the original dispatch intervals. The 31-block
baseline authenticated 744 blocks in the same time. Ethereum Sepolia remained
at 124 blocks. Both tuning runs reached the startup deadline before the Hub
observed the confirmed 1 USDC Ethereum and 5 USDC Arbitrum deposits.
[Raw measurements and WAL frames](hub-faster-profile-public.json) · [Local funding receipt record](local-evidence.md#operator-funding-publicjson)

## What restore reads

1. The watcher reads each block header in a range plus the preceding header.
   It checks continuity and reads the full header range again after reading
   receipts to detect a chain change during the scan.
2. When a block's `logsBloom` indicates possible activity at a watched
   address, the watcher reads the block's receipts and verifies them against
   the `receiptsRoot` in its header. Receipts were the main cost on Ethereum
   Sepolia during the measured runs.
3. Cold restore also verifies old contract storage with `eth_getProof` against
   the historical header's `stateRoot`. The existing protected archive supplied
   the tested proof at Arbitrum block 329895119. Historical headers, receipts
   and historical state proofs are separate RPC capabilities.

[Header and receipt verification](../../../core/jurisdiction/adapter/receipt/reader.ts#L419) · [Historical state proof probe](operator-funding-rpc-capability.json)

## Public measurements

The three Hub-only runs on 2026-11-17 UTC used a managed read-only gateway and
the original Hub store. Header bindings were ethPandaOps for Ethereum Sepolia
and PublicNode for Arbitrum Sepolia. The gateway used the existing protected
history bindings for receipts. Each run lasted about 124 seconds, with at most
32 header calls per batch. The counts include reauthentication of previously
stored scan evidence.

| Page limits ETH / ARB | Header / receipt interval | Authenticated ETH / ARB blocks | New ETH / ARB WAL blocks | Upstream 429 replies |
| --- | --- | ---: | ---: | ---: |
| 31 / 31 | 500 / 1000 ms | 124 / 744 | 124 / 490 | 0 |
| 31 / 127 | 250 / 500 ms | 85 / 1,170 | 0 / 414 | 25 |
| 31 / 127 | 500 / 1000 ms | 124 / 1,288 | 0 / 130 | 3 |

- At 250/500 ms, the gateway recorded 4 rate limits on Arbitrum header batches,
  3 on Arbitrum receipts and 18 on Ethereum receipts. Watcher backoff and smaller
  windows reduced useful throughput. At 500/1000 ms, all three rate limits were
  on Arbitrum header batches.
- The two 31/127 runs added 544 new Arbitrum blocks to the WAL. In the second
  run, 1,158 of the 1,288 authenticated Arbitrum blocks were already in the
  local journal. The watcher rebuilds dispute references and reauthenticates
  this local suffix from the Entity-certified cursor on restart. Ethereum's
  124 authenticated blocks were already stored.
- Both tuning runs recorded zero event blocks and zero Entity-certified cursor
  advances. MM and the user Runtime stayed stopped. The probes performed zero
  financial broadcasts and used existing RPC access. The tuning candidate
  passed 81 focused tests and `bun run check`.

[Baseline evidence](hub-small-range-public.json) · [Tuning evidence](hub-faster-profile-public.json) · [Restart behavior](../../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-poll.ts#L249)

## Official Arbitrum RPC follow-up

The follow-up used the official Arbitrum Sepolia endpoint for headers, a 250 ms
header interval and the 1000 ms receipt interval. It kept the same executable
candidate, 31/127-block page limits, 32-call batch cap, Ethereum header binding
and both protected history bindings. The 250 ms interval tested a profile
with enough theoretical headroom for the two-hour target.

- In 124 seconds, the original Hub authenticated 1,010 Arbitrum blocks
  (8.1 blocks/s) and 68 Ethereum blocks. The gateway recorded seven HTTP 429s
  on Arbitrum header batches and four 429s on Ethereum receipts. Arbitrum
  receipt reads completed without an observed 429.
- Both authenticated scans ended inside the restored local suffix. The WAL
  advanced from Runtime frame 58 to 59 with `importJ`. There were zero new
  scan blocks, funded observations, Entity-certified cursor advances or
  financial broadcasts. The Hub reached its readiness deadline.
- The tested profile fell below the roughly 40 blocks/s needed to reach the
  Arbitrum funding block in two hours. The best measured PublicNode profile
  remains 10.4 blocks/s. The runs used different dispatch intervals, so this
  comparison describes the tested profiles and their observed limits.

[Official endpoint reference](https://docs.arbitrum.io/chain-info#arbitrum-public-rpc-endpoints) · [Follow-up measurements and WAL](hub-official-arbitrum-rpc-public.json)

## Original Hub with HyperSync headers and HyperRPC receipts

On 2026-11-18 the session restored the original Hub at WAL frame 63
and ran for 170.275 s. The managed read-only gateway used HyperSync JSON
for Arbitrum header ranges, HyperRPC for Ethereum receipt batches, and
the protected archive for Arbitrum receipts and historical state reads.
The Hub reached its 165 s readiness deadline. The supervisor shut it
down, released the stand, and left the MM and user stores closed.

| Chain | Authenticated blocks | Live scan through | WAL scan before | WAL scan after | Entity-certified cursor |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ethereum Sepolia | 228 | 12,150,204 | 12,150,100 | 12,150,100 | 12,149,976 |
| Arbitrum Sepolia | 8,185 | 329,903,317 | 329,897,428 | 329,903,317 | 329,895,132 |

WAL frames 64–70 contain one `importJ` and six `observeJRange`
transactions. The Arbitrum observations extended the durable local scan
by 5,889 blocks, with zero event blocks and zero certified cursor advances.
The Ethereum gain remained in the live scan. Both original Hub funding
blocks are ahead of the recorded scans.

The gateway recorded zero 429s, 20 successful HyperSync pages and 67
archive receipt replies. Twelve HyperRPC batches returned receipts for
203 Ethereum blocks. One Ethereum HyperRPC batch reached its 10 s
deadline. One Arbitrum HyperSync range read returned a transport
availability error. Subsequent authenticated ranges completed on both
chains.

The fresh Arbitrum startup head sample was 330,488,495. From the
Entity-certified cursor, the two-hour budget requires approximately
82.4 authenticated blocks/s at confirmation depth two. This run
averaged 48.1 blocks/s including startup. At that rate the sampled
Arbitrum backlog alone projects to about 3 h 26 min for Hub. The MM
still has its own later startup target and recovery checks. A longer
continuous run needs an explicit launcher and stand budget sized for
the observed backlog.
[Session evidence and exact WAL frames](hub-hypersync-hyperrpc-restore.json)

## Continuous Hub/MM run stopped by the owner

The 2026-11-18 run started at 17:54:50 UTC and stopped on the owner's
request at 18:09:56 UTC after 905.693 s. The session selected the
original operator stores and a managed read-only gateway. Arbitrum used
HyperSync JSON for headers and the archive for receipts. Ethereum used
ethPandaOps for headers and HyperRPC for receipt batches. The launcher
allowed six hours per operator and 12 h 5 min for the outer stand lease.

| Chain | Last authenticated block | WAL scan before | WAL scan after | New WAL scan blocks | Entity-certified cursor | Funding block |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ethereum Sepolia | 12,151,407 | 12,150,100 | 12,151,302 | 1,202 | 12,149,976 | 12,156,195 |
| Arbitrum Sepolia | 329,929,917 | 329,903,317 | 329,929,917 | 26,600 | 329,895,132 | 330,178,730 |

The Hub WAL advanced from frame 70 to 96 with one `importJ` and 32
`observeJRange` transactions. The observations contained zero event
blocks and zero certified cursor advances. The MM WAL remained at
frame 29. Its startup inspection completed, and the MM Runtime stayed
stopped while Hub caught up. The user Runtime stayed stopped. The run
broadcast zero public transactions. The supervisor received SIGTERM and shut down
its children. The launcher recorded `USDC_SESSION_CHILD_EXIT:gateway:0:null`
as its gateway exited during shutdown. A post-stop inspection verified
the WAL frames and released the stand.

Measured from startup, the authenticated frontiers advanced by 1,431
Ethereum blocks and 34,785 Arbitrum blocks at 1.58 and 38.41 blocks/s
respectively. The gateway recorded 81 successful HyperSync pages,
513 archive receipt replies, and 57 successful HyperRPC receipt
batches. The logs show one 10 s HyperRPC batch timeout and one
reported HyperSync transport availability error. The recorded responses
include zero 429s.

The durable scan positions are 4,893 Ethereum blocks and 248,813
Arbitrum blocks short of the deposits. A later restore will reauthenticate
from the certified cursors and capture fresh chain targets. Completion
still requires Hub/MM readiness, both reserve observations in their
original Runtime WALs, and an exact subsequent restore. Local
verification covered the six-hour deadline with 43 assertions. The
[progress command](../../runtime/usdc-poc-session.md#observation-and-shutdown)
can read this stopped session's logs.
[Exact WAL frames and gateway counts](hub-mm-continuous-stopped.json)

Local launcher log `.logs/ts-usdc-cross-j-poc/public/sessions/ticket-12-continuous-Ve43cB/launcher.log`.

## Remaining work and the startup budget

The estimates below describe the earlier RPC-only profile and its
historical heads.

| Chain | Entity-certified cursor | Local WAL scan through | Funded deposit block | Blocks left from local scan |
| --- | ---: | ---: | ---: | ---: |
| Ethereum Sepolia | 12,149,976 | 12,150,100 | 12,156,195 | 6,095 |
| Arbitrum Sepolia | 329,895,132 | 329,896,420 | 330,178,730 | 282,310 |

- **Transport ceiling.** At 500 ms per batch and 32 calls per batch, the
  gateway can dispatch at most 64 header calls/s. Two header observations
  per block reduce the ideal ceiling to 32 authenticated blocks/s. The
  remaining 282,310 Arbitrum blocks alone take at least 2 h 27 min at that
  ceiling, before predecessors, receipts, audits, retries or restart work.
  The current launcher accepts a startup budget of at most two hours.
- **Measured pace.** The best short run averaged about 10.4 authenticated
  Arbitrum blocks/s. A linear extrapolation at that rate gives about 7.6 hours
  to the deposit from the saved local scan. The sample establishes only
  short-run throughput. Full startup and a subsequent exact funded restore
  are still pending.
- **Two-hour alternative.** An Arbitrum header binding would have to sustain
  about 40 authenticated blocks/s to reach the deposit, with additional
  headroom for the startup target. The four observed Ethereum receipt rate
  limits are a separate capacity consideration.

[Startup budget](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/config.ts#L73) · [Ticket 12](../../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md) · [Deferred optimization ideas](../../runtime/rpc-catchup-optimization.md)

## Continuous run estimate

Each Runtime captures its own startup target at `head - finalityDepth` once.
The Hub must scan to that target and settle pending financial finality. The
launcher waits for Hub delivery and reserve readiness before starting MM.
MM then captures a later target and reads history from its own cursor. The
fixed-target calculation therefore uses elapsed Hub time to estimate MM's
starting backlog.

Using the observed Arbitrum head of 330,223,707 on 2026-11-17 at 22:04 UTC and
the run's two-block finality depth, the Hub target would have been 330,223,705.
That is 328,573 blocks from its Entity-certified cursor, including the local
suffix rechecked on restart. Between the two most recent head probes, Arbitrum
advanced by 5,951 blocks in 28 min 10 s, about 3.52 blocks/s. The MM cursor in
the retained attempt was 329,895,119.

| Assumed Arbitrum rate per Runtime | Hub reaches deposit | Hub reaches startup target | MM catch-up after Hub | Total scan time |
| --- | ---: | ---: | ---: | ---: |
| 10.36 blocks/s, best Hub short sample | 7.6 h | 8.8 h | 11.8 h | 20.6 h |
| 8 blocks/s, slower scenario | 9.8 h | 11.4 h | 16.4 h | 27.8 h |

These scenarios assume a steady rate and the same MM throughput while Hub
stays live on the shared gateway. They exclude additional Ethereum delays,
startup work after the scan, downtime and the subsequent exact-restore check.
Refresh the head before estimating an actual run. The observed RPC limits and
separate MM workload leave the total duration unverified.

- A continuous run of this size needs a longer launcher startup budget and a
  stand timeout that spans both phases. The stand has one slot. The launcher
  currently caps the budget at two hours per readiness wait. The watcher
  separately fails after 60 seconds without a change in its progress
  fingerprint. Raising the launcher budget leaves that protection active.
- A one-hour Hub-only run fits the current budget and can test sustained
  authenticated and WAL progress at the best measured profile. At the short-run
  pace it would authenticate about 37,000 Arbitrum blocks. Record both
  frontiers and the response mix before deciding whether to reserve the stand
  for the longer run. Local WAL scan evidence can be rechecked on the next
  start until Entity finality advances the committed cursor.

[Target capture](../../../core/jurisdiction/adapter/operations/backlog-drain.ts#L35) · [Drain completion and stall guard](../../../core/jurisdiction/adapter/operations/backlog-drain-status.ts) · [Hub/MM startup order](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts#L185) · [Head samples](hub-faster-profile-public.json) and [follow-up head](hub-official-arbitrum-rpc-public.json)

## Ticket 15 retry with two Arbitrum header RPCs

On 2026-11-21, the read-only gateway restored the original Hub on
`ticket15-warm-FadKvT` using the working diff over `c77866445`. Numeric
Arbitrum header batches used PublicNode and the official Arbitrum Sepolia
RPC. HyperSync supplied bulk ranges. HyperRPC supplied Ethereum receipt
batches and the protected archive still supplied Arbitrum receipts and proofs.

The 2,047-block profile encountered an archive receipt timeout around a
Mac clamshell sleep. After a subsequent sleep and wake, its Arbitrum window
fell to one block. A retry with a 1,023-block cap reproduced the one-block
window while the Mac remained awake. It ran from 20:52:02 UTC until orderly
shutdown at about 20:55:40 UTC. The gateway recorded 15 successful numeric
header batches from the official RPC, 14 from PublicNode, 28 successful
HyperSync pages, and no observed HTTP 429s. The short diagnostic run below
reproduced and identified the trigger for the window reduction.

| Chain | Hub authenticated range | Blocks |
| --- | --- | ---: |
| Ethereum Sepolia | 12,182,771–12,183,266 | 496 |
| Arbitrum Sepolia | 331,408,841–331,410,362 | 1,522 |

The Arbitrum range began at the existing Entity-certified cursor plus one.
The initial gateway head sample was 331,470,525. Hub delivery readiness
stayed false, so MM and user passed offline restore inspection only. The
session ended with zero of three live Runtime ready and released the stand
lock. Post-stop verification checked 506 WAL frames and found zero signed
journey attempts and zero user Cross-J admissions. Both RPC paths confirmed
zero mined journey transactions, `0/0` latest/pending nonce for all three
payers, 1 USDC in the Ethereum Sepolia user wallet, and 1 USDC in the
Arbitrum Sepolia Hub reserve.

### First window reduction

A read-only Hub restore with temporary watcher instrumentation ran from
20:59:51 to about 21:00:15 UTC on 2026-11-21. Both failures occurred in
`verifyCanonicalState`, before the watcher selected a history range. The
gateway sent both numbered header batches to the official Arbitrum Sepolia
RPC. It had read the tip number from PublicNode.

| UTC | Missing tip height | Watcher error | Window after error | Backoff |
| --- | ---: | --- | ---: | ---: |
| 21:00:03.371 | 331,472,169 | `J_HISTORY_HEADER_MISSING`, `error=none` | 511 | 1 s |
| 21:00:14.132 | 331,472,207 | `J_HISTORY_HEADER_MISSING`, `error=none` | 255 | 2 s |

The watcher classified both errors as transient transport unavailability.
A 511-block history range authenticated between the failures. A separate
direct read reproduced the provider difference on three fresh heights:
331,472,365, 331,472,370 and 331,472,374. PublicNode returned all three
headers. The official RPC returned HTTP 200 with JSON-RPC `result: null`
for all three. Both sources returned the header two blocks behind each
sample, and agreed on the hashes 32 blocks behind each sample.

Keep the tip number and its canonical audit header on the same RPC.
Historical numeric header batches can retain the second source. This
diagnostic tested the failure and stopped at the second window reduction.
The stand released its lock. The post-stop check verified 507 WAL frames
with zero signed journey attempts and zero user Cross-J admissions.

[Header routing](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/arbitrum-header-rpc.ts) · [Missing header handling](../../../core/jurisdiction/adapter/rpc/rpc-chain-io.ts#L318) · [Window reduction](../../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-controller.ts#L164)

### Verification after routing the tip to the primary

The router shares numeric header batches below the verified common startup
block. Batches containing newer heights go to the primary that reports the
tip number. The regression test failed on the old router when a batch
included the common block, then passed after the routing change.

On 2026-11-21 at 21:12:41 UTC, the read-only gateway served tip 331,474,927
from PublicNode. The two RPC lanes returned the same hash for historical
block 331,474,799. The original Hub authenticated eight consecutive
1,023-block Arbitrum ranges, from 331,408,841 through 331,417,024, in 95 s
including startup. The trace recorded zero `J_HISTORY_HEADER_MISSING`
errors, zero poll window reductions and zero observed HTTP 429s. The gateway
recorded 11 numbered-header replies from PublicNode, two from the official
RPC and 16 successful HyperSync pages.

The smoke test stopped after the eighth range and released the stand lock.
It covered Hub catch-up. Full delivery readiness and the public journey
remain open. The post-stop check verified 508 WAL frames with zero signed
journey attempts and zero user Cross-J admissions.

### Parallel restore with shared RPC queues

On 2026-11-21, the owner stopped the sequential restore after Hub had
authenticated 50,127 Arbitrum blocks and requested concurrent startup of
Hub, MM and user. The parallel experiments used the original three WALs,
the same read-only gateway and one stand lock. A temporary local launcher
overlapped startup and retained each role's normal readiness checks.

1. With the original deadlines, all three roles authenticated their first
   Arbitrum range. Shared queue waits then caused 15 s range timeouts on
   Arbitrum and 30 s receipt timeouts on Ethereum. All three Ethereum
   windows fell to one block. The upstream logs showed no HTTP 429s.
2. With a 60 s local Ethereum receipt deadline, all three roles retained
   31-block Ethereum windows. In the sampled trace, 33 of 37 successful
   requests took more than 30 s including the shared queue wait. Arbitrum
   still hit its original 15 s range deadline.
3. With 60 s local client deadlines for both methods and a 45 s HyperSync
   gateway budget after admission, all three retained full scan windows.
   The original 4.5 s HyperSync and 12.5 s HyperRPC dispatch spacing
   remained in use. Of 184 Ethereum receipt replies, 176 exceeded the old
   30 s deadline including the queue. Of 429 successful Arbitrum range
   replies, 72 exceeded the old 15 s deadline. The run recorded zero
   watcher window reductions and zero upstream HTTP 429s.

The final experiment started at 21:53:35 UTC and ran for about 38 minutes.

| Runtime | Ethereum blocks | Arbitrum blocks | Last authenticated Arbitrum block |
| --- | ---: | ---: | ---: |
| Hub | 1,891 | 73,656 | 331,482,496 |
| MM | 1,891 | 79,794 | 331,485,573 |
| User | 1,922 | 65,472 | 331,471,306 |

MM completed its startup chain drain (Ethereum target 12,184,556,
Arbitrum target 331,483,516), then started Cross-J bootstrap while Hub
was still scanning. MM saw only Hub's Ethereum profile. After 60 s with
no bootstrap progress, MM exited with `MARKET_MAKER_BOOTSTRAP_STALLED`
in `bootstrap-cross`. The launcher stopped the session and forced the
user process to exit when its 10 s shutdown grace elapsed. The stand lock
was released. A follow-up parallel run needs to gate MM's quote bootstrap
on Hub delivery readiness and the required Hub profiles after the concurrent
chain scans have started.

Post-stop checks verified 702 WAL frames with zero signed journey attempts
and zero user Cross-J admissions. Both RPC paths agreed on zero mined
journey transactions, `0/0` latest/pending for all three payers, 1 USDC
in the source user wallet, and 1 USDC in the Arbitrum Hub reserve.

[MM startup](../../../core/orchestrator/market-maker/node/mm-node-run.ts#L2502) · [Session readiness](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts#L165)

### Full readiness after gating MM bootstrap on Hub routes

The managed launcher uses concurrent chain catch-up after Hub binds its API.
MM waits for authenticated delivery to both configured Hub Entities before
starting the quote bootstrap watchdog. The 60 s local gateway-read deadline,
45 s HyperSync admitted-range budget and 4.5 s HyperSync request spacing are
part of the launcher profile.

On 2026-11-21, the normal managed launcher restored `ticket15-warm-FadKvT`
with the working diff over `c77866445`. It used the original three WALs and
a read-only gateway. Startup finished in 3,021 s with all three Runtimes
ready. The observer recorded these milestones in UTC:

| Milestone | Time |
| --- | --- |
| MM completed local catch-up and waited for both Hub routes | 23:29:39 |
| User restored and connected to the relay | 23:30:16 |
| Hub completed catch-up, MM opened both routes and published `offers.ready` | 23:34:05 |

MM waited about 266 s before the quote watchdog started. The gateway
recorded 664 successful HyperSync pages and 243 successful HyperRPC
receipt replies, with zero observed HTTP 429s. Hub, MM and user readiness
were read from the running session before shutdown. The funded restore and
supervised financial scenarios passed on two local Anvil chains, and
`bun run check` passed on the working candidate.

After the readiness snapshot, user and Hub exceeded the 10 s shutdown
grace. The launcher forced their exit and returned code 1. Hub logged a
mesh producer pause timeout during cleanup. The stand lock was released.
Post-stop verification covered 776 WAL frames. It found zero signed
journey attempts and zero user Cross-J admissions. Both public RPC paths
confirmed zero mined journey transactions and `0/0` payer nonces. The
source user wallet and target Hub reserve each held 1 USDC at shutdown.

[MM route gate](../../../core/orchestrator/market-maker/node/mm-node-run.ts#L2407) · [Funded restore scenario](../../../core/__tests__/market/startup/usdc-funded-restore.test.ts)

### Owner stopped the authorized run on 2026-11-22

Run `ticket15-warm-fadkvt-1usdc-20261122` used clean commit
`7b92e63cc1084e01d169f33a9333d2ba72f3fc0b` and the original stand and WALs.
The unsigned manifest has SHA-256
`d6ec0e8834a6ad5309b7a210a09831aa80c8dccd1afae81de8560e8a4dc61727`
and is retained in the [local archive](local-evidence.md#ticket-15-earlier-attempts).
The clean candidate passed the funded restore, supervised financial
scenario and `bun run check` before the authorized launch.

Hub and MM reached readiness at 00:29:19 UTC. The owner stopped the stand
at 00:38 UTC while the financial CLI was restoring the user's history.
The user authenticated 22,506 Arbitrum blocks through 331,428,340 and 434
Ethereum blocks through 12,183,186. The stop occurred before the fresh
quote and first signature. The process group exited and released the
stand lock.

At 00:39:04 UTC, both RPC bindings confirmed zero mined journey calls and
`0/0` latest/pending for all three payers. The user wallet still held 1
USDC on Ethereum Sepolia, and the target Hub reserve still held 1 USDC on
Arbitrum Sepolia. Both user reserves and Account collateral were zero.
The offline integrity check verified 815 WAL frames with zero signed
journey attempts and zero Cross-J admissions. The
[later public proof](../../../.scratch/ts-usdc-cross-j-poc/issues/15-clean-candidate-public-proof.md#completed-public-proof-on-1ce560d95)
used a fresh stand.

### Public parallel recovery sample on 2026-11-22

The read-only session restored the original Hub, MM and user WALs for
`ticket15-warm-FadKvT` with one stand lock. The checkout was
`7b92e63cc1084e01d169f33a9333d2ba72f3fc0b` with the parallel startup
working changes. The standard operator launcher ran all three roles
without an execution authority. Both gateway routes rejected the
`xln_executionAuthority` probe. The first attempt stopped after a malformed
local timing probe. The measurements below come from the corrected attempt.

The sample ran from 13:56:45 to 14:02:02 UTC. The initial heads were
12,189,177 on Ethereum Sepolia and 331,693,688 on Arbitrum Sepolia. All
three Runtimes authenticated ranges at the same time.

| Runtime | Ethereum authenticated blocks | Arbitrum authenticated blocks |
| --- | ---: | ---: |
| Hub | 248 (12,182,771–12,183,018) | 11,253 (331,408,841–331,420,093) |
| MM | 248 (12,182,752–12,182,999) | 10,230 (331,405,780–331,416,009) |
| User | 248 (12,182,753–12,183,000) | 10,230 (331,405,835–331,416,064) |

The gateway recorded 67 successful HyperSync pages, 24 successful
HyperRPC batches and zero observed HTTP 429s in the sample. From seconds
145 to 317, the three consumers authenticated 403 Ethereum blocks and
19,437 Arbitrum blocks in aggregate. At those rates, the starting volumes
of about 19,258 Ethereum and 860,611 Arbitrum block observations project
to roughly 2 h 17 min and 2 h 7 min respectively. These are per-network
extrapolations with concurrent RPC queues.

With the configured 1,023-block windows, the initial Arbitrum volume takes
about 843 ranges across the three consumers. The receipt reader reads
the headers twice per range. At the 4.5 s HyperSync interval, dispatching
that volume alone takes about 2 h 6 min. I stopped the benchmark before
full readiness because that estimate exceeds the two-hour run budget.
The process group exited, the stand lock was released and no EVM
transactions were submitted.

This sample measures public RPC recovery throughput. The parallel
`execution run --stand` IPC barrier and its final user suffix check have
local Anvil evidence. Full public readiness and a same-WAL timing
comparison remain unmeasured.

[Header verification](../../../core/jurisdiction/adapter/receipt/reader.ts#L461) ·
[HyperSync pacing](../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/hypersync-headers.ts#L130)
