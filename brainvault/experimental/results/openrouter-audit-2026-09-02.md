# External performance audit — 2026-09-02

Two independent read-only audits were anchored to commit `4753608dd` through
Pi and OpenRouter. Five OpenCL files also carried the disclosed local
profiling-toggle change measured in the follow-up below. The models were
`moonshotai/kimi-k3` and `qwen/qwen3.8-max`.
Credentials came only from the existing environment and were not printed.

The audited fast paths were the OpenCL/C hybrid, the bundled C/NEON backend,
and the native binding with isolated workers. The BrainVault V1 byte protocol,
ordered root fold, secure erasure, and no-new-runtime-dependency rule were
explicit constraints.

## Independent validation

Both model reports contained invented performance facts. Kimi predicted an
impossible sub-200ms run and used the wrong CPU topology. Qwen initially read
256MiB as 256KiB and invented 384 GPU cores. Those claims and all unmeasured
speedup percentages were rejected. Recommendations below survived comparison
with source and retained measurements.

- M3 Ultra: retain multiplier 1 and the measured 480 GPU / 520 CPU split,
  batches of 240, one job per workgroup, and 30 CPU workers.
- Entry M5 MacBook Pro: keep CPU-only C/NEON as the production default until
  the exact hardware is measured. Test 4/6/8/10 CPU workers first.
- A 16GB M5 OpenCL experiment must begin conservatively. Test GPU batches
  8/10/12, then 16/24/32 only after allocation, swap, thermal, abort, and wipe
  tests pass on the real machine.
- Never infer performance from RAM capacity alone. Multiplier greater than 1
  changes the root and is a slower memory-hardness choice, not an optimizer.
- Keep native worker isolation: prior same-isolate concurrency corrupted
  results.

Large rewrites proposed by the models were rejected. Double-buffered 60GB GPU
arenas compete for the same unified-memory bandwidth, a 16-thread permutation
requires a new shuffle design, and shared CPU arenas merely emulate fewer
workers. Blocking map/unmap replacement remains a possible 1–3% experiment,
but its scatter/gather kernels currently cost more audit complexity than the
plausible benefit.

## Measured follow-up

The narrow M3 Ultra sweep confirmed the existing layout. The best observed
1,000-shard run was 3.053922s (327.448 shards/s), with the frozen root
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.
Against the fresh 5.135514s C/NEON baseline, that is 1.682x. Runs around the
optimum remain thermally noisy, so this is a best observation, not a guaranteed
rate.

The entry M5 target is deliberately unmeasured. Before changing its default,
run at least five warm sequential trials per candidate, report median and p95,
and test plugged-in and battery operation, memory pressure/swap, sustained
thermals, parity, OOM, Ctrl+C, and secure erasure.
