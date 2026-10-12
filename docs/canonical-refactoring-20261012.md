# Canonical refactoring review — 2026-10-12

One financial responsibility should have one production implementation per
engine. Separate trust boundaries, platform transports and independent test
oracles remain separate. The release engine is TS; the frozen Rust engine was
reviewed without modifying it or restoring its parked changes.

Reviewed source: `b07da2b8762d3398683f3f2c481ee65a8caedc41`.
First implemented and verified candidate: `005f5cd5ba69bbe44a9941e9a5b3a933ad8f90c2`.
This is a static refactoring review plus a bounded implemented patch, not a
complete security audit or mainnet acceptance.

## What was actually inspected

Eight reviewers mechanically indexed all **4,051 tracked TS/TSX/Rust/Svelte
source files**, including tests, generated bindings and reference code:
**1,082,237 physical lines**. The repository had 6,074 tracked files; other file
formats were inventoried and relevant dependencies inspected selectively.
Focused semantic reading covered regions in **236 assigned files**. The other
3,815 files were mechanically screened; their correctness is not attested.

| Area | Indexed files | Files with focused semantic reads |
| --- | ---: | ---: |
| Runtime, storage, transport | 698 | 24 |
| Entity and books | 357 | 34 |
| Account, protocol, Hanko | 301 | 43 |
| Jurisdiction, API, tower | 565 | 17 |
| Rust and TS bridge | 661 | 23 |
| React, frozen Svelte, browser tests | 794 | 33 |
| Tooling, QA, release | 462 | 23 |
| Brainvault, native, custody, proofs, archive | 213 | 39 |

The [per-file ledger](evidence/canonical-review-20261012/coverage.json) distinguishes
review depth. [Detailed findings](evidence/canonical-review-20261012/findings.json)
retain each reviewer's exact paths, semantic caveats and proof commands; overlapping
findings are not additive savings. These are static proposals, not passing gates.

The existing XLN-1000 collector measured **816 files / 161,062 code lines** in
the transitive kernel closure, versus 539 declared files / 95,315 code lines.
It found 137 infrastructure and 21 tooling edges leaving the declared kernel.
This is the relevant starting point for audit size, not the million-line physical
repository total. [Baseline and collector inputs](evidence/canonical-review-20261012/baseline.json)
are retained; ledger and CI were disabled, so no overall readiness score is asserted.

## First patch: fewer implementations, one reproduced financial bug fixed

| Change | Retained owner | Evidence |
| --- | --- | --- |
| Remove Move's second outgoing-debt scan | Exact runtime `debtTotals.outgoing` | 21 claims of 50 against 1,500 reserve: old UI reported 500; correct result 450. The 21st token was omitted entirely by bounded details. |
| Remove duplicate output coalescing | `runtime/delivery/pending.ts:dedupeEntityOutputs` | Routing and durable pending outputs share the same merge; accepted order, input copying and equivocation rejection remain. |
| Delete unused readiness executable | `scripts/dev/readiness/wait-dev-backend-ready.ts` | Retired copy differed only in its relative import; all tracked callers already use the retained path. |

Measured diff: **94 non-test source lines removed net**, 82 regression-test
lines added; **12 source lines removed net including tests**. The folder-width
ratchet tightens from 12 to 11 after the file deletion. No financial assertion
or required scenario was removed.

On the clean committed candidate: **90/90 focused tests, 867 assertions**;
`bun run check` passed, including all **38 source gates**. The locked real local
browser stand passed **3/3, zero skipped/flaky**: Move LEFT, Move RIGHT, and
reserve funding with 22 real seconds without mining. Two independent static
diff reviews reported no actionable findings. These do not cover every Move
route, every E2E, or public Sepolia P6.
[Commands, results and retained logs](evidence/canonical-review-20261012/verification.json).

### Follow-up: one overload policy and exact restore evidence

The public Sepolia watcher repeatedly restarted a 2,048-block range after RPC
429/timeouts. Its existing shrinking-window policy handled only Runtime mempool
pressure. The same branch now handles both, removing three production lines net.
A real Anvil forwarding proxy reproduces 429 and a real HTTP timeout: the old
controller retries 2,048 blocks, while the fixed controller reads 512 and then
delivers the original event beyond 4,700 blocks without skipping history.

