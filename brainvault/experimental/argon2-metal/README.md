# BrainVault Metal experiment

This is a macOS-only batch prototype for the frozen BrainVault V1 Argon2id
parameters. It keeps initialization and final BLAKE2b expansion in the audited
vendored C reference code and moves only the 256 MiB block-filling phase to the
Apple GPU. One 32-thread SIMD group cooperates on each independent shard.

The register/SIMD-shuffle layout is a Metal adaptation of Ondrej Mosnacek's
MIT-licensed `argon2-gpu` warp design. Its notice is retained in
`LICENSE-ARGON2-GPU`. The barrier kernel is an independently written readable
reference used to cross-check the faster register kernel.

It is deliberately separate from wallet creation and is not a production
engine. Promotion requires exact raw-shard and root parity across the canonical
matrix, failure tests, reproducible artifacts, secure buffer erasure, and a
repeatable speed win over C/NEON.

## M3 Ultra result

Every tested raw shard matched the canonical C/NEON output at batch sizes
1, 2, 8, 32, 64, 128, and 256. Four SIMD groups per Metal threadgroup was the
best packing tested. Throughput saturated near 50 shards/s, while the 36-thread
C experiment reached about 192.5 shards/s. A concurrent 800 C + 200 Metal split
reached 193.2 shards/s: unified-memory contention erased the theoretical hybrid
gain. Metal is therefore research-only and must not be selected for wallets.

Rejected experiments are equally important: 2 MiB Mach superpages fail to
allocate on Apple Silicon, and fixed-corpus PGO was within run noise.

```bash
make -C experimental/argon2-metal
make -C experimental/argon2-c oversubscribed
make -C experimental/argon2-metal parity
make -C experimental/argon2-metal benchmark
```
