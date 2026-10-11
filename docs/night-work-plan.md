# Current xln execution handoff

## Current SHA

Current HEAD `041d7dbc2`, main, 2026-10-11; runtime fix `d10bcc0ff`, coherent
checkpoint `5d38b5d9b`. Other writers committed CI/tooling as `d226d476d` and
`041d7dbc2`; those are not this task's changes. This task has not pushed.
Read-only Account proposal selection is committed locally. Frozen Rust remains dirty.
TS only, React only, Ethereum same-J, lending included. Rust stays frozen.
Work solo. Preserve frozen Rust, foreign CI edits and unknown-owner HANDOFF.md.
Dedicated Sepolia key management, free faucet funding and deployment are authorized.
Mainnet participation is open; exact-build promotion/signatures remain owner-controlled.
Credit limits bound unsecured risk; only collateral secures recovery. A bank owes
its saver despite borrower default. [todo.md](../todo.md) is the live queue.
Latest owner clarification: use a common bank pool per jurisdiction/asset, with
no saver-to-borrower allocation. All six policy answers are now explicit: launch
term and demand deposits, allow bank-approved lending above deposits, queue due
payments by maturity then request admission, charge actual elapsed loan interest,
apply partial repayments interest-first, and automatically draw within signed
borrower facilities. Prefer one signed obligation mechanism and delete duplicate
allocation code. Implement outstanding product terms without further approval.

## Last green command

Bank simplification and elapsed loan interest: 558 related tests / 448,443
assertions / 46 files / 31.38s; 87 focused financial tests / 796 assertions;
18 release-fixture/registration tests / 122 assertions. Three rebuilt React
journeys pass with no retries or skips (39.23s). The borrower pays exactly the
interest at its signed Account frame, while a saver can close independently.
Fresh 102-frame production WAL is exact through TS W1/W4 for all R/E/A roots and
ordered outputs. Full check passes: 38 source gates (26,972ms), three outer gates.
No Solidity bytecode changes were needed: cooperative repayment now reuses the
existing dispute clock. Common-book changes alone also passed 109-frame W1/W4
replay, three browser journeys and four real SIGKILLs across five processes.

Preceding candidate: proposal selection reads Account replicas instead of claiming
them for writing. The real-worker regression fails before the change with two
write claims, and passes after it with zero; actual materialization still claims
writes. Focused tests: 28 passed / 107 assertions. Related suite: 554 passed /
448,400 assertions / 34.74s, including actual SIGKILL recovery. Payment (35 frames)
and lending (110 frames) remain byte-for-byte exact in their per-frame root/output
evidence through TS W1 and W4. Three rebuilt lending browser journeys pass.
No verifier, protocol deadline or live-load criterion changed. Full check passes:
two short gates, 38 source gates (27,755ms), three outer long gates. The first
full run rejected the new test's folder width; moving it to the existing authority
test folder fixed that boundary without changing any assertion.
Release integrity also passes: 59 tests / 462 assertions / 16.03s and one
real-contract Foundation release Hanko test.

Two stale release fixtures are repaired in the working tree: native watchtower
appointment construction returns `{ uploads, failures }`, and Pull uses the
current typed transformer batch with explicit `loans: []` and Int512 offdeltas.
Combined focused verification: 9 tests / 59 assertions / 842ms. Runtime-contract
type checks pass (34 files, 93 relative imports). `bun run check` passes again:
38 source gates, source wall 27,632ms, three outer long gates. This does not run
or satisfy the new bank-pool regression below.

Previous committed candidate:
`bun run check` passes: two short gates, 38 source gates and three outer long gates;
source wall 27,640ms after the local outbox marker fix.

The payment/swap bootstrap reproduced a fatal strict-codec rejection of a Runtime
authority symbol. Outbox matching now uses the existing canonical WAL payload
encoder without mutating signed inputs or changing consensus hashing. The named
regression fails before the fix. All six rebuilt payment/swap journeys pass,
zero skips/flaky retries, 54.354s. Related recovery: 37 tests / 108 assertions,
including four actual SIGKILLs. The 110-frame lending WAL remains exact through
TS W1/W4. Full check passes. This closes the new production blocker.

