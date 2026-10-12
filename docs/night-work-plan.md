# Current xln execution handoff

Owner scope: TS + React + Ethereum same-J; Rust and lending remain frozen.
Foreign Rust stash `438bf1a6ddd8679bba0b63bdef11dd1fd1f45e90` is untouched.
Keep frozen-core, PRs with seven required green jobs, no WIP commits.

- Owner authorized the one active TS fixture import correction on October 12.
  The stale worker path is replaced by the canonical Runtime worker path;
  clean 01cde8881 passes all 97 settlement tests (528 assertions, 2.67s),
  60 tests covering former CI failures (1,037 assertions, 859ms), and full
  `bun run check` (38 source gates, source phase 28.518s).
  Evidence: docs/evidence/canonical-review-20261012/fixture-import-01cde8881.json.
  Next: update PR #73 and resolve its first required CI failure.
  Continue to Sepolia rollout/recovery after green CI. No other `rscore/` edit
  is authorized; the earlier pending-permission entries below are historical.

- Latest owner-report review: clean 9fa2a4bf6 passes full `bun run check`
  (38 source gates, React types, Svelte build/types) and both real React faucet
  journeys (2/2, no skips/flakes/errors). The unchanged production implementation
  passed 102 targeted tests / 587 assertions on clean 5e648e71c; the real RPC
  integration passed 11/11 / 74 assertions on clean 089f198b5. Invalid debug
  limits and malformed/unsafe RPC chain IDs now reject at their source. The
  existing J-prefix authority guard returns its checked weight without another
  lookup or non-null assertion; its remote-DoS claim did not reproduce. Map
  sorting already occurs in the canonical codec. Faucet elapsed waits now use
  the monotonic clock; reducer time and consensus bytes are unchanged. Existing
  coordinate brands/negative checks remain; no unit-confusion failure was shown.
  The browser test now binds adaptive gas grants to the mined transfer and
  exact wallet balance; delayed reserve funding waits 22 real seconds for a
  block and credits 1 USDC through one request. Three preceding browser failures
  remain recorded, including an unavailable test import introduced and fixed
  during this review. Evidence: docs/evidence/canonical-review-20261012/critical-boundaries-9fa2a4bf6.json.
  Rust/lending/contract files are unchanged. No push, public transaction or
  deployment; the frozen active fixture import below still blocks release CI.
- Current branch: codex/ts-worker-boundary. Earlier clean b225f8ac4 passes 38 source
  gates, React types, 40 related tests / 766 assertions and UI-only dev
  funding/payment/reload (1/1). Its production code equals the compiled
  5e6d08a16 wallet proof below; later changes only wire CI and retain evidence.
  Financial-core retirement source fc4f267db
  retires the native authority driver/storage hooks, rejects native WAL before
  TS projection/writes and retains exact TS crash/commit/outbox semantics.
  All six bounded checks pass: 155 targeted tests / 1,893 assertions, 38 source
  gates, the same 708-frame W1/W4/W8 replay, React payment/reload 3/3, stopped
  H1 cold restore R4474 / 128 retained integrity frames, and static closure.
  This cut removes 1,384 production lines, 43 test lines and 47 script lines;
  nine doc lines added, net 1,465 fewer physical lines. Prior clean 942385253
  retires the live authority recorder and observers: 1,615 fewer physical
  production lines, 872 fewer retired-feature test lines and one replay-CLI line.
  All five checks pass: 147/147 related tests (1,906 assertions), 38 source gates,
  the same 708-frame WAL exact on W1/W4/W8, React payment/reload 3/3 with no
  skips/flakes/errors, and measured closure. Each replay retains one outbox
  item; not TPS. H0 financial assertions remain in canonical Account tests.
  No new public-chain operation or deployment occurred. Earlier clean 8584d3ce0
  has 45/45 tests and 38 gates for the 49-line unread-bookkeeping deletion.
  Prior financial source 2d2115dc8: all six checks passed — 34/34 related
  tests (1,249 assertions), 38 source gates, 708-frame mixed WAL exact on
  W1/W4/W8, 3/3 React payment/reload, actual Sepolia event decoding, and the
  stopped hub's cold replay (R4474, 128 retained frames). WAL replay retains
  one final outbox item; no TPS claim. Cold replay stops before counter block
  11897542, does not start network effects, and is not deployed catch-up.
  Earlier clean 88f14ce5f has 104/104 watcher tests (951 assertions);
  7d3134853 has lock-ahb (85 frames), 25/25 funding/exit cases, 512 fuzz
  invocations and eight matching compiler templates. Keep original SHA binding.
