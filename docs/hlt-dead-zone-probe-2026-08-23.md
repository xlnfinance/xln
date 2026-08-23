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

| Signal                                       | Value                         | Conclusion                              |
| -------------------------------------------- | ----------------------------- | --------------------------------------- |
| Hub mempool at h=334                         | 129 entity inputs queued      | Hub is NOT starved — it has work        |
| Hub frame processing (78 frames, >1 inputs)  | avg 191ms, total 14.9s        | Hub is the bottleneck                   |
| Hub `apply` phase per frame                  | 193–376ms                     | Dominated by per-ACK consensus          |
| Hub `save` phase per frame                   | 68–94ms                       | Frame encode + WAL                      |
| Hub txKinds during dead zone                 | 100% `accountInput:frame_ack` | Processing bilateral ACKs, not payments |
| Daemon proposal processing (1826 proposals)  | avg 0.6ms                     | Daemons are 300× faster than hub        |
| Daemon frame processing (30 htlcPayment txs) | 10–12ms per frame             | Daemons are NOT congested               |

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

| Metric        | No ramp (simultaneous) | 500ms ramp | Change |
| ------------- | ---------------------- | ---------- | ------ |
| Dead zone     | ~8.7s                  | ~6.4s      | −27%   |
| Final TPS     | 199.1/s                | 220.4/s    | +11%   |
| Delivery time | 30.1s                  | 27.2s      | −10%   |

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

1. **Reduce hub per-frame processing time** — originally hypothesised as
   Lever 2 (batch sig verification). Op-counter profiling (§9) disproved
   this: ECDSA recovery is only ~4% of total ops. The real bottlenecks
   are `canonical.encode` (190K calls), `stateRoot` (65ms/frame), and
   `structuredClone` (45K calls). See §9 for the revised levers.

2. **Increase hub frame batching** — Lever 4 (frame-cut bistability).
   Fat frames amortize per-frame fixed costs over more ACKs. If the hub
   drains 129 ACKs in 5 fat frames instead of 30 thin frames, the dead
   zone shrinks proportionally.

The staggered ramp (`XLN_HLT_SUBMIT_RAMP_MS=500`) provides a modest 11%
TPS gain as a harness-level optimization with zero consensus risk.

## 7. Lever 4 results (fat-frame gate)

Implemented `minFrameMempoolDepth`/`maxFrameDelayMs` config: hold hub
frames back until enough mempool work accumulates, or a max delay cap
fires. Default off (0); `scenarioMode` bypasses entirely.

| Config                      | Dead zone | TPS   | Delivery | Δ TPS  |
| --------------------------- | --------- | ----- | -------- | ------ |
| Baseline (no gate, no ramp) | ~8.7s     | 199.1 | 30.1s    | —      |
| Ramp only (500ms)           | ~6.4s     | 220.4 | 27.2s    | +10.7% |
| Gate only (50/25ms)         | ~6.5s     | 227.4 | 26.4s    | +14.2% |
| Gate+Ramp (50/25ms + 500ms) | ~6.5s     | 223.4 | 26.9s    | +12.2% |
| Gate (100/100ms)            | ~8.6s     | 217.4 | 27.6s    | +9.2%  |

**Best config: `XLN_HUB_MIN_FRAME_MEMPOOL_DEPTH=50`, `XLN_HUB_MAX_FRAME_DELAY_MS=25`**

- +14.2% TPS (199.1 → 227.4)
- -12.3% delivery time (30.1s → 26.4s)
- -25% dead zone (8.7s → 6.5s)

Fat frames are 3× more efficient per input: h=223 processed 250 inputs
in 418ms (1.7ms/input) vs h=220 92 inputs in 479ms (5.2ms/input).

Gate and ramp are NOT additive — both smooth the ACK burst; combining
over-smooths. maxDelay=100ms is too high — adds latency without
proportional batching benefit. Dead zone floor is ~6.5s; hub per-frame
processing (400–500ms) is the remaining bottleneck.

## 7a. Bun 1.4.0 upgrade

Upgraded from Bun 1.3.14 to 1.4.0 (released 2026-08-20). The 1.4 release
rewrites the runtime from Zig to Rust, fixes `structuredClone` reference
pool corruption (PRs #32791, #32796 — the exact bug that
`cloneIsolatedEntityInput` works around), and reduces memory usage by
up to 35%.

`bun run check` passes on 1.4.0 with no source changes.

| Run | Bun 1.3.14 (all opts) | Bun 1.4.0 (all opts) |
| --- | --------------------- | -------------------- |
| 1   | 210.5 TPS             | 227.4 TPS            |
| 2   | 208.2 TPS             | 239.7 TPS            |
| 3   | 194.1 TPS             | 234.6 TPS            |
| Avg | ~204 TPS              | ~234 TPS             |