Checkpoint regressions: 554 passed, 448,400 assertions, 46 files, 34.76s.
Isolated real-clock Anvil proofs: three passed / 64 assertions / 148.00s;
secured exit and both orientations of a shortfall recover 850 collateral plus
100 available funds, retaining 50 debt from a 150 unsecured claim.
Offline-wallet watchtower: two passed / 130 assertions / 46.74s.
The two earlier combined commands exceeded their 60s budget and remain failures;
separating real-clock economic stands preserves every financial assertion.

At the preceding checkpoint, nine React journeys passed: three lending,
three funding/exit and three recovery. Browser dispute deadlines use a private
clock advance; separate CLI economic proofs above use real time. Four actual
SIGKILLs across five processes preserve origination, controlled-clock default,
saver close and repayment, including a local ACK deferred across another crash.
Exact output redelivery causes no second debit. This does not prove public-chain exits.
The 110-frame lending and 35-frame payment WALs remain exact before/after both
gas-charge and Hanko-priming changes through TS W1/W4: every R/E/A root and
ordered output. No redundant parent dispute-signature warming is needed when
the Account worker owns verification; all actual verifiers remain unchanged.

Unchanged contract evidence: 40 settlement + nine stock cases and 16 gas vectors.
80-claim finalization costs 3,623,080; 18 full-width claims cost 3,483,560 / 5M gas.
Only DeltaTransformer differs from the base, runtime 7,867 bytes, creation 7,893:
`0x0771c06db45d23cadb711ffc6c78278399132674c8fd7c739aa7838c6b34dff9`.
Artifacts and TypeChain are synchronized; eight other contracts match literally.

## First red command/error

The common-bank regression now passes for 100 and 150 draws against two 60-unit
deposits. Loans have no saver fields; saver allocation counters and matcher are
deleted. Signed facilities authorize bank exposure and Account rules still own
payment capacity. Focused validation: 53 tests / 465 assertions. Real WAL recovery:
four SIGKILLs across five processes, 15 assertions, 8.87s, preserving default,
saver withdrawal and duplicate repayment delivery. Browser and source checks pass.
Remaining product boundaries: demand savings, due/request-ordered withdrawal
servicing and partial repayment in the same signed covenant. Early repayment now
uses the existing elapsed-time dispute calculation; both orientations, cold
restore, real browser debit and fresh replay are verified above.

The runtime release command, after both fixture repairs, stops after 77 tests on
`core/__tests__/rscore/parity/cross-j-opening-lifecycle.test.ts`: current output
differs from the frozen `rscore/fixtures/cross-j-opening/lifecycle-v1.json`.
Do not update frozen Rust fixtures or regenerate goldens merely to pass. The
first differing Account fields are `currentDisputeHash` and
`currentDisputeProofBodyHash`; initial states and Account financial roots agree.
Read-only reconstruction proves both frozen ProofBody hashes use the old
three-component batch ABI, while both current hashes use the added empty `loans`
component. The new ABI is part of the existing fresh-domain cutover. No frozen
fixture or runtime encoder was changed. Runtime release gate remains red.

The runtime release manifest omitted bank lending and real crash recovery.
Seven current TS test files now join every quick/CI/release runtime invocation;
three new registration regressions fail before the fix. All nine gate-ordering
tests pass after it (63 assertions). No existing gate was removed. The integrated
bail-on-first-failure rerun still reaches the frozen cross-J mismatch first;
it does not establish that the newly registered financial tests pass.
Full check after registration passes: two short gates, 38 source gates
(27,437ms), three outer gates; `bank-release-gate-full-check.log`.