- First required-TS red, corrected at 11:19 UTC on clean 67a2a1dca:
  settlement-execute-atomicity.test.ts cannot resolve the relocated TS worker
  through rscore/fixtures/entity-resident-group-e/group-e.ts:3. The test fails
  during import (319ms, zero assertions executed). Required CI already excludes
  core/__tests__/rscore/, so the separate cross-J parity failure is outside this
  release job. Narrow the pending owner exception to this one active fixture
  import; do not copy its full Runtime setup, add an alias or weaken assertions.
  Prepared patch: docs/evidence/canonical-review-20261012/ts-worker-active-fixture-import.patch.
  Original clean-source output: docs/evidence/canonical-review-20261012/settlement-fixture-import-67a2a1dca.log.
  Do not push this known-red candidate.
- PR #73 still points to 72c38fa4b: six of seven required pull_request jobs
  passed, Unit Tests failed four cases. Those four are fixed locally; fresh
  eligible CI is still required after the fixture blocker. Main remains
  86d2a515; no merge or public deployment occurred during this cut.
- Artifacts: docs/evidence/canonical-review-20261012/native-retirement-fc4f267db.json
  binds the latest six checks and the still-red frozen-fixture import test.
  record-retirement-942385253.json retains the preceding collector deletion. Earlier
  retired-capture-8584d3ce0.json binds its narrow deletion. The preceding
  null-stage-2d2115dc8.json binds its replay/browser/receipt/recovery results.
  The prior ts-worker-evidence.json retains the 498-frame historical WAL
  failure at frame 12 on both pre-move baseline and candidate. Moving 3,857
  worker lines is ownership correction, not deletion. Private WAL/seeds stay private.
- Next single command after the one active fixture import is authorized and replaced:
  `bun test core/__tests__/payments/settlement/settlement-execute-atomicity.test.ts`
  Then related active TS consumers, exact-candidate source/browser/scenario checks
  and push HEAD:codex/production-qa-boundary for PR #73 required CI.
- Release preparation on clean d4502ec94 is complete locally: real React
  production build, existing Git bundle/UI archive layout, 11/11 archived UI
  files verified, and another full check (38 source gates). A fresh private
  stopped-H1 copy caught up through real Sepolia J11898153 and cold-restored
  exactly at R4476: P6 Account dispute cleared, its collateral zero, 128/128 retained frames,
  identical root/outbox, zero pending network/J/registration queues. The strict
  RPC gateway forwarded 185 read requests and zero transactions. No public
  service restarted; this closes isolated catch-up, not deployed P6 or CI.
  The unactivated bundle/manifest is in `.logs/canonical-review-20261012/`;
  durable proof: docs/evidence/canonical-review-20261012/release-preparation-d4502ec94.json.
  Sepolia deployment is already authorized; no new blanket approval is needed.
  It still requires eligible CI and compatible rollout/rollback evidence.
- Prepared-archive validation found and fixed a real React dependency defect:
  d450 production UI exposed shared debug commands on localhost. The canonical
  debug owner now requires a development build. Clean 5e6d08a16 production
  archive passed UI-only import, 100-unit funding/move, payment of 25 and
  identity/balance recovery after reload (1/1, zero errors/skips/flakes).
  All 11 extracted files and three served entrypoints match their hashes;
  Runtime/worker bytes are unchanged. This supersedes the d450 UI archive,
  not its isolated H1 recovery proof. Evidence: exact-ui-artifact-5e6d08a16.json
  in docs/evidence/canonical-review-20261012/. The existing CI/release runner
  now includes production build plus this same artifact test; CI has not run.
