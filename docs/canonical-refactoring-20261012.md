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

## Implemented ownership changes

| Removed duplication or wrong owner                                          | Canonical owner and preserved behavior                                                                                                                                | Evidence                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Move's second outgoing-debt scan                                            | Runtime `debtTotals.outgoing`; 21 claims of 50 against 1,500 reserve correctly leave 450, including tokens omitted by bounded details                                 | [First patch](evidence/canonical-review-20261012/verification.json)                                          |
| Duplicate output coalescing and unused readiness executable                 | Existing ordered output merge and retained readiness runner; equivocation still rejects                                                                               | [First patch](evidence/canonical-review-20261012/verification.json)                                          |
| Runtime imports of QA and both production QA HTTP mounts                    | Runtime owns pure tracing; scenario CLI owns ASCII; tooling retains QA handler                                                                                        | [QA boundary](evidence/canonical-review-20261012/qa-boundary.json)                                           |
| Ordinary launcher Rust selectors, authority propagation and build preflight | TS-only production launch rejects retired selectors before process preparation                                                                                        | [Launcher](evidence/canonical-review-20261012/ts-only-launcher.json)                                         |
| Active TS workers and Entity stages under `core/rscore`                     | Runtime owns 14 worker modules; Entity owns execution stage, inbound arrivals and leaf cache; no compatibility alias                                                  | [Worker boundary](evidence/canonical-review-20261012/ts-worker-evidence.json)                                |
| RPC binding mutating committed state on restore                             | Live infrastructure owns configured RPC selection; restored Runtime roots remain exact                                                                                | [Two cold restores and profile repair](evidence/canonical-review-20261012/rpc-transport-recovery.json)       |
| Independent handling of watcher overload                                    | Existing window reduction handles mempool/RPC pressure; one cancellable cooldown controls manual and automatic polling; retained pressure prevents immediate regrowth | [Real proxy regressions](evidence/canonical-review-20261012/watcher-pressure-window-7d3134853.json)          |
| Watcher re-fetching authenticated history after restore                     | Start from existing contiguous history, audit its canonical anchor/frontier, retain Entity-certified semantic progress                                                | [Restore regression and public funding](evidence/canonical-review-20261012/restored-frontier-88f14ce5f.json) |

The last static measurement (`942385253`) is **158,880 kernel-closure code lines in
815 files**, versus **161,062 / 816** at the review baseline: **2,182 fewer
reachable code lines**. Direct QA imports are **0**; direct `core/rscore` imports
are **2**, down from 11 before the recorder retirement, reaching 6,998 lines.
Storage/recovery still imports the native driver transitively; this is not yet
a Rust-free kernel. [Exact collector and verification](evidence/canonical-review-20261012/record-retirement-942385253.json).

Moving 3,857 worker lines corrects ownership and is not deletion. The QA handler
was disconnected, not deleted. The two RPC-pressure fixes add 27 physical
production lines net; the restored-frontier fix adds another 11. Closure and physical-line deltas are different measures;
no overall XLN-1000 readiness score is asserted without CI and ledger inputs.

## Current verified boundary and remaining failures

On clean financial source `7d31348533a5b9694d3fb67ecc8b287ad72c3532`:

| Check                             | Result                                                      |
| --------------------------------- | ----------------------------------------------------------- |
| Related watcher tests             | 104/104; 947 assertions                                     |
| Full `bun run check`              | 38 source gates                                             |
| Real React payment and reload     | 3/3; zero skips or flakes                                   |
| `lock-ahb`                        | 85 frames                                                   |
| Current-contract funding and exit | 25/25; 512 fuzz invocations; eight compiler templates match |

[Commands and retained logs](evidence/canonical-review-20261012/watcher-pressure-window-7d3134853.json).
The gas cap is per operation, not the sum of a whole dispute. Largest printed
finalization is 4,453,117 gas; one-token start/finalize samples are
449,300 / 399,142. Printed fuzz samples are not claimed maxima. Local time warp
does not replace public real-clock evidence.

The subsequent clean source `88f14ce5f3727d5fab4353d8b836a1d4db66c7f0`
passes 104/104 related tests with 951 assertions, all 38 source gates and
3/3 React payment/reload journeys with zero skips or flakes. The restore
regression retains canonical anchor checks while forbidding duplicate reads of
already authenticated intermediate blocks. Contract and `lock-ahb` results
above remain bound to their earlier SHA, not relabelled as this candidate.

On the preceding worker source `f163415eb`, a real mixed production WAL has
708 frames, 2,600 delivered payments and 1,040 matched swaps across 130 user
Runtimes. TS W1/W4/W8 reproduce every root and ordered output; checkpoint and
full recovery pass. Each replay retains one final outbox item: this is neither
a fully drained stand nor qualifying TPS. The historical 498-frame transcript
fails identically at height 12 on both baseline and candidate. Both results
remain in the [worker evidence](evidence/canonical-review-20261012/ts-worker-evidence.json).

