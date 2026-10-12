# Current xln execution handoff

Owner scope: TS + React + Ethereum same-J; Rust and lending remain frozen.
Foreign Rust stash `438bf1a6ddd8679bba0b63bdef11dd1fd1f45e90` is untouched.
Keep frozen-core, PRs with seven required green jobs, no WIP commits.

- Current source: `bbd33b1bbff2b14b130c27b153915818fbcf0c35` on
  `codex/production-qa-boundary` (PR #73), merging PR #72 at `8d7f1e742`.
  PR #71 now carries the Activity readiness test fix at `ca96f041d`; PR #72 is
  stacked on it. Main remains `86d2a515`. No PR is approved for merge
  until all required CI jobs pass on its exact candidate.
- Last green: clean `8d7f1e742`: focused backlog 1/1, full jurisdiction shard
  444/444 / 2,181 assertions, and check / 38 source gates. Receipt focus browser
  1/1 and check / 38 on clean `ca96f041d`. QA separation on clean `34fec4412`:
  53/53 units / 1,912 assertions,
  full check / 38 source gates, React payment and reload 1/1 with no skips/flakes,
  live QA route 404. `lock-ahb` passed 85 frames on `2b2c1081c`; subsequent change
  only made formatter helpers private. Kernel closure shrank 454 code lines;
  direct kernel QA imports are zero. Earlier: 60/60 RPC tests on clean `50281daaa`,
  including real Anvil 429, timeout, unchanged failed-read state and exact
  512-block retry before full backlog completion. Restore browser 1/1 on clean
  `0ff079f41`, no skips/flakes; full check / 38 source gates there and on
  `999396327`. The original refactor retains 90 units and three browser journeys.
- First red: public P6 `PUBLIC_P6_WAIT_FAILED:reserve-funded` on `50281daaa`.
  Public RPC catch-up still times out. Dedicated profile
  `sepolia-p6-20261012b` has 200 test USDT confirmed in reserve, zero collateral,
  no prepared appointment or attack. Do not fund again. Adaptive polling preserved
  the first authenticated range through block 11893390; later retries retain it.
  Main CI 38197082078 and old PR runs 38198105230/38198345234 all failed the same
  tower-restore expectation race; the selected-snapshot fix is now submitted.
  PR #71 run 38200202391's receipt-focus fixture navigation race is fixed.
  PR #72 run 38200437268 finished 6/7 green including E2E, with only the backlog
  unit test exceeding 60 seconds. Its exact failing phase is unknown. Explicit
  gate/poll race diagnostics now preserve stage and state; this is not a claim
  that the CI-only timeout is fixed. The next run must supply that evidence.
- Artifacts: `docs/evidence/canonical-review-20261012/` records the original
  eight-scope review and `rpc-restore-followup.json` with clean-source tests,
  browser/check logs and the explicitly failed public P6 run. `qa-boundary.json`
  binds the production QA cut to clean source, kernel measurements and tests.
  Public P4/P5 and
  cold restore remain in `docs/evidence/rc-20261012/`. The live public alpha
  still runs `7c3f63f9841f4e8b61ac5eee5dbe4f9710b10621`.
- Next single action: inspect exact-candidate CI for PR #71 (`ca96f041d`) and
  PR #72 (`8d7f1e742`). Keep QA PR #73 stacked until the base is green; its old
  run 38201516918 was cancelled after the parent changed. Revalidate the final
  QA candidate rather than repeatedly running stale stacked combinations.
  For public P6, identify the slow RPC method/range before another identical
  retry; never skip chain history or manufacture ingress. The next structural
  cut separates active TS workers from retired Rust hooks. Rust proposals stay read-only.
- Remaining gates: ten consecutive green main CI runs; production Rust/QA
  isolation; public P6 with current code and real clocks; external tower
  start/finalize/reveal coverage; exact owner-reviewed mainnet release package.
  No extra dispute-start freeze, FIFO, one debt per debtor/creditor/token and
  party-selected windows remain settled. No starter bond/governance redesign.

Method review, 2026-10-12: use the existing real-chain fixture to inject transport
pressure instead of adding another watcher or retry abstraction. A red run on the
old controller and a clean-source green run establish the change. Bind browser
restore expectations to the snapshot selected by discovery, not a moving display.
The attempted public retries did not complete P6; retain their exact failure and
stop repeating unchanged requests. Before any external retry, read chain state
and preserve submission intent. The 30-minute review heartbeat `xln-30` remains
  active; no external-model budget was spent or renewed.

## Historical evidence and superseded scope

Owner priority, 2026-10-11 17:28 UTC: ship a public Sepolia deployment and usable
asset flow; Base is an alternative, not a prerequisite. Finish the TS launch path
before resuming Rust book parity. Mainnet activation remains a separate exact-build
decision; a local Anvil wallet or test tokens are not real-value mainnet assets.

Live public alpha: `https://sepolia.xln.finance`, immutable source
`7c3f63f9841f4e8b61ac5eee5dbe4f9710b10621`, TS only, one hub, Test USDT on
Sepolia 11155111. The normal production Runtime path passed external deposit
100 -> collateral 100 -> payment 25 to the hub -> external withdrawal 75.
Client restart preserved the identity and zero Account/reserve balances;
all 49 WAL frames passed storage integrity verification. Both timed contract
exit proofs also passed. Public faucet delivered 100 test USDT plus 0.00001
Sepolia ETH to a fresh independent signer, with both receipts checked.

Public startup blockers fixed: exact four-address import projection; full-block
receipt retrieval in place of per-transaction RPC fan-out; fee-sized faucet gas
grants. Receipt tests: 18/18, 585 assertions. Faucet tests: 24/24, 110 assertions.
Last full check: 38 source gates, 26.369s; external-wallet API 20/20, 90 assertions.
The wallet now reads token metadata from its selected network; both HTTP entry
points pass the required request through the catalog handler. Public malformed
Entity scope changed from an incorrect 200 to a typed 400. The proxy selects the explicitly
configured public audience for non-browser TLS clients while retaining rejection
of foreign browser origins. Old production checkout/services remain untouched.

Post-alpha financial correction: delayed savings withdrawals now freeze their
quote at the signed Account-frame time, rather than the later bank Entity clock.
The boundary regression reproduced a 10,100 payout instead of 10,000 and then
passed on both sides of maturity. A real Runtime request signed before maturity,
delivered after it, killed while queued and restored pays exactly the early
principal. Final focused financial set: 94 tests / 899 assertions / six files;
full `bun run check`: 38 source gates, 26.369s. Evidence is
`docs/evidence/sepolia-20261011/lending-close-clock.json`.
This fix is deployed. The production wallet bundle matches the served bytes;
the fresh browser reports Sepolia connected and zero console errors. Hub Account
height 11, exact balances, zero mempool and no pending frame survived restart;
the tower sweep is healthy. Cold backup `98cfbf3bf-cold.tgz` matches locally and
remotely at SHA-256 `28dbca8d755c957a263e757c6140197cd92d1d1caadcb90262d6b793e77afbe1`.
The first backup attempt named a nonexistent `main` directory and automatically
restored the previous healthy release. The successful retry archives the actual
whole state directory excluding prior backups. No contract or financial transfer
changed. Evidence: `docs/evidence/sepolia-20261011/public-clock-rollout.json`.
The deployed candidate adds demand savings through the existing signed Account covenant:
prospective annual rates, a one-year renewable coverage window, preserved whole
and fractional earnings, and actual-time withdrawal. Renewal requires current
bank policy and accepted Account risk; queued withdrawals keep their last signed
rate. The wallet exposes coverage expiry. No new Solidity or durable rate ledger.
Account regressions pass (6 tests / 49 assertions); production Depository demand
exits pass (4 cases, both sides and collateral shortage, maximum gas 368,350).
Four real Runtime processes and three SIGKILL boundaries preserve funding,
rate amendment, queued withdrawal and final payout. Exact-commit financial set:
122 tests / 1,103 assertions / nine files / 26.30s. The browser flow funds,
changes 5% to 2%, reloads the same wallet and withdraws (14.4s, no page or console
errors). The bank administration flow passes separately (13.0s). Full source
check passes 38 source gates in 26.476s, plus frontend build and UI types.

This public rollout holds new ingress during restart, then verifies the exact
clean Git source before reopening. Account height 11 and all token deltas remain
exact; no mempool or pending frame. Tower sweep is healthy and its offline
appointment remains present. Served runtime bytes equal the production artifact.
Cold backup `7c3f63f98-cold.tgz` is protected locally and on the server; SHA-256
`53ab403956318e9bf026abfb72e819cec670770dd3ffd8357c8bb1f984026c52`.
Evidence: `docs/evidence/sepolia-20261011/demand-savings-release.json`.
Demand financial scenarios ran on real local Runtimes and the production
Depository; this rollout did not originate a new public Sepolia demand deposit.

Method review: finish each production boundary before expanding scope. Two
nonfinancial blockers were removed: pure amount formatting no longer initializes
the browser store, and the lending handler stays below the function-size limit.
Keep the new demand regression in the integrated release profile. Next is the
remaining full release profile, then valid live load/soak; do not mistake this
public alpha or local browser evidence for mainnet acceptance.

Current boundary: public browser wallet tab 21 awaits the owner entering a local
password (required handoff under the browser tool policy). No password is known
or requested in chat. UI render/network detection and console checks pass; do
not claim its authenticated payment/reload flow passed yet. The CLI Runtime
flow is separate evidence. Public alpha is not mainnet acceptance: the full
release profile, lending completion and valid load gates remain open. Existing
unrelated/unfinished Rust edits stay unstaged. Rust is not the public alpha engine.

Public offline watchtower exit passed with a separate 1-USDT Account: the daemon
countered stale nonce 1 with signed nonce 2 before the deadline, finalized after
the deadline, and restored 1 USDT to the owner's reserve. The offline owner's EOA
nonce remained 4 throughout. Both transactions came from the tower signer.
The encrypted height-49 backup was read back and decrypted successfully. Evidence:
`docs/evidence/sepolia-20261011/offline-watchtower.json`. This later drill leaves
1 USDT in the client's reserve; the earlier normal-flow recovery proof's zero
reserve is historical, not the latest on-chain balance.

Final deployment restart recovered Hub Account height 11, collateral 25 USDT,
zero mempool and no pending frame. Public health reports systemOk/coreOk true,
the exact source above and dirty false. Watchtower sweep health is green.
The previous cold backup `f62e86dc4-cold.tgz` includes Hub/tower stores, protected secrets and
startup configuration; local/server SHA-256 matches
`8e4c23289a0cce0df6cae30940b362783601222b0fd3dac62f00fffdcd8503da`.
It is outside Git. A real 5-GiB startup disk guard blocked the final restart;
removing redundant old-checkout documentation through Git sparse checkout
recovered space to 5.71 GiB. No guard, shared Git object store or funded state
was removed. Retain the release parent object stores and shared node_modules.

Method review, 19:27 UTC: the public economic path, offline defense and cold-backup
restart now have evidence. Stop extending UI scope; save the exact release
evidence and finish the personal browser flow on owner handoff. Do not repeat funding, minting or financial
proof scripts without inspecting their persisted receipt guards. Operator keys
and the cold backup are outside the repository under protected local/server
configuration directories. The public faucet and contract tokens have no real
monetary value.

Post-alpha verification: the complete current TS runtime family passed in four
disjoint sequential groups: 79 files, 690 tests, 4,141 assertions, zero failures.
Each group exited 0 under the stand lock. The real-clock tower case passed
unchanged in 46.69s. Earlier interrupted commands used the unsupported
`--timeout-ms=60000` spelling and hit the default 30s limit; they are not green
evidence. Always pass `--timeout-ms 60000` to this launcher.
The first real gate defect was a reference to a test deleted in August: Bun
silently ignored `tests/unit/resetdb-guard.test.ts`. The gate now rejects absent
paths before execution. The regression failed in all three profiles, then passed
9 tests / 73 assertions. Evidence: `docs/evidence/sepolia-20261011/ts-runtime-gate.json`.

Additional current gates passed: 260 Solidity tests; bilateral simultaneous
proposal/reload (Runtime height 27, Account heights 12, no pending frames);
RPC settlement parity (123 transferred, three exact receipt/refetched events);
static security audit pack; WAL restore; watchtower backup/restart smoke; and
flow-marker coverage. Marker coverage is not executed browser E2E, and these
individual gates do not certify the complete release profile or mainnet.

The old localhost preview was gracefully stopped to free the single heavy stand.
Both Anvil dumps and a cold backup of J/R state, metadata and operator secrets
are outside Git under `/Users/zigota/.config/xln/owner-preview-20261011/`.
Backup SHA-256: `efd242b74f3d95ee11270c6e1dca2e0ede170441de7f056ec82ba837a634b2bd`.
Original data remains at `db/owner-preview-20261011`. Do not restart it with
`bun run dev`, which deliberately resets JDB/RDB. Public Sepolia stayed online.

Public funding is resolved: the existing project deployer's key was available in
macOS Keychain under its lowercase account address. A chain-11155111-guarded
transfer funded the dedicated signer with 0.001 Sepolia ETH in block 11893327,
transaction `0xccbca3a7ed33d64f60f992be52eba45129bf4fec1f92e9b649ec003280bd553b`.
No faucet action remains for the owner; the faucet tab was closed. Keys remain
outside the repository and were never printed.

The first actual deployment failed before broadcasting: Hardhat's last-block
median selected about 1 gwei, while the RPC quoted about 0.001 gwei. The same
Account init code fails gas estimation with the former (1,000,000-gas balance
allowance) and passes with the latter (35,735,287 gas). The canonical stack script
now passes fresh EIP-1559 fee quotes for every deployment and write. Wiring tests
11/11 and full check (38 source gates, 26.861s) pass. All nine contracts, share
binding and token registration are confirmed (11 transactions, nonce 11).
Depository is `0x4e7333463cDde39AA58587D58AF3f66757117f61`; the six-decimal test USDT
is `0x4d6cF5B015567B598B5961f9662Fce6e5267d774`, tokenId 1. Deployment cost was
0.00013982213938686 Sepolia ETH. All nine code/receipt checks and the canonical
linked-bytecode check pass. Secured proof passed: deposit, bilateral settlement,
collateral funding, timed unilateral exit and ERC-20 withdrawal. Evidence is
`docs/evidence/sepolia-20261011/contracts-and-exit.json`.

The follow-up unsecured proof exposed a public RPC head race: the same signed
batch rejects at block 11893378 and estimates successfully at deposit block 11893379. The proof runner now reads nonce and estimates against one explicit
block, at least its last mined batch. The interrupted deposit was withdrawn back
to the signer with exact reserve/token deltas; the corrected proof passed.
Of the 250-unit unsecured claim, 200 available reserve units were collected and
50 remained in the on-chain debt row. No insolvency guarantee is claimed.
Evidence: `docs/evidence/sepolia-20261011/rpc-head-regression.json` and
`.logs/crisis-20261011/release-sepolia-*`. Latest full check passes 38 source gates
in 26.737s. This was the pre-wallet deployment checkpoint; the current alpha above
supersedes that status.

Public Runtime startup exposed a deployment/configuration boundary mismatch.
The matrix wrote linked libraries into `contracts`; the config loader accepts
five addresses, but durable `importJ` accepts only the four Runtime entry points.
The writer now projects those four and retains every library address/receipt in
the existing deployment evidence. The regression exercises both real decoders,
first red then green (12 tests / 96 assertions). The first unfunded bootstrap's
invalid import WAL is preserved outside the checkout; the corrected startup
uses `/var/lib/xln/sepolia-20261011/mesh`, with the same operator keys. No user
Account or funded Hub state was discarded. Latest full check: 38 gates, 27.159s.

Method review, 18:19 UTC: funding, deployment and both public exit proofs now have
receipts. Keep the next boundary the real hosted wallet. The server uses the
canonical orchestrator and a dedicated persistent Sepolia state root, never the
Anvil-reset deployment script. Do not overwrite the older public stack.

Guided demo checkpoint `cca6cd8fe` reuses PasswordEntry and canonical Runtime ids; the encrypted
key is saved before boot and wallet metadata before chain sync. The owner completed
password creation and the wallet opened (tab 19); reload/unlock is not yet verified.
Do not interrupt the owner's current payment. Crypto/recovery tests: 12/12, 28
assertions. The older 203-USDC preview remains in tab 18, with its test phrase
backed up outside the repository in the local xln configuration directory.

Release discovery incorrectly included frozen Rust cross-J parity vectors using
the old three-component proof ABI. Their mismatch is reproduced, not re-goldened.
The TS release family now excludes only core/**tests**/rscore; all current TS
cross-J, proof-builder, lending and recovery gates remain. Scope regression first
failed 4 tests, then 30/30 scope/proof tests passed. Release integrity: 62/62 plus
one Solidity Hanko parity case. Full check passes: 38 source gates, 27.329s.
Fresh production browser Runtime/worker and React bundles build; files are under
`.logs/crisis-20261011/sepolia-candidate`, not deployed or served to the owner.
The full integrated runtime suite remains unrun
on this candidate because the owner's preview holds the heavy stand.

Current Rust evidence: engine all-target check passes; the shared borrow request
commitment passes exactly. First native divergence is lending_disburse AccountState
root: the old handler lacks the modern covenant and authorization consumption.
Keep this unfinished port and the six foreign Rust files separate from TS launch.

Method review, 17:42 UTC: stop spending the release path on Rust or UI polish.
Obtain one actual public receipt before extending deployment scope. Preserve the
owner's running local wallet and remote state; never use deploy:prod as a mainnet
rollout, since that command resets Anvil and Runtime data.

## Earlier checkpoint evidence

Owner priority on 2026-10-11: redesign the React wallet with one bounded Opus
consultation. Backing and signed credit now sit next to the balance; compact
actions precede the charts, secondary actions use More, tutorial details disclose.
All amounts still use committed projections/deriveDelta. Equal $100 segments
measure the same width in all seven visible bars; 320px buttons do not overflow.
Browser evidence: `.logs/crisis-20261011/wallet-design-{desktop,mobile}.jpg`.
An independent demo wallet has 203 USDC: 100 collateral-backed, 100 unsecured,
and 3 in reserve, after actual funding on the running local chain. This is not
a restore of the owner's earlier 699.85 USDC Tour wallet. Editing the Vite entry
caused a reload; that older mnemonic wallet now needs its recovery phrase.
Do not reload the current demo or rebuild served runtime files during preview.
Fix next: guided-demo recovery requests a random phrase users may never have saved.
The reserve faucet failure is fixed: the 5-second proxy timeout masked a missing
external-recipient receipt event. The watcher now retains reserve evidence from a
locally delivered Hanko batch without adding recipients to Entity delivery; an
unrelated transaction is excluded. The three chain faucets share one timeout list.
Regression: 65 tests / 337 assertions; full check 38 source gates / 26.200s.
Live proof: fresh production proxy -> existing H1 -> local Depository returns 200
in 446ms with exact +1 USDC and a successful matching receipt. H1 was gracefully
restarted and recovered its existing DB (PID 84720, verify before use). A separate
browser request then succeeded: reserve 2 -> 3 USDC, request accepted, Pay enabled.
The orchestrator remains the original process; its timeout policy is not hot-loaded.
No ambiguous request was retried. The initial failed 1-USDC request was confirmed
credited before the two distinct verification requests. Evidence:
`.logs/crisis-20261011/reserve-{evidence-missing,timeout-live}.{json,log}` and
`reserve-browser-accepted.jpg`. One browser WS-close error is from the intentional
H1 restart; it reconnected. The page was not reloaded or its wallet replaced.

Method review, 17:17 UTC: a live request exposed the missing receipt behind the
timeout; extending the wait alone was insufficient. Keep unit, chain receipt and
browser success as separate claims. Use supervised single-hub recovery to load
backend changes while preserving the owner's chain, databases and open wallet.
Prioritize guided-demo recovery before another UI entrypoint change or mesh restart.

The unfinished Rust lending parity work is preserved separately, uncommitted.
The current TS lending vector passes with partial repayment and signed expiry;
Rust authorization is now exact, but disbursement and later steps are not parity-proven.
Do not include that work or the six foreign Rust files in the UI checkpoint.

## Earlier code checkpoints

Historical UI checkpoint: `f9f5388cc`, main, 2026-10-11; funding fix follows.
Book checkpoint: `cd345aafd`.
The three books now have sibling `paybook`, `swapbook`, `lendbook` module paths in
TypeScript and Rust; retired directories and imports are removed. Full check
passes (38 source gates, 25.807s), 26 existing Rust book tests and two shared TS
book tests pass. The same 108-frame production WAL is byte-exact before/after
through TS W1/W4. This proves the move, not modern lending parity in Rust.
Evidence: `.logs/crisis-20261011/books-*` and
`withdrawal-react/books-comparison.json`. Rust tests ran with the six unrelated
dirty Rust files retained, not a clean-checkout claim. No push.

Previous checkpoint `079c101cc` isolates Lendbook and fixes queued withdrawals. Related tests
564/564, six SIGKILLs across seven processes, three browser journeys and all
108 TS W1/W4 replay frames pass. Full check: 38 source gates plus short/outer
gates pass. Evidence: `.logs/crisis-20261011/withdrawal-*` and
`withdrawal-react/queue-comparison.json`; transcript
`bfeef7065f24d509bf1a0280093e47bb9bd99e59b9c257076b6b38382439efbc`.

Latest owner instruction: all three books must have consistent names and module
boundaries in TS and Rust, deleting retired paths. Rust freeze is lifted for
that refactor and the books' financial parity; TS remains the launch engine.
Rust baseline `cargo check -p xln-rscore-entity-kernel --all-targets --locked`
passes in 7.47s. Its lending still uses the old saver allocation/credit-grant
semantics; a module rename alone is not financial parity. Preserve the six
unrelated dirty Rust files (baseline patch in
`.logs/crisis-20261011/books-foreign-rust-before.patch`).
`8c5ef2793` implements partial repayment; `5a2025a81` validates Account access once
and lowers non-null assertion debt from 617 to 616. Earlier `87f860bd1` and
`494b162cc` repair release fixtures, remove saver allocation and charge actual
elapsed loan interest. Not pushed.
Preserve unrelated frozen Rust changes, HANDOFF.md, output/ and tmp/.
TS launch engine, React only, Ethereum same-J. Work solo. The owner's explicit
Opus design request permitted one packet-only response on `bc75c6a4cdfc48870f997beefc3663ec24f7941d`:
`wallet-design-opus-20261011`, requested `anthropic/claude-opus-5` via pi/OpenRouter,
reported cost USD 0.1476725, completed. No recurring grant or further calls.

All six owner choices are resolved: term and demand savings; lending above deposits
inside signed bank facilities; withdrawal order by maturity then request admission;
actual-time interest; partial repayment interest-first; automatic draws inside
borrower approval. One signed obligation mechanism; no saver-loan allocation.
Credit limits bound unsecured risk. Only collateral secures recovery. Testnet key
management/funding/deployment is authorized. Mainnet is open participation; exact
build promotion and mainnet signatures remain owner-controlled.

## Earlier partial-repayment checks

Latest: `bun run check` -> `.logs/crisis-20261011/reserve-evidence-check.log`;
65 focused tests -> `.logs/crisis-20261011/reserve-evidence-related.log`;
live handler/contract receipt -> `.logs/crisis-20261011/reserve-timeout-live.log`.
Earlier book verification:
`cargo test -p xln-rscore-entity-kernel --lib --locked book::` -> 26 pass;
production replay W1/W4 -> 108/108 exact, matching `079c101cc`.

Owner preview is running via the canonical `bun run dev`, TS engine, dedicated
`db/owner-preview-20261011`, stand holder PID 51040 (verify before use).
React URL: `http://localhost:5183/`. Browser tab 18 has a disposable tour wallet
with 203 test USDC. Do not reset its data
or start another heavy stand while the owner is trying it. The current dev
launcher still exposes Svelte at 8080; unify the advertised React entry without
weakening singleton/port ownership or adding a second launcher.

Method review, 16:22 UTC: closed the book-path migration through immutable WAL
comparison and full check before starting another refactor. Updated the existing
improvement loop with the owner's Japanese-inspired quality direction. Retained
the generator-path failure and folder-width reduction as evidence; no new gates.

Earlier partial-repayment candidate (historical evidence):

- Related suite: 562 tests, 448,491 assertions, 46 files, 33.88s.
- Production Depository/transformer: 65 cases; partial claims in both directions,
  fractional carry, offline debtor and unsecured shortfall included.
- Gas frontier: 16/16; 80 claims finalize at 3,930,280 / 5M gas; 18 full-width
  claims at 3,552,680 / 5M. Do not report whole-test gas as one transaction.
- React: three real browser journeys, zero skips/retries/page errors, 41.43s.
  Partial repayment followed by full settlement conserves money exactly.
- Real recovery: five SIGKILLs across six processes; fractional interest,
  remaining principal, saver independence and duplicate outbox delivery survive.
- Fresh production WAL: all R/E/A roots and ordered outputs exact for 108 frames
  through TS W1/W4. Transcript digest
  `1d625ebbcd2212037c1326174fba51433706aaf88ec2c34c522df9fe39f84cff`.
- Runtime, contract-test and UI types pass. Full check passes: two short gates,
  38 source gates (28,653ms), three outer gates. The first check rejected one new
  non-null assertion. Reusing the validated Account removed it and one older
  assertion; the stricter ratchet passes. All 108 replay frames remain exact
  before/after that source-only guard change.

Partial payments mutate the same root-bound Account covenant. Interest accrues on
remaining principal, carries its fractional numerator and never compounds. The
original maturity/late endpoint stays fixed. Each repayment signs the previous
claim hash: stale retries cannot debit twice. The bank book uses the same pure
settlement function. Principal repayment replenishes the signed facility.

This is a fresh-domain ABI cutover. Old coupon-only claims and six-field repayment
worker tuples reject, not migrate silently. Artifacts/TypeChain are synchronized.
Of nine artifacts only DeltaTransformer bytecode changes: runtime 7,867 -> 8,326
bytes; keccak
`0xf0b6c12143a14da9143b650dbb23895da3b01482dc352c2bb90b5ef76cf01b98`.
Other bytecode/ABI templates are identical; build metadata/AST ids differ.

## First red command/error

No remaining partial-repayment L1/L2 or full source-check failure.
Demand savings are not implemented. Due/request-ordered withdrawal servicing
is implemented and verified at `079c101cc`; see the newer evidence above.

The previous integrated runtime release gate reached the frozen cross-J fixture
mismatch after 77 tests. Its first difference is dispute ProofBody hashing:
read-only reconstruction proves the frozen vector uses the old three-component
stock batch ABI; current production has the fourth loans component. Financial
roots match at the first boundary. Frozen native vectors are now excluded from TS
launch discovery; their direct tests remain red. The corrected TS runtime family
now passes all 79 existing files; the full release profile remains incomplete.

The prior 1,000-user stand committed 20,000 payments with zero pending ACKs but
needed 26,183ms against the 25,000ms acceptance window. No valid TPS claim.
Do not resume speculative performance changes or relax the gate.

## Artifact path

`.logs/crisis-20261011/partial-{related,contract-full,gas,crash-verified,wire-ui}.log`,
`partial-bytecode-review.json`, `partial-check-final.log`, and `partial-react/`
browser/replay evidence.
Durable evidence index: `docs/evidence/crisis-20261011.json`.

## Next single command

Check the stand with `bun run stand:status` before heavy work. The local preview
was preserved and stopped, freeing the stand. Continue the remaining release
profile, then the missing demand-savings product. Deployment and offline defense
have receipts; do not redeploy or repeat funding. Personal browser reload remains
unverified pending password handoff. The owner delegates demand-rate design:
prospective variable rates, earned interest preserved, one signed accrual mechanism.
Do not repeat unchanged green gates without a new concern.

## Remaining final gates

Demand savings, native financial parity, the rest of the integrated release profile,
personal-wallet browser lifecycle, valid 1,000-user live load, required topology
and soak, and final immutable candidate/rollback evidence. Public Sepolia alpha,
secured/unsecured exits, offline watchtower defense and the TS runtime family now
have evidence; none of them alone establishes mainnet acceptance.