- Latest coherent deletion: native driver, native storage completion/restore
  callbacks and unused byte counters/candidate helper. Retired selectors have
  one fail-fast guard; old native persisted frames retain their original hash
  domain before explicit rejection. TS workers/checkpoints/WAL remain. The
  standalone offline importer retains one pure session identity helper/codecs.
  Independent review found no blocker. No root rscore/ or lending edits.
- Public P6 on clean d388464db: original funding resumed without repeating
  payment or funding. Recovered exact signed states at Runtime 140/141; tower
  upload initially rejected its wallet RPC URL. A one-line explicit allowlist
  correction accepted the same appointment; no source deployment occurred.
  Real-clock stale start used 1,161,420 gas, external tower counter 460,487,
  finalization 250,134. Local recovery and a second cold replay agree at R142:
  reserve 200 Test USDT, collateral zero, no active dispute/pending Account frame.
  Retained storage integrity checks 127 frames, not full genesis history.
  Evidence: docs/evidence/canonical-review-20261012/public-p6-d388464db.json.
  This is NOT whole deployed-system P6 acceptance: old 7c3f63f98 H1 failed on
  the counter (ethers Result cannot be cloned), then finalization evidence,
  and stopped after three repeats at 08:01 UTC. Public RPC returns 502;
  tower remains online. Both decoder fixes already exist in d51910eee.
  Stopped H1 DB/WAL is preserved privately; current-source replay and the two
  real receipts now pass. Prepare an exact eligible build; do not resend transactions.
  Local recovery retained one undeliverable outbox message while H1 was down.
- Current static kernel closure: 150,930 code lines in 796 files, down 10,132
  from the initial review and 7,950 from 942385253. QA/core/rscore direct edges
  and reachable lines are zero. Offline codecs/import tooling remain outside
  this closure. Necessary recovery fixes are included in the net measurement;
  no aggregate readiness score is asserted without CI/ledger inputs.
- Remaining release gates: required PR CI; ten consecutive green main runs;
  deployed hub recovery and full public P6;
  start/finalize/reveal coverage; owner-reviewed release
  package. No dispute-start freeze, FIFO, one debt per debtor/creditor/token
  and party-selected windows remain settled. No governance/bond redesign.

Method review, 19:18 UTC: two supplied boundary defects reproduced and fixed;
do not equate a static suspicious expression with an exploitable halt or change
working consensus bytes. The final check source phase took 26.993s; selected
units 3.91s, RPC integration 2.20s, browser cases 38.580s excluding stand startup.
The first two browser failures exposed outdated gas request/amount assumptions;
the third was an unavailable import introduced in the test repair. Before the
next heavy run, load the spec with the exact UI Playwright CLI used by the
existing runner, and inspect current API/policy semantics before changing an
assertion. The final test checks transaction, recipient, receipt and exact
credited balance. No new gate/framework; the non-null debt allowance decreased
616 to 615. Next single step remains the narrow authorized fixture import repair
and settlement-execute-atomicity command above, then required PR CI.

Method review, 11:19 UTC: re-read the actual required CI discovery instead of
repeating the frozen parity failure. One active TS settlement test, not both
frozen fixtures, blocks that boundary. Its clean-67a2a1dca failure took 319ms;
no heavy stand or broad suite was repeated. The existing Account reviewer found
no equivalent TS fixture: direct Entity/Account helpers omit signed Runtime
admission, final EntityFrame capture or routed outbox evidence. Recreating the
full setup would duplicate about 180 lines for a one-line import repair. Keep
all financial assertions and the frozen tree intact pending the narrower
exception. No code was deleted and no new financial invariant was proved in
this review. Next: apply that single authorized import repair and run the active
settlement command above. The old two-line patch remains historical, not the
requested release scope.

