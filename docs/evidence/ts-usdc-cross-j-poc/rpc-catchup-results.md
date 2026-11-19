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