Three CI runs exposed the same restore-test race: the tower replaced a displayed
snapshot before discovery, but the test still requested the older frame from a
newer restored baseline. The test now binds its exact root and Account comparison
to the selected snapshot. No importer, retention or financial assertion changed.

Clean source `50281daaa`: 60/60 focused RPC tests, 284 assertions. The selected
snapshot browser journey passed 1/1 on `0ff079f41`; its full check and the base-PR
candidate `999396327` both passed 38 source gates. Public P6 remains unproved:
RPC catch-up timed out before reaching the already-funded reserve. No extra
funding or stale-state attack was submitted by those retries.
[Exact commands, source bindings and retained logs](evidence/canonical-review-20261012/rpc-restore-followup.json).

### Implemented: production no longer depends on QA

Pure Account causal tracing now belongs to Runtime observability. The scenario
CLI owns ASCII formatting, including the existing frame-step stop. Both production
HTTP entry points no longer mount the QA API; its tooling implementation remains.
No financial transition, trace content or debug-stop timing changed.

On clean `34fec4412`: 53/53 focused tests with 1,912 assertions, full check with
38 source gates, and one real React payment/reload journey passed with zero skips
or flakes. The live orchestrator returned 404 for `/api/qa/health`. The unchanged
financial path passed `lock-ahb`, 85 frames, on preceding `2b2c1081c`.

The existing collector measures kernel closure **161,031 → 160,577 code lines**
and **816 → 815 files**. Reachable QA code falls **533 → 0**, with **3 → 0**
direct kernel imports. The net closure reduction is 454 lines because the pure
trace remains reachable under its actual owner. This is a static kernel closure,
not the whole server bundle; the 1,412-line QA handler was disconnected, not deleted.
All 18 remaining tooling edges point to `core/rscore`, whose reachable 11,691
code lines include active TS code that cannot simply be removed.
[Exact measurements, commands and retained logs](evidence/canonical-review-20261012/qa-boundary.json).

The next CI failure separated browser readiness from financial behavior: a
shared history-row locator focused Home after the URL changed but before Activity
mounted. One existing Activity-only readiness assertion fixes the test; the real
keyboard/resize journey and 38 source checks passed on clean `ca96f041d`.
[Retained trace diagnosis and execution evidence](evidence/canonical-review-20261012/receipt-navigation.json).

CI run 38200437268 on `f257ad8eb` passed its E2E job and five other jobs, but its
jurisdiction unit shard timed out in the backlog fixture. A full local shard
passed 444/444 on `f48eca1a`; the CI-only cause remains unresolved. Gate handshakes
now fail explicitly if a poll completes before the expected request, preserving
all assertions and the 60-second limit. That diagnostic change on clean `8d7f1e742`
passed its focused case, all 444 jurisdiction tests, and 38 source checks.
[Diagnostic scope and retained logs](evidence/canonical-review-20261012/watcher-gate-diagnostics.json).

The next public P6 attempt found an earlier boundary than RPC throughput:
recovery failed at Runtime frame 14. On clean `c4566fd81`, replay through frame
13 succeeds. Changing only the restored `JReplica.rpcs` from its committed
publicnode URL to the configured public proxy reproduces frame 14's exact
recorded hash. The restore binding had changed committed state outside WAL.
The original funded database and its forensic copy remain unchanged.
[Exact hashes and retained diagnostic](evidence/canonical-review-20261012/p6-replay-rpc-diagnosis.json).

This changes the immediate order: keep RPC selection in live infrastructure,
prove two successive restores with exact Runtime roots, then explicitly recover
the affected profile before resuming P6. Excluding the field from hashes or
silently patching replay would hide the original failure. At the 04:15 UTC method
review, the useful change was to test recovery before another network retry;
the first offline reproduction took 0.535 seconds. The release gap is reopened,
not closed by identifying its cause.

## Target ownership and deletion sequence

The live queue stays in [todo.md](../todo.md). This table is the reviewed design,
not another backlog or an instruction to run all changes together.

