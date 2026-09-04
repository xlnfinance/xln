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
kernel remains selectable as an experimental independent implementation. Auto
chooses an available verified engine before derivation; once selected, every
accelerator failure is fatal and never silently switches. Promotion elsewhere
still requires a real-device parity, memory-pressure, cancellation, and thermal
matrix.

## M3 Ultra result

Every tested raw shard matches the canonical C/NEON output. The final
1,000-shard root is
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.

The original shared-memory Metal path completed 256 shards in 5.213 seconds
(49.11 shards/s). The retained native path adds four measured changes:

- a GPU-private arena with small upload/download staging buffers;
- a 64-bit modern register permutation split into four Argon2 segments;
- four SIMD groups per threadgroup;
- eight independent Metal processes, each reusing a 40-shard private arena.

On the 32-CPU-core / 80-GPU-core M3 Ultra used for development, the current
default sends 640 shards to Metal and 360 to C/NEON, using eight Metal
processes with 40 workers each and 32 CPU workers. Eight retained runs took
2.422–2.623 seconds with a **2.472-second median**. The generic kernel's
2.514-second median differed by only 0.39%, which is noise; the frozen-V1
kernel remains the canonical production choice. The profile needs roughly
88 GiB of unified memory at peak, so it is an M3 Ultra tuning, not a laptop
default.

The exact 10,000-shard level-4 default uses a separately measured 8,000 Metal /
2,000 C/NEON split with the same process and worker counts. Three alternating
runs improved the prior plan's 20.169-second median to 14.064 seconds while
preserving the frozen root. Other shard counts do not extrapolate this split.
The frozen-V1 function-constant and generic kernels both retain exact raw-shard
and 1,000-shard root parity.

Rejected experiments are equally important: 2 MiB Mach superpages fail to
allocate on Apple Silicon, fixed-corpus PGO was within run noise, reference
precomputation did not improve a saturated batch, and marking the erased arena
purgeable made cleanup slower.

```bash
make -C src/native/source/metal
make -C src/native/source/c oversubscribed
make -C src/native/source/metal parity
make -C src/native/source/metal benchmark
```

`benchmark.ts` accepts `--cpu-workers`, `--metal-workers`, `--metal-processes`,
`--gpu-shards`, `--simdgroups`, `--kernel`, and `--memory`. With no flags it
runs the retained fastest profile. Set `BRAINVAULT_METAL_PROFILE=1` to include
host-stage timing. All child outputs and input material are erased on success
and failure; the private GPU arenas are zero-filled and synchronized before
release.
