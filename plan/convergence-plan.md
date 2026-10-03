# Convergence plan

Written 2026-10-03 for Arthur, from a fresh read of `adimov-eth/og_xln` at `development` 87f352ac (checkout in the thread's scratchpad; `git rev-parse origin/development`). It assumes none of the current thread arrangement. Every number carries its source in a `[proof: ...]` tag; `{unverified}` marks what I did not check. No time estimates: nobody can see how long a run or a person takes.

## The result

We are closer on the scripted path than on Done. Twelve of thirteen end-to-end steps run, but the checks that make Done mean something are not built: no readable spec, no walk over the new code, and the old 48,410-line `xln.ts` still sits in the tree as the thing the walk judges. The shortest path is three pieces of work, in this order:

1. Write the dispute and HTLC machine once, as one document with one model, then prove the code follows it by replay on the real contracts.
2. Move the walk onto the new code and delete `xln.ts` and the og-parity rig.
3. Run it once on live Sepolia, with a trace-capable RPC.

Everything else (more PRs, more review rounds) is the current route to the same place, only slower.

## 1. Where we are, per Done item

| # | Done item | State | Evidence |
|---|---|---|---|
| 1 | Compact spec of Account, Entity, J, Runtime, no open questions | **Not met.** Two sets of models, no document. | Arrival: 5,768 `.scm` lines outside the vendored checker [proof: `find spec -name '*.scm'` minus `spec/arrival`]. Quint: 62 `.qnt` files, 8,701 lines [proof: `wc -l spec/quint/*.qnt`]. Question logs: 1,569 and 795 lines, each with open points left [proof: `spec/QUESTIONS.md:257` "OPEN: R-FRAME-SIGNATURE-NAMES-ACCOUNT"; `spec/quint/QUESTIONS.md:181` "Open point"]. The nearest thing to a readable spec is `spec/quint/OVERVIEW.md`, 153 lines, Quint only [proof: `wc -l`]. |
| 2 | Contracts reviewed, every encoding pinned by a contract-made vector | **Reviewed and deployed; the pinning is incomplete.** | Review has C1, C2, H1 to H4, M1 to M3 with decisions [proof: `plan/contracts-review.md` headings; `plan/contracts-decisions.md`]. Eight contracts on Sepolia since 10-01 [proof: `contracts/deploy/sepolia.manifest.json`, `contracts/deploy/README.md`]. Vectors exist for batch, hanko, proof hash, lifecycle [proof: `ls contracts/vectors`]. The calldata decoder, which the node now relies on for money, is tested against "its own test encoder" [proof: `pure/j/calldata/decode.test.ts:43`]. The same test file has no mention of a deployed-contract vector [proof: `grep -n "vector\|deployed" decode.test.ts` found nothing]. |
| 3 | `xln.ts` cut to the spec, passes the relief test | **Half done, and the other half is the problem.** The new tree exists; the old file is untouched. | New tree: 11,441 source and 19,343 test lines across `account chain entity host j kernel market runtime` [proof: per-directory `wc -l` on development]. `pure/xln.ts` is still 48,410 lines, last edited 09-29 [proof: `wc -l`; `git log -1 -- pure/xln.ts`]. The relief test has no instrument: the style README says it is "not mechanically checked" [proof: `pure/style/README.md:33`]. The tree gate at zero baseline does cover every new directory [proof: `pure/rules/tree/gate.ts:17` `NOT_GATED` omits them]. |
| 4 | Walk checks the spec's properties every frame against real contracts; mutants killed; CI green | **Not met for the new code.** CI is green; the walk judges the old code. | Of 97 files under `pure/diff/`, 74 import `xln.ts`, none imports any new directory, and the files import og `core` 581 times [proof: `grep` over `pure/diff`, run this session]. The new stack's only randomized test, `pure/runtime/chaos.test.ts`, runs two model Runtimes with no chain [proof: file header lines 1-10]. Register: 126 live rows need a rig cell, 2 hold (C1, C11), 124 are owed [proof: python count over `pure/rules/register/*.json`]. Last push run on development is green, 37 minutes [proof: run 37091621724, 02:58:19 to 03:35:30]. |
| 5 | Contracts on testnet, nodes run one scripted run: open, pay, HTLC across hubs, swap, loan, dispute | **12 of 13 on an anvil fork of Sepolia; nothing has run on Sepolia.** | S0 to S8, S10, S11, S12 done; S9 (dispute with an open HTLC) blocked [proof: `e2e/skeleton-status.md` table]. The run is on an anvil fork with anvil dev keys, 16.8 s [proof: same file, header]. The last repeated count recorded there is at `ca96254ca`, not at 87f352ac [proof: same file, "Merged-head count (10-02 20:58)"]. |

### The scope tension, resolved

Done item 5 lists a swap and a loan. Your D3 decision (10-01 02:53) took a two-party swap inside an Account and left loans to v2 [proof: `pure/rules/register/R-SWAP-CONSENT.json` source field; `R-ENTITY-SWAP-COMMANDS.json`]. The project instructions were never edited, so they still say loan. **Edit item 5 to: open, pay, HTLC across two hubs, two-party swap in an Account, dispute (including one with an open HTLC).** The swap step is already done (S7). Loans stay v2.

Two gaps from the 09-30 consolidation plan are also settled in practice, and I would write them down:

- Cross-J and the watchtower are out of v1 as "diligent online party" (D5). The plan marks D5 decided by the coordinator, not by you [proof: `plan/consolidation-plan.md:480`]. Confirm it in writing.
- The Host transport is no longer unowned. It exists as 3,621 source lines under `pure/host/`, with a transport spec page `spec/transport/link.scm` [proof: per-directory `wc -l`; `ls spec/transport`].

### Where I disagree with the coordinator's picture

- **"The Quint models were written after the code."** Half true. The contract-level dispute game was specified first: Arrival's dispute page 09-29 16:26 and `chain.qnt` 09-29 17:33, before `pure/entity/chain.ts` (10-01 05:58). What came after the code is the node-level lifecycle: `dispute.qnt` 10-02 14:34, `htlc.qnt` 10-02 14:51 [proof: `git log --diff-filter=A` on each file]. That is the layer where every audit finding sat. The spec had the chain's rules and not the node's duties.
- **"Were the two specs compared?"** Once, for the Account layer, on 09-30: fourteen differences found, one Quint bug among them [proof: `review/account-comparison/spec-comparison-account-2026-09-30.md`]. No other layer was compared Arrival against Quint. The fifteen `SPEC-COMPARE-*` files for #162, #165, #167 and #171 compare a model against a builder's code head, which is a different check [proof: `find review -name 'SPEC-COMPARE*'`].
- **"12 of 13 on the merged head 87f352ac."** The recorded repeated counts stop at `ca96254ca` [proof: `e2e/skeleton-status.md`]. Development has merged more since. Re-count before quoting it.
- **Register as a progress meter.** 65 of 160 live rows have an Arrival or Quint cell held, 20 have both; 28 rows are fully held across all five layers [proof: python count over the register]. The gate checks names, not runs, so none of these numbers shows a property was walked [proof: `pure/rules/README.md`, "The gate is a naming gate"].

## 2. The real risk

Your view is right about disputes, and I would sharpen the cause. Two things together:

**The contract gives the chain four ways to learn a secret, and only two leave an event.** `revealSecret` writes the registry and emits `SecretRevealed` [proof: `DeltaTransformer.sol:426-436`]. A secret passed in a dispute start shows up in `DisputeStarted`'s argument bytes [proof: `Account.sol:43-57`]. A secret passed at finalize is treated as evidence inside a `view` function and leaves nothing: `DisputeFinalized` carries two hashes [proof: `Depository.sol:142-148`; `DeltaTransformer.sol:289-310`]. So the node has to read calldata from traces, through wrappers, and wait for those reads. That is the whole of PR 171's four failed audit rounds. The cause is structural, and it will keep producing findings until the node's duties are written as one machine.

**The checking layers never meet.** Models cover the chain's rules. Tests cover the code's functions. The walk covers the old code. Nothing replays a model's adversarial sequence through the real node against the real contracts. A model cannot catch an encoding bug; a vector can. A function test shares its author's misreading, which your own instructions say. A replay of model traces on the real stack is the only check that catches a wrong sequence, and it does not exist.

The consequence shows in the numbers: 124 of 126 rig cells owed, and the rig stream has been dormant since 10-01 15:07 [proof: `plan/backlog/rig.md` mtime and its "Nothing open" line; one commit under `pure/diff` since 10-01 14:00]. The builder meanwhile moved the e2e count from three to twelve. Done item 4 has been parked while the scripted path had a builder.

Second-order risks, smaller:

- **Quint is random search, not proof.** Apalache does not finish the Account at depth 3 and completed only states 0 to 2 for J batch [proof: `spec/quint/PROGRESS.md`, Evidence]. "All mutants killed" shows the properties bite on sampled traces. It does not show the space was covered, and Quint mutants do not run in CI [proof: `review/development/0c251720.md` C7].
- **A trace-capable RPC is a hard dependency.** The manifest RPC answers -32601 to call tracing {unverified, from the coordinator's memory}, and value-bearing nodes require it by decision.
- **Dev review verdict, "don't promote", is mostly stale but not fully.** B1 and A1 are fixed on later heads; A2 (a renamed killer breaks the register ratchet against main) and A3 (main's ruleset does not require Quint or Arrival) were not re-checked at 87f352ac [proof: `review/development/0c251720.md`, updates].

## 3. What to stop doing

- **Stop counting e2e steps as progress.** The next step, S9, proves one more path. The walk proves the paths nobody scripted. Count walked properties and killed mutants.
- **Stop adding to the og-parity rig.** `pure/diff/` is 25,791 lines and gained 2,262 lines since main [proof: `wc -l`; `git diff --shortstat origin/main origin/development -- pure/diff`]. It judges the code we are deleting.
- **Stop patching a dispute rule one audit round at a time.** The DESIGN document for 171 is the right move; the rule is: a dispute or HTLC timing change starts in the lifecycle document, then the model, then the code.
- **Stop one-off spec comparison per builder head.** Replace it with a machine replay in the push job (step 3 below).
- **Stop adding register rows without a rig predicate for money rows.** The register already has 124 owed rig cells.
- **Stop demanding a duplicate Arrival and Quint spec for every layer.** See section 5.

## 4. The shortest sequence

Each step names what it proves and how we would know it is done.

**Step 0. Decisions (you, no engineering).** Item 5 text; D5 confirmation; trace-capable Sepolia RPC; scope call on the duplicate spec. See section 5.

**Step 1. Land what is cleared; no new patches.** PR 171 is cleared by Review A at `8fbd2a8ab` [proof: `review/pr-171/REVIEW-A.md`, memory `e2e-builder-state`], 176 is stacked on it, 177 is a draft [proof: `list_pull_requests`]. Merge in order, fix only findings, then S9 and S9b. *Proves:* the HTLC-in-dispute path on the real chain once. *Done when:* 13 of 13, five runs in a row from a clean checkout on the merged head, the counting rule already in `e2e/skeleton-status.md`.

**Step 2. Write the dispute lifecycle once.** One document, `spec/dispute-lifecycle.md`, in the node's terms: an Account's states across Entity, Host and chain; the four ways a secret reaches the chain and which the node can see; reads and depth; every deadline as one inequality table (the memory holds the current ones: hold-to-read safe iff HOP >= SLK+PD+RD+LAG). The pieces exist: `review/pr-171/DESIGN-watch-wait.md`, `review/spec/MODEL-reveal-registry-and-clock.md`, `spec/quint/DISPUTE.md`, `dispute.qnt`, `htlc.qnt`. The document is the first chapter of the compact spec of Done item 1; Account, Entity, J batch and Runtime chapters follow by lifting from `spec/quint/OVERVIEW.md`. *Proves:* the node's duties are one machine, not a pile of fixes. *Done when:* every dispute, HTLC, freeze and watch row in the register holds in the spec cell and the code cell and names a rig predicate; both QUESTIONS files have no OPEN; a script in the gate fails on an OPEN.

**Step 3. The conformance walk on the new stack.** This is the critical path and the piece that has been parked. Build it on what exists: `testnet-e2e/lib/cluster.ts` already boots four nodes with WAL, journal, key and ports against anvil in 16.8 s for the whole run [proof: `ls testnet-e2e/lib`; `skeleton-status.md` header]. Add: (a) the properties in `pure/diff/rig/properties/` (1,255 lines: belief, enforce, properties) ported to read the new Accounts; (b) money conserved (R-CONSERVE) and "the chain pays what both sides believed" per frame; (c) weather from `chaos.test.ts` (loss, reorder, crash); (d) dispute scenarios replayed from the lifecycle model's ITF traces, so a model's adversarial sequence runs through the real nodes and contracts. *Proves:* the properties hold on the code that ships, every frame, on fresh seeds. *Done when:* three seeds run in the push job; the mutant list covering money, deadline and consensus code (the per-PR `mut*.py` files under `review/` merged into one) runs against it on a schedule and every mutant dies or is named an equivalent; survivors recorded at present (#148 two, #155 two, #156 three, #158 two) are killed or retired [proof: `review/pr-148/REVIEW-A.md`, `pr-155/REVIEW-A.md`, `pr-156/REVIEW-A.md`, `pr-158/REVIEW-A.md`].

**Step 4. Delete the old stack.** When step 3 is green on three consecutive push runs: remove `pure/xln.ts`, `xln_run.ts`, `pure/diff/`, `oracle.test.ts` and the og isolation tests. `pure/` goes from 113,094 lines to about 38,700 before the walk's own code is added [proof: python sum over `pure/**/*.ts` minus those paths, run this session]. The consolidation plan decided to freeze the old file and delete it once at the end (D1) [proof: `plan/consolidation-plan.md:476`]. Keep `core/` and `jurisdictions/` untouched; the frozen check still guards them. v2 draws (order book, lending, boards) go to `legacy/` as D1 said. *Proves:* Done item 3, and that nothing hides behind the old file. *Done when:* the relief test, which has no instrument, is a named review checklist of five lines applied to every file under `account chain entity host j kernel market runtime` by a reviewer who did not write them.

**Step 5. Close the contract pins.** List every reader of chain bytes: `pure/j/log.ts`, `pure/j/watch.ts`, `pure/j/calldata/decode.ts`, `pure/host/shell/codec/value.ts`, `pure/chain/hanko/hanko-verify.ts` [proof: grep for decoders in `j host chain entity runtime`]. For each, one vector made by the deployed contract (an `eth_call` result or a log from an anvil run), not by our encoder. Start with the calldata decoder. *Proves:* Done item 2. *Done when:* the register has a vector row per reader and the gate fails on a reader without one.

**Step 6. Live Sepolia, no value.** Run S0 to S12 once on the live chain with test tokens. The fork cannot show block-time jitter, reorgs, RPC lag or provider limits, which the HTLC give-up arithmetic depends on (D9 left the depth "from the LAG measurement") [proof: `plan/consolidation-plan.md:484`]. I did not find a recorded LAG measurement {unverified}. *Done when:* the run is green twice and the measured LAG and depth are written into the lifecycle document's inequality table.

**Step 7. Promote.** `development` to `main`: one `promote/<sha>` PR, a fresh whole-branch review, your word. Fix A2 first (restore the renamed killer title) and make `One gate` a required check on main [proof: `review/development/0c251720.md` A2, A3]. After step 4 the diff is mostly deletion.

I recommend against redeploying the contracts. A contract change emitting finalize-time secrets would remove the trace dependency and most of the read-wait machinery, but it reopens a reviewed, deployed set, regenerates every vector, and delays steps 3 to 6. A trace-capable RPC key is cheaper for testnet. Record it as a gate before mainnet, where the same cause would cost real money.

## 5. What needs you

| Need | Why | When |
|---|---|---|
| Edit project instructions item 5 (swap in, loan out) | The Done list contradicts D3 | now |
| Confirm D5 in writing (cross-J and watchtower out of v1) | Decided by the coordinator only | now |
| A trace-capable Sepolia RPC, or a key for one | Value nodes require call tracing; the manifest RPC fails it {unverified} | before step 6 |
| Sepolia ETH for four test wallets, and your word to run live | The deployer key is only on your Mac "Jam" {unverified, memory}; the run needs funded wallets and no key of yours | step 6 |
| Relax "complete duplicate in Quint" for Entity consensus, Runtime and the lifecycle | Where models sit beside real contracts and a replay, a second hand-written model buys less than the replay; keep the duplicate where the money rules are decided (Account done; chain dispute game once) | now |
| "Merge to main" | Your rule | step 7 |
| Main's ruleset to require `One gate` | `One gate (quint)` and the Arrival shards are not required on main [proof: `review/development/0c251720.md` A3] | step 7 |

## 6. Structure of work

The sequence needs four roles, not sixteen streams (the thread table lists sixteen [proof: `plan/threads.md`]):

- **Spec owner (one).** Writes the lifecycle document and the compact spec; owns QUESTIONS to zero; owns the models and the ITF traces. Does not read code to decide rules; reads it only when comparing.
- **Node owner (one).** The current builder's job: merge 171, 176, 177, then S9 and S9b, then the deletion in step 4. One PR is one change.
- **Walk owner (one).** The step 3 work. This is the role parked since 10-01. It cannot be the node owner, who then judges their own code with their own predicates.
- **Breaker (one, independent).** Reads only the spec, never the code, and writes attacks as model traces and mutants. This is Review A's role pointed at the spec first. Its output is the replay input of the walk.

Merging is mechanical: merge on green fast checks, as R-GATE-CI-SPLIT already says [proof: `.github/workflows/build-and-test.yml:185,250,289` seeds, Quint, Arrival skip on PRs into development]. The push run (37 minutes) is the judge. Red development is fixed forward and nothing else merges, as now. Per-PR reviews stay for money code only.

## Appendix A. Measured numbers, with commands

| Number | Value | Source |
|---|---|---|
| Development head | 87f352ac, push run green | `git rev-parse origin/development`; run 37091621724 |
| Commits ahead of main | 423 commits, 202 merges; 550 files, +38,105 / -1,873 | `git log origin/main..origin/development`; `git diff --shortstat` |
| `pure/` total | 113,094 lines | `wc -l` over `pure/**/*.ts` |
| `pure/xln.ts`, `xln_run.ts` | 48,410 and 187 | `wc -l` |
| `pure/diff/` | 25,791 lines | `wc -l` |
| Cut tree source | account 1,526; chain 951; entity 1,898; host 3,621; j 2,138; kernel 498; market 506; runtime 303; total 11,441 | per-directory `wc -l` |
| Cut tree tests | 19,343 | same |
| Register | 161 files, 160 live, 1 retired | `ls`; `retired_by` |
| Register cells (live) | arrival: 38 hold, 68 owed, 53 n/a, 1 stale. quint: 47, 61, 51, 1. contract: 26, 5, 129. rig: 2, 124, 34. ts: 121, 28, 11 | python count |
| Killers named | 961 ts tests, 137 Quint mutants, 116 contract tests, 113 Arrival bugs | python count |
| Open PRs | #171 (Review A cleared at 8fbd2a8ab), #176 (stacked on 171), #177 | `list_pull_requests`; `review/pr-171/REVIEW-A.md` |
| CI on PRs into development | `gate-static` and `gate-tests` only; seeds, Quint, Arrival, Runtime Checks and Frontend Build skip | workflow `if:` lines 185, 250, 289, 412, 458 |
| CI on push and schedule | all of the above; seeds are 3 matrix jobs | same |
| e2e | 12 done, 1 blocked (S9) | `e2e/skeleton-status.md` |

## Appendix B. Reading order for the next owner

1. `plan/convergence-plan.md` (this).
2. `spec/quint/OVERVIEW.md`, then `spec/quint/DISPUTE.md`.
3. `review/pr-171/DESIGN-watch-wait.md`, `review/spec/MODEL-reveal-registry-and-clock.md`.
4. `review/development/0c251720.md` (the promotion review).
5. `e2e/skeleton-status.md`, then `testnet-e2e/lib/cluster.ts`.
6. `pure/diff/rig/properties/*.ts` for the predicates to port.