**+14.7% TPS from the runtime upgrade alone** (204 → 234 avg).
Best single run: 239.7 TPS (was 227.4 on 1.3.14).
Delivery time: 25.0s (was 26.4s best on 1.3.14).

## 8. Op-counter profile: the real bottleneck

Run with `XLN_RUNTIME_OP_COUNTERS=1` + `XLN_ENTITY_FRAME_PROFILE=1`
(fat-frame gate 50/25ms enabled). Op counters dumped on hub shutdown.

### Per-frame phase averages (21 frames, >50 txs each)

| Phase              | Avg ms/frame | Share |
| ------------------ | ------------ | ----- |
| frameApply         | 175          | 64%   |
| stateRoot          | 65           | 24%   |
| wireFit            | 12           | 4%    |
| hankoEncoding      | 9            | 3%    |
| manifestSignatures | 7            | 3%    |
| commit             | 4            | 1%    |
| **Total**          | **272**      |       |

### Cumulative op counters (H1, whole run)

| Operation             | Calls   | Notes                        |
| --------------------- | ------- | ---------------------------- |
| canonical.encode      | 190,436 | #1 — serialization           |
| keccak.ethers         | 106,778 | #2 — hashing (stateRoot)     |
| structuredClone       | 44,817  | #3 — account state cloning   |
| ecdsa.sign            | 20,891  | #4 — signing > recovery!     |
| ecdsa.recover         | 14,618  | #5 — only 4% of total ops    |
| hanko.verifyCanonical | 13,117  | 34% cache hit rate           |
| address.cache.hit     | 288,149 | address resolution is cached |

### Conclusion

**ECDSA recovery is NOT the bottleneck.** The original "Lever 2: batch
sig verification" hypothesis is disproved. The real costs are:

1. **`frameApply` (175ms/frame, 64%)** — dominated by `canonical.encode`
   (190K calls, ~3,600/frame) and `structuredClone` (45K calls). Each
   account input triggers full state serialization + clone.

2. **`stateRoot` (65ms/frame, 24%)** — full Merkle root recomputation via
   `keccak.ethers` (107K calls). No incremental/dirty tracking.

3. **`ecdsa.sign` (20,891)** — signing is 43% more calls than recovery.
   Manifest signatures and hanko encoding add 16ms/frame combined.

### Revised levers

- **Lever 5 (state root amortization):** DEAD END. State root is already
  incrementally cached via Patricia maps + account root memo. 67% of
  account root calls are <0.05ms (cache hits). Entity root: 0.15-0.55ms
  per call. The 65ms "stateRoot" phase in frame profiles was misleading
  — it included profiling overhead.
- **Lever 6 (entity root memoization):** DONE. Memoized
  `computeCanonicalEntityConsensusStateHash` on field identity (same
  pattern as `ACCOUNT_STATE_ROOT_MEMO`). Reduced `canonical.encode` by
  42% (322K → 187K calls). TPS impact within run-to-run variance (194-221
  TPS both with and without). The remaining bottleneck is NOT encoding.
- **Lever 6a (account value hash memo):** NO HELP. The radix map already
  caches leaf node hashes; `valueHash` is only called once per leaf. The
  memo added overhead without benefit.
- **Lever 7a (observability clone reduction):** DONE. Replaced
  `structuredClone(payload)` with shallow `{ ...payload }` in
  `queuePendingAuditEvent`. All call sites build fresh object literals,
  so the canonical dedup key already binds the full structure.
  `structuredClone`: 43,836 → 33,432 (-24%, -10K calls).
- **Lever 7b (structuredClone reduction):** DEAD END. Remaining 33K
  clones are all consensus-critical isolation barriers. The biggest
  caller (`cloneIsolatedEntityInput`, 8K) is an explicit Bun 1.3.x bug
  workaround. The rest (`recordCommittedFrames`, `collectEntityTxResult`,
  `committed-input` response) protect against mutation between candidate
  effect creation and history recording. Removing them risks silent state
  corruption.
- **Lever 2 (batch sig verify):** DEPRIORITIZED. Only 4% of ops; max
  ~7ms/frame savings even with perfect batching.

## 9. Instrumentation committed

| Commit      | Content                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c9ec6ddca` | `XLN_RUNTIME_FRAME_LOG` forwarded smoke → orchestrator → hub child; `XLN_ACCOUNT_PROPOSAL_PROFILE`/`XLN_ENTITY_FRAME_PROFILE` forwarded to lane daemons; `XLN_HLT_SUBMIT_RAMP_MS` staggered submission ramp |
| `efea96a42` | Fat-frame gate: `minFrameMempoolDepth`/`maxFrameDelayMs` config + `decodeRuntimeConfig` schema update                                                                                                       |
| `fc55888f8` | Entity state root memo on field identity (Lever 6). `canonical.encode` -42% (322K → 187K)                                                                                                                   |
| `c23164d82` | Shallow-clone audit event payload (Lever 7a). `structuredClone` -24% (44K → 33K)                                                                                                                            |
