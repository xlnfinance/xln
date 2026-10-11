# Current xln execution handoff

## Current SHA

Runtime checkpoint `5d38b5d9bb6d81a4a9d4a806fddbece3813a5b88`, main, 2026-10-11.
201 reviewed paths committed locally; no push. Frozen Rust and foreign CI remain dirty.
TS only, React only, Ethereum same-J, lending included. Rust stays frozen.
Work solo. Preserve frozen Rust, foreign CI edits and unknown-owner HANDOFF.md.
Dedicated Sepolia key management, free faucet funding and deployment are authorized.
Mainnet participation is open; exact-build promotion/signatures remain owner-controlled.
Credit limits bound unsecured risk; only collateral secures recovery. A bank owes
its saver despite borrower default. [todo.md](../todo.md) is the live queue.

## Last green command

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

The production-default 1,000-user load commits 20,000 payments, zero pending ACKs,
but drains in 26,077ms against 25,000ms. No valid TPS claim follows.
A raw-string IPC experiment returned 25,191ms and 26,043ms, both failed, with
63% more IPC bytes. It was fully reverted before the outbox correctness fix.
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
`priming-scope-production-load/`, `priming-scope-live/`,
`lending-crash-live-ts1000/priming-scope-comparison.json`,
`profile-routing-react-fixed/priming-scope-comparison.json`.
Earlier exact replay, crash, profile and bytecode evidence remains retained there.

## Next single command

`bun .logs/crisis-20261011/inspect-live-ledger.ts .logs/crisis-20261011/priming-scope-production-load`

Inspect the measured live completion tail; do not loosen the drain limit,
run blind cap/worker trials or rewrite serialization without a measured cause.
No external model spend. Do not rerun unchanged green financial gates.

Sepolia runner: `/Users/zigota/.config/xln/sepolia-deployer/run.ts`.
Address `0x4a009FaaA692DE8f66d70b53E785Ae0f7a307902`; key stays in macOS Keychain.
After funding, current-bytecode dry-run, deploy, secured exit and debt proof.
Do not retry unchanged empty/retired faucets. Specific CAPTCHA confirmation remains
unanswered; no bypass. The PoW faucet also rejects at CAPTCHA; no mining started. A specific Cloudflare
CAPTCHA confirmation for the 0.01 ETH ghostchain.io faucet is now pending.
Quicknode's revised FAQ says no mainnet balance is needed, but its UI still
rejects this empty signer. Latest chain check remains 0 ETH.

## Remaining final gates

Funded public Sepolia current-bytecode identity and three real-clock exit paths,
including an offline-wallet watchtower. Valid 1,000-user live load. Immutable tested
source/config/artifacts, recovery/rollback package and full check. Local checkpoint
is not a release candidate. Old claims missing signed late terms reject; fresh
deployment domain only. Full repayments only; partial restructuring is absent.
