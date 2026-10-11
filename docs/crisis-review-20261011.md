# xln crisis review and release priorities

xln has a coherent financial thesis and substantial working machinery. The
current constraint is closing a release across its growing scope. My architectural
judgment is that implementation breadth has outrun evidence that one fixed product
can be used, fail safely, recover and exit. Another rewrite would worsen that gap.

Baseline: `f1464e84e916a65146c046b576a976c4359bcd25`, 2026-10-11, with pre-existing
uncommitted settlement/contract work. [Evidence](evidence/crisis-20261011.json)
separates new checks, historical records and interpretation. This is an engineering
and strategy review, not an exhaustive audit or independent assurance.

Continuation: current `AGENTS.md` narrows launch to TypeScript, React and Ethereum
same-J. Rust and Svelte wallet development are frozen; companies and other
jurisdictions are deferred. The owner's later October 11 instruction includes
lending: savers lend to a bank, borrowers borrow from it, and the bank retains its
liability to savers after borrower default. Earlier broad-scope conclusions below
describe the initial review, not the current release denominator.

## The idea and the outcome

J/E/A models existing finance: jurisdictions enforce, entities authorize, and
bilateral accounts record obligations. Runtime executes and durably delivers their
transitions. Signed accounts let counterparties verify agreement and invoke J when
cooperation fails; ordinary operations need not all be published globally.

MML remains **accounts supporting 51% of world GDP provable and disputable by
2050**. Broad bilateral relationship coverage is how to reach it. Counting accounts
would reward empty relationships; counting payment volume would reward turnover.
GDP attribution must identify underlying value added once. Until an attribution
method is validated, report useful customer activity and enforcement coverage
without converting either into a GDP percentage.

Owner clarification: **credit limits cap accepted unsecured risk; only the
collateral-backed entitlement is secured**. Signed unsecured debt is still debt.
A claim of 100 with 70 allocated collateral has 30 unsecured exposure. A 50 credit
limit permits that exposure; it does not guarantee its repayment. Secured recovery
still uses actual evidence, challenge windows, inclusion and finality.

The principle for development is: **a financial promise is implemented only when
its failure path is executable**. This connects MML to today's work more directly
than feature count, a throughput slogan or a model's approval.

## What the last six months show

Reachable non-merge history in the inspected April 11 to October 11 window contains
**3,752 commits**, including **584 with a refactor prefix** and 241 refactor titles
mentioning splits, moves, extraction, location, size or facades. These are subject
counts, not effort measurements; many refactors establish legitimate ownership.

| Period | Observed development | Implication |
| --- | --- | --- |
| April and May | Runtime adapter and recovery work; release CI at `31753252e` on May 20 | A complete release path was already an explicit objective |
| June and July | 432 and 1,335 non-merge commits respectively; July includes 385 labelled refactors; native TRON integration at `5ba0c7c5a` | Large structural investment needs stable user-flow evidence to retain its value |
| August | 850 non-merge commits; Rust commitment primitives begin at `3d9aa1af2` on August 23, followed by live/parity work | A second engine creates an ongoing obligation to prove the same financial semantics |
| September and October | Native-chain, recovery, typed-reject, wallet and gas-bound work; current scope includes two engines, two wallets, three jurisdictions, lending and companies | Completion must be judged against this explicit matrix, not one green subset |

The tracked documentation inventory contains 147 Markdown files and 82,414 lines,
including generated release snapshots and historical reports. Size is not a defect
count. The actionable problem was stale authority: the owner profile excluded
lending and prioritized Svelte while the current execution loop required lending
and equal UI priority. The active night handoff had 3,566 lines of mixed history.

## Architectural mistakes and their replacement

