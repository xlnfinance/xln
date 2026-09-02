# BrainVault OpenCL hybrid experiment

This self-contained source experiment accelerates the frozen BrainVault V1
derivation on Apple Silicon by running independent shards on the CPU and GPU at
the same time. It uses the system OpenCL framework; it does not install a
library, contact the network, or alter the V1 byte protocol.

It is not selected by the normal wallet CLI. Apple deprecated OpenCL, and the
vendored upstream has mixed per-file licensing; read `NOTICE` before reuse.

## Frozen operation

- Argon2id v19, `m=262144 KiB`, `t=1`, `p=1`, 32-byte output
- exact V1 salts supplied independently for every shard
- canonical shard order preserved before root combination
- raw CPU/OpenCL output parity checked by `parity.ts`
- device memory is explicitly zero-filled and synchronized before output
- password, salts, outputs, IPC buffers, and combined shards are erased

The host integration is roughly 500 lines; the remaining vendored source is
the small GPU kernel, BLAKE2b/Argon2 initialization, and Khronos' header-only
OpenCL C++ wrapper. No hashcat runtime is included.

## M3 Ultra result

On the 32-CPU-core / 80-GPU-core M3 Ultra used for development:

| Exact V1 run | Time | Shards/s | Root |
| --- | ---: | ---: | --- |
| C/NEON, 32 workers | 5.136 s | 194.72 | `dc2090d6…3485` |
| OpenCL hybrid, 32 CPU workers | 3.127 s | 319.83 | `dc2090d6…3485` |
| OpenCL hybrid, 480 GPU + 520 CPU | **3.072 s best** | **325.53 best** | `dc2090d6…3485` |

That is a measured **1.67x best / about 1.62x typical** end-to-end speedup. The best layout uses two GPU
batches of 240, one shard per OpenCL workgroup, and 30 CPU workers. Thirty was
faster than 32 in the hybrid because two fewer CPU arenas reduced unified-memory
contention. All 80 GPU compute units remain available. Run-to-run thermal noise
is material; the retained modern permutation repeatedly ran in about 3.07-3.25
seconds, while the fresh CPU baseline was 5.136 seconds.

The 2x target was not honestly reached. Hashcat's specialized hot kernel can
briefly report higher throughput, but its full process took over 20 seconds and
its sustained kernel rate did not yield a 2x end-to-end wallet derivation. The
small hybrid here is the fastest verified, auditable implementation found.

## Build and verify

Run from this directory:

```text
make
bun parity.ts 2
bun benchmark.ts 480 240 30 1
```

The benchmark arguments are `gpu shards`, `GPU batch`, `CPU workers`, and
`GPU jobs per workgroup`. The default uses the requested 32 CPU workers; the
best observed tuning used 30 and is available as `make benchmark-fastest`.
The binary is intentionally ignored by git and excluded from the npm allowlist.
