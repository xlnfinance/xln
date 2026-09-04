# BrainVault M3 Ultra re-audit and tuning — 2026-09-03

## Environment and method

- Apple M3 Ultra: 32 CPU cores, 80 GPU cores, 512 GiB unified memory
- macOS 26.6.2 (25G83), Bun 1.4.0, clang 21, rustc 1.94.1, SDK 26.5
- AC power, low-power mode disabled
- every run held the repository machine lock; engines ran sequentially
- A/B order was alternated; no failed or slow sample was discarded
- exact V1 parameters: Argon2id v0x13, m=262,144 KiB, t=1, p=1, out=32

Every result below produced the complete expected root for its shard count.
The 1,000-shard root was:

```text
dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485
```

The 10,000-shard root was:

```text
5557e8b96514ba45d0f3af0450616c68d41625731a8de9fbe54046cce1de0298
```

## Repeated comparisons

| Comparison | Samples | Best | Median | Worst | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Metal V1-specialized, 1,000 | 8 | 2.429s | 2.524s | 2.566s | production remains V1-specialized |
| Metal generic, 1,000 | 8 | 2.465s | 2.514s | 2.588s | 0.39% median advantage is noise |
| Rust secure Apple M1, 1,000 | 6 | 6.425s | 6.595s | 7.012s | portable baseline retained |
| Rust secure Apple M3, 1,000 | 6 | 6.438s | 6.625s | 6.782s | 0.45% slower; no speed claim |
| C/NEON Apple M1, 1,000 | 6 | 5.403s | 5.424s | 5.635s | portable baseline retained |
| C/NEON Apple M3, 1,000 | 6 | 5.389s | 5.416s | 5.706s | 0.15% faster; noise |
| Metal private storage, 1,000 | 4 | 2.431s | 2.470s | 2.556s | retained |
| Metal shared storage, 1,000 | 4 | 2.478s | 2.525s | 2.547s | 2.22% slower |
| Current 640/360 Metal plan, 1,000 | 8 | 2.422s | 2.472s | 2.623s | retained |
| Candidate 800/200 Metal plan, 1,000 | 8 | 2.247s | 2.516s | 2.959s | 1.78% slower and unstable |

At 1,000 shards, 640 GPU shards are exactly two 40-arena waves in each of
eight Metal processes. Increasing the split without changing the process count
creates a third wave and sharply regresses end-to-end time. Ten-process
candidates occasionally produced a fast single result but did not survive
alternating A/B measurement.

## Level-4 production improvement

The previous 10,000-shard plan mechanically scaled the 1,000-shard 64/36 split.
A profile showed 20.753s end to end, with Metal complete at 11.589s and the CPU
tail taking another 9.164s. The measured replacement uses 8,000 GPU and 2,000
CPU shards while keeping eight Metal processes, 40 Metal workers per process,
32 CPU workers, private storage, and the same 88 GiB of live Argon arenas.

Final ABBA samples:

| 10,000-shard plan | Samples | Best | Median | Worst | Median shards/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| old 6,400 GPU / 3,600 CPU | 3 | 20.087s | 20.169s | 29.904s | 495.81 |
| new 8,000 GPU / 2,000 CPU | 3 | 13.954s | 14.064s | 14.496s | 711.02 |

The median improvement is **30.27%**. The slow 29.904s old-profile sample was
retained; even comparing its best result with the new median gives a 29.98%
improvement. A production CLI run after changing only the planner completed in
14.379s and matched the frozen 10,000-shard root.

This promotion applies only to the exact measured 10,000-shard production
profile. The 1,000-shard split remains 640/360, and custom, level-5, and level-6
counts are not extrapolated from this result.

## Profile and rejected directions

For the retained 1,000-shard production profile, eight Metal children reported
setup 164–201ms, initialization about 1ms, command work 1.45–1.60s, and wipe
22–71ms. Process orchestration and result transfer account for the remaining
gap to about 1.97s on the Metal side; the parallel C side set the 2.45s wall
time. Persistent helpers or reusable arenas could amortize setup, but they also
create a cross-request secret-retention boundary and cannot improve the current
CPU critical path enough to justify production complexity.

Apple M3-specific C and Rust prebuilds are byte-reproducible and root-identical,
but this memory-bound workload showed no measurable speedup over the Apple M1
baseline. They are architecture artifacts, not evidence of a faster algorithm.