| Judgment | Concrete evidence | Better action |
| --- | --- | --- |
| Asset admission was confused with custody observation | The runtime imported 127 unsolicited assets into the signed proof; the historical expanded-proof fixture needed 12,657,990 gas | Custody events update agreed assets but cannot add assets. The original signed one-asset/32-payment proof still exits after those donations in 921,213 conservative gas in the new fixture |
| Too many implementations became simultaneous completion obligations | The initial scope required TS/Rust, React/Svelte and three Js | The updated scope now selects TS, React and Ethereum; finish their complete money and recovery paths before reopening deferred features |
| Structural neatness became easier to demonstrate than release closure | Hundreds of refactor-labelled commits coexist with a blocked release preflight | Require a measured reduction in failure, duplication or time to evidence before more structural changes; file counts and line limits are constraints, not success metrics |
| Instructions and evidence have multiple competing homes | Conflicting owner-profile scope; dated `mainnet.md` results presented as current; stale process handles in the active handoff | One live queue, a short execution handoff, canonical specifications and explicitly historical evidence |
| Public claims outran the risk model | Landing copy said loss was bounded by collateral plus credit, and a caption implied one signed frame sufficed to reclaim funds | Explain secured entitlement, chosen unsecured exposure and actual dispute execution consistently |

These are judgments about sequencing and control, not a claim that six months
were wasted. Preserve the useful work: deterministic transitions, canonical money
math, signed authority, WAL/outbox boundaries, exact replay and typed rejection.
They are essential infrastructure for enforceable accounts.

## What is still missing from release evidence

1. **Complete bounded exit and funding compatibility.** The owner's asset-list
   clarification led to a smaller runtime fix: custody cannot enlarge the agreed
   proof. The collateral-positive contract guard and first-funding settlement
   detour were removed. First funding, top-ups, offline exit, signed reopening
   and external withdrawal pass for both sides on the existing contract. React
   funding/exit, recovery, payment and same-J swap pass seven browser cases. One shape
   under 5M does not prove every admitted shape or correlated exit capacity.
2. **Lending within the current scope.** Named borrower facilities, bilateral
   covenants, bounded signed late interest and repayment authorization are now
   implemented; [lend.md](lend.md) defines their limits. Local maturity/default
   and crash recovery pass. The owner's common-bank-pool requirement remains
   unimplemented: allocation still ties each loan to a saver position. A named
   regression rejects a 100-unit draw against two committed 60-unit deposits.
   These existing green tests do not prove pooled-bank semantics.
   Current public-chain enforcement and immutable
   release evidence remain required; neither local tests nor the bank's promise
   guarantee unsecured repayment.
3. **One current candidate with full evidence.** October 9 replay/native-J results
   and October 10 tutorial results are useful historical evidence. They do not
   certify the changed October 11 runtime candidate. The current local contract
   suite passes 202 cases; final replay matches all 498 frames. The recorded
   Sepolia deployment fails current-bytecode identity for all five core contracts
   (block 11889009). Redeploy/verify before real-clock secured, debt and offline
   stale-dispute drills. Stable-candidate CI, live load and operations remain open.
4. **Proven repeat use and executable liquidity.** The [pilot](launch-pilot.md) has
   concrete recruitment and operating targets. It labels 15 interviews and five
   partners as targets, not achieved relationships. This review establishes no
   customer count. A real recurring desk workflow and reliable quotes are the next
   adoption evidence; no contact or spending is authorized by this report.

## What to stop and what to keep

Keep financial correctness, executable dispute, crash/key recovery and usable
funding/payments/same-J swaps on the current TS/React/Ethereum scope. Preserve
pre-freeze Rust and Svelte evidence as history; do not spend the release cycle
repeating checks that the current scope explicitly excludes.

Stop expanding scope while stabilizing the candidate. Defer optional new chains,
new clients, more model-ranking exercises, unmeasured optimization and cosmetic
file splitting. Do not defer a required assertion or hide a currently offered
financial feature merely to improve a completion percentage.

## Release timing and the improvement loop

There is no defensible release date while public-chain enforceability and the
executable gate remain unresolved. The local exit boundary is now green. Align
the production profile, verify the current Sepolia stack, then freeze a candidate
and measure the remaining complete run. The owner excluded the soak gate; do not reintroduce
it as a release requirement. A failed money/recovery gate restarts the affected
candidate verification after its fix.
Only an exact reviewed build and deployment/rollback package goes to the owner
for promotion approval and signatures.

Use [the existing improvement loop](improvement-loop.md): one gap, one owner,
shortest reproduction, smallest canonical fix, same-boundary rerun, then related
evidence. Review the method every 30 minutes. After two attempts without new data,
change observation or hypothesis. Compare net closed gaps per engineering hour
and time to first useful failure over the next two work blocks.

