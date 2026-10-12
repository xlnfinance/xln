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

| Area                                         | Indexed files | Files with focused semantic reads |
| -------------------------------------------- | ------------: | --------------------------------: |
| Runtime, storage, transport                  |           698 |                                24 |
| Entity and books                             |           357 |                                34 |
| Account, protocol, Hanko                     |           301 |                                43 |
| Jurisdiction, API, tower                     |           565 |                                17 |
| Rust and TS bridge                           |           661 |                                23 |
| React, frozen Svelte, browser tests          |           794 |                                33 |
| Tooling, QA, release                         |           462 |                                23 |
| Brainvault, native, custody, proofs, archive |           213 |                                39 |

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

| Change                                  | Retained owner                                    | Evidence                                                                                                                                |
| --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Remove Move's second outgoing-debt scan | Exact runtime `debtTotals.outgoing`               | 21 claims of 50 against 1,500 reserve: old UI reported 500; correct result 450. The 21st token was omitted entirely by bounded details. |
| Remove duplicate output coalescing      | `runtime/delivery/pending.ts:dedupeEntityOutputs` | Routing and durable pending outputs share the same merge; accepted order, input copying and equivocation rejection remain.              |
| Delete unused readiness executable      | `scripts/dev/readiness/wait-dev-backend-ready.ts` | Retired copy differed only in its relative import; all tracked callers already use the retained path.                                   |

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

That prospective fix is verified on clean `042026fe0`: **20/20 tests, 82
assertions**, all four real RPC SIGKILL boundaries and **38 source gates**.
The existing regression now checks the Runtime root after the first restore,
a new committed event, a second restore and adapter recreation. Production code
shrinks four lines net; the unconsumed RuntimeState export is now private.
No snapshot field or hash-verification exception was added.

The affected private profile passed all five offline stages: a wrong RPC value
is rejected; the evidenced value allows ordinary verification of original
frames 14–16; the existing signed-bundle importer creates a separate checkpoint;
two cold restores preserve financial roots, Account envelopes and both outboxes.
The original WAL is archived unchanged. This deliberately creates a new frame
chain; its checkpoint hash is not represented as the original WAL hash.
[Proof, archive digests, script and retained logs](evidence/canonical-review-20261012/rpc-transport-recovery.json).

Live startup from that checkpoint succeeds. Public RPC 429/timeouts then limit
the next 60-second trace to 576 authenticated blocks, before the funding event;
no financial transaction is submitted. That is the next unresolved boundary.
Both predecessor PR candidates now have seven successful CI jobs, including E2E:
[PR 71 run](evidence/canonical-review-20261012/ci-38201621912-final.json) and
[PR 72 run](evidence/canonical-review-20261012/ci-38202183279-final.json).
The final combined candidate still needs its own required CI.

The uninterrupted 160-second P6 follow-up still did not reach the existing reserve.
A bounded raw-response capture identifies PublicNode's HTTP 429 / -32005 quota
error. Neither of two alternative public providers passed basic availability;
configuration is unchanged. The 04:45 UTC method review replaces repeated long
retries with first-error capture and resumes the independent TS launcher cut.
[Retained evidence and availability limits](evidence/canonical-review-20261012/p6-rpc-quota.json).

### Implemented: ordinary launch has one engine

On clean `f774dbb70`, the existing selector rejects Rust, embedded authority and
shadow activation before dev preparation, process cleanup or Hub spawn. The
68-line Rust build preflight and authority propagation are deleted. Native
diagnostic helpers remain; active TS worker isolation is a separate unfinished cut.

Measured source delta: **69 non-test lines removed net**, **25 including tests**.
Verification: **52/52 tests, 427 assertions**, including twelve real rejected dev
launches; **38 source gates**; and **3/3 real React payment journeys**, zero skips
or flakes, through three TS Hubs. The payment journey verifies reload recovery.
[Clean-source commands, browser results and retained logs](evidence/canonical-review-20261012/ts-only-launcher.json).

Combined predecessor `c6215ccd3` passed all seven CI jobs, including E2E, in
[run 38204500382](evidence/canonical-review-20261012/ci-38204500382-final.json).
It was a manual workflow_dispatch run. GitHub does not evaluate those jobs as
required PR checks, so merge remains blocked; the next combined candidate must
run through the ordinary pull_request event. This is a CI invocation correction,
not a test failure or permission to bypass branch protection.

