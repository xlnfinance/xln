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
- password, salts, outputs, IPC buffers, combined shards, and temporary
  password-derived host stack state are erased

The host integration is roughly 500 lines; the remaining vendored source is
the small GPU kernel, BLAKE2b/Argon2 initialization, and Khronos' header-only
OpenCL C++ wrapper. No hashcat runtime is included.

## M3 Ultra result

On the 32-CPU-core / 80-GPU-core M3 Ultra used for development:

| Exact V1 run | Time | Shards/s | Root |
| --- | ---: | ---: | --- |
| C/NEON, 32 workers | 5.136 s | 194.72 | `dc2090d6…3485` |
| OpenCL hybrid, 32 CPU workers | 3.127 s | 319.83 | `dc2090d6…3485` |
| OpenCL hybrid, 496 GPU + 504 CPU | **2.964 s best** | **337.43 best** | `dc2090d6…3485` |

That is a measured **1.73x best / about 1.72x median** end-to-end speedup. The
best layout uses two GPU batches of 248, one shard per OpenCL workgroup, and 30 CPU workers. Thirty was
faster than 32 in the hybrid because two fewer CPU arenas reduced unified-memory
contention. All 80 GPU compute units remain available. Run-to-run thermal noise
is material; four retained runs of the final split took 2.964–3.021 seconds
(2.981-second median), while the fresh CPU baseline was 5.136 seconds.

The 2x target was not honestly reached. Hashcat's specialized hot kernel can
briefly report higher throughput, but its full process took over 20 seconds and
its sustained kernel rate did not yield a 2x end-to-end wallet derivation. The
small hybrid here is the fastest verified, auditable implementation found.

## Build and verify

Run from this directory:

```text
make
bun parity.ts 2
bun benchmark.ts 496 248 30 1
```

The benchmark arguments are `gpu shards`, `GPU batch`, `CPU workers`, and
`GPU jobs per workgroup`. Direct invocation defaults to the measured fastest
496/248/30/1 profile; the requested 32-worker comparison remains available as
`make benchmark`, and the fastest profile as `make benchmark-fastest`.
The binary is intentionally ignored by git and excluded from the npm allowlist.