The requested /1000 metric measures evidence coverage for a frozen candidate and
denominator. FAIL and UNKNOWN mandatory gates still block release; 1000 never
means defect-free. This review does not assign an overall score because that
candidate and complete denominator have not been frozen.

The second pass must challenge the retained artifacts under the same criteria.
It must not approve this report because its author agrees with it. The active
queue remains [todo.md](../todo.md), not a new framework or permanent background job.

## Changes and verification from this review

Reconciled owner-profile scope, separated current instructions from archived
history, clarified MML and the credit/collateral distinction, and corrected risk
and inbound-capacity copy in all ten landing languages. The English/Russian
browser views show the correction with no captured console errors or warnings.
Broader landing claims about unlimited scale, competing protocols and CBDCs remain
outside this financial-copy correction and need alignment with the qualified
claims in the canonical introduction before public promotion.

Initial copy review: 17/17 admission/preflight tests and 21/21 caption tests;
frontend build/Svelte check with 0 errors/warnings. Its contract-artifact drift
failure and proposed 22,824-byte Account patch remain historical evidence, not
the selected fix.

Autonomous continuation: 73 TS tests / 437 assertions, 50 native Account tests,
232 native Entity tests, and three real-contract funding/exit regressions pass.
The new receipt rule reports excluded unadmitted rows and preserves their custody
on-chain; it does not promise that an unwilling peer will admit donated assets.
A newer local dispute draft also no longer invents native counter-proof authority:
the named h474 regression failed before that fix and passes after it.

One fresh production WAL contains 498 frames, 9,586 Entity inputs and 9,470 outbox
envelopes. Final TS/Rust W1/W4/W8 replay after the asset fix matches every root and
ordered output; the native evidence predates the freeze. This recording used
130 users and is not a valid production TPS benchmark. `bun run check` passed
before subsequent parallel scope/package edits. The active handoff has the current
first failure and remaining gates. No push or deployment has occurred in this task.

The actual public-proof operator command subsequently exposed stale factory imports,
a missing signed proposer direction and reused EOA nonces. Those paths now pass
a real-clock local deployment/funding/dispute/withdrawal regression (14 assertions,
49.42 seconds in the latest run), including a code-identity rejection before signing. React's hosted
build passes; its deployment now selects an exact reviewed SHA rather than whichever
commit `origin/main` reaches while testing. Its regression also rejects untracked
source before checkout/build, preserving the existing build and revision. React
source now participates in the signed release scope and source-cleanliness gate.

Payload preparation exposed a separate correctness defect: an internal marker
bypassed strict consensus projection, changing bytes for long hex values and
admitting undefined. The fix passes 26 codec/hash checks, exact TS W1/W4/W8 replay
of all 498 frames and seven freshly rebuilt React browser journeys. It leaves
the frozen core unchanged; it is not a demonstrated performance optimization.

The 1,000-user live gate remains red: all 20,000 payments deliver, but W8 drains in
30.387 seconds and W4 in 32.184 against the 25-second limit. Instrumented W8 repeats
also fail; a W32 trial drains in 29.381 seconds. No valid TPS or isolated capacity
improvement is claimed. Worker profiling reproduced the entire immutable WAL and
located signature recovery and serialization costs, but provided no evidence for
another worker-count trial. Production defaults remain unchanged.

The metrics entrypoint now points to its actual CLI, clearing the unwired-file
failure. The latest full check passes 38 source gates plus the frontend and React
checks. These are working-tree results, not an immutable release candidate;
public-chain verification, production-profile closure, live load and the deployment
and recovery package remain open.

The next real-clock rehearsal now covers unsecured shortfalls from both Account
directions as well as secured exit: three operator cases, 64 assertions. An 850-unit
collateral allocation plus a 150-unit unsecured claim pays 950 immediately from
collateral and the counterparty's 100 free reserves; the remaining 50 is verified
in the on-chain debt row. Existing debt and changed bytecode reject before another
transaction. These are atomic token amounts and controlled local identities.

The automatic watchtower drill now uses a real 30-second response window. The
stale proof would give the counterparty 200 of the protected wallet's 300 collateral
units. The production daemon locks the newer proof 12 seconds before the deadline
and finalizes it after expiry; the counterparty receives zero and the protected
wallet's transaction nonce does not change. Both tower cases pass. Public Sepolia
receipts and real network conditions remain unverified; local clock realism does
not remove that gate. The subsequent full source check passes again.

