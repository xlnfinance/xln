# BrainVault Metal experiment

This is a macOS-only batch prototype for the frozen BrainVault V1 Argon2id
parameters. It keeps initialization and final BLAKE2b expansion in the audited
vendored C reference code and moves only the 256 MiB block-filling phase to the
Apple GPU. One 32-thread SIMD group cooperates on each independent shard.

The register/SIMD-shuffle layout is a Metal adaptation of Ondrej Mosnacek's
MIT-licensed `argon2-gpu` warp design. Its notice is retained in
`LICENSE-ARGON2-GPU`. The fastest `modern64` kernel uses the equivalent compact
permutation already validated in the sibling OpenCL experiment. The barrier
kernel remains an independently written readable reference.

The V1-specialized hybrid is now the measured M3 Ultra production engine.
Automatic selection is restricted to that measured hardware class; the generic
kernel remains selectable as an experimental independent implementation and all
accelerator failures fall back to C/NEON. Promotion elsewhere still requires a
real-device parity, memory-pressure, cancellation, and thermal matrix.

## M3 Ultra result

Every tested raw shard matches the canonical C/NEON output. The final
1,000-shard root is
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.

The original shared-memory Metal path completed 256 shards in 5.213 seconds
(49.11 shards/s). The retained native path adds four measured changes:

- a GPU-private arena with small upload/download staging buffers;
- a 64-bit modern register permutation split into four Argon2 segments;
- four SIMD groups per threadgroup;
- two independent Metal processes, each reusing a 139-shard private arena.

On the 32-CPU-core / 80-GPU-core M3 Ultra used for development, the current
default sends 544 shards to Metal and 456 to C/NEON. Earlier retained runs of
the 556/444 profile took
2.732, 2.740, 2.738, and 2.741 seconds: **2.739-second median** and
**365.0 shards/s**. A later cool run of the same retained profile set the best
observation at **2.675 seconds / 373.85 shards/s**.
Against the fresh 5.136-second C/NEON baseline, the stable profile is **1.875x**
faster. It is also **1.082x** faster than the 2.964-second OpenCL best while
using Apple's native Metal API and no external runtime.

The default profile needs roughly 78 GiB of unified memory at peak, so it is an
M3 Ultra tuning, not a laptop default. The frozen-V1 function-constant kernel and
generic kernel both retain exact raw-shard and 1,000-shard root parity.

Rejected experiments are equally important: 2 MiB Mach superpages fail to
allocate on Apple Silicon, fixed-corpus PGO was within run noise, reference
precomputation did not improve a saturated batch, and marking the erased arena
purgeable made cleanup slower.

```bash
make -C experimental/argon2-metal
make -C experimental/argon2-c oversubscribed
make -C experimental/argon2-metal parity
make -C experimental/argon2-metal benchmark
```

`benchmark.ts` accepts `--cpu-workers`, `--metal-workers`, `--metal-processes`,
`--gpu-shards`, `--simdgroups`, `--kernel`, and `--memory`. With no flags it
runs the retained fastest profile. Set `BRAINVAULT_METAL_PROFILE=1` to include
host-stage timing. All child outputs and input material are erased on success
and failure; the private GPU arenas are zero-filled and synchronized before
release.
