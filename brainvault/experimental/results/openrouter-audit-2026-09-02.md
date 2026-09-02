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

- M3 Ultra: retain multiplier 1 and tune around the then-measured 480 GPU /
  520 CPU split, batches of 240, one job per workgroup, and 30 CPU workers.
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

The first narrow M3 Ultra sweep confirmed the 480/240 layout. A later
CPU/GPU-tail measurement showed CPU finishing about 170ms later, leading to a
balanced 496 GPU / 504 CPU split in two batches of 248. The best observed
1,000-shard run was 2.963581s (337.430 shards/s), with the frozen root
`dc2090d65af300c74384ca36adf16ff993c43f4947ee9a0f09e8055f009c3485`.
Against the fresh 5.135514s C/NEON baseline, that is 1.733x. Four final-profile
runs had a 2.981436s median. Runs remain thermally noisy, so the fastest value
is a best observation, not a guaranteed rate.

## Additional model review

The same frozen constraints were reviewed by exact models
`anthropic/claude-fable-5.1`, `z-ai/glm-5.3`, and `x-ai/grok-4.6`. Grok's own
CLI stalled twice, so the exact same model was reached through Pi/OpenRouter.
All three independently favored measuring CPU/GPU completion separately and
retuning the split. They also identified temporary password-derived OpenCL host
stack state that was not explicitly erased; the retained implementation now
uses non-elidable cleanup for Blake2 state, compression temporaries, the Argon2
prehash, long-hash buffer, and final block.

More speculative proposals remain experiments only: two simultaneous 60GB GPU
arenas, OpenCL scatter/gather staging, subgroup shuffles, and a native-worker
binary protocol. No model supplied evidence for another 2x gain, and incorrect
claims about SSSE3 on arm64, M5 timing, OpenCL persistence, and automatic
multiplier scaling were rejected.

The dual-queue proposal was implemented as a disposable probe and rejected:
two concurrent 62GB arenas took 5.261247s at the final 496/248 split, versus
2.964–3.021s for the retained single queue. The probe code was removed.

The entry M5 target is deliberately unmeasured. Before changing its default,
run at least five warm sequential trials per candidate, report median and p95,
and test plugged-in and battery operation, memory pressure/swap, sustained
thermals, parity, OOM, Ctrl+C, and secure erasure.