The latest owner instruction restores lending to launch scope, permits open
mainnet participation and authorizes autonomous Sepolia key management/funding/
deployment. A dedicated test signer now lives in macOS Keychain; readback and
the canonical deployment dry run pass. Faucet access remains unresolved and its
balance is zero. No public transaction was broadcast. The former global funding
cap blocker is removed; 16 policy tests retain financial and recovery requirements.

Two lending defects are now reproduced and repaired. A valid overdue repayment
previously failed with `LENDING_REPAY_LOAN_NOT_ACTIVE`. A matured 10,000-unit
deposit at 1% returned only 10,000 when there was no borrower. Late repayment now
works, and the saver independently receives 10,100 at maturity when the bank has
Account payout capacity. Borrower interest belongs to the bank. Repayment or
default during/after saver payout cannot change the agreed payout or recreate
paid capital. Existing committed earnings remain preserved. Early cancellation
does not earn unelapsed deposit interest.

Verification: 46 focused tests / 238 assertions, two freshly rebuilt React
lending journeys with zero skipped tests, and 38 source gates plus frontend and
React checks. Maturity/default cases are Account/Entity evidence, not a public
chain or browser maturity drill. Signed loan/deposit covenants, on-chain term
enforcement, exposure approval and restart evidence remain open; this is not a
release-candidate or mainnet-readiness claim.

The next two reproduced failures are repaired. Distinct savings rates previously
produced identical executable proofs. Savings now live in the signed subcontract
tree and the stock transformer settles principal plus earned simple interest,
frozen at dispute start. Cooperative payout removes that exact claim. Sixteen
Depository cases include both directions and bank insolvency: collateral pays;
any shortfall becomes debt. Delayed finalization cannot inflate interest.

Savings interest and later spending could also exceed the signed credit limit.
The Account now checks aggregate ordinary debt, savings obligations and reserved
work, including projected collateral withdrawals. Limit reductions preserve prior
claims, and top-ups remain admissible. The related suite passes 130 tests / 5,291
assertions; both rebuilt React lending journeys pass. Sixteen gas tests include
80 claims with maximal starter arguments (3,520,680 conservative finalization gas)
and 18 full-width claims (3,460,520), below the 5M transaction budget.

Only DeltaTransformer runtime bytecode changes: 6,714 to 7,745 bytes; new hash
`0x0252d347d8c11dbcda19cba4022c431b26994b39809a135dd1b739ff5f5bfda6`.
Artifacts and TypeChain are synchronized. The full check still fails its
committed-artifact drift gate in this shared, uncommitted tree; the source,
frontend and React checks pass. No release or public deployment is claimed.

The next executable failure is the borrower side: loans owing 2,525 and 2,550
produce identical dispute proofs. Savings storage round-trip evidence is not a
full lending process/WAL restart. Loan authority, borrower enforcement, recovery,
public Sepolia receipts and the live load deadline remain open. The dedicated
Sepolia signer still has zero test ETH; the browser CAPTCHA confirmation remains
pending. The 05:55 UTC method review retains one reproduced financial boundary at
a time and stops blind faucet/worker retries. Migration validation stays at the
storage boundary rather than rescanning historical lending receipts for every proof.

## 2026-10-11 07:11 UTC — signed borrower claims and real wallet boundaries

The borrower proof collision is fixed: both savings and loans use the signed
TermLoan program. Thirty-two real Depository settlement cases cover both claim
kinds, directions, timing and insolvency, with nine existing cases also passing.
The 16 gas tests pass. DeltaTransformer runtime is 7,746 bytes with hash
`0x63fba61efba77634fbceb13be1453d24c7129acea5397889b9c529cfc7d74139`;
all eight other contract bytecodes match HEAD literally. Old unpaid unsigned
claims reject during restore rather than acquiring fabricated signatures.

A real browser WAL now replays exactly across TS W1/W4: 111 frames, 382 worker
operations each, with roots and ordered outputs checked per frame. The generic
HLT exporter could not consume this WAL because ordinary frames lack recorded
canonical-state hashes. Canonical journal replay verifies the recorded output
hashes directly and compares richer evidence between worker counts. No absent
recorded root was fabricated; this is not TPS or full failure-injection evidence.

