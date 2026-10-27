# Dispute calldata recovery implementation

Checkout HEAD: `20afadf2ec1cadbe8d8000e44b58dd12c5b1b30d`. Files are uncommitted for coordinator integration;
no Git command wrote repository state. All execution was on Mac Studio.

Immutable review artifact: `implementation.patch`, SHA-256 `2f60b176b54953ed07dd0519232d5033a54d0ecccaf2e5107f5894fc096b3b50`.
It contains the three production files, design update and new regression tests.

## Result

The receipt-authenticated reader now enumerates raw canonical spans, tests the
direct call first, authenticates the event-bound proof-body hash before decoding,
and materializes only matching bodies. Nested wrappers do not recurse; decoys
have no shared decode/candidate budget to exhaust. Raw span hashes and validated
bodies are memoized. Resource errors remain typed and evict the transaction cache.
Finalization sidecars retain the existing event-commitment resolver and delegated
watchtower empty-signature semantics. EVM authentication avoids duplicate getter
hashing while recomputing the complete signed envelope; native TRON is unchanged.

## Counterexamples: 11 passed, 0 failed

One final run, Bun 1.4.3, with the stand lock held. CLI wall time 2.797 seconds;
Bun reports 2.71 seconds. These are local regression timings, not TPS.
Recovery includes transaction authentication, excluding fixture construction/signing.
Test time includes fixture construction/signing and assertions. A dash means the
test does not instrument that metric.

| Case                                       | Result |  Test ms | Recovery ms | Decoded body bytes |
| ------------------------------------------ | ------ | -------: | ----------: | -----------------: |
| (a) 33,892-byte actual / 120 nested decoys | PASS   |   100.92 |        21.3 |             32,512 |
| (b) 3 KB actual / 15-level shorter decoys  | PASS   |     8.50 |         2.0 |              1,728 |
| (c) 2,048 canonical decoys / 1 MiB         | PASS   | 1,084.22 |       361.2 |                608 |
| (d) 1,900 nested wrappers                  | PASS   |   330.88 |       130.5 |                608 |
| (e) direct call with signature decoys      | PASS   |    22.76 |         6.7 |                608 |
| (e2) preceding decoys                      | PASS   |    22.59 |         6.9 |                608 |
| (f) retry after decoder resource ceiling   | PASS   |    62.02 |           — |                  — |
| (g) nested finalized body and sidecar      | PASS   |     3.77 |           — |                  — |
| (g2) independent sidecar recovery          | PASS   |     2.35 |           — |                  — |
| I6 forged body with copied event hash      | PASS   |     4.43 |           — |                  — |
| I3 inconsistent offset chains              | PASS   |   957.29 |       349.4 |                608 |

Each decode-work assertion passed. Case (c)'s one-second assertion measures
recovery (361.2 ms), not the total test (1,084.22 ms).

## Checks

| Check                                                           | Result                               |        Wall seconds |
| --------------------------------------------------------------- | ------------------------------------ | ------------------: |
| `bunx tsc --noEmit -p .`                                        | PASS                                 |               0.143 |
| `bun run check:runtime-types`                                   | PASS                                 |               1.043 |
| `bun tools/soundcheck.ts`                                       | PASS, 10/10 gates                    |              14.797 |
| Counterexamples                                                 | PASS, 11/11                          |               2.797 |
| Jurisdiction watcher files plus two related root evidence files | 133 pass, 6 setup failures           |               5.974 |
| Additional recovery regressions (final isolated run)            | PASS, 8/8                            |       Bun: 166.00ms |
| `bun run check`                                                 | BLOCKED, compiler-cache lock timeout | failed gate: 62.054 |

The root tsconfig excludes core tests; runtime type checking additionally covers
the changed production files. Three new recovery regressions were included in
the broad watcher run. Five additional signed-envelope cases subsequently passed
for types 0–4, each also rejecting substituted calldata. No production edits
followed the recorded final counterexample, runtime-type and soundcheck runs.

The broad watcher command selected every watcher-named test under
`core/__tests__/jurisdiction`, all tests in its `watchers` directory, plus
`j-watcher-finalization-evidence.test.ts` and
`j-watcher-watchtower-finalization.test.ts`. Its full command and output are in
`post-watchers.txt`. The 15 existing calldata tests passed.

## Remaining verification blockers

All six broad-suite failures occur in setup at `server.listen(0, '127.0.0.1')`
with `EPERM`, before the integration assertions. Four affected files:

- `watchers/j-watcher-backlog-drain.test.ts`: three setup failures.
- `watchers/j-watcher-receipt-root.test.ts`: one setup failure.
- `adapter/state-anchor/watcher-board-anchor.test.ts`: one setup failure.
- `watchers/admission/j-watcher-counter-dispute-reimport.test.ts`: one setup failure.

The failed beforeAll hooks prevent the remaining tests in those suites from
being verified; the output's 139 count is not full integration coverage.

`bun run check` failed before its source gates because Hardhat could not acquire
`/Users/zigota/Library/Caches/hardhat-nodejs/compilers-v3/compiler-download-list`
within 60,000 ms. No lock was removed, gate bypassed, or failing test weakened.
No tracked contract artifacts changed. See `post-full-check.txt`.

Three-AI confirmation remains with the coordinator as sole Quorum reservation
owner; this worker made no external-model calls or spending reservations.

Next: coordinator runs the blocked integration files and `bun run check` in its
normal Studio environment, obtains the required reserved reviews of this patch,
and commits the owned files after those gates pass.
