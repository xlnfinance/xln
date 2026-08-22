# HLT dead-zone probe: root cause (2026-08-23)

Branch `fix/radapter-oversized-read-storm`, commit `c9ec6ddca`.
Probe of the dead zone described in §2 of `hlt-throughput-report-2026-08-22.md`.

## 1. Hypothesis (disproven)

> Lane-daemon event-loop congestion during simultaneous route/gossip warm-up.

## 2. Method

200u payments run (30s, 1 action/user/s, 6000 payments total) with three
profiling env vars forwarded end-to-end:

- `XLN_RUNTIME_FRAME_LOG=1` → hub child (per-frame mempool depth, tx count, timing)
- `XLN_ACCOUNT_PROPOSAL_PROFILE=1` → lane daemons (per-proposal validateTxs/stateRoot/proof timing)
- `XLN_ENTITY_FRAME_PROFILE=1` → lane daemons (per-entity-frame consensus timing)

Causality test: `XLN_HLT_SUBMIT_RAMP_MS=500` spreads the t=0 `Promise.all`
burst across 500ms instead of firing 200 submissions simultaneously.

## 3. Evidence

| Signal | Value | Conclusion |
|---|---|---|
| Hub mempool at h=334 | 129 entity inputs queued | Hub is NOT starved — it has work |
| Hub frame processing (78 frames, >1 inputs) | avg 191ms, total 14.9s | Hub is the bottleneck |
| Hub `apply` phase per frame | 193–376ms | Dominated by per-ACK consensus |
| Hub `save` phase per frame | 68–94ms | Frame encode + WAL |
| Hub txKinds during dead zone | 100% `accountInput:frame_ack` | Processing bilateral ACKs, not payments |
| Daemon proposal processing (1826 proposals) | avg 0.6ms | Daemons are 300× faster than hub |
| Daemon frame processing (30 htlcPayment txs) | 10–12ms per frame | Daemons are NOT congested |

Hub frame log excerpt (H1, payment phase):

```
h=334 ms=238  inputs=1   mempool=129  txs=1   txKinds={accountInput:frame_ack: 1}
h=335 ms=176  inputs=137 mempool=64   txs=137 txKinds={accountInput:frame_ack: 136, scheduledWake: 1}
h=336 ms=62   inputs=64  mempool=1    txs=64  txKinds={accountInput:frame_ack: 63, scheduledWake: 1}
h=337 ms=107  inputs=1   mempool=1    txs=1   txKinds={scheduledWake: 1}
h=338 ms=154  inputs=1   mempool=31   txs=1   txKinds={scheduledWake: 1}
h=339 ms=172  inputs=31  mempool=1    txs=31  txKinds={accountInput:frame_ack: 30, scheduledWake: 1}
...
h=360 ms=513  inputs=123 mempool=1    txs=123 txKinds={accountInput:frame_ack: 122, scheduledWake: 1}
```

Mempool is non-empty throughout the dead zone. The hub has work; it processes
it one frame at a time at ~191ms per frame.

## 4. Causality test (staggered 500ms ramp)

| Metric | No ramp (simultaneous) | 500ms ramp | Change |
|---|---|---|---|
| Dead zone | ~8.7s | ~6.4s | −27% |
| Final TPS | 199.1/s | 220.4/s | +11% |
| Delivery time | 30.1s | 27.2s | −10% |

Staggering reduced but did NOT eliminate the dead zone. This confirms the
bottleneck is hub-side frame processing, not daemon-side congestion.

## 5. Root cause

```
200 daemons submit payments simultaneously
  → each generates 1 account proposal to hub
  → hub processes proposals, sends 200 account frames back
  → 200 daemons ACK simultaneously
  → ~129 ACKs arrive at hub in a burst
  → hub processes ACKs at ~191ms per frame
  → ~8.7s to drain the initial backlog
```

The dead zone is the hub's bilateral consensus ACK processing backlog.
Daemons are fast (0.6ms per proposal); the hub is slow (191ms per frame).

## 6. Implication for levers

The dead zone fix is NOT daemon-side. Two paths:

1. **Reduce hub per-frame processing time** — Lever 2 (batch sig verification).
   The `apply` phase (193–376ms) is dominated by per-ACK ECDSA recovery.
   Batch verification would reduce per-frame cost directly.

2. **Increase hub frame batching** — Lever 4 (frame-cut bistability).
   Fat frames amortize per-frame fixed costs over more ACKs. If the hub
   drains 129 ACKs in 5 fat frames instead of 30 thin frames, the dead
   zone shrinks proportionally.

The staggered ramp (`XLN_HLT_SUBMIT_RAMP_MS=500`) provides a modest 11%
TPS gain as a harness-level optimization with zero consensus risk.

## 7. Instrumentation committed

| Commit | Content |
|---|---|
| `c9ec6ddca` | `XLN_RUNTIME_FRAME_LOG` forwarded smoke → orchestrator → hub child; `XLN_ACCOUNT_PROPOSAL_PROFILE`/`XLN_ENTITY_FRAME_PROFILE` forwarded to lane daemons; `XLN_HLT_SUBMIT_RAMP_MS` staggered submission ramp |