Wallet shortfall accounting had omitted 50 units of J debt after a 950-unit
reserve payout. Complete debt summaries now preserve the 1,000-unit asset while
keeping the 50 unsecured and unavailable for payment. A 441-debt regression
covers both compact-view truncation dimensions. Automatic Account opening also
silently granted 10,000 USDC of credit; it now grants zero. Savings interest asks
for explicit extra risk consent. The real loan journey then exposed a full
borrower receiving limit; the existing receiving-capacity control is reused.
Three of four browser journeys passed before that final UI fix; the rebuilt
candidate is running. The adapter regression suite passes 97 tests/647 assertions.

Method review: stop expanding scope until the same production journey passes.
Reuse the canonical receive planner, retain full pre-truncation financial
aggregates and distinguish source checks from an immutable release. Approved bank
facilities, signed late terms, current public Sepolia receipts and live-load drain
remain open. Dedicated Sepolia balance is still zero. No public deployment,
commit, push or release-candidate claim is made.

## 2026-10-11 07:29 UTC — current wallet verification and unfunded requests

All four rebuilt wallet journeys pass (53.8s). The remaining payment failure
was stale routing data: the recipient had 8 USDC incoming capacity, but the
borrower still saw 0.05. User profile heartbeats can be one hour. Signed credit
policy changes now publish immediately; normal balance updates retain the
heartbeat policy. The authenticated-socket regression verifies both properties.
The broad related suite passed 226 tests / 5,953 assertions, and the original
111-frame lending WAL remained exact across TS W1/W4 on this source.

The next production boundary was reproduced: a valid request with no matching
pool threw after Account commitment. It now returns a closed liquidity-unavailable
outcome, records a signed bank-frame decline, retains the consumed request ID and
allocates no funds. Twelve local lending tests pass. The rebuilt browser submits
that request, then receives another 100 USDC through the same bank. Both lending
journeys pass together (27.0s); related tests pass 182 / 1,185 assertions.
The resulting 113-frame WAL replays exactly across TS W1/W4, including roots and
ordered events/effects/outbox evidence. Digest:
`ee4e4943fa52e48b243e9232f2f22f86a94c8817be6412e8f5e82c105c75da85`.

The 38 source gates and three outer gates pass. Full `bun run check` still fails
committed-artifact drift. Current-bytecode Sepolia dry-run passes; the dedicated
address has zero test ETH and no broadcast occurred. Bank approval/pricing and
borrower-facing request status remain incomplete. Exact replay does not prove
maturity/default crash handling or public-chain operations. No immutable RC claim.

## October 11 lending authority closure

Bank Entity governance now publishes saver/borrower prices and grants named,
expiring facilities bound to the borrower Account epoch. Actual disbursement still
needs payment capacity and accepted Account risk. Three browser journeys and
129-frame TS W1/W4 replay passed before the next consent correction.

A targeted regression then showed that a bank could create coupon debt without a
prior borrower request. The fix binds funding to the exact signed request, maximum
rate, deadline and epoch, consumes it once, and preserves that authority through
recovery. Local evidence: 44 tests / 518 assertions, 219 related tests, three browser
journeys and exact 132-frame TS W1/W4 replay. All source gates pass. This is release work, not an additional scoring or audit campaign.

Two earlier boundary fixes are also retained: close requests remain retryable after
bank liquidity recovers, and authenticated Account finality retires opening loan
reservations without inventing repayment. A further free Sepolia faucet returned
HTTP 500, `Faucet balance is too low`; the dedicated signer remains unfunded.

The next product pass added bank-officer controls to the existing React wallet:
publish prices, approve a borrower facility and revoke future draws through the
normal authenticated command lane. Borrowers see committed request status. The
current candidate passes 225 tests / 1,652 assertions, three real browser journeys,
130-frame TS W1/W4 equality and all source gates. The full release gate still stops
at uncommitted contract artifacts. These are dirty-tree results, not mainnet approval.

## October 11 signed late-interest boundary

The missing accrual regression expected 10,150 but returned 10,100 after maturity.
Bank-published, borrower-authorized late windows now bind the Account covenant and
Solidity proof. Interest stays simple and capped. Savings remain independent.
A maximum repayment authorization of 2,575 pays only 2,537 when that is the committed
Account quote; the later Entity clock cannot charge extra. Admission reserves the
whole possible coupon. Old unsigned fields fail restore instead of gaining consent.