### Implemented: TS workers belong to the Runtime

Fourteen active TS worker modules now live under `core/runtime/workers/account`.
The Entity execution stage, inbound arrivals and leaf cache live with their
Entity owners. All active production callers use these paths directly; no
compatibility barrel or second executor was added. This moves 3,857 physical
worker lines; it does not delete them. Six newly visible oversized functions
were split into bounded execution phases without changing positional ordering.

The existing collector measures kernel closure **160,573 -> 160,531 code lines**
and direct kernel imports into `core/rscore` **18 -> 13**. The closure has 816
files, one more than before this cut. Remaining reachable `core/rscore` code is
8,418 lines: driver, recorder and checkpoint ownership still require work.
This is a modest ownership improvement, not a Rust-free kernel.

On clean `f163415eb`, the real production stand recorded **708 Runtime frames**,
2,600 delivered payments and 1,040 matched swaps across 130 user Runtimes.
TS W1/W4/W8 each replayed all 708 frames with identical roots and ordered
effects; checkpoint and full recovery both passed. One final outbox item
remains in each replay report, so this is not evidence of a fully drained stand
or qualifying live TPS. Focused tests passed **234/234, 158,704 assertions**;
the full check passed all 38 source gates.

The older 498-frame transcript fails at height 12 with the same output-hash
mismatch on both the baseline and candidate. That negative evidence remains;
the fresh recording does not establish historical compatibility. Two stale HLT
decoder schemas were fixed by requiring fields already emitted by the real
RuntimeAdapter projectors. Tests now consume those real projectors; strict
missing/unknown-field rejection remains, with no lending implementation change.

The browser build exposed a tracked generated worker bundle. It is now ignored
and rebuilt through the existing generator, like the runtime bundle; source
and isolated build-artifact hashes remain enforced. Clean `e6fd12883` passed
three payment journeys. After removing unrelated formatting changes, clean
`d723e5827` passed the full check and `lock-ahb` (85 frames). These are separate
source bindings, not a claim that every release gate passed on one SHA.

The cut is **not ready to merge**. A focused lifecycle test cannot resolve the
old worker path from two TS fixture files inside owner-frozen `rscore/`.
The exact two-line import repair is awaiting the owner's narrow exception;
neither Rust implementation nor frozen fixtures have been changed. PR #73's
older head has six of seven required CI jobs green; its four known failures
were repaired locally, but this new fixture failure must be closed before push.
[Source bindings, failures, measurements and retained evidence](evidence/canonical-review-20261012/ts-worker-evidence.json).

The next bounded deletion removes always-null retired Entity-stage handles
and accept/discard bookkeeping, approximately 120 physical lines and two
kernel imports. Preserve the live TS execution stage and checkpoint tooling.
Before that deletion, add the missing real two-leg atomic rejection regression:
valid first signed Account input, invalid second signature, both original roots
and empty outboxes, then an intact retry. Existing sibling-cascade tests do not
prove this specific rollback case.

### Verified transport follow-up

The first RPC window reduction did not control request frequency. A real
forwarding proxy reproduces a retry only 9.535 ms after a 429. One cancellable,
monotonic cooldown now belongs to the existing watcher single-flight path,
shared by automatic and manual polling. A second regression shows the next
successful window expanding despite retained pressure: scanned height 1,536
instead of 1,024. The same pressure state now gates that existing window growth.
No second scheduler, committed field or financial formula was introduced.

On clean `7d3134853`, **104/104 related tests**, **947 assertions**, **38 source
gates**, **3/3 real React payment journeys**, **lock-ahb with 85 frames**, and
**25/25 funding/exit cases with 512 fuzz invocations** pass on the same SHA.
The eight Foundry/production compiler templates match. The preceding clean
`1d780ff75` also verified the public contract stack against its current linked
artifacts and checked Depository bindings; the reads were not block-pinned.

The local gas bound is per operation, not the sum of a whole dispute. Largest
printed finalization is 4,453,117 gas; the minimum one-token start/finalize
samples are 449,300 / 399,142. Printed fuzz samples are not claimed maxima.
Local time warp does not replace public real-clock evidence.

