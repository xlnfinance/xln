# BrainVault native source and research backends

Reproducible comparison for the frozen BrainVault V1 shard parameters:

- Argon2id v19
- 256 MiB per shard
- time cost 1
- parallelism 1
- 32-byte output
- 1,000 shards, factor 4
- 8 outer workers unless explicitly noted
- inputs `benchmark-user` / `benchmark-password`
- Apple M3 Ultra, Bun 1.4.0, macOS arm64

Every full backend run produced this identical master root:

```text
dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485
```

## Results

| Backend | 1,000-shard time | Shards/s | Notes |
| --- | ---: | ---: | --- |
| Existing production CLI/native baseline | 15.335 s | 65.21 | Original path, 8 workers |
| Existing native worker via common harness | 16.629 s | 60.14 | Apples-to-apples harness |
| Native binding, synchronous isolated workers | 16.433 s | 60.85 | Same Rust binding |
| Native binding, direct async pool | 15.233 s | 65.65 | Best 8-worker run; not promoted due historical same-isolate corruption |
| Official C Argon2 through SSE2NEON | 15.992 s | 62.53 | Reused 256 MiB arena per worker |
| Native Rust pooled, secure wipe | 18.150 s | 55.10 | `argon2-rust` 1.1.0 |
| Native Rust pooled, final wipe only | 18.003 s | 55.55 | Experimental security trade-off; not for production |
| TypeScript/WASM (`hash-wasm`) | 28.430 s | 35.18 | Browser-compatible parity path |

The normal CLI now defaults to all hardware cores allowed by RAM. On this
32-core machine the same 1,000-shard derivation completed in 6.336 seconds,
2.42x faster than the original 8-worker baseline. That result is concurrency
scaling, not a same-core algorithmic speedup.

## 32-worker results

All options were also run with 32 workers on the same 1,000-shard input. Every
run produced the same master root shown above.

| Backend | 1,000-shard time | Shards/s | Speedup vs original 8-worker CLI |
| --- | ---: | ---: | ---: |
| C/NEON, reused arena and final wipe | **5.212 s** | **191.87** | **2.94x** |
| C/NEON, secure wipe after every shard | 5.646 s | 177.11 | 2.72x |
| Native binding, direct async pool | 5.984 s | 167.10 | 2.56x |
| Native binding, synchronous isolated workers | 6.056 s | 165.12 | 2.53x |
| Existing native worker via common harness | 6.265 s | 159.61 | 2.45x |
| Native Rust pooled, secure wipe | 6.710 s | 149.03 | 2.29x |
| Native Rust pooled, final wipe only | 7.303 s | 136.94 | 2.10x |
| TypeScript/WASM (`hash-wasm`) | 13.096 s | 76.36 | 1.17x |

The C final-wipe process does not leave a long-lived dirty arena: each worker
reuses its arena only while processing its assigned shards, then securely wipes
the full 256 MiB before the subprocess exits. On macOS that final erase uses the
non-elidable, libc-vectorized C11 `memset_s`; other platforms retain the portable
volatile fallback. The source variants and comparison
modes remain under `src/native/source/`; the publishable CLI selects a verified
C/NEON release build as its fast Apple Silicon default when eligible, otherwise
the portable native binding. Selection happens before derivation; a runtime
engine failure is fatal and never silently switches. Both paths automatically
use all CPU cores allowed by RAM.

## Apple GPU research

`metal/` contains the dependency-free native Metal backend for the exact
V1 Argon2id shard. GPU-private arenas, a compact 64-bit segmented permutation,
and multi-process scheduling raised the M3 Ultra result from the original
49.11-shard/s pure GPU prototype to **2.478 seconds / 403.62 shards/s** in the
latest full sequential 11-engine run for the complete 1,000-shard CPU/GPU
derivation. The frozen root remained
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.
That run was **2.22x** faster than its 5.497-second C/NEON baseline and 1.28x
faster than OpenCL. The current V1-specialized profile uses 640 Metal / 360 CPU
shards, eight Metal processes with 40 workers each, 32 CPU workers, and about
88 GiB of live arenas. A separate alternating sweep measured a 2.374-second
median and 2.340-second best for this profile. It is the automatic wallet engine
only on the measured 80-GPU-core, 512-GiB M3 Ultra class. Other Macs retain the
C/NEON default until a real-device release matrix exists.

`opencl/` is the faster source-only experiment. A one-shard-per-workgroup
layout plus concurrent C/NEON processing completed 1,000 exact V1 shards in a
best 2.964 seconds (337.43 shards/s), versus a fresh 5.136-second C/NEON
baseline: **1.73x best / about 1.72x median end-to-end**. The frozen root remained
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.
The measured M3 Ultra split is 496 GPU shards in two batches of 248 and 504 CPU
shards. The required 32-worker run took 3.127 seconds; the best observed
2.964-second tuning used 30 workers to reduce unified-memory contention. GPU
and host memory are explicitly erased.

The exact 10,000-shard user default has its own measured Metal plan rather than
scaling the 1,000-shard ratio. A 3+3 alternating comparison moved from 6,400
GPU / 3,600 CPU shards at a 20.169-second median to 8,000 GPU / 2,000 CPU at a
14.064-second median, a 30.27% improvement with the same 88 GiB active-arena
budget and frozen root. See the source-only
`docs/evidence/audits/m3-ultra-re-audit-2026-09-03.md`; release evidence is
kept in the source repository and is not nested in the npm artifact.

OpenCL is deprecated by Apple and the pinned upstream has mixed license
notices, so it is never selected automatically. Its `NOTICE` explains
provenance and the conservative GPL treatment. The npm package contains the
audited source, kernel, and prebuild; it builds against the macOS system
framework and contains no hashcat runtime or downloaded dependency.

## Run

```bash
# Existing native binding
bun src/native/source/benchmark.ts --backend=baseline --shards=1000 --workers=8

# Browser-compatible TypeScript/WASM
bun src/native/source/benchmark.ts --backend=wasm --shards=1000 --workers=8

# Build and run C/NEON
make -C src/native/source/c
bun src/native/source/benchmark.ts --backend=c-neon --shards=1000 --workers=8

# Build secure/no-wipe Apple M1 baseline and M3-family prebuilds entirely offline
make -C src/native/source/rust
bun src/native/source/benchmark.ts --backend=rust-pool --shards=1000 --workers=8
```

Raw run output and prior model-review notes are source-only under
`docs/evidence/`; they are not part of the npm artifact. The aborted
100,000-shard log records the initially requested run before the benchmark size
was corrected to 1,000.