Current evidence: 263 tests / 1,959 assertions; three browser journeys / zero skips;
133 exact TS W1/W4 frames; 40 settlement cases, nine stock cases and 16 gas vectors.
The 80-claim stress finalization uses 3,623,080 conservative gas against 5M.
Only DeltaTransformer bytecode changes; its 7,867-byte runtime hash is
`0x0771c06db45d23cadb711ffc6c78278399132674c8fd7c739aa7838c6b34dff9`.
All source gates pass. Full check still stops at artifact drift against HEAD.

The browser exposed an omitted strict-ingress field and a fixture startup race;
both were reproduced and fixed before recording the passing WAL. The first gas
failure was an inadmissible test claim exceeding uint256, not an exit-budget
regression; the corrected full-width claim keeps the original 5M assertion.
Public Sepolia remains unfunded. Runtime crash/outbox maturity drills, public
real-clock exits, valid load and immutable release identity remain open.

## October 11 Runtime lending crash recovery

The first real process crash left the bank recording 2,575 repaid while the
borrower remained at 12,500 with an unacknowledged Account frame. Forty Runtime
cycles did not repair it: local outputs were never saved in the WAL outbox.
Retaining them only until RAM enqueue also failed after a capped frame and a
second crash. The canonical ordered outbox now retains local outputs until the
exact authenticated recipient payload commits. There is no second durable queue.

Four SIGKILLs across five processes now recover origination, controlled-clock
default, independent saver close and exact late repayment. The borrower finishes
at 9,925, the saver at 10,050; redelivering recovered output bytes causes no second
debit. These balances are explicit bank IOUs, not fabricated collateral funding.

The current candidate passes 319 tests / 2,173 assertions, three rebuilt browser
journeys and exact 136-frame TS W1/W4 replay. Evidence digest:
`3ccb007dc22ca4073df35f8e07005e482a7e7ebe62cfc9e7e178cb389f0781c6`.
All 38 source and three outer gates pass. Full check still rejects uncommitted
contract artifacts. Public real-clock exits and valid live load remain open;
the next step is a current 1,000-user baseline before any performance change.

## October 11 measured proof construction

The unique-operation ledger confirms 20,000 payments across 1,000 Accounts, with
40,000 unique locks and resolves across their two Account legs. A 1,448-sample W1
replay profile places 26.6% of stacks inside dispute-gas admission. Prefix batching
repeatedly ABI-encoded every growing prefix. The canonical builder now tests the
whole ordered batch first: when its storage atom and both independent uint256
allowances fit, all prefixes fit. Existing greedy overflow splitting is unchanged.

All 352 related tests / 2,253 assertions and three rebuilt wallet journeys pass.
Both the 136-frame lending and 35-frame payment WALs remain exact before/after and
across TS W1/W4. All 38 source and three outer gates pass. Full check still rejects
uncommitted artifacts. The live drain changes from 30,849ms to 28,911ms, but both
fail the 25,000ms requirement. These are N=1 shared-desktop runs, not a stable causal
speedup estimate; no TPS claim follows. Continue from the remaining measured cost.

## October 11 routing publication and lending freshness

A real Entity chat commit cloned the configuration shell, invalidating the
profile cache's reference comparisons despite unchanged policy. Compare exact
policy values and routing edges from the existing canonical descriptor instead.
A second regression proves that first collateral on an existing zero row must
publish the newly visible token even when credit limits and row count stay equal.
No signature verification, financial admission or heartbeat deadline is weakened.

Removing accidental gossip exposed a real React dependency: the bank could commit
an active loan after the borrower's last ACK, while the wallet kept displaying
pending funding. Serial bank-view refresh with superseded-response rejection now
passes the unchanged browser assertions. All three rebuilt journeys pass with
zero skips; 375 related tests and four isolated profile tests pass. A prior grouped
profile run aborted in Bun teardown after passing assertions, and remains failed
evidence. The fresh 110-frame lending WAL is exact through TS W1/W4, including all
R/E/A roots and ordered outputs. All 38 source and three outer checks pass.

