# HLT throughput: bottleneck analysis (2026-08-22)

Branch `fix/radapter-oversized-read-storm`, upstream base `0bbab6856`.
All runs: payments mode, Anvil testnet, isolated smoke shard, 10 lanes.

## 1. Throughput ladder

```
TPS
 300 |                                                    ● 295 run9
 276 |                                              ● 276 run6
 224 |                                        ● 224 run5
 177 |                                  ● 177 run4 (200u)
  72 |            ● 72 run3 (200u)
   7 |● 7.4 runs1-2 (200u)
     +------------------------------------------------→
       broken watcher  +retryable  +upstream   +full
       (read storms)   =false      watcher     profiling
```

| Run | Code                      | TPS   | Change under test                                          |
| --- | ------------------------- | ----- | ---------------------------------------------------------- |
| 1–2 | `2aeb5f432`               | 7.4   | Baseline: 1023 oversized radapter reads, ~125 s blind tail |
| 3   | +`retryable=false`        | 71.7  | Retry storm killed (1023 → 1 oversized read)               |
| 5   | +upstream watcher rewrite | 223.6 | Fat `/accounts` reads replaced by committed counters       |
| 6   | +profile log-level fix    | 276.7 | Measurement only; revealed real hub CPU data               |
| 9   | +account-level profiling  | 295.3 | Full per-phase decomposition                               |

Previous ledger best: 248.8/s (500u, commit `285c313`).

## 2. Every run has the same shape

```
delivered
15000 |                                            ●●●●
10000 |                                      ●●●●●
 5000 |                              ●●●●●●
 1000 |              ●●●●●●●●
    0 |●●●●●●●●●●●●●
      +------|----------|--------------------|-----→ s
      0     ~20s        dead zone ends      ~51-67s
            hub ~5% CPU
```

- **Dead zone (~0–20 s):** hub idles at ~5% CPU, ~160 payments delivered.
  Hub frames wait on bilateral ACKs from lane daemons — one pending frame per
  account, so nothing batches yet.
- **Acceleration:** ACK latency collapses as the 500-way gossip/submission
  burst clears; frames fatten (run 9: 37 frames × ~405 payments).
- **Steady state:** hub pegged at ~111% CPU; tail bursts hit ~1140/s
  instantaneous.

## 3. Hub CPU decomposition (run 9, H1, 38 s frame time)

```
apply                74% ██████████████████████████████████
└─ entityApply       99% of apply
   └─ account input   1.33ms/payment  (consensus 1.06ms) ─┐
      + proposal      1.49ms/payment  (validateTxs 1.16)  ├─ THE marginal cost
save/storage         19% ██████████  (frameEncode ~half)   │  ≈2.8ms per payment
dispatch+other        7% ███                               │
                                                           │
per-frame fixed costs: amortized to ~0 by 405-tx batches ──┘
```

## 4. Insights

1. **The bottleneck is per-payment validation crypto, not "the hub is slow".**
   `validateTxs` ≈ 1.16 ms/payment ≈ per-tx signature/Hanko verification.
   Storage, encoding, and frame overheads already amortize at fat batches.
2. **1000/s arithmetic:** marginal cost must drop 2.8 → ~0.9 ms/payment.
   Batch signature verification (verify N signatures once per frame/batch
   instead of per tx) is the single move that gets there.
3. **The dead zone is pure loss.** Fixing it lifts identical code to ~450/s
   average. Hypothesis: lane-daemon event-loop congestion during simultaneous
   route/gossip warm-up; needs daemon-side log capture to prove.
4. **Frame batching is bistable.** Identical code produced 758 thin frames
   (run 8) and 37 fat frames (run 9). Fat is strictly better; whatever drives
   frame-cut timing is chaotic and worth understanding.
5. **Measurement hygiene was the hidden tax.** Three separate "hub looks slow"
   incidents were observer-side: radapter read storms (retryable=true on a
   deterministic size failure), and profile logs emitted at info under a warn
   default. The measurement pipeline is now trustworthy end-to-end.

## 5. Fixes behind this report

| Commit / state | Content                                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `34e1ad9e5`    | Pin `@openzeppelin/contracts@5.4.0` at root for reproducible contract sync (bit-exact with committed artifacts, AST key 16557)                                                                                                                  |
| `387f72db0`    | Radapter oversized responses non-retryable (identical retry of a deterministic size failure can never succeed)                                                                                                                                  |
| uncommitted    | Profile telemetry (`process.profile`, `apply.profile`, `frame.profile`, `inputs.profile`, `proposal.profile`, `input.profile`) emits at warn when explicitly enabled; `XLN_ACCOUNT_PROPOSAL_PROFILE` forwarded smoke → orchestrator → hub child |

## 6. Next levers, ranked

| Lever                                         | Prize                        | Risk                                            |
| --------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| Dead zone (daemon warm-up congestion)         | 275 → ~450/s                 | Low                                             |
| Batch signature verification in `validateTxs` | the 1000/s gate              | High (consensus code — owner sign-off required) |
| `accountProposals` amortization (8.5 s/run)   | ~15% of entity CPU           | Medium                                          |
| Frame-cut bistability                         | free fixed-cost amortization | Low                                             |
