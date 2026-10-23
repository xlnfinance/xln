# Hub shutdown quiesce with an offline peer's pending Account frame (2026-10-23)

Base SHA: `f8de82c2371eb56670241f3b41855daa88473bf4`. Production boundary: the public
rollout of `a5075ad87` failed with H1 `NODE_RUNTIME_QUIESCE_FAILED:work_drain_timeout`
(`quiesce.post_failed`, `shutdown failed:`) because H1 held one signed Account
`pendingFrame` for an offline user whose committed output was retained undelivered.

## Cause

`waitForRuntimeWorkDrained` blocks on any `ACCOUNT_WORK_PENDING` Account. That is
required while an ACK can still arrive (wallet lock keeps transport alive for it),
but an Account whose committed `accountInput` is still in `pendingNetworkOutputs`
has not reached its peer, so no ACK can be in flight. The node drain waited for
an event that cannot happen before reconnect.

## Change

- `RuntimeDrainOptions.parkUndeliveredPeerFrames` (loop-drain.ts): an Account with a
  `pendingFrame` whose own `fromEntityId:toEntityId` accountInput is retained in the
  committed outbox is parked; every other queued/pending Account, Entity mempool,
  proposal, locked frame and in-flight input still blocks.
- Only `quiesceNodeRuntime` (WAL-backed hub/MM node shutdown, control quiesce and
  checkpoint) sets it. Wallet lock (`suspendRuntimeActivity`) is unchanged.
- No protocol, WAL format, ACK, timeout or financial change.

## Evidence (scenario `hub-quiesce-offline-peer`, real sockets, real anvil, 3 Runtimes)

1. Active peer: proposal delivered, Alice not yet run → wallet drain `false` and node
   drain `false` for 600 ms; the real ACK then commits height 3 exactly once.
2. Offline peer: Hub signs height 4, retained for Alice. Wallet drain still `false`.
3. Production `quiesceNodeRuntime(workTimeoutMs 10 s)` succeeds; signed frame bytes,
   whole outbox and Runtime height 8 unchanged.
4. Close + reopen from checkpoint + ordered WAL: height 8, exact signed `pendingFrame`
   bytes, whole outbox byte-equal to the outbox committed with frame 8 (5074 B).
5. First restored writer tick applies the committed local wake exactly as live did;
   whole outbox then byte-equal to the live pre-shutdown outbox (4804 B), no frame.
6. Reconnect: Hub commits the original frame, both sides at height 4, deltas agree,
   exactly 1 unit moved, no socket failures.

Earlier comparison (run l2-01) failed by design-mismatch, preserved: the live outbox
was read after a non-advancing tick retired the committed payload-less self wake
(`frame/intake/finalize.ts` skips the empty frame; `reducer.ts` retires the applied
local output in RAM), while the WAL holds the outbox as of the committed frame.
Both points are now compared whole and exact; no output is filtered.

Open, not fixed here: `resolveRuntimeWorkReason` does not count a restored committed
local output as work (`canDeliverCommittedOutput` is false for the own Runtime), so
it is applied on the next writer tick, not proactively. It stays durable in the WAL
outbox until applied.

| Run | Seed file | Result | Wall |
|---|---|---|---|
| l2-01 | l2-01.seed | FAIL whole outbox (live-after-tick vs committed) | 27.1 s |
| l2-02 | l2-02.seed | FAIL drained check without writer tick | 26.0 s |
| l2-03 | l2-03.seed | PASS | 26.3 s |
| l2-04 | l2-03 seed repeated | PASS identical line | 26.2 s |

L1: node-runtime-quiesce, runtime-consensus-drain, runtime-scheduled-wake,
mesh-common-queued-work: 40/40 pass, 143 expects, 6.6 s. `check:runtime-types` pass.
Raw logs: `/Users/zigota/agent-jobs/xln-claude-e2e-20261023/hub-quiesce-offline-peer-20261023/`.