The current live run settles 20,000 payments with no pending ACKs in 27,665ms,
still above 25,000ms. Hub signature recoveries fall from 19,289 to 52; this does
not establish a stable speedup from N=1 shared-desktop measurements. A native hex
projection experiment showed no established live benefit and was reverted.
The canonical load uses durable Hub WAL/fsync and RAM-only user lanes; it is not
evidence for persistence of all 1,000 users. Full check still rejects uncommitted
contract artifacts. No public deployment or immutable release candidate exists.

## October 11 checkpoint and remaining live boundary

Gas admission now builds the previous proof only when resolution or idempotent
asset admission needs a before/after comparison. Every successful transition
still checks its entire resulting proof. A new adversarial vector proves an
ordinary payment cannot slip through an already oversized proof. Parent signature
priming now omits dispute signatures that only isolated Account workers verify;
worker verification and canonical financial outputs remain unchanged.

The fixed 35-frame payment and 110-frame lending WALs remain exact before/after
through TS W1/W4. Checkpoint coverage expands to 554 tests / 448,400 assertions,
three real-clock local funding/exit cases, two offline-watchtower cases and three
rebuilt React journeys with zero skips. Two combined test commands hit the 60s
budget; isolated real-clock stands pass without shortening dispute windows.

Production-default load still fails: 20,000 settled, zero pending ACKs,
26,077ms against 25,000ms. Diagnostic counters were disabled; financial checks
and Hub WAL/fsync stayed enabled. Source payments were acknowledged by 20,094ms,
Hub ingress completed at 23,564ms, all delivery at 25,909ms and drain at 26,077ms.
The remaining completion tail needs evidence, not a relaxed deadline. N=1 does
not establish a stable causal speedup. Public Sepolia remains unfunded.

Repeatedly treating intentional synchronized artifacts as an unresolvable drift
was a workflow mistake. A reviewed coherent source/tests/artifacts checkpoint
is the correct next step. Frozen Rust and foreign CI edits remain unstaged;
a local checkpoint does not grant release readiness or mainnet promotion.

## October 11 common bank book and elapsed repayment

The saver matcher was the wrong abstraction. Independent saver liabilities and
borrower facilities now replace per-deposit loan allocation; no loan names a saver.
The bank's existing authenticated facility is its exposure policy, including
approval above deposited principal. Account risk and payment capacity remain
separate. Default cannot replenish synthetic liquidity or change a saver claim.

Cooperative repayment now reuses the existing dispute-clock formula. Half-term
repayment no longer charges the entire term coupon. This deletes a financial
branch without changing Solidity bytecode. The React balance projection consumes
the independent savings quote instead of removed allocation counters.

Evidence: 558 related tests, 87 focused financial cases, three rebuilt React
journeys, 102 fresh WAL frames exact through TS W1/W4, and full check. The common
book also survived four actual SIGKILLs across five processes. All six product
choices are now resolved; demand savings, queued payouts and partial repayment
remain implementation work. No mainnet-readiness or public-deployment claim follows.

## October 11 partial repayment through the same signed claim

The next cutover implements partial repayment without a separate payment engine.
The existing covenant carries remaining principal, rate, accrued interest and
fractional carry. Both cooperative repayment and unilateral exit use that clock;
interest is paid before principal and never compounds. The original end does not
reset. An exact preceding-claim hash prevents a stale partial debit from executing
twice, without adding another durable receipt. The bank uses the same settlement
function, and principal repayment replenishes the approved facility.

Evidence: 562 related tests; 65 production-contract cases; three React journeys;
108 production WAL frames exact through TS W1/W4; five real SIGKILLs across six
processes preserve fractional accrual and outbox redelivery. All 16 gas vectors
pass: 80 claims finalize at 3,930,280 / 5M gas. Only DeltaTransformer bytecode
changes among nine artifacts; runtime grows from 7,867 to 8,326 bytes. Synchronized
ABI/types reject old claim schemas rather than reading them through a fallback.
Full source check passes on source checkpoint `5a2025a81`: 38 source gates and
three outer gates. A rejected non-null assertion was removed by sharing the
validated Account, lowering existing debt from 617 to 616; all 108 replay frames
remain exact. Demand savings, ordered payouts and public Sepolia deployment
remain open; this is not a mainnet-ready release.