Public P6 is still incomplete. Two bounded traces retain 429 failures; the
second scans 1,048 blocks and last observes Runtime height 36 with reserve 0.
It does not reach the funding event or submit a dispute. Those sampled values
are not represented as post-shutdown state or a controlled throughput comparison.
The next direct-upstream trace also encounters 429: 940 authenticated blocks,
last observed Runtime height 40 and reserve 0. Switching routes has not solved
catch-up. A single successful identical-range probe per route proves availability
only. [Transport evidence](evidence/canonical-review-20261012/public-rpc-transport-d81a0ed9f.json)
retains both results. The next offline diagnostic compares restored authenticated
history with the watcher's old semantic start cursor before another network run.
The frozen TS fixture import exception and required PR CI also remain open.
[Exact source bindings, commands, failures and retained logs](evidence/canonical-review-20261012/watcher-pressure-window-7d3134853.json).

The existing static collector now measures **160,552 kernel-closure code lines
in 816 files**, versus **161,062 / 816** at the review baseline: **510 fewer
reachable code lines**. QA imports stay at zero and `core/rscore` imports at 13.
These RPC fixes add 27 physical production lines net; the fresh closure includes
that cost. No overall XLN-1000 readiness score is asserted without CI and ledger.

## Target ownership and deletion sequence

The live queue stays in [todo.md](../todo.md). This table is the reviewed design,
not another backlog or an instruction to run all changes together.

| Boundary                           | Canonical form                                                                                               | What goes away                                                                                                       | Required proof before removal                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Production versus QA               | Runtime owns pure causal trace; scenario CLI owns formatting; money servers expose only their production API | Both QA HTTP mounts; both Runtime paths to the 465-line ASCII formatter                                              | Real startup/payment, pre-intake debug stop, preserved scenario diagnostics, measured import closure                                 |
| TS execution                       | Account transition owns money; Runtime workers distribute the same transition                                | Retired Rust authority selectors/hooks; active TS code moves out of `core/rscore` with no alias                      | Reject retired launcher selectors before spawn; same WAL roots and ordered outputs inline/W1/W4, recovery and checkpoints            |
| Wallet reads                       | One browser-safe runtime route query; exact runtime Book/debt aggregates                                     | Embedded route-policy copy, Account-page depth reconstruction, local swap scale/orientation and batch counter copies | Missing-profile/relay refresh, read-lease ordering, depth beyond detail limits, real pay/swap journeys                               |
| Proof encoding                     | One low-level ProofBody codec per language; builder, JBatch and tower consume it                             | Four TS production hash owners; Rust manual-versus-ethabi duplication                                                | Exact Solidity ABI bytes, Int512 extrema, uint256 widths, transformer order; avoid batch→builder import cycle                        |
| Identity recovery                  | Existing strict Brainvault shard collector owns result admission                                             | React lax hex/result acceptance and duplicated hosted validator                                                      | Wrong spec/request/index, duplicates, abort and malformed result rejection before wallet creation; browser/native mnemonic agreement |
| Matcher                            | One production matcher; canonical commitment hash                                                            | `debugRebuildProjectionOnly` mode enabled only by two tests; weak diagnostic `computeBookHash`                       | Same matching/settlement/reject economics; keep actual preview semantics and useful failure diagnostics                              |
| Release execution                  | Existing release runner owns suites; preflight owns deployment-specific evidence                             | Deferred lending blocker, repeated suite/process runners, Svelte source-marker surrogate                             | Current production typed rejection, full required React journeys, exit/recovery/owner signoff preserved                              |
| Rust restore, after freeze reopens | Existing batch/checkpoint boundary owns one Account ABI decoder                                              | Process/restore AccountTx and checkpoint decoder copies                                                              | Error-context adapters, nil-versus-empty-tuple boundaries, malformed vectors and exact TS/Rust WAL comparison                        |

The Rust Account/checkpoint candidate could remove **500–900 lines**; the Rust
proof codec **70–130**. These are estimates before implementation, not measured
savings or a reason to unfreeze Rust. At the reviewed baseline, active TS worker
code occupied **3,857 physical lines in 14 files** inside `core/rscore`; those
files now live under Runtime. The reviewed TS driver was 1,154 lines, but retained
diagnostic/checkpoint consumers must be traced before claiming those lines removable.

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
