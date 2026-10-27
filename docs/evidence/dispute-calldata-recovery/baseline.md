# Dispute calldata counterexample baseline

Run on Mac Studio, Bun 1.4.3, before any production edits.
Actual checkout: detached `9dd6a67e45a8b5ebc1f7df13a03b302f876828d3`.
Local main and origin/main: `7ac40d39e`; all three relevant watcher production
files and both existing calldata test files are identical at these commits.
The sandbox denied `git switch main` at `.git/index.lock` (Operation not permitted).
Implementation and both requested commits remain blocked; nothing was pushed.

## New counterexamples: 1 passed, 10 failed, 5.70 seconds

Command: `bun run stand:run --reason dispute-calldata-old-counterexamples -- bun test core/__tests__/jurisdiction/rpc/rpc-watcher-calldata-counterexamples.test.ts`

The stand was free before acquisition and held throughout the run. One run per
reported timing; these are local regression measurements, not throughput data.
Recovery timings exclude fixture creation and signing, but include transaction
authentication. Test durations include fixture creation/signing and assertions.

| Case                                                                         | Old result                                                           |                  Recovery ms | Decoded bytes |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------: | ------------: |
| (a) 33,892-byte actual, 120 nested decoys totaling 27,076 bytes              | Body not found                                                       |                         71.9 |       156,260 |
| (b) 3,108-byte actual, 15 nested decoys totaling 3,044 bytes, 192-byte steps | Body not found                                                       |                          8.1 |        15,844 |
| (c) 2,048 canonical decoys in 1 MiB                                          | Body recovered; decode-work assertion fails                          |                      1,552.8 |       792,192 |
| (d) 1,900 nested canonical wrappers                                          | Body not found                                                       |                        602.6 |       982,820 |
| (e) Direct call carrying decoys in signature bytes                           | Body recovered; decode-work assertion fails                          |                         29.8 |        59,904 |
| (e2) Decoys preceding a valid direct-call encoding                           | Body recovered; decode-work assertion fails                          |                         41.9 |        51,840 |
| (f) Two polls with an instrumented decoder-byte ceiling                      | Generic identical evidence-not-found; operator-error assertion fails | See test duration, 170.05 ms |  Not recorded |
| (g) Three-level finalized body recovery                                      | Body not found                                                       |   See test duration, 5.47 ms |  Not recorded |
| (g2) Three-level finalization sidecar recovery                               | Empty evidence                                                       |   See test duration, 5.31 ms |  Not recorded |
| I6 forged body claiming the event hash                                       | Correctly rejected                                                   |   See test duration, 6.37 ms |  Not recorded |
| I3 inconsistent offset chains                                                | Body recovered; decode-work assertion fails                          |                      1,170.4 |         5,760 |

The small authenticated body's ABI encoding is 608 bytes. Decode-work assertions
require no more than one matching body's bytes, as specified by the chosen design.
The observers forward calls to the genuine ethers decoder; only (f) deliberately
throws a typed resource error once cumulative decoded bytes exceed calldata size.
The current implementation has no explicit budget API, so (f) uses this tripwire
to expose swallowed decoder exhaustion and repeated generic lookup failures.

## Existing checks on the unchanged production code

- `bun run stand:run --reason dispute-calldata-existing-watcher-baseline -- bun test core/__tests__/jurisdiction/rpc/rpc-watcher-dispute-calldata.test.ts core/__tests__/jurisdiction/rpc/rpc-watcher-calldata-scan.test.ts`: 15 passed, 0 failed, 2.15 seconds.
- `bunx tsc --noEmit -p .`: exit 0, 0.480 seconds command wall time. The root
  tsconfig excludes test files; this does not establish test-file type coverage.
- `bun tools/soundcheck.ts`: exit 0, 10/10 gates; slowest gate eslint-ratchet,
  14,878 ms. Full output is in `old-soundcheck.txt`.

Full raw outputs are the adjacent `old-*.txt` files. The broad jurisdiction
watcher suite, `bun run check`, post-fix timings and three-AI fix confirmation
remain outstanding. No implementation or completion claim is made.

Next: enable Git writes and switch this clean-source checkout to main; commit
the design, new tests and baseline evidence first, then implement and verify.
Both commit messages must end with `Co-Authored-By: Codex <noreply@openai.com>`.