| Boundary | Canonical form | What goes away | Required proof before removal |
| --- | --- | --- | --- |
| Production versus QA | Runtime owns pure causal trace; scenario CLI owns formatting; money servers expose only their production API | Both QA HTTP mounts; both Runtime paths to the 465-line ASCII formatter | Real startup/payment, pre-intake debug stop, preserved scenario diagnostics, measured import closure |
| TS execution | Account transition owns money; Runtime workers distribute the same transition | Retired Rust authority selectors/hooks; active TS code moves out of `core/rscore` with no alias | Reject retired launcher selectors before spawn; same WAL roots and ordered outputs inline/W1/W4, recovery and checkpoints |
| Wallet reads | One browser-safe runtime route query; exact runtime Book/debt aggregates | Embedded route-policy copy, Account-page depth reconstruction, local swap scale/orientation and batch counter copies | Missing-profile/relay refresh, read-lease ordering, depth beyond detail limits, real pay/swap journeys |
| Proof encoding | One low-level ProofBody codec per language; builder, JBatch and tower consume it | Four TS production hash owners; Rust manual-versus-ethabi duplication | Exact Solidity ABI bytes, Int512 extrema, uint256 widths, transformer order; avoid batch→builder import cycle |
| Identity recovery | Existing strict Brainvault shard collector owns result admission | React lax hex/result acceptance and duplicated hosted validator | Wrong spec/request/index, duplicates, abort and malformed result rejection before wallet creation; browser/native mnemonic agreement |
| Matcher | One production matcher; canonical commitment hash | `debugRebuildProjectionOnly` mode enabled only by two tests; weak diagnostic `computeBookHash` | Same matching/settlement/reject economics; keep actual preview semantics and useful failure diagnostics |
| Release execution | Existing release runner owns suites; preflight owns deployment-specific evidence | Deferred lending blocker, repeated suite/process runners, Svelte source-marker surrogate | Current production typed rejection, full required React journeys, exit/recovery/owner signoff preserved |
| Rust restore, after freeze reopens | Existing batch/checkpoint boundary owns one Account ABI decoder | Process/restore AccountTx and checkpoint decoder copies | Error-context adapters, nil-versus-empty-tuple boundaries, malformed vectors and exact TS/Rust WAL comparison |

The Rust Account/checkpoint candidate could remove **500–900 lines**; the Rust
proof codec **70–130**. These are estimates before implementation, not measured
savings or a reason to unfreeze Rust. Active TS worker code is **3,857 physical
lines in 14 files** inside `core/rscore`; deleting that directory would break TS.
The TS driver is 1,154 lines, but retained diagnostic/checkpoint consumers must
be traced before claiming those lines removable.

The reviewed baseline mounted the same **1,412-line QA API** in two production
hosts. That removal is now implemented and measured above. Moving the causal
trace corrects ownership, not size.

## Boundaries that must not be flattened

- Paybook, Swapbook and Lendbook may share naming and module shape; their state,
  clocks, authority and scheduling semantics do not justify a generic book or
  Runtime/Entity/Account reducer. Lending admission stays disabled for this release.
- TS and Rust are distinct engines with common protocol vectors. Within each,
  remove duplicate codecs and state owners; keep differential verification independent.
- Frozen Svelte is not deletable wholesale: React has 48 import references in
  36 files into its helpers/resources. Move a shared owner only after tracing consumers.
- Preserve the 100 generated TypeChain files via their generator, 69 vendored
  dependency files, 37 historical references and 28 independent proof sources.
  Their presence is not evidence of a second production feature.
- Rejected naive deletions: default-credit helper also rejects token 0; two
  faucet observations guard different freshness facts; tower recovery and RPC
  decode different external formats; checksum normalization differs by boundary.

One further concrete mismatch needs a TS-only regression: JBatch accepts
`cooperative: true` through a real ABI round-trip although current Account.sol
always rejects it. Keep the ABI field as literal false and remove the dead
TS branch; do not alter live cooperative settlement or contract bytecode.

## Method result

The best finding came from duplicate **authority**, not a textual clone: bounded
debt details were incorrectly treated as a total. Prioritize replicated policy,
hash preimages, financial aggregates and recovery decoders before small helpers.
All future deletion candidates must name their non-equivalence risks before
implementation. This rule rejected several unsafe apparent simplifications here.

The existing [30-minute loop](improvement-loop.md#reflection-that-changes-the-next-action)
remains the only method: one tested change, stable diff, measured closure/source
delta, then reassess from failures. A heartbeat is scheduled in the current chat;
unchanged state stays quiet. It improves instructions and working choices, not
model weights, and creates no external-model spending authorization.