The production-default 1,000-user load commits 20,000 payments, zero pending ACKs,
but drains in 26,183ms against 25,000ms on the read-only proposal candidate
(25,955ms on the preceding outbox fix). No valid TPS or speedup claim follows.
A raw-string IPC experiment returned 25,191ms and 26,043ms, both failed, with
63% more IPC bytes. It was fully reverted before the outbox correctness fix.
Further codec/cache/export/ingress trials failed the same timing gate and were
reverted. Their patches and results remain in the evidence JSON. Only the two
read-site changes and their regression are retained for proved write ownership.
Hub WAL/fsync is enabled; canonical load users are intentionally RAM-only.
Diagnostic counters are off in this run. The instrumented run takes 26,392ms;
N=1 shared-desktop runs do not establish a stable causal speedup.
Public Sepolia balance remains 0 ETH; no public broadcast or push.
Full check now passes for the reviewed coherent source/tests/artifacts checkpoint.
Frozen Rust and foreign CI remain outside the checkpoint; this is not a release.

## Artifact path

[Evidence](evidence/crisis-20261011.json), [design](lend.md), [diagnosis](crisis-review-20261011.md).
Under `.logs/crisis-20261011/`: `checkpoint-fast-regressions.log`,
`checkpoint-watchtower.log`, `checkpoint-funding-exit.log`, `checkpoint-react/`,
`checkpoint-files.json`, `checkpoint-bytecode-review.log`,
`outbox-marker-recovery.log`, `outbox-marker-check.log`,
`outbox-marker-wallet-payments-swaps/`,
`proposal-readonly-parity-comparison.json`, `proposal-readonly-regressions.log`,
`proposal-readonly-react/`, `proposal-readonly-load/`,
`priming-scope-production-load/`, `priming-scope-live/`,
`lending-crash-live-ts1000/priming-scope-comparison.json`,
`profile-routing-react-fixed/priming-scope-comparison.json`.
Earlier exact replay, crash, profile and bytecode evidence remains retained there.

## Next single command

`bun test core/__tests__/finance/lending/loan-covenant.test.ts --test-name-pattern 'partial repayment'`

Implement partial repayment in the same signed claim, then demand
terms and ordered withdrawal servicing. Preserve fractional interest across
partial payments; otherwise repeated small payments can erase earned interest.
All six choices are authorized. Preserve other writers' CI, tooling and
Rust edits; do not make a shared-tree checkpoint while they are changing files.
Stop speculative codec/cache/scheduling
variants: none closed the live gate. Select the next missing production boundary
from the release gate; do not loosen the drain limit or disable verification.
No external model spend. Do not rerun unchanged green financial gates.

Sepolia runner: `/Users/zigota/.config/xln/sepolia-deployer/run.ts`.
Address `0x4a009FaaA692DE8f66d70b53E785Ae0f7a307902`; key stays in macOS Keychain.
After funding, current-bytecode dry-run, deploy, secured exit and debt proof.
The owner answered the CAPTCHA confirmation with an instruction to complete
funding autonomously. Ghostchain verification completed and its UI reported
success, but receipt `0x77e02ca76d2a1b929ad16a849968e326125c1c2b085671e0354af7f60ab88a1e`
has status 0: the faucet sent 21,000 gas; the current RPC estimate is 207,391.
Balance remains zero. The PoW faucet verification also completed, then rejected
the connection as a hosting IP range. No mining started; no restriction bypassed.
Zalalena image input hit a browser coordinate limitation; Google/Metana require
a login absent from the current session. Do not retry these unchanged failures.
Quicknode's revised FAQ says no mainnet balance is needed, but its UI still
rejects this empty signer. Latest chain check remains 0 ETH.

## Remaining final gates

Funded public Sepolia current-bytecode identity and three real-clock exit paths,
including an offline-wallet watchtower. Valid 1,000-user live load. Immutable tested
source/config/artifacts, recovery/rollback package and full check. Local checkpoint
is not a release candidate. Old claims missing signed late terms reject; fresh
deployment domain only. Full repayments only; partial restructuring is absent.