The candidate is **not ready to merge**:

- Two frozen TS fixtures still import the relocated worker's old path. The
  [exact two-line patch](evidence/canonical-review-20261012/ts-worker-frozen-imports.patch)
  awaits the owner's narrow exception to the explicit no-write rule for `rscore/`.
  No alias or skipped assertion hides this failure.
- PR #73 remains on older `72c38fa4b`: six of seven required pull-request jobs
  pass; Unit Tests fail four cases already fixed locally. Fresh eligible CI
  requires closing the fixture failure first. A successful manual workflow
  dispatch does not satisfy required PR checks; protection remains unchanged.
- [Public P6 on clean d388464db](evidence/canonical-review-20261012/public-p6-d388464db.json)
  proves real-clock external counter/finalization and local cold recovery:
  R142, reserve 200 Test USDT, collateral zero, no active dispute or pending
  Account frame; 127 retained frames pass integrity. Start/counter/finalize
  gas is 1,161,420 / 460,487 / 250,134. Original funding and payments were
  preserved through two harness failures; only the tower RPC allowlist changed.
- The deployed hub remains older `7c3f63f98` and **failed** on those same tower
  events, then stopped. Current code contains both decoder fixes, but full
  public-system P6 and deployed recovery are not passed. Local recovery retains
  one undeliverable outbox message. Required CI, ten consecutive green main
  runs and the owner-reviewed mainnet release package remain open.

Clean source `2d2115dc8cd2694cad4672d49ba7b08482098de2` removes the always-null
retired Entity-stage handle, its accept/discard bookkeeping and partial-stage
array: **155 physical production lines deleted net**, plus a **126-line real
regression** (29 fewer source lines overall). TS candidates, checkpoints and
recording remain. The signed two-leg regression passes before and after: the
first valid leg is visited, the second signature rejects, both full Entity/Account
snapshots remain unchanged, no outboxes are published, and an intact retry
matches the clean control.

All six checks for this bounded patch passed on that clean source:

- 34 related tests / 1,249 assertions and all 38 source gates.
- The same 708-frame production WAL is exact on TS W1/W4/W8, including ordered
  outputs; each retains one outbox item as before. This is not TPS.
- React payment/reload: 3/3, zero skips/flakes/unexpected results.
- Real Sepolia counter/final calldata and receipts pass the canonical decoder;
  the original Result proxy and repeated signature reproduce the old failures.
  The changed start-receipt block passes seven actual-receipt/mutation checks.
- The stopped deployed hub's private cold copy restores at R4474 with 128/128
  retained frames verified. It stops at block 11897541 before the counter;
  network effects were disabled by the existing read-only loader. This is not
  deployed catch-up, and its Account correctly still records the active dispute.

[Immutable commands, results and limitations](evidence/canonical-review-20261012/null-stage-2d2115dc8.json).
The next clean source `8584d3ce0af99290c1fd226831dad8f03cf530f3` removes
unread capture/cursor maps and three write-only driver fields: **49 physical
production lines deleted net**, including import formatting. Independent static
review found no blocker; 45 related tests / 1,204 assertions and all 38 source
gates pass. Recorder scope, arm, checkpoint validation and WAL fail-stop remain.
The prior WAL, browser and chain results above retain their original SHA: they
were not rerun for this bounded deletion.

Clean source `9423852536ae7cc4fa4c14765169691761b52228` removes the entire
1,215-line live authority recorder, its Account/Entity/Runtime hooks and 201
lines of orphan wire builders. Canonical WAL recording remains. `RECORD=1`
now rejects explicitly at launch, executor installation and replay entry.
Prepared commit caches, selected transactions, occurrence/input positions,
effects, roots and storage formats are unchanged. The real H0 assertions moved
to the existing Account-resource tests; only retired collector tests disappeared.

The complete cut is **1,615 fewer physical production lines**, **872 fewer test
lines** and one fewer replay-CLI line, across 34 files. Deleted tests do not
improve a pass-rate denominator. Independent static review found no blocker.
All five checks pass on the clean committed source: **147/147 tests / 1,906
assertions**, all **38 source gates**, the same **708-frame WAL on W1/W4/W8**,
**3/3 React payment/reload** with zero skips/flakes/errors, and the measured
closure above. Each WAL replay still retains one outbox item; no TPS, fresh
public-chain result or deployed-hub recovery is claimed.

The next release action is to resolve the two frozen TS fixture imports and run
required PR CI before promoting a reviewed build. Do not restart the known-broken
old hub or repeat the financial transactions to hide a deployment-version gap.

The next code boundary is the two remaining native driver calls plus their
storage/recovery consumers. Preserve TS WAL crash classification and checkpoint
export; retiring old native persistence requires rejection before projecting
away its refs. Removing only the two imports would not eliminate that dependency.

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
