# BrainVault experimental Argon2 backends

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
| Native Rust pooled, secure wipe | 18.150 s | 55.10 | `argon2-rust` 1.1.0, `target-cpu=native` |
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
| C/NEON, reused arena and final wipe | **5.364 s** | **186.44** | **2.86x** |
| C/NEON, secure wipe after every shard | 5.646 s | 177.11 | 2.72x |
| Native binding, direct async pool | 5.984 s | 167.10 | 2.56x |
| Native binding, synchronous isolated workers | 6.056 s | 165.12 | 2.53x |
| Existing native worker via common harness | 6.265 s | 159.61 | 2.45x |
| Native Rust pooled, secure wipe | 6.710 s | 149.03 | 2.29x |
| Native Rust pooled, final wipe only | 7.303 s | 136.94 | 2.10x |
| TypeScript/WASM (`hash-wasm`) | 13.096 s | 76.36 | 2.17x |

The C final-wipe process does not leave a long-lived dirty arena: each worker
reuses its arena only while processing its assigned shards, then securely wipes
the full 256 MiB before the subprocess exits. It remains experimental and
Darwin/ARM64-specific; the publishable CLI defaults to the portable native
binding and automatically uses all CPU cores allowed by RAM.

## Run

```bash
# Existing native binding
bun experimental/benchmark.ts --backend=baseline --shards=1000 --workers=8

# Browser-compatible TypeScript/WASM
bun experimental/benchmark.ts --backend=wasm --shards=1000 --workers=8

# Build and run C/NEON
make -C experimental/argon2-c
bun experimental/benchmark.ts --backend=c-neon --shards=1000 --workers=8

# Build and run both native Rust variants
make -C experimental/argon2-rust
bun experimental/benchmark.ts --backend=rust-pool --shards=1000 --workers=8
```

Raw run output is in `results/`. The aborted 100,000-shard log records the
initially requested run before the benchmark size was corrected to 1,000.
