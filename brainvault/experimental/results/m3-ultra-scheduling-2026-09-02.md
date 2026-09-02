# M3 Ultra scheduling result — 2026-09-02

This file records performance evidence, not BrainVault V1 protocol material.
Every listed configuration produced the frozen 1,000-shard root
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.

## Machine

- Apple M3 Ultra
- 32 CPU cores: 24 performance + 8 efficiency
- 80 GPU cores
- 512 GiB unified memory
- macOS 26.6.2
- Metal-reported maximum buffer length: 348 GiB

Some early observations overlapped an XLN replay workload. Final comparisons
were alternated to reduce thermal and background-load bias.

## Scheduling sweep

| Configuration | Median | Best | Median shards/s |
| --- | ---: | ---: | ---: |
| retained 556 GPU / 2 processes x 139 / 32 CPU | 2.703s | 2.658s | 370 |
| **640 GPU / 8 processes x 40 / 32 CPU** | **2.374s** | **2.340s** | **421** |
| 680 GPU / 9 processes x 38 / 28 CPU | 2.474s | 2.250s | 404 |

The selected profile improved median latency by 1.14x over the retained profile
and by roughly 2.26x over the same-day 5.366-second C/NEON median. The first
full canonical 11-engine run after integration measured production Metal at
2.478 seconds and the generic Metal control at 2.438 seconds; the difference is
within observed noise and both reproduced the same root.

The standard 10,000-shard user default subsequently measured 22.329 seconds on
production Metal and 52.560 seconds on C/NEON. Both produced
`5557e8b96514ba45d0f3af0450616c68d41625731a8de9fbe54046cce1de0298`,
which is retained as `s10000-m1` in `matrix-v1.json`.

## Bottleneck evidence

- A cold 256-MiB arena costs about 9.9 ms per shard.
- A warm arena costs about 1.17 ms per shard, or roughly 854 shards/s from one
  process in the measured 556-concurrent-shard wave.
- Warm useful traffic was about 458 GB/s against a measured 555 GB/s Metal blit
  fill ceiling.
- Eight or nine processes scale cold arenas; adding command queues to one
  process did not. One process measured about 6.242 seconds at one or two queues
  for 556 shards.
- Process spawn and Metal setup contributed about 450–690 ms total at eight or
  nine processes. Wipe contributed about 60–370 ms.
- Four simdgroups beat two; 32 CPU workers beat both 28 and 24, so efficiency
  cores remain useful.
- Sharp scheduling cliffs were reproducible: 8x40 was fast while 8x41 and 8x42
  regressed. A measured profile is safer than an analytical extrapolation.

## Bound and next experiments

The exact V1 work implies about 549.8 GB of mandatory traffic for 1,000 shards.
At a measured 555 GB/s ceiling, 0.99 seconds is a hardware traffic floor, not an
attainable end-to-end target. Around 2.0 seconds appears plausible; approaching
1.5 seconds would require eliminating much of cold page-in and process startup.

The next experiments must remain isolated until each proves parity, failure
semantics, and an end-to-end gain:

1. Parallel prefault of shared Metal arenas before derivation.
2. An offline per-hardware autotuner for process count, worker count, and split;
   no machine-dependent value may enter V1 derivation.
3. Emit result bytes before secure arena wipe, while retaining a nonzero child
   exit on wipe failure and ensuring the parent never accepts output from a
   failed child.

Hashcat's public Argon2 benchmark uses different memory parameters and is not a
valid speed comparison. No claim of a public world record is made.