Method review, 08:45 UTC: the previous half-hour closed a bounded deletion
with 45/45 tests and 38 source gates, but no additional public-release gate.
The hub is still stopped and the two frozen fixture imports remain unresolved.
Next change in method: bundle connected retired-driver seams into one coherent
candidate, then replay that candidate once; avoid a full evidence cycle per
small unread field. Preserve TS workers/checkpoints and reject retired selectors
explicitly. This is not permission to remove financial assertions or relabel
old evidence. The earlier operational lesson remains: `/healthz` served static
HTML; verify `/api/health` and bounded RPC, preserve the stopped DB, and never
repeat funding to hide a deployment-version gap. Discover paths before reading.
First result of that method change, 09:04 UTC: one coherent recorder removal
closed all five bounded checks and removed 1,615 production lines; the public
release blocker remains open. Continue evaluating the method over the next block,
not a claim of improved mainnet readiness.
Method review, 09:18 UTC: coherent retirement closed 5/5 candidate checks and
reduced the measured kernel closure by 1,488 lines from the preceding slice.
The next storage cut first reproduced silent acceptance of a real native DB row.
Keep that failing production boundary as the deletion's regression, preserve
original frame-hash verification before rejection, and inspect actual namespace
ownership before removing codecs used by offline exports. Two disjoint owners
handle runtime and storage; root removes the retired driver. Review the stable
diff before one exact-candidate proof cycle. No public-release gate closed in
this block. Outcome, 09:37 UTC: one driver/storage cut closed all six bounded
checks and removed another 7,950 reachable kernel lines. The first full check
caught folder width: use the existing integrity directory for integrity guards,
and run the small structural gate before the immutable proof cycle. No gate
was relaxed. The known frozen-fixture/public-deployment blockers remain.
Method review, 09:51 UTC: stop expanding deletions until the actual H1 release
boundary is exercised. Reuse existing source-bundle/UI packaging instead of
expanding the unrelated native-products manifest. Check produced files: one Bun
argument order printed help with exit zero and was rejected as build evidence.
Use the canonical read-only RPC allowlist, since watchOnly does not prevent
prepared transaction rebroadcast. Outcome, 10:02 UTC: all three preparation
steps pass (build, package, isolated real-RPC catch-up plus cold restore).
The first harness run stopped before the loop on URL normalization; reusing the
adapter's existing normalizer fixed the helper without production changes.
No public activation, new payment or CI gate was claimed. Resume at the frozen
fixture exception and required PR CI, not another cosmetic refactor.
Method review, 10:27 UTC (scheduled 10:21): clean 090c79158 passed all six
local financial/browser groups: 11 named React cases, lock-ahb (85 frames),
25 funding/exit tests with 512 fuzz invocations, eight bytecode templates and
38 source gates. The browser runner still served Vite dev, so these results
cannot certify the prepared UI archive. Reuse that runner with an explicit
artifact directory and the existing UI-only production test; verify served
hashes and absence of debug hooks. Exercise the actual archive before adding
CI wiring or another abstraction. This changes the next action, not release
eligibility. The frozen-import/required-CI blocker is unchanged.
Next scheduled method review: 10:51 UTC.
Outcome, 10:47 UTC: the actual archive first failed on a shared debug owner,
then passed after one canonical condition. Production and dev both preserve
the UI-only funding/payment/reload flow; the existing CI runner now tests
production bytes. Its first type error was fixed by the existing GateStep
type, without weakening a gate. This bounded set is green; the frozen-fixture
test remains red. Its exception has blocked three consecutive goal turns. Further
release work requires that answer; do not replace it with cosmetic churn.
Latest check evidence: docs/evidence/canonical-review-20261012/compiled-ui-ci-b225f8ac4.json.
Existing 30-minute heartbeat `xln-30` remains active. No external-model budget
was spent or renewed. Earlier method evidence remains in the linked manifests:
provider quota -> bounded first failure; existing authenticated history -> no
refetch; workflow_dispatch success -> not required PR checks; tower upload
failure -> original appointment recovery rather than repeated payments.

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
