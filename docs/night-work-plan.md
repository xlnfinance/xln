# Autonomous xln work

Latest owner-requested implementation handoff: [J/E/A continuation](jea-continuation.md).
Its evidence is dated; root `todo.md` remains the only live release checklist.

## Mission clarification — owner update 2026-09-30

[MML](intro.md#mission) means making the accounts supporting 51% of world GDP
provable by 2050, with dispute on underlying programmable J-machines. This
supersedes older definitions equating MML with settled turnover in this record.
Unique completed economic operations remain near-term adoption evidence, not
GDP-coverage estimates. The attribution method for coverage remains to be specified.

Ethereum, TRON and XLNC are the initial J focus; Base, Arbitrum and other
compatible EVM Js share the same financial architecture after their boundaries
are verified. Preserve existing pay/swap/lending, recovery and platform
deliverables. The new-UI walkthrough and existing-frontend failure E2E
requirements are recorded in [wallet-journey-plan.md](wallet-journey-plan.md).
The owner accepted the [exposure-based reaction schedule](launch-design.md#accepted-automatic-exposure-schedule).
It differs from the current summed finalization clock. Implementation must
preserve immutable signed policy and cross-J evidence portability.

## Active release objective — 2026-09-18

Working method: `docs/improvement-loop.md`. Last deeper review: 2026-09-18
11:11 UTC. Existing ten-minute heartbeat now performs the thirty-minute review
in the same task; no second concurrent automation. Current method change:
stop repeated polling of unchanged external blockers, and count screenshot
disagreements as acceptance failures even when interaction assertions pass.
Quorum `method-review-20260918-01` completed once; USD0.25 remains reserved,
cash unknown. No Claude generation was invoked. Latest owner correction:
working pay/swap in web and iOS takes priority over more reflection or polish.
Verify financial interruption/recovery boundaries while signing/public-service
blockers remain unchanged; do not count repeat happy-path runs as fixes.

11:16 short review: fixed2 observed backup failures. Actual authenticated
HTTP/LevelDB quota regression initially returned200 where413 required: quota
was checked before the new signed receipt joined the stored document. Canonical
writeLookup now enforces exact final serialized bytes before any mutation.
Prior backup remains exact after rejection/reopen; a valid upload still succeeds
immediately after rejection. Related tests27/27,169assertions,2.45s.
Actual native WebKit interrupted prepublication import left empty IndexedDB
containers; retry failed with existing-wallet message. Replaced duplicate
name-only heuristics in native BrainVault open and restore with one read-only
hasLocalWalletData record-count query. Any records remain occupied; inspection
errors propagate; no deletion, storage schema or canonical import guard change.
New live regression checks interrupted retry succeeds and occupied wallet restore
rejects, then new payment/swap/reopen and second fresh archive all pass6/6.
Exactly2paymentreceipts+1swap, final73.000001USDC/0.0099970002WETH. Original21frames
verified; isolated stand43.486s, health green/free. First red stand25.479s.
Final sourcechecks39/39,33.667s; UI types and iOS runtime/Swift build pass;
source native-network restored to public URL. No new SwiftUI video or physical
install. Evidence docs/evidence/ios-ux-20260918/backup-failures. Interruption is
injected before atomic publication, not OS kill/power-loss evidence.
Next useful UI gates remain camera-denial handling and VoiceOver, plus hardware
and public-service blockers; avoid repeating unchanged payment/swap happy paths.

11:11 deep review: one guarded Quorum method-review-20260918-11, short immutable
packet with candidate hashes and observed quota failure. Verified existing route
and caps; no retries, fallback, Claude, new grant or recursive review. Model
suggested speculative preparation-time usage mutation; locally rejected because
usage updates only follow successful writeLookup put. Added useful valid-upload-
after-rejection assertion, which passes. Accepted next-boundary choice: reproduce
interrupted-import retry rather than repeat happy-path UI; produced the second
actual fix above. No method rule change. LedgerUSD4.00reserved/USD6.00remaining,
actual cash/account-wide costs unknown. Next hourly report remains11:32.

10:58 short review: post-recovery spending milestone4/4 passes on real local
hubs through native WebKit: new payment, swap, ordinary reopen, then a new tower
archive imported into fresh wallet storage. Exactly2 finalized payment receipts
and1 closed swap execution survive, with exact give/want/fee. End balances:
73.000001USDC and0.0099970002WETH; swap debit24.999999USDC, gross0.009998WETH,
fee0.0000009998WETH. Fresh archive includes both payments and the swap. No mocks,
owner wallet deletion, public mutation or repeated unchanged happy-path stand.
First run stopped in acceptance evidence export, not payment execution:
walletEvidence scanned frame1 although restored history correctly declares that
height unavailable. Fixed the diagnostic to read canonical activity metadata,
start at its retained boundary, and export availability explicitly. Regression
asserts the recovered floor before new spending; does not hide missing history.
First rerun21/21 original frames exact; extended swap-archive run19/19, then
validated receipts and balances after another actual fresh import. Local health
healthy/free. iOS runtime+Swift test build and UI types green. This block adds
native WebKit acceptance, no new SwiftUI videos or physical-camera coverage.
Evidence docs/evidence/ios-ux-20260918/post-recovery. Signing rechecked10:57:
0valid identities; owner installation remains blocked. No unchanged public probe.
No Quorum call: last deep review10:35, not due. USD3.75reserved unchanged; actual
cash unknown. Next: interruption/quota rejection preserving last usable backup,
and fresh-storage retry behavior; keep existing payment/swap receipt assertions.
Final source gate result recorded in this block's candidate artifact.

10:41 result: native fresh-device payment recovery now passes2/2. Production
wallet backup exports the retained signed checkpoint+tail under committed-read
lock, encrypts them with existing crypto and submits one HTTP pair. Tower uses
existing owner verification, retention and quota preparation, then writes only
the final lookup document; second-entry rejection leaves prior backup intact.
Wallet restore uses canonical atomic recording importer, deleting duplicate
signer registration and old tip-only persistence. No new receipt authority.
Related tests27/27,163assertions,3.57s. Full WebKit real local payment→tower→fresh
import→second reopen passes; original21frames exact, restoredtip24, one receipt.
SwiftUI source payment+backup103.291s; new clean iPhone17Pro simulator restore
33.181s. Restored98.999998USDC, exactlyone confirmedSent1.000001; independent
custody recipient credited1.000001. Whole stand173.066s, health green/free.
Exported videos+11screenshots and visually inspected backup/restored history.
Backup screenshot exposed obsolete claim that another-iPhone restore unavailable;
replaced with honest manual-backup reminder in EN/RU and rebuilt SwiftUI. Videos
precede that wording-only correction; no claim of a second visual run. Original
strict history assertions retained. No camera hardware/public install claim.
First source gate rejected2new non-null assertions in tower receipt handling;
replaced with explicit missing-receipt failure. Final checks39/39,32.436s; UI types
and Swift build pass, diff clean. Source resources remain public xln.finance;
local compiled test product separate. New simulator shut down, data preserved.
Evidence: docs/evidence/ios-ux-20260918/tower-archive; videos in
output/ios-ux-2026-09-18/tower-archive. No Quorum retry; USD3.75reserved unchanged,
actual cash unknown. Next useful acceptance: payment/swap after recovered wallet
rejoins, not repeated recovery happy path. UI retry after empty-target failed
import, archive quota boundaries and OS power-loss remain unverified limitations.
Public/signing blockers unchanged; milestone2/2 is narrow recovery, not release.

10:35 deep review: tower archive integration is now the first useful boundary.
One guarded Quorum call method-review-20260918-10 used an immutable source packet
with per-file hashes. Same verified pi/CodingPlan route and caps; no Claude,
retry or fallback. Returned INVALID_OR_TRUNCATED_SSE_DATA with no usable answer.
Keep full reservation: USD3.75 reserved,USD6.25remaining; cash unknown. No method
rule change or speculative fix based on missing output. Prior method continues
to produce new evidence: local import then full WebKit tower round trip green;
next actual SwiftUI fresh-device test is running, without weakening assertions.
Hourly update delivered10:32: previous block export+import verified20/20 tests,
21/21frames,39/39sourcegates. Actual effort and account-wide spend are unmetered;
known test times in their artifacts, no new installed public product. Next report11:32.

10:21 short review: production fresh-destination archive import now stages and
verifies checkpoint + retained WAL, publishes the complete WAL in one sync batch,
then reopens via the canonical loader. Existing current/previous/WAL/infra or
activity data rejects import. No new receipt authority or persistence schema.
Actual WebKit run first failed MISSING_SIGNER_KEY after source lock; importer now
authenticates bundles and derives/registers their signed signer indexes locally.
Real local three-hub payment rerun passes21/21 frames R2–R22 from checkpointR1,
all four stored commitments per frame, exactly1 matching HtlcFinalized after a
second reopen, sender99USDC after paying1. Local stand healthy and free.
Recovery tests20/20,131assertions,11.55s: next checkpoint and another reopen,
pre/post-publication injected interruption, destination and stale-index rejection.
The extra checkpoint test initially used an unauthorized raw checkpointBarrier;
fixed the test to use the canonical local builder, no guard bypass. Final source
checks39/39,31.358s. No public mutation, UI acceptance rerun or device install.
Evidence: docs/evidence/ios-ux-20260918/atomic-archive. Native fresh restoration
remains1/2 until tower and UI use this archive. Next: atomic tower publication
of checkpoint + tail; sequential uploads can evict the previous complete pair.
Do not repeat the unchanged tip-only simulator test. Empty staging containers
and UI retry after empty-target interruption remain integration limitations.

10:05 deep review: one bounded guarded Quorum method-review-20260918-09,
immutable packet/result in docs/evidence/improvement-loop-20260918. Verified
route pi0.84.4 to Z.AI CodingPlan GLM5.3 low, existing caps8192/64KB/USD0.25;
no retries, fallback, tools or Claude. Accepted content-level stale activity
counterexample: added actual empty activity/infra checks and regression. Rejected
speculative extra receipt/sequence authorities; canonical WAL remains truth.
No method rule change. Reservation ledger returnedUSD3.50 reserved/6.50remaining;
actual cash and account-wide spend unknown. Hourly report remains due10:24.

09:54 short review: proved persistent archive construction using existing
checkpoint import + per-frame verified replay + ordinary saveEnvToDB after each
replay returns. Replay-mode write guard remains intact. All work uses an isolated
storage namespace; no unfinished prefix published to the wallet. New recovery
regression closes/reopens and deletes disposable activity index before verifying
reconstruction:7/7 tests,37assertions. Real local native WebKit payment then
isolated persistence/reopen passes21/21 frames R2–R22 from checkpointR1, with all
four stored commitments matching the original each frame (replica metadata,
post-state, ordered outbox digest and count). One exact HtlcFinalized restored.
Source paid1USDC and held99; full wallet UI not rerun. History remains honestly
partial before retained baseR1. Initial live assertion used raw log fields on
projected activity; corrected to rawType/hash and htlc type, then passed. Second
run added original-versus-imported commitment checks, not another happy-path
repeat. Local services healthy/free. Source checks39/39, diff clean.
This block adds acceptance evidence only, no product fix or new storage API.
Evidence: docs/evidence/ios-ux-20260918/archive-stage. Full fresh-device native
history still1/2; tower integration and atomic publication remain unfinished.
Next design must stage complete archive, publish WAL atomically, invalidate
current cache and reopen via canonical loader so sparse materialization overlays
are rebuilt. Do not resume the old in-memory tip after swapping sparse WAL,
and never expose a partly imported prefix. No duplicate receipt authority.
No Quorum call: last deep review09:26, not due; reservationsUSD3.25 unchanged,
actual cash unknown. Hourly report next10:24. No public mutation/device install.

09:34 short review: isolated real WebKit payment exposed a new first failure:
recording export rejected R2 because default sparse WAL lacks per-frame full
canonicalStateHash. Fixed export to replay the retained tail with all existing
checks before deriving portable full roots, leaving original WAL untouched.
This exposed the next codec mismatch: readPersistedCheckpointSnapshot used
internal storage shape rather than the canonical portable recovery projection.
Switched to existing recovery projection, no fallback/schema weakening.
Recovery suite10/10 (84assertions) and related retention suite31/31 (152assertions)
pass. Real local payment→recording→detached replay passes19/19 frames R2–R20
from checkpointR1; exactly one matching HtlcFinalized atR20, sender99USDC after
1USDC payment. Local services healthy/free afterward. No persistent import,
tower format change, copied wallet, mock, public mutation or iOS binary rebuild.
Canonical recording now works for this payment; full fresh-device history still
1/2 because tower exports tip and persistent restore resets WAL base.
New harness lives scripts/native/tests/payments/recovery-recording.js; invoke
with existing run-session under stand lock. Broader gates first caught unsafe
finally throw, now cleanup preserves original+cleanup failures; second run
caught test-folder width, new test moved into existing payments directory.
Final bun run check passes39/39 source gates (31.032s), frontend/short gates
also green; diff check passes. Stand free.
Evidence in docs/evidence/ios-ux-20260918/recovery-recording. Quorum unchanged
USD3.25 reserved, actual cash unknown. Next: verified canonical archive import,
then tower integration, then rerun strict clean-simulator history acceptance.

09:26 deep review / hourly report: previous hour proves same-install payment
reopen, fresh-device balance restoration, and the missing-history disclosure.
One user-visible fix (partial-history warning), not three product fixes; native
fresh restoration remains1/2. Latest source checks39/39. New root evidence:
backup exports only a tip snapshot, and import deliberately resets WAL base to
that tip. Existing buildPersistedRuntimeRecording exports a retained checkpoint
plus contiguous signed tail, but verified persistent import is not implemented.
Next experiment: real local payment, detached verified recording replay and exact
HtlcFinalized correlation; never invoke persistent import or touch public data.
Quorum method-review-20260918-08 supports isolated replay. Reject its inference
that an ephemeral stand forbids copies/destructively modifies public data, and
its suggestion that merely rebuilding an index solves durability: history must
remain reproducible from canonical stored checkpoint/WAL after another restart.
No method rule change; establish replay before archive implementation. Guarded
route/caps and current official tariff checked, one call/no retries/fallbacks.
Cumulative reservedUSD3.25, remainingUSD6.75; cash/account-wide spend unknown.
Known final UI run durations since last hourly report:117.716+103.543+38.754+
100.192+39.980=400.185s, excluding initial reruns/builds/setup/checks; active
effort not metered. No deploy/install/signing or unchanged public polling.
Hourly report delivered09:24; next due10:24.

09:11 short review: fixed misleading native empty-history state. Native history
projection now passes through the existing complete/partial availability field;
Swift decoder requires a known value. Partial history shows Earlier history
unavailable plus explanation, in EN/RU resources; no empty-page claim. No new
state, receipt store or consensus logic. Rebuilt the actual WebKit host and
SwiftUI app. Real post-payment backup passes100.192 s; a second clean simulator
restores98.999998 USDC. Both new disclosure assertions pass2/2; screenshot
visually inspected. Original full-history assertion still fails39.980 s, so
milestone remains1/2. No assertion removed; missing history is still unresolved.
Stand healthy/free afterward, new simulator shut down without deleting data.
Source checks39/39 (33.468 s), diff check passes, source public network restored.
Artifacts in `history-disclosure/` under existing iOS evidence/output folders.
No new Quorum call: last deep review08:49, no method fork. ReservationsUSD3.00,
cash unknown. Next work must inspect canonical checkpoint+WAL archive restore
options; do not repeat this known-red E2E without a historical-recovery change.
EN disclosure verified live; RU copy added but not separately visually exercised.
No public mutation or physical installation; hourly report last08:15.

08:54 result: fresh-device recovery milestone is1/2, not complete. Native
post-payment backup passes103.543 s, verified snapshot157 /43 KB displayed.
Second simulator was newly created (not cloned), with no XLN installation before
test. Remembered credentials restore exact98.999998 USDC, but Sent history is
absent; strict testTowerRestore fails38.754 s. Whole stand finishes169.957 s,
within180 s, health green. Independent custody post-check is not reached because
the UI test fails; do not imply that verification ran in this scenario.
Root cause from canonical source: encryptTip exports current checkpoint plus one
tip journal; persistRestoredRuntimeState replaces local persistence at that tip.
Earlier history is absent by construction. History query exposes partial
availability, but ui/src/native/history.ts discards it and WalletActivity says
No activity. Keep full-history test red; do not manufacture receipts or remove
its assertion. First useful fix: pass existing availability metadata through to
native Activity and show an explicit missing-history notice. Full history needs
canonical retained checkpoint/WAL archive work, not a second receipt store.
Six source screenshots and fresh-restore failure attachments/videos preserved;
balance/backup inspected, missing-history frame extracted from actual video.
Evidence in `tower-restore/` under existing iOS folders. Source checks39/39
(32.853 s), native test build green, diff clean, stand free. No product code fix
in this block; only reproducible test/runner additions. Original simulator/data
preserved; new simulator shut down after capture to save resources. No public
mutation/signing recheck. Quorum reservationsUSD3.00, actual cash unknown.

08:49 deep review: same-install reopen is now proven, but not fresh-device
recovery. Existing native code discovers tower recovery when local IndexedDB
is absent; backup screen still labels transfer unavailable. Test that boundary
before changing copy. Preparing one post-payment backup + fresh second-simulator
restore, preserving the original simulator. Same stand stays alive,180 s total;
no timeout relaxation. New simulator CFA23D80-93CE-467A-8348-B37127E1D816 was
created and booted, never cloned; app absence is checked before the run. Only
public test name/password are entered, no DB/keychain copying or runtime bypass.
Quorum method-review-20260918-07 raises stale local/keychain state as a false
positive. This new device addresses it; reject redundant erasure/recreation and
its suggestion to prohibit remembered credentials, which are the intended UX.
Live tower retention is required, not a false-positive by itself. Shared guarded
reservationsUSD3.00, remainingUSD7.00, actual cash/account-wide spend unknown.
One call, no retries/fallback/Claude; current tariff/caps checked. No new method
rule: verify rendered evidence and distinguish persisted reopen from remote restore.

08:35 short review: default BrainVault native payment→terminate→relaunch→
password reopen passes1/1 in117.716 s. Relaunched app stays locked; same remembered
name/password restores98.999998 USDC and exactly one confirmed1.000001-USDC Sent
record. Independent custody verifies1.000001 received after reopening; all local
services healthy. Initial run also passed118.341 s, but screenshot review caught
the balance capture during unlock-sheet dismissal. Added a semantic wait for
that sheet's submit control to disappear; one rerun now shows the actual balance.
This is a test/evidence timing correction, not a wallet bug fix. Corrected the
new helper's initial XCTest element-vs-query compile error before live execution.
Nine final screenshots exported; restored balance/history visually inspected.
68.974 s normal-speed video excludes52 s setup; full and initial runs retained.
Evidence/video in `payment-reopen/` under existing folders. Source checks39/39
(source stage31.269 s), diff check passes, stand free, source network remains
xln.finance. Local persisted recovery only; fresh-install tower recovery remains
unverified. Next useful boundary: native encrypted backup verification after a
payment, then fresh-install restoration from that exact backup. No Quorum call:
last deep review08:12, not yet due, no new method fork. ReservationsUSD2.75,
actual cash unchanged/unknown; no public poll, deployment, reset or install.

08:15 result / hourly report: native Market ask→limit buy→receipt passes1/1
in105.177 s. Selected2500.5 USDC price matches prefilled input; buy0.009 WETH
debits22.5045 USDC, gross0.009 WETH, fee0.0000009, net0.0089991,
remaining77.4955 USDC. Receipt and both balances reconcile; WETH headline
selection passes. Real local stand healthy; default100-shard BrainVault used.
Seven screenshots exported; book/review/receipt/balances visually inspected.
55.454 s normal-speed demo excludes54 s setup; full recording also retained.
Evidence in `orderbook/` under existing iOS evidence/output folders. Source
checks39/39 (31.133 s), diff check passes, stand free, production source network
configuration preserved. Product code unchanged in this block. Resting orders,
partial fills and cancellation are not proven by a marketable limit fill.
Past hour: four new native acceptance runs passed4/4—Russian payment, default
BrainVault creation, Russian swap with defaults, and Market limit buy. This is
coverage, not four bug fixes or release readiness. Removed custom test creation
branch and extended locale/entry-path assertions. Known test runtimes326.179 s
combined, excluding build/check/review/setup; total active effort not metered.
Two bounded Quorum consultations in this hour addedUSD0.50 reservations;
cumulativeUSD2.75 reserved, actual cash and external spend unknown. Public
startup/signing/camera remain blocked/unverified; no deploy/reset/install.
Next smallest user-visible safety boundary: real default BrainVault reopen and
restored payment/swap history after app termination, using the remembered secret.

08:12 deep review: previous two blocks closed default BrainVault and Russian
swap evidence gaps; default setup now shared by financial tests, custom6-shard
branch removed. New bounded decision: native Market price tap has never been
covered by the Home swap test. Quorum method-review-20260918-06 supports one
real orderbook limit-buy run using the existing exact receipt/balance assertions.
Locally verified Market row IDs contain price ticks and draft prepopulates price;
new test checks that value rather than inventing a separate financial formula.
Retain the Home swap case; do not replace existing coverage as the model suggested.
Model confidence is opinion, not acceptance. Its passive-order warning is valid:
a tapped ask may move; report an unfilled result honestly if that happens.
No new method rule or infrastructure. Build passes; one bounded stand now running.
One guarded GLM call, zero retries/fallbacks/Claude. Shared reservationUSD2.75,
remainingUSD7.25; actual cash/account-wide spend unknown. Guarded caps and current
Z.AI price page checked; no new authorization or release of historical reserves.

07:56 short review: Russian native swap passes1/1 in91.467 s using the shipped
factor3/100-shard BrainVault defaults. Removed the custom-six-shard setup from
all financial UI tests after the previous default-path measurement proved it
fits the existing limits. Locale-aware labels and Decimal parsing preserve
exact receipt and balance assertions. Debit24.999999 USDC; gross0.009998 WETH;
fee0.0000009998; net0.0099970002; remaining75.000001 USDC. WETH headline
selection passes. Six screenshots exported; review/receipt visually inspected;
normal-speed43.043 s demo removes52 s of setup. Services healthy afterward.
Default submit-helper-to-ready11.0140 s includes UI/network/polling overhead.
Final source checks39/39, source stage32.421 s. Evidence in `russian-swap/`
under the existing iOS evidence/output folders. Test simplification and new
locale acceptance, not a product bug fix. Source network configuration restored
to xln.finance; no public mutations. Signing still has zero identities at07:52.
No new Quorum call: last deep review07:35, no new method fork; reservations
unchangedUSD2.50, cash unknown. Next useful boundary: native orderbook price tap
through limit-order confirmation and receipt, rather than another swap repeat.

07:35 deep review: Russian native payment passes 1/1 in95.387 s, with exact
localized review values (maximum1,000002; recipient1,000001; fee0,000001 USDC),
independent custody credit1.000001, sender98,999998, Russian Activity and
background lock. Screenshots inspected; real isolated local services healthy.
Source checks pass39/39 (source stage31.718 s). Changes here extend the existing
test/runner to select English/Russian and assert localized amounts, not wallet
financial behavior. Evidence/video: `russian-payment/` in the existing folders.

Quorum `method-review-20260918-05` supports measuring the untouched default
BrainVault path next: Swift factor3 selects100 shards; UI financial tests used
custom6. Verified those constants locally before choosing the experiment.
One default-settings native creation run completed, with the existing180 s
stand /150 s UI limits and a100 s post-confirmation readiness bound. The prior
40 s bound remains for custom-shard financial cases. Record confirmation-to-ready
time including UI/network overhead, not pure KDF time or physical iPhone speed.
No security parameter changes, repeat-until-green loop or new test framework.
Default creation passes1/1 in34.148 s overall; timed submit-helper start to
wallet visibility10.9897 s, including roughly2.3 s of XCTest pre-tap waiting,
network/backup work and polling. Tap dispatch25.06 s to visibility33.71 s is
approximately8.65 s at test-log precision, not an isolated KDF benchmark.
Single simulator sample on this Mac; no physical-phone latency claim. Video
frame shows BrainVault52/100; ready screenshot shows the actual joined wallet.
No recovery-settings detour or shard override. Evidence/video in
`default-brainvault/` under the existing iOS evidence/output folders.
Final source checks pass39/39 (source stage31.188 s), diff check passes, stand
free, source native-network configuration remains public xln.finance. Two new
acceptance gaps closed in this block; no product bug fix, deployment or install.
Reject Quorum's example of a210 s completion under a180 s deadline as impossible
in this experiment. Shared reservationsUSD2.50, remainingUSD7.50; cash unknown.
One guarded call, no retry/Claude. Keep the existing method: first useful boundary
and visual evidence alongside assertions; do not invent another reflection rule.

07:18 short review / hourly update: bounded public diagnosis confirms the same
deployed SHA 4dfabd621b913e9e79da315f33d21a1b9708778b. PM2 reports 5,070 existing
server restarts. Fresh 07:16 logs show all three hubs failing the unchanged
10,313,244 / 13,336,516 / 13,336,514-byte frame heads against 5,666,667 bytes.
The earlier online flags were transient startup observations, not restored
connectivity. Stop investigating direct links as an independent fault. Keep the
existing schema/contract upgrade and destructive-reset owner decision open;
no public restart, deployment, backup, reset or ledger mutation was performed.
Evidence: `docs/evidence/ios-prod-testnet-20260918/startup-0717.log`.

Caught a regression introduced by the large-text UI fix: its shared amount view
had been placed in WalletQuote.swift, coupling the Foundation-only quote decoder
to SwiftUI/localization and breaking the existing standalone expiry vector's
compilation. Moved that unchanged view into WalletActivity.swift. Original quote
expiry vector now passes 5/5, simulator build passes; final source checks pass
39/39 (source stage32.309 s), diff check passes and stand is free. Evidence in
`docs/evidence/ios-ux-20260918/model-separation/`.
The 07:02 full swap video precedes this source-only relocation; no new financial
claim is based on compilation. Past hour delivered one amount-readability fix,
the consent test correction and the correction of this introduced coupling;
normal-text and maximum-text swap flows passed, plus worker isolation evidence.
Public demo and intermittent Bun startup crash remain unresolved. External
managed reservations still USD2.25, actual cash unknown; no new model call.

06:57 short review: maximum-text swap first failed because the test treated
an off-screen lazy receiving-capacity button as optional and skipped consent.
The fresh-wallet test now always scrolls to consent and prepares WETH capacity.
It then passes 1/1 in 131.716 s with reconciled receipt/balances and healthy local
services. Screenshot review still rejects visual acceptance: the minimum WETH
amount wraps mid-number. A shared native amount row now keeps review and fill
quantities on one line with font scaling; the header does the same. Fresh
maximum-text swap validation initially caught separated receipt accessibility
labels; the row now uses the original native LabeledContent accessibility
representation with the exact same value. Final full swap passes 1/1 in
130.325 s, including receipt/debit/fee/balance assertions and healthy services.
Final review screenshot confirms complete, unbroken amounts at maximum size.
Source checks pass 39/39 (source stage 32.222 s), diff check passes, stand free,
simulator text size restored to normal. This confirms
why rendered evidence must remain independent of green interaction assertions.
No extra Quorum call: the last bounded review was 06:33, and no new method fork
needs an external opinion. At 06:48 public hubs report online 3/3, but aggregate
service health still fails and signing identities remain zero. No public changes.

07:04 deep review: retain visual inspection plus financial assertions; no new
reflection mechanism. Quorum `method-review-20260918-04` recommends next examining
public startup read-only, which directly gates the owner's demo. Verify its
claim before acting: the saved 06:48 health snapshot still has zero direct hub
links despite three online flags, so its assertion that connectivity is cleared
is unsupported. Also reject its inference that unchanged dependency inputs prove
a health-check bug. Next smallest action: inspect the first public direct-link
failure in existing logs, preserving the ledger and reset authority. No further
speculative Bun restart loop. Shared reservations USD2.25, remaining USD7.75;
actual cash and external account spend unknown. One call, no retry/Claude.

06:33 review: isolated the startup hypothesis before repeating the full swap.
Existing real-worker parity passes 20/20 (80 assertions, 4.05 s). A bounded
production coordinator lifecycle probe starts/closes 48 pools of eight workers
in three waves (128 concurrently, 384 total) in 16.046 s without a crash. Empty
worker churn is therefore insufficient to reproduce the failure; this is not
financial or startup reliability acceptance. The decoded native crash is in
JSC garbage collection; root cause remains unknown. Added field-name/type-only
diagnostics to the existing unmatched-response fail-stop, preserving rejection
and avoiding payload/key logging. The instrumented native swap passes 1/1 in
100.510 seconds, with healthy services afterward: receipt debit 24.999999 USDC,
gross 0.009998 WETH, fee 0.0000009998 WETH, net 0.0099970002 WETH, remaining
75.000001 USDC. Review/receipt screenshots inspected; amounts start visible.
Video and seven screenshots: `output/ios-ux-2026-09-18/swap-current/`.
This clears the current UI regression, not the intermittent startup gate.
Final unchanged-code `bun run check`: 39 source gates pass, source stage
31.866 s; `git diff --check` passes and stand lock is free. This block added
diagnostic evidence, not a crash fix. Current public/signing observations remain
the 06:16 ones; no unnecessary repeat poll or public mutation.
Quorum `method-review-20260918-03` agrees the observation is useful but a clean
run cannot clear intermittency. Reject its suggested ~20 stand repetitions:
unknown frequency gives no basis for that number and displaces client evidence.
Keep the existing method; capture first failure or stop after this one bounded
swap acceptance run. No Claude call. Shared reservations USD2.00, remainder
USD8.00; cash/account-wide spend unknown. Evidence in `worker-startup/` under
the existing iOS evidence directory and `improvement-loop-20260918/`.

06:00 review: maximum-text payment testing exposed a half-height recovery sheet
and a test tap outside the viewport despite XCTest's hittable flag. Recovery
settings now use full height at accessibility sizes; wallet creation succeeds.
The consent interaction now verifies its actual tap point. A further real UI
defect retained the input form's bottom scroll position on entering review.
New quote identity now resets the Form to the amounts. Largest-text payment
passes 1/1 in 114.954 seconds, including independent 1.000001-USDC custody credit,
exact sender balance, Activity and background lock. Source checks pass 39/39 in
31.803 s. Generated output videos/screenshots are Git ignored (retained on disk):
the unchanged canonical-payment gate now passes 7/7 in 1.64 s instead of timing
out while decoding 1.48 GB of mixed source/evidence files. Swap regression is
blocked before UI launch by a second Bun Worker crash: MM logs
`TS_ACCOUNT_WORKER_UNMATCHED_RESPONSE:4:undefined`, then SIGSEGV, 299 process
threads. Evidence: `docs/evidence/ios-ux-20260918/large-payment/`. Next smallest
failure: isolate malformed worker response/startup crash before repeating swap.
At 06:16 UTC public H1/H2/H3 remain offline and signing has zero valid identities.
Quorum `method-review-20260918-02` returned once: reuse a healthy
owned stand for repeated UI debugging, but retain fresh-stand final acceptance.
Adopt this as the next repeated-debugging method trial, not a reason to build
new stand infrastructure now; claimed savings are unmeasured. Keep the Bun crash
as an independent startup gate. Shared reservations USD1.75, managed remainder
USD8.25, cash/external account costs unknown. No Claude call or fresh grant.

Current robustness evidence: Chromium payment validation and double-confirm /
reload tests pass 2/2 in 38.9 seconds. Native WebKit plus NativeSockets passes
in-flight lock with the real H1 paused for ten seconds: lock completes after
10,398 ms, the reopened wallet has exactly 99 USDC, one matching initiated /
finalized 1-USDC payment, and no pending Account work. This is a macOS WebKit
runtime probe, not an iOS background-suspension or camera test. The first run
never reached the probe: H1's Bun 1.4.0 worker crashed during startup
(macOS EXC_BREAKPOINT / SIGKILL); peers then halted. The controlled rerun passed,
but the native Bun crash is unresolved, not fixed. Logs and crash summary:
`docs/evidence/ios-ux-20260918/robustness/`. Native swap minimums, fee accounting
and exact balances after reopen also pass: below-minimum and rounded-below-minimum
quotes reject without changing balances; one closed fill and reopened balances
match its recorded debit, gross receipt and fee. Four current scenarios pass
(two browser tests and two native-runtime probes), with one separate startup
crash still unresolved. This block produced verification evidence, no code fix.
Next client boundary: financial confirmation at largest text, while public
recovery/signing and native Bun crash reproduction remain separate open gates.

Latest owner steering: continue simulator testing and establish evidence-backed
native UX/UI acceptance, target 95/100. See `docs/ios-ux-acceptance.md`; do not
declare that score before evaluating every criterion. Ten-minute reflection
heartbeat `xln-10-minute-reflection` is active in the current thread. Change a
stalled method after two attempts without new evidence, and use bounded Quorum
consultation for real uncertainty. First UX review `ios-ux-20260918-01` completed;
one request, no retry, USD 0.25 reserved with cash cost unknown. Public/device
blockers below remain open; simulator work must not imply they are resolved.

Owner priority correction: finish the physical iPhone scan → confirm → receipt
demo before extending the cross-chain/recovery work. Do not use extra coverage
or broad milestones as a substitute for removing installation/service blockers.
One work block must remove a concrete blocker or produce visible acceptance
evidence. The withdrawal fix and its historical replay limitation remain saved;
checkpoint migration is deferred while the phone/public-demo path is active.

Fresh device evidence: the physical iPhone 17 Pro is now connected over USB and
paired; the latest CoreDevice check confirms Developer Mode enabled. Xcode's
Apple Accounts UI still shows the Sign In screen, and Keychain reports zero
valid signing identities. Apple sign-in remains required; do not ask the owner
to enable Developer Mode again. No installation claim. Public `/api/health` remains HTTP 200 with
`coreOk=false`, `systemOk=false`, `HUB_MESH_NOT_READY`, `CUSTODY_NOT_READY` and
other readiness failures. It reports reset/startup in progress; that flag alone
does not prove active recovery. No public mutation was performed by this task.

Latest financial fix: the production Entity stage used to discard a newly
created withdrawal continuation before its queued Account transition was
materialized. The fix reads the existing pending admissions; inline / TS W1 /
TS W4 regressions pass, with 56 focused settlement tests / 367 assertions.
The stranded signed cross-swap withdrawal was recovered through the canonical
explicit execution command after checking chain nonce and exact workspace.
A separate fresh automatic deposit → collateral → withdrawal returned the same
10 private native-Tron test tokens without manual execution. Real receipts at
blocks 121/124/127, nonces 2/3/4; latest-head restart exactly reproduces hub R220
and user R188. `bun run check` passes 39 source gates / 44.571 seconds.

Next financial release gate: prove an explicit offline checkpoint migration and
cold recovery. Historical replay with the fix loudly rejects the old buggy R91
(`RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH`); latest-head restoration alone
does not establish upgrade compatibility. Preserve that history, never bypass
its hashes or silently run old transition logic. Current ledger inspection
entrypoint is `--automatic-withdraw-restore`; older commands below refer to
superseded heads. Evidence: `docs/evidence/tron-native-release-20260918/withdrawal-proof.json`.
Lending, rendered cross-chain app acceptance, public-ledger recovery and physical
iPhone installation remain unfinished. No release or deployment claim.

Latest native UI acceptance: payments passed on iPhone 17 Pro simulators on
iOS 26.5 and 27, with independent custody receipt verification. A native swap
also passed on iOS 26.5: debit 24.999999 USDC, gross 0.009998 WETH, fee
0.0000009998 WETH, exact final balances 75.000001 USDC / 0.0099970002 WETH.
The UI test used real local hubs/market maker; videos and evidence are in
`docs/evidence/ios-prod-testnet-20260918/readme.md`. No mocks or public deployment.
Xcode 27 license is now cleared; native compilation passes, but physical-device
reachability/signing and the public-ledger recovery decision still block install.
The older license failures below are historical. The misleading $109.99
reference-price headline is now removed: native and React Home show the selected
asset's exact balance and separate payment capacity. Native asset-sheet selection
and a real Chromium swap both pass against committed balances. Evidence/video:
`output/ios-balance-2026-09-18/`. Web allocation charts retain explicitly labeled
fixed reference prices; no live portfolio valuation is claimed. Physical install
and public-testnet recovery still have priority when their blockers clear.

Latest cross-chain milestone: one real match between two opposite orders
exchanges 10 six-decimal test-token credit claims per direction across private
Ethereum and native TVM. Two sovereign Runtimes use authenticated direct sockets;
four bilateral Account pairs end at height 5 with equal peer roots, outgoing
capacities 90/110/110/90 (from 100), and zero pending frames, offers or pulls.
Restart reproduces hub R71 and user R64 frame/root hashes and all Account/route
states exactly. User WAL has four prepares: one per owner, two per order, one
economic match. Proof: `docs/evidence/tron-native-release-20260918/cross-swap-proof.json`.
Final focused strict TypeScript check and full `bun run check` pass (39 source
gates / 40.864 seconds). 43 evidence hashes pass; stand free, nodes stopped.
No financial core edit, mock, public deployment or GDP attribution. First failed
driver waited for user profiles before dialing the direct connection; setup
order fixed and existing WAL preserved. Current dual-ledger entrypoint is
`--cross-swap-restore`; the old observer-only restore lacks the Entity keys.
Next release gaps: native-chain withdrawal after swap, lending and actual app
acceptance. Physical iPhone install/demo retains priority when Xcode setup and
the public-ledger recovery decision are resolved.

Earlier dual-chain boundary: a real private Ethereum node and native TVM node
are authenticated in one Runtime. Restore preserves the original R4 frame/root
and both certified registration claims, then commits R5 observations. Import
and recovery pass; cross-J financial execution remains untested. Evidence:
`docs/evidence/tron-native-release-20260918/cross-network-restore.json`.
Use `--cross-network-restore`; preserve both ledgers and the existing WAL.
Full repository check passes: 39 source gates / 40.512 seconds; 36 evidence
hashes verified, stand free, no chain processes left running.
The owner's renewed phone confirmation triggered a fresh device check, but
Xcode exits 69 for an unaccepted license and signing has zero identities.
Current phone reachability cannot be revalidated until setup finishes. Fresh
public health remains unhealthy. Physical installation is still the priority.

Latest wallet milestone: the real frontend Move builders and
EmbeddedRuntimeAdapter submitted a private-native-Tron deposit and withdrawal
through the running canonical Runtime. Deposit at block 69 commits 1,000,000
XLNUSD base units / nonce 3; withdrawal at block 72 commits reserve 0 / nonce 4,
no pending batch, exact external token balance restored. Same-WAL restart
reproduces R22 frame/root and Entity frame 5 exactly. Submitted transaction
hashes match both observed receipts. Evidence:
`docs/evidence/tron-native-release-20260918/wallet-proof.json`.
Full `bun run check` passes: 39 source gates / 40.949 seconds,
`/tmp/xln-tron-wallet-final-check.log`; diff check and 28 evidence hashes pass.
Current reuse is `--wallet-restore`; prior nonce-2 `--entity-restore` is historical.
One initial harness attempt failed before submission because the Bun driver had
not started the normal Runtime loop; that lifecycle setup is fixed. No core
financial change. Both successful stands exit zero, node stopped and lock free.
This is shared wallet command-path evidence, not rendered native UI acceptance.
Next native gap is ETH↔native-Tron bilateral execution, then lending/app acceptance.
Physical iPhone installation remains the immediate owner priority when external
device/signing prerequisites and the pending public-ledger decision are resolved.

Latest native milestone: canonical TS Runtime/Entity consumed the real private
Tron deposit/withdrawal receipts (blocks 23/24), finalized nonce 2 and reserve 0,
and restored the same Entity frame hash from WAL. The ordered signed prefix
contains reserve 1,000,000 then 0 and nonces 1 then 2 exactly once. Final recovery
run restores R10, ends at R11, exits 0, closes databases and stops the native node.
Harness fixes: load the known disposable Foundation signer before replay and
exit the bounded CLI after cleanup because crypto pools live until process exit.
Failures remain recorded. Current reuse is `--entity-restore`; authority-only
`--runtime-restore` cannot restore the newly imported Foundation signer.
Evidence: `docs/evidence/tron-native-release-20260918/entity-restore.json`.
Full check passes, 39 source gates / 40.288 seconds, log
`/tmp/xln-tron-entity-final-check-retry.log`; diff whitespace check passes.
The first full run had an unrelated advisor process-group cleanup `EPERM`;
focused 4/4 and unchanged full retry pass, intermittent cause remains unresolved.
Next native gap: wallet-originated financial work and ETH↔native-Tron execution;
this catch-up proof does not demonstrate cross-chain swap, lending or the app UI.

Host setup changed during this work: Apple Xcode tooling now reports an
unaccepted license. Existing Command Line Tools Git still runs, so repository
checks use its PATH without changing global Xcode selection or accepting terms.
The owner must finish Xcode setup before device build/install can proceed.

Immediate owner priority: install the first native build on the owner's physical
iPhone 17 Pro, connect to `https://xln.finance`, and prove one real public-testnet
payment. Public-testnet connection/demo testing is now explicitly authorized;
this does not authorize mainnet spending or destructive public-ledger resets.
Current build: `/tmp/xln-ios-prod-testnet-device/Build/Products/Debug-iphoneos/App.app`.
Physical-device compilation and bundled production origin/recovery configuration
pass. Signing fails because no development team/valid signing identity exists.
The known phone is unavailable; direct USB inspection finds no iPhone even after
the owner reported connecting it and enabling Developer Mode. Owner is signing
in to Apple; Xcode first-launch component setup was attempted, but LaunchServices
reports incompatible application version on this Mac. No physical install yet.
Public testnet is independently unhealthy: deployed SHA
`4dfabd621b913e9e79da315f33d21a1b9708778b`, all three hubs repeatedly fail
`ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED` (10,313,244 / 13,336,516 / 13,336,514
bytes against 5,666,667). Only read-only production diagnostics performed;
no restarts, reset, deployment or payment. Tower health passes. Current public
active chains are EVM 31337/31338; native Nile/Sepolia entries remain pending.
Full `bun run check` passes (39 source gates, 40.030-second source phase).
Evidence: `docs/evidence/ios-prod-testnet-20260918/readme.md`.

Production upgrade preflight: current committed code has a 100 MB frame limit;
the deployed source still has 10 MB. A new 150,000-empty-block catch-up case passes
without a production-code change; complete J-prefix suite passes 19/19 with 141
assertions. Old production storage format is 7 versus current 5, and contracts
have changed. No code-only upgrade or ad-hoc limit backport is justified. The
owner has been asked whether to archive and rebuild the testnet, losing active
test balances/channels. This decision is pending. Remote state sizes: JDB 680 MB,
hub mesh 6.7 GB, watchtower 356 KB, free disk 8.6 GB; stream a consistent stopped
backup off-host rather than exhausting remote disk with an uncompressed copy.
Release source preflight also rejects the dirty shared tree. Published main was
`dc4b000af39d99c5052cc8b2d4599c4f2ce80b97`, local HEAD
`a8210663e8378f76c387359f59f69eb35d3f4324`; do not deploy an unverified mixed version.

Native Runtime authority recovery now passes on the preserved ledger. Fixed the
test harness to read authoritative frames from Runtime WAL, not the materialized
state database. Recovered the interrupted import without clearing its frames.
The original R4 frame/root and signed Foundation authority are retained; restart
from R5 then commits R6 with fresh native RPC-attested observation through block 35. The stored original evidence still observes block 25, correctly unchanged by
idempotent repeated authority. Authenticated watcher scan reaches 35. An initial
assertion incorrectly expected the immutable stored authority to advance; its
failed log remains saved. No production fallback or financial code changed.
Evidence: `docs/evidence/tron-native-release-20260918/runtime-proof.json`.
Reuse `--runtime-restore`, never fresh import or `--economic` over this ledger.
Full `bun run check` passes (39 source gates, 41.711-second source phase), native
node stopped and stand free. Next native step: Entity financial transitions on
this real native jurisdiction, then ETH↔Tron and lending. iPhone install/demo
retains priority as soon as phone/signing and testnet rollout decisions permit it.

Owner: Egor Homakov. MML: by 2050, accounts supporting 51% of world GDP are
provable through programmable J enforcement. The immediate deliverable is an ETH ↔ Tron release with pay, swap and
base lending, recovery, and working web/iOS/Android/desktop apps; the existing
extension remains a companion. This supersedes the September 7 lending exclusion.
Use the existing capped-testnet acceptance policy as the preparation baseline.
The later physical-iPhone demo request authorizes public-testnet connection and
payment testing. Mainnet deployment and real-money transactions remain unauthorized.

Execution order: repair the first live financial/lifecycle failure; prove pay,
cross-chain swap in both directions, lending and recovery on the canonical runtime;
connect the supported app surfaces to those same paths; package and verify each
target; then run the existing release gates and canary. Native Tron TVM/public
network evidence must be distinguished from the current two-Anvil dev stack.
An iOS same-chain quote is not ETH ↔ Tron coverage. A build is not app acceptance.

Immediate-lock follow-up (2026-09-18): reproduced payment-confirm → lock causing
H1 to halt because the wallet raised its P2P ingress fence before receiving the
accepted payment's reply. Shared web/native shutdown now pauses J watchers first,
drains with peer ingress still active, then fences persistence. The real
WKWebView/Swift-socket regression observes pending work at lock, restores the
same identity and exactly 99 USDC from 100, has one matching finalized payment,
zero pending Account work, and healthy hubs. Evidence:
`docs/evidence/native-quote-session-20260918/immediate-lock-result.json`.
Related tests: 36/36, 153 assertions; UI typecheck and full `bun run check` pass
(39 source gates, 39.231 seconds). Updated iOS simulator build passes. This does
not prove disconnected peer closure or forced-kill recovery. Next: reach the
native Tron cross-chain production boundary and lending acceptance. Forced
shutdown remains mandatory before claiming general payment recovery/release.

Delayed-peer follow-up: pausing the actual H1 process for 1,500 ms exposed a
false-success drain (lock returned after 286 ms). Runtime drain now also waits
for live Entity consensus and the existing indexed queued/pending Account work.
The same delayed-peer payment/lock/reopen succeeds with exactly 99 USDC, one
finalized payment and healthy hubs. The source-built canonical native probe
independently passes with lock returning after 1,892 ms. The reusable command is
`bun run stand:run --reason native-delayed-lock --timeout-ms 180000 -- bun scripts/native/run-session.ts immediate-payment-lock.js 1500`.
The normal run omits `1500`. Focused/related tests pass 43/43 with 181 assertions.
Evidence: `docs/evidence/native-quote-session-20260918/delayed-lock-result.json`.
This uses real WebKit/Swift sockets and local Anvil; neither forced process
termination nor native Tron/public-network coverage is claimed.
Full `bun run check` now passes (39 source gates, 39.887 seconds); the updated
iOS runtime/Swift simulator build passes and is installed. The earlier folder
width failure was fixed by reusing the existing Swift probe and keeping its
runner in `scripts/native`. No commit, push or public deployment.

Native Tron next-step clarification: the owner's recorded 17:31 decision below
already authorizes configured RPC-attested native evidence, including external
RPCs. Do not reopen the old FullNode-versus-portable-proof fork. Current code
contains that implementation, and the September 6 authority manifest records
same-WAL recovery and fresh native watcher observations. Revalidate current
source against the actual TVM fixture, then advance financial/cross-J execution.
Public deployment network authorization remains separate and unanswered.

Native Tron restoration (2026-09-18): the old `/tmp` fixture was absent. Exact
java-tron 4.8.2.1 ARM and Temurin 17.0.20.1+1 binaries were restored from official
assets and matched the recorded SHA-256 hashes. A new private native ledger is
now preserved at `db/native-tron-release-20260918`; this is not restoration of
the old chain history. Nine artifact metadata source sets match current Solidity.
The canonical deployer deployed eight XLN contracts plus a local XLNUSD test
token. After node restart the canonical JAdapter reads the real registry in
`tron` mode. Native deposit block 23 and signed withdrawal block 24 pass:
reserve 0→1,000,000→0, external balance exactly restored, Entity nonce 0→1→2,
with withdrawal solidification awaited. The disabled energy-estimation API was
the first financial failure; enabling the native API fixed configuration without
a signer fallback. Its failure evidence and unchanged initial-state checks remain.
Full `bun run check` passes: 39 source gates, 41.289-second source phase.
Evidence: `docs/evidence/tron-native-release-20260918/readme.md` and `manifest.json`.
Reuse the existing graph with `bun run stand:run --reason native-tron-readback --timeout-ms 60000 -- bun scripts/tron/native-stand.ts --verify-graph`.
Do not repeat `--economic`: it intentionally rejects an existing progress file.
Next: current Runtime authority import/Entity financial execution on this native
graph, then ETH↔native Tron cross-J pay/swap and lending/app acceptance. The old
temporary import driver references a different graph and must not be reused
without adapting its actual bindings. No public deployment or full release claim.

Native session follow-up: four live WebKit/Swift-transport regression cases now
pass on an isolated healthy two-Anvil stand. Unexpired quotes are rejected after
lock, invalid boot and invalid BrainVault entry; a fresh one-USDC payment leaves
99 USDC from 100, and duplicate confirmation rejects. A discovered same-page
Runtime leak is repaired by awaiting canonical shutdown before native boot or
BrainVault replacement. UI typecheck passes. The updated iPhone simulator app
builds; actual iPhone UI acceptance and native Tron remain unverified. Evidence:
`docs/evidence/native-quote-session-20260918/quote-session-result.json`.

The original immediate-close failure remains open: H1 halted at Runtime height
179564 after a closing wallet rejected an Account input as
`INBOUND_ENTITY_RUNTIME_QUIESCING`. Preserve its evidence and databases. Do not
conflate passing settled-payment lock/reopen with immediate-close safety.

Follow-up evidence: restarting only halted H1 preserved its database, but the
supervisor exhausted three recovery attempts with
`HUB_JURISDICTION_IMPORT_COMMIT_MISSING:Testnet`. H2/H3 also halted when H1's
socket closed. H1's last health reported one queued Account transaction and one
pending Account frame. The hub import now waits for the exact submitted input
commit and J replica rather than global idleness. Focused regression reproduced
the old ten-second timeout under continuing unrelated ingress; two tests/five
assertions now pass, including conflicting chain rejection. Runtime typecheck
and production function-size gates pass.

A data-preserving restart passed H1/H2/H3 imports in 272/428/482 ms, then exposed
`J_HISTORY_FINALIZED_REORG` at local chain 31337 block 90211. Expected hash
`0xc7e63ffdac4034a30f2ee9e20d51ea1a10ab19916f0fedca012f4f43a95a8c82` differed from
RPC hash `0xf081e3fab9f1fd9fb00f866e17b8357c482484e8d92c60101c2d8e87892fab37`.
The original dev data remains intact and the bounded stand has stopped. Do not
retry this unchanged state or weaken finality checks. Compare the saved chain
history with Runtime evidence; an isolated fresh test stand can unblock further
app tests while preserving this failure, but cannot certify recovery of this one.
Evidence: `docs/evidence/native-quote-session-20260918/import-recovery-health.json`
and `finalized-reorg.json`. Immediate native shutdown and full release acceptance are still open; the quote
regression has since passed on the separate stand described above.

Source verification: the current candidate passes full `bun run check` under
its 60-second stand lock (39 source gates; `check:src` 54.646 seconds). UI
typecheck and the iPhone simulator build also pass. Log:
`/tmp/xln-native-session-check.log`. The previous iOS folder-width failure was
fixed by grouping the three native bridge files in `App/runtime`, without
changing the limit. BrainVault E2E category tags remain fixed (195 tests).
No push or deployment. Actual iPhone UI financial acceptance, native Tron,
cross-chain swaps/lending on the native surface, and immediate-close recovery
remain incomplete.

## Current native acceptance — 2026-09-18

Actual iPhone 17 Pro / iOS 26.5 creation, 100-test-USDC funding and confirmed
one-USDC payment are recorded in `output/ios-release-2026-09-18/payment-proof.mp4`.
The first-run Create flow is explicit; ordinary Open still requires local state
or verified recovery. Five live creation/rejection/reopen checks pass. Creation
verifies an initial encrypted backup; continuous backup remains unproven.

The recording exposed submission below the hub minimum. Market snapshots now
publish that committed policy per hub; native and React quote review reject a
rounded amount below it, and unknown policy stays unavailable. Live native-host
checks pass 4/4, including a 24.999999-USDC debit, 0.0099970002-WETH net receipt,
and exact balances after reopen. Focused tests pass 23/23 (96 assertions). Full `bun run check` passes
(39 source gates; 40.313 seconds for source, 23.092 seconds for frontend).
Detailed evidence: `docs/evidence/native-quote-session-20260918/readme.md`.
The updated packaged iPhone swap UI also passes: exact completed order/fee,
matching balances and rejection before confirming an undersized quote. Recording:
`output/ios-release-2026-09-18/swap-proof.mp4`. The native Market screen displays
live depth. Reference-price fiat valuation remains a limitation.
Next: canonical cross-chain and lending surfaces, retaining the recovery blockers. No native-Tron or all-platform acceptance claim.

A second saved local stand failed restart with truncated Anvil state JSON.
Keep `/tmp/xln-native-release-hGfpwg` intact. Separate fresh test stands unblock
app checks without certifying preserved-state recovery. No public deployment,
real-money transaction, commit or push.

## Current saved-stand recovery repair — 2026-09-18

Normal launcher shutdown was reproducibly truncating Anvil snapshots: duplicate
forwarded signals triggered immediate SIGKILL, while shell cleanup raced the
supervisor. Shutdown is now idempotent and waits before cleanup; bounded forced
termination remains. The same reproduction changes from invalid 24,550-byte
JSON to valid 3,181,904-byte JSON. A preserved three-hub restart becomes healthy
and restores the exact contract code. The real-Anvil regression passes one test /
five assertions, including identical mined block hash after reload. Related
lifecycle tests pass 30/30 (172 assertions); full `bun run check` passes with
39 source gates (40.564-second source phase).
Evidence: `docs/evidence/native-quote-session-20260918/dev-shutdown-result.json`.
Original damaged data remains intact. This does not certify abrupt-crash or
immediate-wallet-close recovery. Next financial boundary: close immediately
after payment submission, then recover exact balances and receipts without
halting a hub; subsequently native Tron, cross-chain/lending and app acceptance.

## React swap and recovery proof — 2026-09-11

The real React/RAdapter USDC-to-WETH path passes on the preserved devnet.
A fresh wallet receives 100 USDC, explicitly grants incoming WETH credit, checks
invalid inputs, double-clicks submit and records one closed order/one execution.
Exact debit: 99.999996 USDC; gross receive: 0.039992 WETH; taker fee:
0.0000039992 WETH (1 bps); net receive: 0.0399880008 WETH.
The final balances are 0.000004 USDC and 0.0399880008 WETH.
No live offers, pending Account proposal, mempool entries or token holds remain.

The first bounded run executes the swap, verifies signed history, reloads to the
password gate, then exports the actual IndexedDB/WAL: 48.7 s. A second process
unlocks that post-reload database, verifies identical identity, Account root,
balances and full order history, and checks the displayed receipt: 19.0 s.
No seed-only reconstruction, timeout increase or chain reset was used. A combined
fresh-login/swap/unlock process exceeded 60 s and remains a performance limit;
these two bounded runs prove financial recovery, not a fast combined journey.
Proof: `docs/evidence/wallet-swap-20260911/proof.json`.
Logs: `/tmp/xln-swap-financial-final.log`, `/tmp/xln-swap-recovery-final.log`.

The first test failure was an outdated Manage-faucet helper racing asynchronous
capacity UI; this swap test now uses the primary Home faucet. The next production
failure was slow swap history. Account history now reads the captured WAL directly
and verifies ordered outputs without loading unused Entity contexts or Runtime
trees. React joins repeated reads of the same pending query and catches up after
completion without resetting the incremental Activity page. The missing-ACK-row
regression still rejects corrupted output evidence. Storage/history/fee tests:
53 passed, 263 assertions (`/tmp/xln-swap-final-regressions.log`).
Final candidate gate log: `/tmp/xln-swap-final-check.log`.

Next: shared wallet creation/recovery in React and Svelte. Full TS/Rust parity,
native primary-only/Cross-J configuration, live Rust J and full frontend acceptance
remain outstanding. This proof is neither production readiness nor live TPS.

## Two React wallets and repeated dev startup — 2026-09-11

Dev startup fix is committed as `a64d3a340`: repeating ordinary `bun run dev`
checks the existing wallet endpoint and exits 0 without starting processes or
resetting data. Explicit clean/mode requests retain the singleton rejection.
Three focused regressions and the real repeated command pass; full check passes
in `/tmp/xln-dev-repeat-final-check.log`.

The selected two-user payment boundary passes in three bounded runs against the
preserved devnet: fresh Alice + 100 USDC (28.2 s), fresh Bob + 100 USDC (28.6 s),
then both real IndexedDB databases reopened, payment and both reloads (26.8 s).
Bob explicitly prepares Receive for 25 USDC: faucet had consumed his prior
100-USDC receive credit. A no-route rejection before this grant was correct;
no routing implementation change was needed. No implicit credit grant was added.
Alice ends at 74.999975 USDC, Bob at 125 USDC, routing fee 0.000025 USDC.
Both Account roots/balances survive reload, pending/mempool are empty, and raw
receipts contain one matching sender initiation/finalization and receiver receipt.
Proof: `docs/evidence/wallet-transfer-20260911/proof.json`.
The separate invalid amount/recipient/revoked-quote E2E passes in 30.2 s.
Full current-candidate check passes: `/tmp/xln-two-wallet-final-check.log`.
Logs: `/tmp/xln-two-wallet-alice.log`, `/tmp/xln-two-wallet-bob.log`,
`/tmp/xln-two-wallet-receive.log`. The test retains 50-second case deadlines;
preparation exports actual browser IndexedDB/WAL, not a seed-only reconstruction.

The original single-case fresh-login/payment/reload still exceeds 50 seconds:
`/tmp/xln-payment-paged-history.log`. Diagnostics isolated overlapping Activity
history reads holding committed-reader leases after reload. Per-frame DB batching
and a smaller Activity page did not close that case and were removed. This
performance blocker remains open; the staged financial result does not erase it.

Next: same-user swap plus reload
with exact debits/credits and fees. Shared creation, full TS/Rust roots/ordered
outputs, native configuration contradiction and live Rust J remain outstanding.
This section supersedes older immediate-next-command entries below.

## React faucet after aged-chain login — 2026-09-10

Current committed scan SHA: `645125eb2`. Fresh Home plus one-click 100 USDC
is green on the preserved primary chain at 193219 blocks: Home 23337 ms,
funded 25358 ms, Account height 4, no pending Account proposal, Runtime
inputs, committed readers or queued writers. Evidence:
`/tmp/xln-faucet-final-demo.log` (27.0 s test, 27.6 s runner).
The existing five-second faucet assertion and application deadlines are unchanged.

The first receipt failure came from embedded payment-terminal reads bypassing
RAdapter's committed-read lease. Embedded and WebSocket receipts now share
the same reader under that lease. The subsequent faucet delay was Activity
rereading its full historical page on every committed Runtime frame, holding
up the Account ACK. React now keeps one volatile query page and reads only
new frames, preserving the canonical event deduplication and older-page cursor.
Point WAL reads also no longer enumerate checkpoints. A separate attempted
batching of Activity event reads did not resolve the boundary and was removed.

Real-WAL tests compare incremental pages against full reads at limits 2 and 20,
including the rolling scan boundary, and prove receipt reads hold a stable
head while a real commit queues. The focused run has 24 passing tests and
142 assertions: `/tmp/xln-faucet-final-regression.log`.

Next command: rerun `ui/tests/e2e-payment.spec.ts --project=chromium --trace=off`
under stand-lock, without editing UI modules during the run. This spec now
uses the verified Home faucet; its exact payment/fee/receipt/reload assertions
remain. The separate Assets helper is still red with `faucet-offchain` disabled
(`/tmp/xln-payment-activity-fixed.log`) and requires later investigation.
Remaining gates: final `bun run check`, scoped commit, two-sided user payment,
swap/reload, shared wallet creation, exact TS/Rust replay and live Rust J.

## Current scan candidate and next wallet boundary — 2026-09-10

Fresh React Home is reached in 23,057 ms on the preserved chain at primary
finalized height 191569. `/tmp/xln-chain-range-demo.log` records the actual
milestone; the following faucet assertion remains red after five seconds in
Preparing, so this is successful login evidence, not a complete wallet flow.
The payment spec reaches faucet preparation in 31.3 seconds instead of dying
in chain scan; it also exposed a payment-terminal historical-read race:
`STORAGE_DIRECT_HISTORICAL_READ_FORBIDDEN:requested=101:materialized=201:checkpoint=1`.
Evidence: `/tmp/xln-payment-range.log`. Investigate that read boundary and
the pending credit confirmation next; do not increase application deadlines.

The fresh CPU profile contains 33,058 samples; local-history copying owns
7,025 (21.3%). `/tmp/xln-chain-profile/cpu.json` and `runtime.js.map` preserve
the profile and source mapping. The selected fix batches up to 2048 fully
authenticated headers per watcher poll, retaining the 128-call RPC cap and
the complete post-receipt reorg fence. Hash normalization validates the same
hex and length before lowercase conversion without a bytes/hex roundtrip.
The attempted native Map clone did not remove the observed boundary and was
discarded. Payment tracing generated 650 MB before timeout; `--trace=off`
keeps the original financial assertions and 50-second test deadline.

136 focused tests pass in `/tmp/xln-chain-range-regression.log`; its remaining
integration fixture initially blocked on an unread Anvil stdout pipe. Both
stdout and stderr are now consumed. An obsolete empty-tail expectation also
fails with the original 256-block window (723 versus 724), independently of
this change: `/tmp/xln-chain-backlog-control.log`. Corrected expectations keep
the Entity-finalized anchor and financial reserves unchanged while tracking
authenticated local history. The 4700-block, multi-page real Anvil integration
now passes all 20 assertions in 8.47 seconds, including Runtime snapshot restore
and watcher shutdown (`/tmp/xln-chain-backlog-final.log`). `bun run check` and
`git diff --check` pass (`/tmp/xln-chain-range-check.log`). No push.

## Aged-chain wallet verification — 2026-09-10

Verified candidate `589b6bb02f4affacd82b0b7f3f91f9145c0dc78b` on main.
The bloom and local-history changes are already committed in `de42eea2e`;
the faucet assertion is in `589b6bb02`. HANDOFF.md predates both.
History plus receipt regressions pass: 91 tests, 376 assertions, 2.83 seconds
(`/tmp/xln-chain-history-current.log`). The existing React demo test passes
under stand-lock on the preserved long chain: Home plus one-click 100 USDC,
54.2 seconds test time, 55.1 seconds runner time. Primary Entity finalized
and scanned height 190360, one retained header, zero mempool entries.
The second jurisdiction was still scanning (172359); this run does not prove
its readiness, a payment, swap, or recovery. No chain reset or timeout change.
Evidence: `/tmp/xln-chain-login-current.log`. `bun run check` exits zero and
`git diff --check` passes (`/tmp/xln-current-check.log`). Unrelated workspace
deletions and the existing generated worker change remain outside this work.
The current task's Goal API returned null; an active Goal is not established.
Viewing automation `automation` returned a UI card without model-readable
status, and the local automation files contain no matching Egor MML entry.
No duplicate automation was created or existing automation modified.
Next boundary: the real React payment flow on the same chain, then both-party
balances, fees, terminal receipts, swap and reload before broad parity gates.

## Egor MML objective — owner update 2026-09-10

This older MML definition is superseded by the 2026-09-30 mission clarification.
For near-term adoption evidence, measure completed user operations and amounts per asset without
counting intermediate hops, retries, submitted traffic or duplicate receipts.
Testnet nominal value proves functionality, not real mainnet economic value.
Safety, determinism and recovery are constraints, not exchangeable for throughput.

Execution hierarchy (supersedes older immediate priorities below):

1. Deliver one usable React wallet journey through the real RAdapter: create/unlock,
   test funding, payment to a second wallet, swap, accurate receipt/history and
   reload. Verify both parties' balances and terminal outcomes. Fix the earliest
   failing production owner; UI never acquires duplicate financial logic.
2. Prove the foundation: preserve scenario economic assertions across TS and Rust
   H1, identical recorded inputs/roots/ordered outputs, W1/W4, native live J and
   recovery. Hubs are Runtimes; other Runtime roles may remain TS.
3. Establish release evidence: full relevant E2E on React and Svelte, production
   and cfg(test) Rust coverage, check, then valid live throughput and measured
   bottlenecks. Old frontend remains available; no duplicate feature development.
4. Expand product scope only when it removes an observed blocker to useful settled
   operations. Defer cosmetic rewrites, speculative abstractions and broad audits.

Ten-minute heartbeat: new evidence, completed/total current-stage checks and
percentage, next concrete result and any justified direction change. Report bad
patterns immediately with location, consequence and correction. After thirty
minutes without real progress change method; repeated failure without new evidence
means stop and report the blocker, not manufacture activity. Work alone by default.
The app heartbeat is ACTIVE (automation id: `automation`). The separate app goal
was last observed blocked; this document and heartbeat do not falsely resume it.

## Active owner correction — 2026-09-10

Owner architecture clarification: xln is a network of Runtimes. A hub is a
Runtime serving a hub role, not a separate layer above or below Runtime.
Describe wallet interactions as UI → RAdapter → local/remote Runtime ↔ peer
Runtimes (including hub Runtimes). Entity and Account remain the internal
consensus layers; never imply that a hub exists outside the Runtime model.

Owner resumed execution on 2026-09-10 after the hourly report. Mechanical scenario
connection changes are authorized; retain all economic steps and assertions. The
earlier unanswered executor question below is historical, not a current blocker.
Work alone. Send a memo every ten minutes: new verified facts, completed/total
checks and percentage for the current stage, proposed direction and next concrete
mainnet prerequisite. Immediately flag an observed bad code pattern to the owner
with its location, consequence and proposed correction; distinguish hypotheses.
The heartbeat has been reactivated. Do not claim the app goal is active without
reading it: its last observed state was blocked and this API cannot resume it.

First new finding: the old lock-ahb offline phase reported zero dropped/requeued
Hub inputs, then success. Inputs had already entered the runtime mempool, so its
manual pendingOutputs edit did not isolate the Hub. Reuse processWithOffline and
assert a deferred Hub input, unchanged Hub committed height while offline and a
new commit after reconnection. The updated TS scenario passes 93 frames and
actually defers one Hub input. Evidence:
`/tmp/xln-lock-ahb-offline-witness-after.log`. This is not native H1 coverage.
An initial run failed before scenario execution on the workspace size gate;
inactive rebuildable debug artifacts were moved intact to
`/tmp/xln-debug-cache-egor-20260910-2020`. No user database was moved or reset.

Execution correction after source inspection: the latest owner request swaps H1,
not every client validator into Rust. `multi-sig.ts` gives its hub one validator
(alias5); the 3-of-4 boards belong to clients. Therefore native client BFT/import of
all nine cohosted replicas must not block the first unchanged-scenario H1 swap.
`canonicalHubEngine` already selects Rust for H1 alone, and `mm-mesh` uses that real
orchestrator without scenario edits. Validate this live path first, then extend the
shared scenario execution boundary for currently in-process scenarios. Keep native
whole-Runtime BFT as a separately unfulfilled capability; do not call it proven.
Do not add more importer prerequisites before reaching the requested H1 boundary.
Live unchanged `mm-mesh` passes with H1 Rust22.4s and H1 TS21.6s; this proves
bootstrap/book readiness/empty queues, not equal wall-clock-dependent live roots.
Logs `/tmp/xln-h1-rust-scenario-current.log`, `/tmp/xln-h1-ts-scenario-current.log`.
Added explicit `--hub-engine=ts|rust` to the scenario launcher. Rust selection on
the other still-in-process scenarios now fails before launch instead of silently
running TS and creating false native evidence. Missing/empty/unknown selector rejects.
Boundary tests3/3; explicit `--hub-engine=rust` overriding inherited TS also passes
unchanged mm-mesh22.95s, with actual h1/rscore-native storage:
`/tmp/xln-h1-selector-rust.log`, `/tmp/xln-h1-selector-rust/prod-mesh/h1/rscore-native`.
Remaining task: shared external-H1 execution boundary for the in-process scenarios;
scenario body/financial assertions stay unchanged. The six-engine111-frame replay
remains separate exact-root evidence and is not all-scenario coverage.

Fresh unchanged lock-ahb reference at7a3b07930: TS succeeds through frame93,
checkpoint1 +92 inputs. Recording `/tmp/xln-lock-ahb-current-recording.json`, log
`/tmp/xln-lock-ahb-current-recording.log`; file SHA256
`3bc740917ada5c381aa10c9fe50de54dfde0fa5c3738619b1531e770ae1c4674`, manifest
`0x3c4418a53f61a742db83f03e15edc8738f2a86886b29b8f292f3301ea3a16f91`.
First post-checkpoint input contains three importReplica transactions. No Rust
execution of this recording has passed. Lock-ahb uses shared getProcess/commit helpers,
controlled time and direct pendingOutputs removal/restoration for offline simulation
(payments/lock-ahb.ts:1498/1503). A wall-clock HTTP swap alone cannot preserve that
execution contract. An asynchronous owner question asks whether mechanical scenario
imports/calls may move to a shared executor with all economic steps/assertions retained;
no answer yet. Do not interpret elapsed time as permission or weaken the scenario.

Delegation restriction: owner permits non-GPT subagents only, using pi, Claude or
GLM. Do not spawn GPT subagents or silently substitute GPT when another harness
fails. Verify the actual selected model; a harness name alone is not model identity.
External calls remain subject to the shared cumulative budget and unresolved holds.

Latest deliverable: every existing TypeScript scenario must run unchanged against
H1 implemented in TypeScript and H1 implemented in Rust. Engine selection belongs
in the launcher/production boundary, never in scenario assertions or an embedded
TS fallback. Preserve identical initial conditions and controlled inputs; compare
per-frame R/E/A roots and ordered events/effects/outbox, W1/W4. Recording/replay is
the first diagnostic artifact, not a substitute for live interchangeable H1 coverage.
Only after this scenario matrix, native live J, production/cfg(test) and check are
green may work advance to new UI end-to-end acceptance. Do not rewrite scenarios
into a separate Rust-only suite. Inspect their current in-process versus external
Runtime dependency before selecting the minimal canonical execution boundary.

Priority: production TS/Rust parity on one immutable checkpoint/WAL, W1/W4,
comparing every R/E/A root and ordered event/effect/outbox digest. Reproduce the
first divergence, fix its canonical cause, rerun that same artifact before expanding.
First boundary after quorum and independent source/artifact inspection: checkpoint1
has no Entity replicas; Runtime2 imports replicas using `importReplica`, which native
Runtime rejects. Reproduce that full-recording boundary before working on Runtime5
`proposedFrame`. The old diagnostic binary still fails proposal admission (0/1),
but that is not proof that native replay ever reached Runtime5.
Never remove single-signer guards without the corresponding authenticated consensus.

No UI work, broad audit campaign or TPS optimization before this core boundary.
Use one bounded read-only quorum question to challenge the selected next step;
independently verify its answer. New abstractions and repeated green smokes are not progress.
Review evidence every 10 minutes. After 30 minutes without a new verified boundary,
fix or passing production artifact, stop and wait for the owner. Changing a command
or rephrasing the plan does not reset that deadline. A protocol fork needs a concrete
decision; routine implementation of the existing TS canon does not.

The app goal is ACTIVE again (verified with get_goal after owner activation).
It remains the existing unfinished parity goal; do not falsely mark it complete
merely to rename it. The latest unchanged-scenario deliverable above governs execution.

Current-source diagnostic on 2026-09-10: compiled native WAL transaction decoder
against the unmodified recording's first post-checkpoint input. One test executed,
0 passed / 1 failed, build 12.13s. Exact first rejection:
`frame2 tx0 importReplica: FIELDS:runtimeTxs[0]:missing=none:extra=entityId`.
The decoder globally assumes `{type,data}`, while this canonical transaction also
has `entityId,signerId`; recognizing those fields alone does not implement import.
Evidence: `/tmp/xln-recorded-first-native-admission.log`; diagnostic test source
saved to `/tmp/xln-recorded-first-native-admission.rs` and removed from production
source. This is the real input through the production decoder, not full WAL replay.
Next: implement canonical replica import with authority/key/state ownership, then
repeat this admission and full recording. Do not claim parity from admission alone.
The 10-minute heartbeat is ACTIVE for this core task; its old UI prompt was replaced.

Native replica creation prerequisite: `RuntimeEntityReplica::new` previously marked
every local signer `isProposer:true` and did not reject a local key outside the board.
It now derives the role from validator order and rejects non-members, matching TS
import authority. Both new tests fail against the previous code and pass with the
fix; the complete Runtime library passes 347/347, no skips. Logs:
`/tmp/xln-native-replica-authority-before.log`,
`/tmp/xln-native-runtime-authority-regression.log`.
This does not implement `importReplica` decoding/execution or native BFT; the original
recorded admission remains red. Continue there, without relabeling this prerequisite
as scenario parity.

Next prerequisite implemented: native checkpoint/replay configuration accepts multiple
explicit signer derivation base labels, retaining the same labels for native restart.
The runtime-replay CLI now takes `--entity-signer-labels` as a JSON string array;
its canonical TS caller was updated atomically. No old-flag fallback. Live single-owner
startup retains its existing single-label CLI and supplies a one-element keyring.
The keyring still derives each configured base's existing jurisdiction labels, never
guesses labels from persisted signer addresses, and rejects empty/duplicate configuration.
Tests cover 13 local scenario validators and the existing hub jurisdiction keys: 3/3.
Full check39/39: `/tmp/xln-native-scenario-keyring-check.log`.
This does not yet provide live multi-validator execution or importReplica execution.
Production regression replay passes 6/6 (TS/Rust W1/W4/W8), 111 frames, in168.3s
under the stand lock. Evidence `/tmp/xln-production-parity-keyring-regression.log`
and `.logs/hlt-evidence/2026-09-07T22-27-58-651Z/replays/1789001911958-parity.json`.
Native binary SHA256 `0xb29a074d7383fc94a192f1292799b3ccd1e7febb2f1b016febf7476fd29f45c7`.
This is the existing mixed single-validator artifact, not the missing multisig scenario
and not live TPS. Next action remains actual importReplica transition, with these
explicit operator labels used for signer-key lookup; no additional prerequisite audit.

## Owner correction — core before browser acceptance (2026-09-09)

E2E is paused. The 18/18 scenario result covers TS only; the six-engine 111-frame
replay does not establish every scenario on native Rust. The scenario runner invokes
the TS Runtime directly; embedded Rust authority is explicitly retired. Use native
xlnrs production scenarios and retain the same financial assertions, not an engine
environment flag on a TS-only runner. First current native artifact: cross-J full fill
and process restart/recovery, W1, /tmp/xln-native-cross-recovery-w1-20260909.log.
After individual scenario equivalence, measure current TS and Rust W1/W4 on identical
production H1 load, collect phase profiles and optimize only measured bottlenecks.
There is no current W1/W4 TPS matrix or established largest phase. Historical W8
numbers do not answer that request. Resume both frontend E2E only after core gates.

### Native cross-J recovery: first real failure fixed

W1 cross-chain full fill passes; restarting the same production processes exposed
RRS_RESTORE_ENTITY_GRAPH:ROOT_COUNT:2 during the next checkpoint projection.
Projection now selects its exact owner's manifest from the shared Runtime graph;
full hydration still rejects foreign/multiple roots. Named Rust regression1/1 and
root check39/39 pass (/tmp/xln-native-owner-regression.log, /tmp/xln-native-owner-check.log).
Repeated real swap/restart advances past that error and exposes the NEXT boundary:
RRS_STORAGE_CHECKPOINT_REQUIRED:101. Evidence:
/tmp/xln-native-cross-recovery-w1-r3-20260909/server.log.
Storage enforces Runtime-relative cadence but projection only requests checkpoints
from Entity outputs. Align checkpoint preparation with canonical durable HEAD cadence,
then rerun this exact production artifact before any broader scenario or E2E.
The first attempt's MM Bun crash is separately evidenced in macOS DiagnosticReports
bun-2026-09-09-031918.ips (pid42093,303threads); W1 explicitly set for TS peers as well
as Rust passed startup and the swap. This is not a proven causal crash fix.

### Runtime checkpoint cadence fixed — 2026-09-09 00:34 UTC

The committer now answers checkpoint cadence from the canonical durable HEAD after
the preceding fsync, and Runtime projection materializes every Entity when due.
No new durable state, fallback or relaxed storage validation. Regression advances
101 frames without Entity work, verifies unchanged Account root, checkpoint101 and
empty WAL tail on reopen. Genesis socket coalescing still proves two authenticated
inputs -> one Runtime frame with zero economic outputs; frame1 now materializes as TS.
Rust W1 cross-J full fill + process restart recovery passes in36.9s:
/tmp/xln-native-cross-recovery-w1-r4-20260909/production-cross-swap-recovery-report.json.
Hub92->120, load25->35, settled route preserved. This is economic descendant recovery,
NOT equal full-state hashes at different heights. Check39/39 passes:
/tmp/xln-native-cadence-check-r2.log. Next: same native scenario W4, TS equivalents,
then remaining named scenarios and updated exact replay; no E2E yet.

### Post-fix evidence and method review — 2026-09-09 00:47 UTC

At52e5190a4, cross-J full fill + replacement/recovery passes TS/Rust W1/W4 (4/4).
All reports agree source10201020000, target10200000000, settled, different server PIDs.
Artifacts: /tmp/xln-native-cross-recovery-w1-r4-20260909,
/tmp/xln-native-cross-recovery-w4-20260909, /tmp/xln-ts-cross-recovery-w1-20260909,
/tmp/xln-ts-cross-recovery-w4-20260909. Those use the launcher's default fail-fast policy;
they prove happy-path financial recovery, not production rejection handling.
Exact111-frame replay also passes6/6 TS/Rust W1/W4/W8 on binary
0xde0d43a94696325c28ad5d35d108be16abb32fa1a6865fbc7313a3bfb3770af0.
Result .logs/hlt-evidence/2026-09-07T22-27-58-651Z/replays/1788914371662-parity.json.
Log /tmp/xln-parity-checkpoint-fix-20260909.log. No parity assertion weakened.
Production NODE_ENV=production mm-mesh adversaries pass4/4: hub-kill and mm-restart,
each with TS and Rust H1 W4. Logs /tmp/xln-native-hub-kill-prod-w4-20260909.log,
/tmp/xln-ts-hub-kill-prod-w4-20260909.log,
/tmp/xln-rust-mm-restart-prod-w4-20260909.log,
/tmp/xln-ts-mm-restart-prod-w4-20260909.log. Checks prove PID replacement and restored
same/cross books. They are not independent payment-conservation or TPS evidence.
Initial hub-kill used default dev fail-fast and correctly halted a TS neighbour on
unexpected socket close; explicitly rerun production policy without changing core.
Method review: continue missing native financial scenarios before TPS/E2E. Existing
TS-only in-process18-scenario runner is not a Rust gate; do not relabel its result.
Full scenario equivalence, live J on the new binary, final transaction-kind execution
coverage, current W1/W4 TPS/profile and both frontend E2E remain unfinished.

### Live J and the first missing native BFT boundary — 2026-09-09

Current-binary Rust W1/W4 production live J gates both pass: 5000/5000 payments,
freeze/business-input rejection/finalized dispute, plus r2r/r2c/c2r with independent
on-chain reserve/collateral arithmetic. Functional five-second runs, NOT TPS.
Artifacts /tmp/xln-native-j-dispute-move-w1-20260909 and
/tmp/xln-native-j-dispute-move-w4-20260909, dispute and settlement JSON reports.
Critical remaining implementation gap: native Entity consensus is single-signer.
RuntimeEntityInput::decode rejects proposedFrame/hashPrecommits/hashPrecommitFrame/
leaderTimeoutVote; restore rejects multi-validator authority with SINGLE_SIGNER_REQUIRED.
Therefore multi-sig and multi-validator company scenarios cannot currently pass natively.
Do not remove those guards without implementing the corresponding TS BFT transitions.
Recorded the real TS multi-sig132-frame input/output trace, 1514792 bytes:
/tmp/xln-multisig-native-oracle-20260909/inputs.json. First proposal at Runtime5,
first precommit at6;92 proposedFrame inputs and102 hashPrecommits inputs.
The existing --trail is only UI graph evidence; new --input-trace=FILE preserves raw
scenario wire inputs/outputs using the existing scoped collector. It refuses empty
traces and all-scenario runs. This is NOT a checkpoint/WAL/root parity artifact.
Check39/39 passed at /tmp/xln-bft-input-trace-check.log.
Next implementation boundary: native processing of the actual Runtime5 proposal,
with TS Entity consensus as the canonical algorithm; do not substitute more one-signer
smokes for the owner's requested all-scenario native equivalence.

### Durable multi-sig oracle — 2026-09-09 01:05 UTC

Scenario runner --recording=FILE now exports the existing signed RuntimeRecording
(checkpoint + actual persisted WAL), with canonical hash period1 enabled before boot.
It refuses a recording without a journal tail. Initial run failed correctly at
RECOVERY_BUNDLE_JOURNAL_CANONICAL_STATE_HASH_REQUIRED:height=2; enabling the existing
hash cadence, without weakening bundle validation, makes the repeated scenario pass.
Artifact /tmp/xln-multisig-native-oracle-20260909/recording.json: checkpoint1,
131 WAL frames through132. Independent TS restore from that file reaches root
0x5a6d0688542333ad8af4134fbdf1fcbe8af89f59750a7c6f13173bd16bcb6dba.
Manifest 0xea42e714864df2b00d7a1a5e6e101927b9131cbd2077676e9b93c3ed540dae4c.
Logs /tmp/xln-multisig-persisted-r2-20260909.log and
/tmp/xln-multisig-recording-replay-20260909.log. This is TS evidence, not native parity.
Native BFT requires more than admitting new fields: Runtime apply currently immediately
certifies the resident result; EntitySingleSigner also emits single-member Hankos.
Reuse the existing resident Account base/candidate mechanism for speculative state,
and port TS authenticated proposal replay, manifest signature collection, quorum commit
and output publication before removing single-signer guards. No protocol changes made.
Root check39/39 passed at /tmp/xln-multisig-recording-check.log.
The portable restore is read-only recovery evidence; it is NOT a certified W1/W4
authority benchmark. Setting worker-count environment variables alone does not
prove which executor the recovery path used.

### Window checkpoint — 2026-09-09 01:10 UTC

SHA1d686464d. Last green: bun run check,39/39,
/tmp/xln-multisig-recording-check.log. First executed native red: actual TS Runtime5
proposal decoded by RuntimeEntityInput::decode gives
EntityInputFieldUnsupported("proposedFrame"),0/1 tests,0 ignored.
Log /tmp/xln-native-bft-first-boundary-r2.log; temporary regression body retained at
/tmp/xln-native-bft-first-boundary-regression.rs. Temporary test insertion was removed;
production source is unchanged. The first diagnostic filter matched0 tests and is
NOT evidence; only the r2 log contains the executed failure.
Next single diagnostic command (already-built diagnostic binary, not release binary):
bun tools/stand-lock.ts run --reason native-bft-proposal-boundary --timeout-ms 60000 -- rscore/target/debug/deps/xln_rscore_runtime-269ac9f64eb6ede3 --exact machine::tests::multisig_recorded_runtime_5_proposal_native_admission --nocapture
Existing Account candidate selection is in resident_consensus.rs entity_inbound_inner;
reuse it for BFT, do not add a parallel Account store. Remaining final gates unchanged:
full native BFT + all scenarios, per-frame roots and ordered outputs, live J and cfg(test),
current W1/W4 TPS/profile, bounded verified Quorum, E2E both frontends. Automation xln-10
paused at the recorded window boundary. Goal remains incomplete; no production-ready claim.

## Current acceptance window — 2026-09-08 22:07 UTC

Owner authorized several hours of prioritized production work and ten-minute status updates.
Work window: through 2026-09-09 01:10 UTC; review the method every 30 minutes.
No subagents or usage resets. Owner now explicitly authorizes a bounded Quorum review
after scenarios/parity, under the existing shared reservation ledger and budget.
Preserve both frontend and ui.
Report completed/total checks per stage, never an invented production-readiness percentage.

Owner explicitly interrupted the sequence for a narrow Home faucet UX fix and Quorum review
(2026-09-08 23:44 UTC). Restore the scenario/parity-first sequence after that fix.
Quorum job `faucet-ux-20260909-01`: one completed GLM-5.3 low subscription review of the
textual UX proposal, not a code audit or screenshot review. No retry; USD0.25 reservation
retained because actual cash cost is unknown. Result `/tmp/xln-faucet-ux-quorum-result.json`.
Compact faucet follows the old Svelte inline layout; one committed success message and
one-click funding retained. Tour E2E 2/2 in 15.2s:
`/tmp/xln-faucet-ux-r2-20260909/wallet-results.json`. UI types green.

### Scenario/parity acceptance — 2026-09-08 23:57 UTC

All 18 canonical TS scenarios passed individually on isolated RPC chains under the stand
lock at `ad0742a62`: rebalance, lock-ahb, htlc-lazy, ahb, swap, settle, htlc-4hop, grid,
swap-market, multi-sig, company-ipo, rapid-fire, settle-rebalance, processbatch,
dispute-lifecycle, dispute-transformer, cross-j, mm-mesh. Logs:
`/tmp/xln-scenario-<id>-20260909.log`. IPO includes durable recovery at height212 with root
`0xd9ce07f383f95fe337ecac978ce0028d389d469c736d1c23d5d4887b6c85b8e0`.
Cross-J/MM run child Runtimes (outer Frames:0 is not zero economic execution).

New binary semantic replay: 6/6 TS/Rust W1/W4/W8, 111 frames, all checked roots and ordered
outputs equal; 170.2s. `/tmp/xln-parity-scenarios-20260909.log`, canonical result
`.logs/qa/hlt/replays/1788911794633-parity.json`. Logging restricted to runtime scope to
avoid Entity log overhead; assertions unchanged. No resume/provenance bypass used.
Binary SHA256 `7bfc2c7ad6a058af6ce7f29e493f9ffbe590693ea1b604a2ed3e39b365cf6461`.
Native live J + c2r settlement passed with 5,000/5,000 payments; Account32->38, jNonce25->29.
`/tmp/xln-live-j-final-20260909.log`. Five-second functional window is NOT TPS evidence.
Production/cfg(test) compilation is in the green check39/39. The 111-frame WAL still does
not by itself prove transaction-kind completeness or all adversarial scenario variants.

### Independent Quorum review — 2026-09-08 23:59 UTC

One code/evidence packet at `ad0742a62`, job `cross-remainder-review-20260909-01`, completed
GLM-5.3 low subscription; no retries. Result `/tmp/xln-cross-review-quorum-result.json`.
USD0.25 reservation retained; cash unknown. Findings were independently checked:

1. Claimed restored price substitution: disproved by the exact partial-fill snapshot test.
   Changing page price to8888 rejects with PAGES_ROOT_MISMATCH; committed page roots remain
   authoritative. Added this adversarial assertion to the existing regression.
2. Claimed TS accepts zero-lot resize while Rust rejects: incorrect. TS
   `core/orderbook/cross-j/index.ts:resizeBookOrderById` rejects <=0 with ORDERBOOK_RESIZE_INVALID.
   Reachability of a dust route is not established by the supplied counterexample.
3. Skipping fresh lot admission for authenticated committed remainders is the intended fix;
   no external mutation counterexample was supplied. No production approval inferred.

### Method review and wallet journey — 2026-09-09 00:12 UTC

Capacity, hosted entry, sovereignty and catch-up are green. Hosted now verifies the actual
connected Account entity ID against /api/hubs, not stale UI wording; absent servers fail.
Full same-wallet journey passed in21.8s: funding, Pay25, same-chain/cross-chain swaps,
dispute finality, recovered reserve moved to H2, reload and exact preserved state.
Artifact `/tmp/xln-ui-journey-r5-20260909/wallet-results.json`.
The journey requires a fresh private genesis at least three days old; configured with
ANVIL_GENESIS_TIMESTAMP=1788652800. The launcher supports this optional genesis setting,
rejects its use with persisted chain state, and never changes host authentication clocks.
Advancing only the browser clock was rejected as a method: it correctly triggers hello
clock-skew protection when connecting a new peer. That attempt was removed, not bypassed.
Dispute receipts are compared to the signed bilateral windows, never hard-coded24h.
Check39/39 and UI types passed. Next: five remaining React E2E files, production UI artifact,
Svelte full suite, parity transaction-kind coverage. No cosmetic work or TPS tuning yet.

## Owner priority override — 2026-09-08 23:43 UTC

Active Codex goal: all applicable production scenarios and full semantic parity, then
bounded Quorum review, then all E2E on both frontends. Do not switch to cosmetic work.

1. Run every applicable canonical scenario; fix the first real failure and rerun it.
   Include Pay, Swap, partial fill/cancel, Move, settlement, dispute, Cross-J and recovery.
2. Complete immutable mixed-WAL TS/Rust parity across worker configurations: every R/E/A
   root and ordered event/effect/outbox digest; live J and production/cfg(test) builds.
   The earlier 111-frame bundle does not establish complete transaction-kind coverage.
3. Quorum: one bounded read-only review of an immutable SHA and actual evidence. Use the
   existing reservation owner; independently reproduce findings before changing code.
   No new money allowance is inferred from this request; preserve the shared budget/expiry.
4. Run all applicable React ui and Svelte frontend E2E, including public production-build
   coverage and desktop/mobile tutorial interactions. Skips do not count as green.
5. Final applicable gates and checked milestone on main. Report exact remaining blockers;
   cosmetic changes and TPS tuning stay behind correctness. Lending remains disabled.

Every financial scenario must prove actual committed outcomes and recovery, not only rendered UI.
Use one heavy stand. Freeze source and builds throughout browser runs; previous live tests were
invalidated by development hot reload. Commit verified milestones on main; preserve unrelated edits.
Automation `xln-10` reports on this task every ten minutes and expires with this window.

Acceptance evidence at 2026-09-08 22:27 UTC:

- TS/Rust W1/W4/W8 exact replay: 6/6 engines, 111 frames; `.logs/qa/hlt/replays/1788905603729-parity.json`.
- Real browser Cross-J: 1/1, 21.5s, both legs, no holds, reload recovery; `.logs/qa/wallet/cross-j-ts-20260908/`.
- Real browser dispute: 1/1, 14.3s, early rejection and exact 100 USDC release; `.logs/qa/wallet/dispute-ts-20260908/`.
- Browser evidence above uses the diagnostic UI against isolated production servers. It does not claim production-build coverage.
- Final acceptance requires scenarios, E2E, parity and all applicable gates green; skips do not count as passes.

## Method review — 2026-09-08 22:40 UTC

Owner prioritized HLT parity and measured TS/Rust throughput while preserving the remaining E2E goal.
Keep one failing production boundary at a time. Do not repeat setup hypotheses without fresh evidence.
The isolated browser runner now proves Cross-J and dispute rather than skipping them.
The Rust H1-only launcher had created a secondary owner without its quote authority; genesis now
selects matching jurisdiction and owner inventories using the existing primary-only setting.
Native live J/Move passed on the current binary: 5,000/5,000 payments and account settlement.

HLT measured sequentially: 1,000 sovereign users, five processes, 8 workers, 20-second window,
1,000 offered payments/s, real H1 WAL/fsync; one sample per engine, not saturation capacity.

- TS: 20,000/20,000 completed, 672.65 payments/s, complete at 29,733ms, drain at 29,896ms.
  REJECT for TPS acceptance: the five-second drain deadline is 25,000ms.
- Rust: 20,000/20,000 completed, 952.38 TPS, complete at 21,000ms, drain at 22,787ms; no pending ACKs.
- Reports: `/tmp/xln-tps-ts-20260909/hlt-payment-load-report.json` and
  `/tmp/xln-tps-rust-20260909/hlt-payment-load-report.json`.
- The existing HLT checker incorrectly started the five-second drain after settlement. Fixed the
  publication gate to enforce the offered-window deadline; actual reports now reject TS and accept Rust.
  Focused genesis and HLT regressions: 50/50, 1,190 assertions.
- Pending: final source check/commit, verify the simplified wallet entry in browser, remaining scenarios
  and E2E. TS throughput acceptance remains red; do not claim all gates green.

## Method review — 2026-09-08 23:11 UTC

Native browser Cross-J exposed `cross-quote-lot-misaligned` after a real partial maker fill.
The previous payment-only HLT replay did not cover this counterexample. Preserve that evidence
scope: it is not full Cross-J parity. Fix the first divergence before expanding UI polish or load.
Committed signed fill ratios round both remaining amounts; Rust incorrectly reapplied fresh-order
lot admission to the remainder. The focused regression now covers two fills separated by an
orderbook snapshot/restore. Entity-kernel unit suite: 207/207 green. Fresh native build and the same browser Cross-J run passed (1/1, no skips):
`/tmp/xln-ui-cross-rust-r3-20260909/wallet-results.json`. Final exact replay and
`bun run check` remain required.
The owner reported the wallet gate at `/settings`; code shows disconnected sessions display
Gate without changing the URL. A reload clears memory-only unlocked seeds; no evidence yet
identifies whether this specific session reloaded, was locked, or disconnected.

### Verified partial-fill milestone — 2026-09-08 23:18 UTC

`bun run check`: 39/39 green (`/tmp/xln-cross-final-check.log`). Native Cross-J browser:
1/1 green; entity-kernel 207/207. Six-engine replay reached five completed configurations
before the 180-second wall limit killed Rust W8. Do not claim a new six-engine verdict.
Evidence: `/tmp/xln-cross-fixed-parity.log`. Resume correctly refuses the dirty shared tree
(`HLT_MIXED_PARITY_RESUME_REQUIRES_CLEAN_TREE`); preserve unrelated owner changes and do not
bypass provenance. Previous complete 6/6 evidence remains tied to the earlier binary.
Next: complete bounded parity with valid provenance; TS five-second HLT drain remains red.

### Wallet recovery and Move — 2026-09-08 23:37 UTC

Four more real browser checks passed: Manage/token lane/dispute (1), Move LEFT/RIGHT (2),
and tower restoration on a clean device (1). Move conserves all 100 USDC and drains pending
work. Tower recovery compares the canonical Runtime root and Account proofs, then refuses
an overwrite of existing local storage. Reports:

- `/tmp/xln-ui-move-manage-r2-20260909/wallet-results.json` (3/3, 27.5s).
- `/tmp/xln-ui-tower-restore-r3-20260909/wallet-results.json` (1/1, 18.8s).
  The Manage test had a case-sensitive stale label (90s wasted); fixed and bounded to 60s.
  The tower test dynamically imported core into Vite and triggered dependency optimization
  and a page reload. It now bundles the unchanged canonical hash helper before opening a
  wallet. A discarded plain serialization attempt could not preserve persistent collections;
  the final test hashes the original loaded state and retains every semantic assertion.
  Next: capacity, remaining browser scenarios and Svelte, exact new-binary parity, TS drain.

## Historical owner scope — 2026-09-07 (superseded 2026-09-18)

The then-current owner instruction superseded every earlier first-launch Lending
requirement in this document. Lending is OUT OF SCOPE and stays disabled.
Do not implement it or ask further Lending questions. Do not weaken existing
admission rejection, restore retired financial paths, skip tests, or increase
budgets. The sole objective is the existing core: Pay, Swap, Move, Dispute,
Cross-J and recovery, with all scenarios, tests and end-to-end checks green on
TypeScript and the native Rust hub engine.

## Historical execution queue — 2026-09-07

- [x] Close the HTLC boundary: 23/23 focused tests on canonical Paybook;
      corrected duplicate TS self-cycle HtlcFinalized emission to outbound-only,
      matching Rust. Money partition now 748/748, 29,500 assertions.
      Preserve same-frame forwarding, secret propagation, timeouts and idempotence.
- [ ] Build the fresh native xlnrs executable and reach the first live native
      Cross-J boundary; run final bun run check after production evidence is exact. Native rejection and exact signed
      duplicate execute currently pass 336/336 Rust runtime tests; TS settlement
      52/52. Preserve outer-command nonce, rollback and ordered outputs.
- [ ] Run the actual existing Pay/Swap/Move/Dispute/Cross-J scenarios on TS and
      native Rust H1. Prioritize native live Cross-J fill + restart next; previous
      66-frame cross-J replay was exact in TS W1/W4 and Rust W1/W4 but does not replace
      live native evidence. Exercise real J/TVM where the scenario requires it.
- [ ] Run production-mode browser E2E for the same feature flows, plus actual
      crash/recovery and outbox drain. Fix first production divergence and replay
      that exact artifact before expanding work. Remote-command E2E is now 1/1 green.
- [ ] Finish all unit/scenario/E2E partitions with bounded sequential runs,
      compile production and cfg(test) Rust, replay one immutable production WAL
      through all four engines with per-frame R/E/A roots and ordered outputs,
      and run final bun run check. No completion claim with failing or skipped
      required tests. Preserve unrelated shared-tree changes.

## Method review — 2026-09-07 03:36 UTC

The fastest useful method was exact first-frame evidence: native frame 85's
four immutable WAL rows exposed transport grouping, and the TS dispatcher
provided the exact oracle. Keep that method; do not change financial guards
to clear a transport failure. The new release build is green; run r8 now.
For hanging child tests, semantic completion and process completion are separate:
identify actual process-owned workers/handles before another timeout trial.
Open RPC sockets alone did not prove ownership. Use one bounded diagnostic,
then the documented lifecycle; no timeout increase or hidden skip.
After the native boundary, freeze writers once and run Move/Dispute on the
same prepared browser build. Then finish remaining core E2E/unit partitions
and final four-engine replay/check. Lending remains excluded.

## Current evidence and constraints

Runtime units: 238/238, 1896 assertions, 18.03s.
Money suites: 748/748, 29,500 assertions, 15.77s; /tmp/xln-core-money-final-r2.log.
Native live Cross-J exposed a real missing secondary Entity at genesis.
Canonical native control reads and explicit isolated endpoints are fixed.
Two-owner genesis and untouched sibling checkpoint/WAL recovery now pass
focused tests; fresh binary built and used for live Cross-J retries.
No live native Cross-J success yet.
Full TS RPC catalog 18/18 passed, including production mm-mesh.
Production browser Pay/recovery 1/1 (30.9s), Swap partial/cancel 1/1 (26.2s).
Browser Move and Dispute both hit the ordinary 60s process deadline; neither
is green. Owner question pending for a narrowly bounded 180s exception for
these two exact targets. Do not exceed 60s without an answer.
Historical core regression cluster: 116/116 green. Storage: 207/207 green.
Entity and network integrated: 466/466 green with real Runtime workers.
API wallet fixtures: 7/7 green. Adapter: 94/94, 627 assertions; full level
depth preserved independently of the bounded visible order page.
Remaining storage/recovery partition: 114/114, 941 assertions.
J-batch fixture cluster: 18/18; RPC timeout boundary: 4/4 (25ms timeout kept).
Faucet response/evidence and transient error regressions: 21/21, 91 assertions.
Native two-owner release built in 21.38s; Runtime 336/336, genesis 2/2.
Live native Cross-J r8 FILL GREEN: 1/1, 566ms, committed full-fill authority,
Runtime height83→90. This is functional evidence, not TPS. H85 grouping is
fixed with 337 Rust runtime tests and exact TS oracle; original WAL retained.
Restart first red: J_PREFIX_PENDING_RANGE_WITHOUT_OBSERVATION at Runtime91,
Entity87, J base44/attestable47. Restore accepted J evidence consistently;
no clearing pending work, fallback, new durable oracle or success claim.
Immutable artifacts: /tmp/xln-core-native-cross-j-r8-20260907.
J-submit partition 66/66; separate real-RPC SIGKILL recovery has exact money
proof but still leaks a process resource after both adapter closes. Diagnose
the resource owner; do not hide with process.exit or increase the timeout.
Primary TS RPC scenarios 7/7: lock-ahb, swap, settle, dispute-lifecycle,
dispute-transformer, cross-j, company-ipo (recovery exact at height 211).
Fresh immutable Cross-J replay 4/4 engines, 66 frames:
/tmp/xln-core-four-replay-r1.log. Rust self-cycle regression 2/2.
Current check: frontend and all 38 Rust test executables passed; the complete
check timed out at 60s during parity compilation, so it is not green.
Account SIGKILL/commitment focused cluster: 11/11, including 3 real crash/recover
cases. Remote command observation: 90/90 unit assertions cases and 1/1 real
browser E2E. Native live Pay/Move/Dispute and same-J Swap have earlier functional
artifacts; rerun when new core changes require it. No TPS or mainnet-ready claim.

The J-watcher fixture is still protected by macOS uchg. Prepared patch
/tmp/xln-j-watcher-int512.patch has a verified 6/6 copy; owner answer to the
existing protection question is pending. Do not silently bypass that question.

One machine, one heavy stand; normal verification process limit 60s, existing
record/replay/live economic exception 180s. Agents own disjoint areas; stop all
writers for final fingerprinted E2E and commits. No unrelated redesign, module
scoring, cosmetic cleanup, new features or new audit campaign.

Quorum was used once in this wave with zero retries. The existing shared
reservation owner and cumulative ledger remain authoritative: unresolved USD0.25
for this call and prior USD0.25 remain reserved; historical USD100 hold unchanged.
No new allocation, renewal, paid consultation or usage reset is implied here.

Last method review: 2026-09-07 02:32 UTC. Next review: 03:02 UTC.
Method change from measured outcomes: all 18 TS scenarios and the first two
browser money flows are green. Stop blind retries of the two 60s browser
timeouts; inspect their last completed stages and await the explicit bounded
budget answer. Native live Cross-J remains the first production blocker: finish
its canonical read-only control boundary, test real fsync snapshots, rebuild
xlnrs, and rerun the exact fill/restart workload. Keep remaining fixture repairs
parallel and disjoint; no Lending, new features, or broad audit detours.

## Superseded planning and execution history

The material below is historical evidence. Its Lending implementation requests
and wider priorities are superseded by the active scope above.

# Autonomous xln work

Owner instruction updated: 2026-09-06 18:31:42 UTC.
Last strategy review: 2026-09-07 01:39 UTC. Next review: 02:09 UTC.

## Objective and cadence

## Current execution order after draft1 review (2026-09-07)

Owner explicitly authorized agents, garbage removal and Quorum in this wave.
Method review at 01:39: the fresh broad unit run reached 1757 pass / 21 fail
before its 60-second process budget, so it is not a complete suite result.
Do not repeat the whole prefix: finish the newly demonstrated production
boundaries, then partition the remaining suite into bounded sequential runs.
Stable evidence: money fixtures 114/114 (441 assertions), exact Hardhat 3 stack
deployment and compiler-output binding 2/2, recovery Int512-to-tower-wire 36/36
plus browser codec 8/8, and telemetry/raw-input redaction 8/8 scoped tests.
No Solidity or encrypted recovery wire change was needed.
Native exact outer rejection passed runtime 333/333, but independent review
found a multiple-segment same-Entity context collision; implementer is fixing
that concrete replay boundary before release build. UI observation also exposed
a real command-specific confirmation defect: already-observed retries wait an
extra height and pending commands can be mistaken for unrelated frame progress.
Use the existing exact command identity/sequence retry, never add a receipt store.
The protected J-watcher fixture remains unchanged pending the owner's answer;
its prepared patch has a verified 6/6 copy. Full check and release remain open.

Method review at 01:08: disjoint ownership closed the known stale-test cluster
(164/164 integrated tests, 1804 assertions), removed 28 generated files (317721117
bytes), fixed owned-only Lending funding in both engines and Rust multi-clause
dispute bytes/arguments. Production Rust Move now passes R2R/R2C/C2R with exact
chain balances plus 5000/5000 payments and dispute under NODE_ENV=production.
The same immutable 66-frame Cross-J WAL remains exact in TS W1/W4 and Rust W1/W4
after the Rust changes: `/tmp/xln-draft1-four-replay.log`.

Do not extend a coarse signer-lane catch to hide the native duplicate-execute
failure. TS evicts the exact outer command; Rust must preserve that boundary,
nonce and accepted outputs. This remains open. Browser verification exposed a
separate real defect: the process shim selected development rejection policy even
in production bundles. Correct both browser builds and verify actual Chromium.
The production UI now passes using public UI only: identity import, faucet,
Move, Pay and recovery, 1/1 in 14.177 browser seconds. Production browser shim
policy is fixed and verified in real Chromium page and worker (4/4).
Full check r1/r2/r3 exposed formatting, lint and an index-signature error; those
are corrected, but the full check awaits the stable native rejection candidate.
The broad unit run observed 65 failures and did not complete the whole suite.
Follow-up focused runs have fixed Pull/Swap (18/18), orderbook (41/41), scenario
isolation (6/6), and custody (2/2). Preserve semantic assertions; unrelated async
test failures must not be misreported as Cross-J parity failures. The isolated
Cross-J opening vector is green (1/1). No release readiness or TPS claim.

Quorum used one bounded GLM5.3 Coding Plan consultation, zero retries, with the
existing reservation owner. USD0.25 remains reserved because cash cost is unknown;
managed allowance reported USD9.50 after this and the previous unresolvedUSD0.25.
Historical USD100 hold is unchanged. Opinion errors were rejected against real
TS vectors. Source packet/results: `/Users/zigota/quorum/data/packets/dispute-chunk-20260907-01/`.

Source: `/private/tmp/claude-501/-Users-zigota-xln/1eb1a950-0843-45d1-863f-bdeb86d3d990/scratchpad/report/draft1.pdf`,
19 pages read. Treat the report as evidence to verify, not protocol authority.
Pages 5 and 6 contain an unfinished findings table and an empty parity matrix.
Do not adopt its proposed wallet deletion, permanent Rust scope reduction, risk-cap
removal or compiler changes as owner decisions.

1. Finish the current money boundary: native Rust R2R/R2C/C2R must assert actual
   reserve/collateral conservation. Re-run the corrected isolated-jurisdiction
   binding, then reproduce and fix dispute ProofBody chunking/per-clause parity.
   Fix the first failing production transition before expanding the test scope.
2. Restore meaningful money and recovery regressions on the current ABI. The fresh
   four-file run is 61 pass, 7 fail, 1 error in 2.40 seconds; evidence:
   `/tmp/xln-draft1-first-boundaries.log`. Failures include three settlement
   transitions, two Runtime atomicity cases, stale committed-output dispatch
   dependencies and a removed ensureDelta import. Diagnose fixture drift versus
   production defects; preserve semantic assertions and never blindly repin goldens.
3. Prove delivery safety with production reject policy and real peer crash windows:
   commit-before-send, send-before-ACK, exact duplicate delivery, retained outbox.
   Sender-caused rejection must preserve healthy work; storage failures remain halt.
4. Complete Pay/Swap/Move/Dispute/Cross-J scenario evidence in TS and native Rust,
   including partial/cancel/expiry, unilateral exit and recovery. Cross-J currently
   has a fresh 66-frame production WAL exact through all four replay engines;
   native live Cross-J and native TVM remain separate outstanding gates.
5. Implement required first-launch Lending on the existing book: own-funded deposit,
   signed term claim, manual hub approval, principal transferred once, drawn debt,
   partial/full repayment, maturity/default and hub liability, then TS/Rust recovery.
   Keep admission closed until the complete economic lifecycle is proven.
6. Stabilize atomic commits on main, including code, artifacts, fixtures and tooling;
   preserve unrelated work. Run the complete relevant unit/scenario/E2E suites and
   bun run check, then bind final mixed WAL and four-engine replay to that candidate.
   Finish live Rust J/TVM, semantic completeness, production/test Rust compilation,
   production-mode E2E, authorized soak and valid live TPS before release review.

Fresh evidence supersedes report snapshots: stand is free; the five old selective
reruns are resolved; TS Move round-trip is green; native Rust has 5000/5000 payments
and 2500 matched swaps. These are functional results, not TPS or release approval.
The new native Move helper is not yet green after fixing its isolated chain binding.
Do not delay production fixes for module scores, bulk refactoring, a new audit
campaign or rewriting both wallets. Existing owner Lending choices remain binding.

## Earlier execution history

Owner decisions in the soft-mainnet successor task, 2026-09-07: the hub retains
the obligation to term depositors after borrower default; each loan disburses
principal exactly once as a transfer, not a revolving credit-limit grant.
These choices are approved. Complete the current full-check boundary, then
implement Lending against these economics using the existing TS/Rust book.
Admission remains closed until the economic lifecycle is proven.

Method review at 23:27: the first failed production boundary now has exact
evidence. Journey R5 again completes all six money phases and exact historical
Runtime/Account recovery; only the live drain fails. Its retained output is the
exact tip WAL output: Account ACK h4 from Runtime frame48, addressed to active H2.
The signed H2 route is known, but direct peers are empty and canDeliver is false.
This confirms the cold-start circular dependency: the writer waits for a ready
connection while connection preparation only happens inside dispatch. Do not
drop the ACK, weaken readiness, or change financial state. One transport owner
is adding lifecycle preparation using the existing direct-route API and a real
authenticated WebSocket regression, including late profiles and an unready peer.
The same frozen journey will run immediately after the scoped fix is reviewed.
Evidence: /tmp/xln-ui-journey-r5-pending-delivery-20260907.json and
/tmp/xln-ui-journey-isolated-1788736707195. Startup18.965s, browser38.454s.
In parallel, the already reviewed compact-view fix gets a fresh read-only Svelte
browser proof; owner storage is preserved. No broad audit or heavy TVM run before
the UI boundary is resolved. Native TVM preparation types now pass after a
types-only EventEmitter correction; actual stand cleanup tests remain6/6.
No Lending economic choice, new paid model call, commit or push in this interval.

Owner update at 22:04 UTC: Lending IS required for first launch. Desired shape:
hub opt-in extension, lendbook, explicit current-to-N-day term positions, manual
borrower approval and credit underwriting. The owner then asked to read all
relevant existing TS and Rust code before deciding what to finish. Root owns
UI/API/docs, one reader TS and one reader Rust; no admission changes or competing
implementers. Existing six TS state/API tests pass (46 assertions, 2.01 s), which
does not prove the currently prohibited production lifecycle. Preserve that red.
Pay R7 now passes 1/1 in 23.2 s: invalid drafts, revocation of an old recipient
quote, exactly one initiated/finalized payment after double click, exact fee/debit,
same-wallet roots/balances/activity after reload and no repeated receipt. Evidence:
/tmp/xln-ui-payment-edges-r7-20260907.log. Shared Activity deliberately suppresses
raw htlcPayment inputs: its assertion now uses the certified HtlcInitiated event.
Cross-swap R3 and its same-wallet recovery now pass. The full check remains
pending. This is no release completion claim.

Lending review results: TS7/7 and Rust7/7 existing focused tests pass, but bypass
live admission. Two actual-handler accounting counterexamples reproduce in109ms:
own balance0+credit100 can fund pool100; spent loan100 restored with owned R2C101,
then repay101/revoke0 becomes loan=repaid while Account debt100 remains. R2C is a
controlled finality input, not a chain run. Evidence:
/tmp/xln-lending-accounting-counterexamples-20260907.json. Findings and remaining
term-claim/approval/default/full-width issues: docs/lending-review-2026-09-07.md.
The owner was asked whether the hub retains the term-deposit liability or the
depositor accepts a pool loss. No Lending economics/admission was changed.
An earlier full check advanced past artifact drift and first failed at
FOUNDRY_ANVIL_TMP_CLEANUP_BLOCKED for owner dev Anvils87762/87763 on8545/8546;
the other parallel failures are cancellation, not separately established bugs.
Do not kill the owner's live stack or bypass this cleanup guard. No push.

Method review at 22:57: real progress remains measurable: Cross with same-wallet
recovery and signed-proof export are green; full check advanced past artifact,
cache ownership, compiler-intermediate budget and Solidity invariants15/15.
The full same-wallet journey now passes5/6 financial phases: initial100 funding,
Pay, same-J swap, cross-J swap, and actual DisputeFinalized with USDC+WETH payout.
Its first unresolved boundary is the next H2 Account opening: the browser clock
advanced48h for the dispute while hub clocks stayed real, correctly rejected as
a future Account timestamp. Do not weaken timestamp/auth rules or fund again.
The next approach is an existing mutually signed dispute-window setting or
consistent private-stand clocks; another locator-only rerun cannot solve it.
Frontend compact/full-Replica type confusion is now type-green0errors/0warnings;
its owner is freezing the minimal read-view chain for review and the next full check.
Native TVM monetary-ABI wave is prepared but not executed; preserve UI priority.
No Lending economic choice or admission change, no paid model call, no push.

At23:09 the compact-view review found and fixed a real remote-display regression:
four readers were using a live-only resolver even when remote mode intentionally
has env=null. They now read the selected compact/historical view; action authority
still requires a real live Runtime. Numeric regression passes5/5,69assertions,
Svelte0errors/0warnings; independent narrow rereview passes4/4 display consumers.
Existing in-app browser data was preserved when /app rejected deployment-version
change v3-1be66e5f8a49→v1-5d3956f48227; no Reset local data was clicked. A fresh
read-only remote-H1 browser proof is being prepared. Its runtime-import preflight
reports networkready=false; allowPartial is inspection only, not a readiness bypass.

The UI journey clock approach was checked on an actual private Anvil: an old
genesis preserves its mining offset. R4 keeps browser/hub/Runtime clocks real,
advances only J across the observed signed deadline and accepts either legal
dispute finalizer, recording its role. It still requires exactly one receipt,
the same nonce/proof, both exact token payouts, zero work queues and same-wallet
recovery. No race to a particular finalize button is treated as correctness.
R4 source review additionally required exact restored Runtime frame and WETH
reserve after reload; its owner is running that unchanged complete financial route.
R4 completed all six financial operations and exact historical Runtime/Account
recovery, then failed the live drain: pendingNetworkOutputs=1 for15s, other16
queues zero, Runtime height47 unchanged. USDC40,001,976 atoms is inH2 and WETH
5,997,400,200,000,000 atoms is inReserve. Do not call the full journey green.
Artifact: /tmp/xln-ui-journey-isolated-1788736248194; log:
/tmp/xln-ui-journey-isolated-r4-20260907.log. The browser phase took38.055s,
startup19.401s; cleanup completed and stand is free.
Read-only delivery review found a plausible cold-route liveness cycle: loop work
requires canDeliver(target), but lazy direct route preparation happens inside
committed dispatch. A wake alone cannot enter that branch. The exact retained
output and peer state still need evidence before attributing or fixing R4.
ACK evidence cannot be discarded merely because local balances/roots are right.

Method review at 22:27: the previous turn made progress: cross-swap R2 passed
1/1 (13.1 s browser test, 18.755 s startup), with exact 50-USDC debit,
49.995-USDT receipt, both settled route copies, permanent credit54.9945,
zero debt and actual pending/mempool/pull counts. Its first red was an obsolete
test oracle: a 49.995 receipt is below the actual 500-USDT auto-collateral
threshold, so the correct request count and charged fee are exactly zero.
The committed tariff and policy remain checked; production policy was not changed.
Artifact: /tmp/xln-ui-cross-swap-isolated-1788733346809/economic-evidence.json.
Next: prove reload of this same identity and operation, then actual signed-proof
export. Lending review is delivered; its two economics choices remain pending.
Do not rerun the known D3 rejection or enable unsafe accounting.

The full-check cleanup blocker was traced to four orphan Anvil cache directories,
87.03 GiB, all predating both live Anvil processes. Installed Foundry1.7.1 source
creates a unique cache TempDir per process. Root rechecked exact inodes, all file
birth/modify times, live process identities and chain IDs before targeted removal.
Foundry usage fell from97.29 to10.28GiB; both owner PIDs87762/87763 and their live
cache directories remained, and both chain heights advanced. No dev reset,
history deletion or guard bypass. Evidence:
/tmp/xln-orphan-anvil-cleanup-20260907-{before,after}.json.
For future starts, both wrappers now pass Anvil's actual --cache-path option;
TMPDIR alone does not redirect its persisted-state cache. Shell syntax passes;
existing owner processes have not been restarted.
Preserve the 50-GiB check and existing state files. No new external-model spend.

At 22:33, cross R3 passes1/1 in16.5s (startup18.636s): same-wallet recovery
preserves historical Runtime h23 frame/post-state hashes and both Account roots,
balances, credit, tariffs and settled routes. Exactly two accepted preparations
share one Runtime frame; each Account retains one lock and one close, with no
repeated execution or pending work. Artifact:
/tmp/xln-ui-cross-swap-isolated-1788733836717/economic-recovery-evidence.json.
Funded proof export passes1/1 in18.9s: downloaded frame/dispute Hankos match the
wallet's committed historical read surface (not independent cryptographic
verification), followed by Desk/command-palette navigation. Evidence:
/tmp/xln-ui-sovereignty-r1-20260907.log.

Full check then exposed an exact downward unsafe-type ratchet mismatch:
proof-builder removed batchStruct! via union narrowing. Independent AST comparison
found no added assertions; the exact baseline is now176files/637assertions, and
the focused gate passes. Rustfmt required only ordering two module declarations
in resident_entity.rs; formatting now passes. Next full-check failure is the
workspace50GiB budget (74.6GB measured), with 242,588 generated Rust rcgu objects
left in debug/deps. Root is clearing only pre-18:31 compiler object intermediates
with compilers confirmed idle; executables, libraries, incremental cache, release
outputs and economic evidence remain. Cleanup completed233,416 old rcgu objects;
workspace fell from69.47 to41.43GiB while retained libraries/binaries/incremental
cache remain reusable. The unchanged budget passes; contract invariants now
pass15/15 in7.65s. Do not weaken the storage budget.

Next full-check first red: four Svelte types expect a complete AccountReplica
from compact RuntimeAdapterActiveDispute, which intentionally omits raw proof
arguments. One frontend owner is replacing that false reconstruction with honest
read-view types while preserving real live action handles. No empty proof fields
or casts may hide the mismatch. Payment blocking regression passes3/3,21assertions;
remaining EntityPanel consumer types are being adapted. This is not a green
whole frontend or release claim.

The corrected dev Anvil cache path has an actual private-node proof: mined4096
blocks into its isolated cache, graceful shutdown, restart with exact height4096
and unchanged account balance; global cache directory set stayed unchanged.
Two orderly shutdowns completed; owner nodes untouched. Evidence:
/tmp/xln-dev-anvil-cache-path-r2-20260907.log. The first diagnostic call's five-second
bulk-RPC timeout was fixed by four bounded1024-block calls, not a longer test budget.

The remaining old full UI journey is not evidence: it requests excessive faucet
amounts, skips missing APIs, leaves cross as TODO and does not finalize its dispute.
One owner is replacing that test with a same-wallet economic sequence funded
once: reserve100 → Move → Pay → same-J swap → cross-J swap → dispute payout →
Move recovered funds to another hub. No extra token faucet may mask the exit.

Method review at 21:57: Pay double-click reproduced two actual 25-USDC payments.
The form now synchronously locks one submission intent through successful navigation;
errors unlock retry. Final Pay E2E remains red, so do not expand the heavy stand yet.
R2/R3 exposed incorrect test assumptions: exact route fee is 25 atomic units, while
the displayed quote authorizes a 50-unit maximum. Read the committed HtlcInitiated
and HtlcFinalized journals through the embedded UI's production reader, then assert
one hashlock, exact debit and same-wallet recovery. R5 stopped before Pay because
the test read Home before faucet settlement; wait for exact funded Account and UI
balance, rather than assuming request acceptance means completion. Preserve all
financial assertions. Native process-group cleanup now handles observed macOS EPERM
without releasing a live stand; real native tests pass 6/6 and R5 released its slot.
The repeated lending_fund rejection was already documented under D3: rerunning it
was wasted work. Do not repeat it or remove its protocol exclusion. Explicit UI
unavailability is prepared; actual Lending remains blocked on the owner's launch
scope decision. Cross-swap and proof-export tests are prepared, awaiting their real
browser artifacts after Pay. Solidity generation checkpoint is 64b5f62b7 (56 files),
37 commits ahead of origin/main, no push. Full check has not yet rerun after that
checkpoint. No new external-model spend, new TVM execution or production TPS proof.

Method review at 21:24: real faucet and isolated dispute artifacts are now green.
Faucet: four funding destinations, 13.6 s; dispute R6: 14.5 s plus 18.63 s
startup, exact one payout of 100 USDC, the scheduled wake bound to the sent
batch and chain receipt, early-finalize rejection, closed UI and empty queues.
Evidence: /tmp/xln-ui-dispute-isolated-r6-20260907.log. Do not rerun unchanged
private stands. Next first UI boundary: lending principal roundtrip with real
100-USDC faucet fixture, true mempoolCount, whole-limit 10% buffer, and visible
collateral tariff before close. Then actual cross-swap; the old journey has a
TODO cross act and cannot establish coverage. Discovery lists 16 functional
cases, not 16 passing cases. Keep each browser invocation below 60 seconds.
A separate read-only owner verified the exact 56-file Solidity generation
checkpoint, canonical artifact hashes and previous 116/116 controls. Preserve
unrelated work; checkpoint only after writers freeze and formatting/diff checks.
No release claim, new TVM execution, production TPS or new external spend.

Method review at 20:54: the owner reports the faucet is hard to find and does
not give money. Root follows this actual UI boundary now: direct Home/Desk
entry, persistent response/error, then exact on-chain/reserve/off-chain balance
checks through real faucet controls. The old Assets test assumed obsolete
BrowserVM prefunding and never proved ERC20 minting; replace that test. Original
wallet failure details remain requested, not inferred from the screenshot.
Tutorial is now green 23/23 steps in 28.0 s with confirmed DisputeStarted.
The compact Account API omitted dispute details and redacted mempool to []; it
now exposes bounded dispute fields and the true mempoolCount (4/4 vectors,
148 assertions). Earlier Move/recovery queue claims using [] were not queue
drain evidence; corrected count assertions passed the later runs listed below.
The final faucet browser run is green 1/1 (four real funding destinations) in
13.6 s: exactly 100 USDC each in signer wallet, Reserve and Account; an explicit
gas request adds 0.1 ETH. Five requests include one rejected 101-USDC public
faucet mint, then four successes; no duplicate issuance. Credit remains zero
until explicit approval, then 110 USDC. Home/Desk expose the faucet directly;
Assets shows current Account/Reserve balances and one persistent result/error.
Evidence: /tmp/xln-ui-faucet-four-balances-r2-20260906.log and its screenshots.
Corrected true-queue assertions passed Move LEFT/RIGHT and funded same-wallet
Pay recovery (3 passed; combined 55 s budget stopped the fourth from starting).
That fourth empty-wallet recovery passed separately in 16.8 s.
Swap and incoming capacity / prepayment Move passed 2/2 in 33.1 s.

Isolated dispute R3 exposed historical timer ingress after a 48-hour clock jump.
Live wake admission now captures current host time while preserving dueAt and
replay inputs; the named regression failed before the fix and passed after it.
Related wake/ingress tests pass 46/46, 133 assertions. R4 now actually paid the
100-USDC dispute: reserve100, collateral0, activeDispute absent, nonce2, exact
matching chain state and empty queues. Its test still incorrectly expects a
separate Runtime disputeFinalize input: canonical scheduledWake executes local
approved actions inside the same signed Entity frame. Correct this oracle and
the UI's stale "Dispute sent" label before claiming the full E2E green.
The full check was run and stopped at contract-artifact-drift: synchronized new
Solidity artifacts differ from the Git index; compiler metadata parity passed.
No push or release. No new external spend.

Owner priority update at 19:43: first diagnose the actual React UI vault recovery
failure (`RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH`, height 2) without clearing
the wallet; then run and complete the real tutorial through pay, swap, move and
dispute, including meaningful edge and same-wallet recovery assertions. Other
launch work follows. A live browser observation subsequently shows that vault
open at frame 15; this does not establish a recovery fix. Existing payment E2E
imports a fresh random phrase after reload, so replace that false recovery test
with the same identity and persisted financial state. Root owns recovery; the
TS test owner now owns the isolated dispute-finality test; the Move owner finished
the coordinated stack/payment recovery helper changes. Use the UI's own installed
Playwright runner: the repository runner and UI runner differ and cannot mix.

Method review at 20:19: preserve the original h2 wallet; its screenshot mismatch
is still unproven. Two independently reproduced failures are fixed: secondary HD
signers now register before WAL replay (same empty wallet reload 1/1, 9.6 s), and
React catch-up reuses the canonical watcher drain predicate with a captured
finalized target instead of waiting for a durable empty tail. Funded pay 100→75
then SAME-wallet reload is green 1/1 in 14.9 s with identity, historical frame,
Account roots and exact balances unchanged. The second payment run exposed a
test route assumption (Activity restores as Activity); fixed that test helper.
Move found RIGHT collateral omitted from Home and Pay net ownership: both now
derive the view from canonical deriveDelta. Deterministic LEFT/RIGHT Move is
green 2/2 in 23.2 s total: reserve100→0, collateral0→100, owned100 unchanged,
Home100, pending/mempool/draft/sent empty; unfunded action is disabled and inert.
Current sequence: rerun the entire tutorial requiring observed DisputeStarted,
then isolated real dispute timeout/finalize/payout, then swap/capacity negative
cases. One owner per test area; one live stand; no cross-j/TVM expansion until
these user-prioritized financial UI boundaries work. Successful tutorial steps
alone are not exhaustive edge-case coverage or mainnet readiness.

Replacement print completed as job7, one A4 sheet: diagrams left, report right,
center blank. Artifact docs/reports/xln-status-2026-09-06-safe-columns.pdf.
Printer still reports low toner; physical repair/legibility requires observation.

Method review at 19:49: new money ABI is synchronized; Solidity 116/116, TS ABI
45/45, Rust 90/90 focused checks passed. Native Tron selected nine targets compile
in 47.63 seconds and match EVM ABI entries, but new TVM execution remains unproven.
The prior R7 replay evidence uses the old ABI. Cross-j h91 transport now rejects
incomplete close cohorts before publication; producer scheduling remains open.
Freeze those separate areas while the single live stand runs the UI boundary.
The owner also requested a replacement one-page print with a blank center band:
printer reports toner-low-warning and estimated toner 0%; physical legibility of
the previous completed job failed. A printer owner prepares and verifies one new
page, diagrams left and report text right, without changing printer configuration.

New owner instruction at 18:31:42 explicitly approves removing all arbitrary Solidity
monetary ceilings, including the arithmetic/ABI direction in money-domain.md. Preserve
funds, existing signed-state migration, nonce/signature authority, solvency and actual
integer representation. One Solidity owner implements the first full-width settlement
counterexample using the existing harness, then synchronizes artifacts for bytecode
review. No deployment or asset transfer has been performed. Other requested deliverables
remain active; TS/Rust integration follows a stable shared ABI rather than competing edits.

The same message authorizes a new prospective shared Quorum budget of USD 10 per rolling
hour, beginning 2026-09-06 18:31:42 UTC. One reservation owner handles every external call.
Unresolved calls keep their full maximum allocation across hour boundaries; known final
costs occupy the window for 60 minutes after settlement. Keep the historical overnight
grant, its holds and unresolved bills intact; this new explicit authorization is separate.
One bounded GLM 5.3 review was dispatched through the verified subscription route:
HTTP 200 in 26.107 s, 5,867 input tokens, 1,536 completion tokens (1,523 reasoning),
but no final answer. No retry. USD 0.25 remains reserved; the actual bill is unknown.
Available managed allowance is USD 9.75, subject to other later ledger reservations.
An empty answer provides no quality evidence. Any later review must reserve its
own maximum and allow enough output for an actual answer within that cash bound.

Method review at 19:15: Solidity now compiles without MAX_MONEY, full-width asset
lifecycle and the original signed-boundary counterexample pass. Existing financial
controls are 97/98; the actual remaining R2C 4x64 gas boundary fell from 17,197,196
to 15,092,056 against the unchanged 15,000,000 assertion. Remove repeated external
calls and transient allocations while retaining exact event bytes/order and all
256 pairs. Public monetary tuples are frozen; assign one TS owner and one Rust
owner to canonical ABI boundaries while Solidity finishes the same failing vector.
Do not treat old deployed graphs or replay evidence as proof of the new ABI.

The real R7 live cross attempt reached immutable outbox h44 and exposed missing
Rust atomic-pair inference. TS selects the two exact source/target proposals;
Rust forwarded them without the required pair marker. The separate cross-j task
owns transport/routing plus the actual sibling EntityProfile signer lookup, using
the captured real rows as regression evidence. Fix these observed boundaries before
another stand run. Root batches a guarded build after all Rust writers freeze;
new money ABI integration must be coordinated with this old-graph live artifact.
The two obsolete Rust test fixtures now pass (watcher 12/12 and all 62 EntityTx
byte round-trips); full check and production TPS still have no final green result.
The requested one-page report printed successfully: one completed sheet, job 6.

Method review at 18:35: the same immutable R7 now replays exactly through R13 W1/W4
(67 frames, 68 Runtime roots, five ordered comparison counts each 67, both Account
roots). Ordinary live startup restores h90 exactly, catches up to ready h92, and
commits a new policy at h93 in 1.652 s with three checked WAL lineage links and
immutable source copies. The former Account-root assertion compared against h90;
actual h91 creates 18 expired cross-pull cancellation proposals before readiness.
Compare a policy-only command against ready h92, preserving the original exact
restore assertion. These are proposals, not bilateral completion without peer ACKs.

Production and cfg(test) all-target Rust clippy now pass in 16.97 s. Full check first
exposed orchestrator file size; move the exact readiness wait into the existing reset
startup owner, without compressing source or relaxing the limit. Its short stage now
passes; the next first failure is one newly introduced non-null assertion. One TS
owner fixes that boundary while one Solidity owner implements the newly approved
numeric change. A separate task prepares real existing MM/custody peers privately;
it does not edit the continuation driver or start a competing stand. Freeze the
contract ABI before assigning TS/Rust mirrors, then rebuild and rerun exact evidence.

Continue toward evidence-backed xln launch readiness on main. The owner's new instruction
supersedes the old one-hour window and outgoing credit slider in the active goal text.
Incoming uses one credit/collateral spectrum; outgoing uses the owner's reserve/onchain
funds through Move before reviewing the payment. No automatic payment after funding.

Every 10 minutes report verified results, first failure, next action and external spend.
Every 30 minutes review this plan against actual artifacts, reorder work when evidence
changes, and improve the method. After two failed attempts at one hypothesis without
new evidence, change the hypothesis, observation or implementation approach. Preserve
the first failing evidence; do not repeatedly rerun an unchanged expensive stand.

Keep one implementer per area and one heavy stand on this machine. Review stable diffs,
then run focused semantic checks and required final gates. Fast feedback must preserve
financial assertions. Mainnet readiness and live TPS require their actual evidence.
Method review at 18:05: same-socket native payment/ACK and actual saturated ingress
now pass (0.58 s / 0.55 s). A guarded canonical build with 451 unchanged inputs
replays the immutable R7 exactly in W1/W4, including native restart. Ordinary live
continuation passes TS/native h90 root/outbox comparison but stops at
RRS_LIVE_J_WATCHER:TOKEN_REGISTRY_MISSING. Read both implementations before choosing
the fix: TS reads Depository.getTokensLength/_tokens for each selected watcher range;
Rust wrongly requires a cached registry. Match the existing TS live reader, with
strict failure before cursor advancement. Do not persist a derivable extra field,
invent an empty fallback, migrate R7 or record a replacement to evade this boundary.

Native Tron now has two actual committed RPC-attested authority inputs (Foundation
at 25, EntityRegistered at 49, solidified through 60). An observer without an Entity
does not advance the Entity-certified J cursor: validate its actual authority WAL,
not an invented blockNumber expectation. Next verify restoration of the same WAL
and native adapter selection. The receive UI reaches a correct 30.25 USDC buffered
increment; its test mixed innerText with textContent, now corrected without weakening
financial assertions. One Bun/JSC worker crash remains unexplained: 31 isolated
worker-import/signing processes did not reproduce it. A later successful UI boot is
not proof of a Bun fix.

Method change: coordinate all Rust writers across the separate cross-j task before
guarded build, since test edits alone can stale a reviewed binary. That task owns
domain/matcher; this task owns transport/startup/watchers. Preserve the same artifact,
repair the first failing production boundary, then run related fixture/final gates.
The stand sequence is receive UI, native Tron same-WAL restart, then the fresh Rust
R7 live continuation. No new paid calls; the shared USD 100 hold remains in force.

Historical method review at 17:35: the previous answer reconstructed decisions and did not
complete a new implementation gate. The next safe actions are available: the genuine
two-Runtime ACK regression was red in 3.53 s and is now green in 0.57 s; the Rust owner
finishes actual saturated-ingress coverage before freezing. A live-continuation driver
is ready, but it must use the next fresh reviewed build, not bypass binary freshness.
Root integrates and owns native Tron authority; one UI owner changes the credit buffer.
Use the single stand sequentially for continuation, receive UI and native Tron. Do not
repeat a workload until its observed failure or implementation has changed.

Owner decisions at 17:31 supersede earlier proposals in this file:

- Native Tron may use any configured RPC, owned or external, optionally a quorum.
  Implement explicit RPC-attested native evidence; do not claim independent execution
  proof or require a managed local FullNode. The former trust-choice blocker is resolved.
- The default optional +10% buffer applies to the entire required credit limit.
  Collateral preparation is per request with a timeout, not an arbitrary time lease.
- We operate H1/H2/H3 and MM and sign deployment/endorsements. Independent operators
  are a later stage, not a launch dependency. Deliver launch, discovery and economics.
- Owner accepts the proposed platform schedule: 30 days free, then 1 bp/completed
  payment and 3 bp/completed swap, separately disclosed from hub fees/spread/gas.
- Owner asks why the monetary ceiling is being removed; explain the existing removal
  request and arithmetic dependency. ABI migration is still not explicitly approved.
  Preserve states/funds/history and the already authorized removal of arbitrary caps.
  Paid calls remain held in the shared ledger. No spending or funding was executed.

Earlier reviews below are historical evidence, not authority over these newer decisions.
Method review at 17:01: R7 is exact on all four current engine/worker combinations,
including native restart. The first live failure was 1,000 authenticated sockets
rejected on delivery_ready, not slow population startup. Preserve the original
5 s readiness deadline and 1,000-user workload; fix the actual protocol boundary.
Transport and startup/J ownership are separate. Review stable transport while its
startup owner finishes the fixed-target barrier, then freeze both before release.
Transport L1 passes 18/18 in 0.32 s. Root review confirms the authenticated-control
and outbox-retention changes, but also identifies an existing production gap:
dialed sessions decode financial replies only under cfg(test). Advertising readiness
does not prove that receive path. After the next inbound H1 live-J artifact, require
a real bidirectional production-socket regression and route replies into the existing
ingress owner; do not add another queue or accept test-only coverage as production.
Paid external calls remain held; no new spending or usage-reset redemption occurred.
Remote main was fetched: 0 behind / 36 ahead. Final check/TPS/push still await proof.

Boundary update at 17:18: R8 authenticated readiness was correct; the orchestrator
sent its financial bootstrap policy before J catch-up, received the intended 503,
then tore down H1. Gate only that financial policy on validated native deliveryReady;
keep earlier identity/profile publication available. L1: 13/13, 25 assertions, 530 ms;
independent stable-diff review found no actionable issue. R9 then completed in
19.386 s: 1,000 sovereign Runtimes in five processes, 5,000/5,000 payments over the
five-second functional window, no pending Account frames/runtime work/outbox rows,
no rejected sessions or queue rejections before teardown. Actual native Account
settlement traversed proposal, bilateral Hankos, J broadcast and finality in 1.197 s;
Account height 23→29, J nonce 0→24. The same binary replays R7 exactly in W1/W4,
including native restart. Evidence: docs/evidence/rust-live-j-20260906/summary.json.
This is local EVM functional evidence, not 20-second TPS, native Tron authority or
TS-to-Rust live cutover. The Rust owner now builds the real two-Runtime, one-socket
payment→ACK→WAL regression before fixing dialed financial replies in the existing
reactor. Root retains integration/evidence ownership; no paid external calls.

Resume review at 16:33: the previous implementation turn ended at the usage limit;
no continuous work or intervening strategy reviews are claimed. Current main is
744817492, ahead of origin/main by 36 commits, with 306 shared worktree entries.
Neighbor commits changed production recovery since R7, so revalidate that immutable
recording against current TS as well as the corrected Rust binary. The R7 h29
regression exists; its production reader remains unfixed. One Rust owner resumes
that bounded fix while root checks current-source replay and build provenance.
Preserve existing evidence and other writers' changes; paid calls remain on hold.
Method review at 05:08: preserve immutable failing recordings. Progress that cycle:
47/65 R6 → 67/67 fresh R7, a proven TS recovery fix and completed native TVM governance.
R7's same-native restart was that review's first red boundary. Keep restart → W4 → live J →
final completeness/compilation/check → valid TPS as the critical path. New features
do not displace it. A mismatch identifies a boundary, not which engine is wrong:
prove independent source semantics before changing either side. R6 h73's exact
first-seen union of prior touches proved the TS bug; Rust did not inherit that leak.
R7 restart h29 proves all context keys/digests exist, but canonical encoded key order
differs from raw string order for 111/112-byte keys. Fix the reader's map interpretation,
preserving signed bytes and positional financial outputs. Diagnostic console output
uses an allowlist of heights, counts and hashes; full signed inputs remain private files.
The current loop advances, so keep its first-divergence approach. A terminal missing
context can hide an earlier Entity hash mismatch; compare signed commits in exact
order before diagnosing later cascade work. Inspect state sections, then frame events
and replica metadata separately. Matching money alone does not prove signed parity.
A private diagnostic driver now captures the exact signed input, Entity commit links,
events and section digests in one run at a requested height (h69: 2.903 seconds).
Every run uses fresh source-bound WAL copies; raw signed inputs stay in private files.
Existing native section traces avoid rebuilding for observation. Prove unchanged
section hashes before reusing a later dump. Root supplies independent TS evidence and
reviews stable diffs while one Rust owner fixes the boundary. After two attempts with
no new evidence, change observation or hypothesis. Do not weaken the root comparison.
After R7 W1/W4 exact, run the existing live Rust J settlement command. That launcher
uses native genesis, not TS-to-Rust live cutover; keep these evidence claims separate.
The h72 boundary is recorded transport retirement, not a new financial transition.
Follow the existing TS recovery witness: retained output must match prior verified
native bytes and order; current financial outputs remain independently generated.
Preserve current routing, sender-settled pruning and full final digest validation.
Do not refactor the live publisher or add another durable queue to fit this replay.
Replay does not prove independent delivery/liveness; the later live gate must do that.
Production files now stay frozen during builds; child agents write only their owned
tests. Record source hashes before/after release builds and discard mismatched builds.
Native governance runs use idle stand windows while Rust implementation proceeds.
Persist disposable fixture authority privately before funding, so a failing native
check can resume the same funded Entity instead of abandoning it or resetting the chain.
Cross R14 and same-J now share one production bootstrap and pass in 38.099 seconds.
The actual signed collateral fee is disclosed through its committed conditional tariff
before submission. Mobile clearance is 12 px, with zero horizontal overflow. Preserve
the distinction between UI receipt settlement and later jurisdiction rebalance finality.
Run full check after the current corrected production/replay boundary works.
Root owns artifact integration/provenance; one owner each implements Rust parity and
native jurisdiction connection. Source WAL and signed checkpoint remain immutable.
The native authority proof and wide monetary ABI are genuine protocol forks awaiting the
owner's answers; keep those boundaries closed and continue independent replay/UI work.
Fresh-wallet Cross now uses the canonical per-jurisdiction Entity import. For economic
browser proof, obtain an actual executable opposite MM order through the existing
production reader before choosing the pair/amount; a resting unsupported pair is not
evidence of a settlement bug. Use the same real UI actions with sufficient fixture funds.

## Current production boundaries

1. Remove arbitrary monetary ceilings coherently in TS, Rust and Solidity. Credit grants
   may use their full uint256 representation. Existing contract MAX_MONEY = 2^200 also
   supports intermediate arithmetic; replace that dependency with exact arithmetic before
   accepting states the contract cannot settle. Preserve authority, available capacity,
   signed-state representability and unrelated anti-DoS protections.
2. Native Tron: official java-tron 4.8.2.1, mainnet feature settings and JDK17 run locally.
   All eight contracts deployed. Real deposit/withdrawal passed: reserve 0→1,000,000→0,
   nonce 1→2, external balance restored, solid receipts and canonical events observed.
   Evidence: /tmp/xln-tron-native-20260905/economic.json. Native cross-j replay remains.
   The canonical provisioner now accepts the actual native graph with distinct contract
   addresses, native endpoints and solid finality (14.019 s including boot; verification
   86 ms). All nine compiled creation/runtime templates match the earlier graph. Continue
   through the existing Hub adapter factory reached the real first failure:
   J_AUTHORITY_RECEIPT_MPT_PROOF_MISSING:FoundationBootstrapped:25:3. Stock Tron headers
   do not commit receipt/log roots; a successful transaction proof cannot authenticate
   arbitrary authority logs. The validating-FullNode versus portable-proof decision is
   pending. Evidence: docs/evidence/tron-native-20260905/manifest.json (13 verified files).
   Additional actual TVM governance R1 registered numbered Entity 2, proved both
   100-billion supplies and reserve 0→1,000,000 with nonce 0→1, then mined board
   commit/proposal/activation through block 54. Verification stopped because generic
   ethers getBlock rejects native Tron's stateRoot="0x". Preserve that native shape;
   read the exact block timestamp through the canonical parser. Restart then proved
   that the unsolid activation block 54 was replaced, restoring the actual old board.
   The same funded Entity and pending proposal were recovered without registration
   or another deposit: reactivation 55, old-board mined REVERT 58, new-board payout 59.
   Activation and payout now wait for solidity. Reserve returns to 0, external balance
   to 1,000,000,000,000; the failed transaction preserves nonce 1 and payout advances
   it to 2. Execution 20.761 s plus boot 11.513 s. Original failure evidence remains in
   /tmp/xln-tron-native-20260905/governance-r1; final evidence is economic.json and
   /tmp/xln-tron-native-governance-r1-finality-recovery-20260905.log. This is direct L1
   contract evidence and does not close the native J authority-proof decision.
3. Receive/Pay UI: browser R10 passed in 28.926 seconds: credit 25→27.5, own reserve
   top-up 25.000025 including route fee, return to enabled Pay with no automatic send.
   Evidence: /tmp/xln-react-capacity-1788573224783. Downstream fee-capacity correction
   is included. A real LevelDB activity-view repair race was then reproduced and fixed
   under the existing per-path view queue; authoritative commits remain independent.
   R10 has zero activity-view gap warnings. Same-j Swap then passed in 24.100 seconds:
   199.999992 USDC debited, 0.0799760016 WETH received, permanent credit 0.0879824 WETH,
   zero pending work. Evidence: /tmp/xln-react-swap-1788573446670/browser.log.
   Fresh-wallet Cross setup passed in 22.381 s after restoring the existing vault's
   per-jurisdiction signer/import path. A subsequent 0.03 WETH receiving intent explicitly
   granted 0.033 credit without pre-click money movement, but had no opposite MM market.
   The test now reads the actual production MM order before selecting its UI pair/size.
   Cross R10 then passed in 27.139 s: both routes settled, 10,200 USDC debited,
   gross 10,198.98 USDT received, net 10,197.860102 plus a signed 1.119898 collateral
   request fee. Account frame 6 proves net + fee = gross; debt and pending work are zero,
   permanent credit remains 11,218.878 USDT. Evidence:
   /tmp/xln-react-cross-swap-1788576931486/browser.log. The auto-rebalance fee was not
   disclosed before Swap. The corrected R14 now shows the existing committed tariff
   and conditional nature before submission, without inventing an exact future net quote.
   Same-J and Cross pass together: startup 18.761 s, browser 19.338 s, two tests with
   fresh wallet contexts and one stand bootstrap. Mobile fee text clears the Swap button
   by 12 px with zero horizontal overflow. Evidence:
   /tmp/xln-react-cross-swap-1788578133651/browser.log. Receive/Pay R13 also passes in
   29.489 s, including the explicit default-credit CTA, 25→27.5 permanent limit, own
   reserve top-up and return to review without auto-send. Evidence:
   /tmp/xln-react-capacity-1788578008372/browser.log. Lending R1 reached the first real
   failure before position creation: the UI exposes Offer, but canonical TS/Rust live
   admission rejects lending_fund under D3. Account state remains unchanged; a real
   worker/stage regression proves the error. Aggregate logging now retains both apply
   and discard causes. Spectrum/close payout and fee assertions were not reached.
   Evidence: /tmp/xln-react-lending-1788578675867/browser.log and
   /tmp/xln-lending-stage-diagnostic-green.log. Existing Lending handlers and direct
   semantic vectors exist in both engines; these do not prove live admission/consensus.
4. Current R7 production plus real process replacement/recovery passes in 38.681 s;
   one cross-j swap settles in 625 ms. PID 95392→95745, both routes settled. Frozen
   checkpoint 23 plus tail 24–90 contains 67 frames, 108 Entity inputs and 104 outputs.
   Current-source TS W1 (2.909 s) and W4 (3.031 s), rechecked September 6, match all
   five evidence arrays and the original TS results. Native W1 originally verified
   every frame/root/ordered digest and fsync, then failed the mandatory same-native
   restart: RRS_NATIVE_RESTORE_STORAGE:RRS_ENTITY_CONTEXT_FRAME_REFS. Actual native
   h29 has two complete context payloads with exact keys and digests. The reader
   incorrectly required raw string order while the canonical codec orders encoded
   keys (different lengths). The corrected reader validates encoded order/uniqueness,
   then compares map membership in the existing String index. Real append/reopen,
   duplicate rejection and changed-manifest rejection pass in 0.10 s after a 3.04 s
   compile. Root review found no actionable issue. Release build: 20.510 s, all 407
   source files unchanged. Same immutable R7 now passes native W1 and W4 including
   native restart: 67 frames, 68 runtime-root comparisons, all five ordered comparison
   counts 67, 108 inputs, 104 outputs, both Account roots exact. Whole driver wall:
   W1 1.444 s, W4 0.607 s; these are replay measurements, not TPS. Evidence:
   /tmp/xln-cross-j-parity-r7-20260906-1633/rust-worker-comparison.json and
   rust-context29-fixed-w{1,4}-20260906.log in the original R7 replay directory.
   Public summary: docs/evidence/r7-parity-20260906/summary.json.
   Next production boundary is live Rust J settlement on this binary. Its first
   September 6 run booted in 2.910 s but stopped before any financial input:
   RRS_TRANSPORT_INBOUND:unsupported-direct-message:delivery_ready. All 1,000
   sovereign Runtimes started and authenticated; Rust rejected all 1,000 sessions.
   HLT_HOST_READINESS_INCOMPLETE:missing=855 is a later readiness snapshot, not
   evidence that those Runtimes never started. Preserve the 5 s readiness deadline;
   port the existing authenticated readiness control and recipient outbox gate to
   native transport, with local readiness owned by actual startup J catch-up.
   Current TS readiness/outbox regressions pass 4/4, 86 assertions, 361 ms.
   Evidence: /tmp/xln-rust-live-j-r7-20260906/server.log (first rejection line 37;
   1,000 authenticated/rejected sessions and zero inputs at line 1038).
   Source: /tmp/xln-cross-j-wal-r7-20260905/recording-manifest.json; replay/import:
   /tmp/xln-cross-j-parity-r7-20260905. Original signed checkpoint fields, snapshot,
   tail and source binding remain exact after offline import (140→154 rows).
   Prior cross-j WAL binds checkpoint 22 and 35 frames through 57, with 64 Entity
   inputs and 56 outputs. TS W1 and W4 verify every frame/root and ordered output. All five
   per-frame evidence arrays match exactly; the recording contains one pending outbox at
   its first failure boundary, so this replay is not a drained live TPS claim. Manifest:
   /tmp/xln-cross-j-wal-r4-20260905/recording-manifest.json. Report:
   /tmp/xln-cross-j-parity-r4-20260905/ts-worker-comparison.json. Native exact range,
   whole-Runtime checkpoint root, plural Entity restore and offline Account import pass.
   The canonical imported manifest preserves five signed checkpoint fields and the source
   binding; its source WAL is frozen separately from each mutable replay copy. Rust now
   matches frames 23–44 (22/35). Corrections preserve positional Account publications,
   per-owner continuations, canonical events, per-input admission and per-owner immediate
   cascades. Related Rust machine tests now pass 85/85. Frame 45 isolated the TS worker bypass:
   whole-mempool proposal precedes cohort selection; the later guard sees an empty mempool.
   Four real worker regressions failed in 1.385 s. The corrected worker path, including
   failed-HTLC continuation, passes 52 tests and 41,146 assertions in 9.42 s. Fresh R6
   production recording and actual process replacement/recovery pass in 38.387 s;
   the single cross-j swap settled in 650 ms. Frozen R6 checkpoint 24 and tail 25–89
   contain 65 frames, 105 Entity inputs and 104 outbox envelopes. TS W1 (2.837 s) and
   W4 (3.115 s) match every frame and all five evidence arrays exactly. Manifest:
   /tmp/xln-cross-j-wal-r6-20260905/recording-manifest.json; comparison:
   /tmp/xln-cross-j-parity-r6-20260905/ts-worker-comparison.json. Rust W1 matches 25–42
   and first diverges at 43: all 23 sections of both committed Entity states agree,
   but two pending Account proposal roots differ. Exact candidate logging and caller
   inspection isolated cross_pull_lock.createdHeight: TS passes J height, Rust passed
   Account height. The unequal-height test reproduces 4 vs 24; the caller fix passes
   five focused tests and R6 now matches h43 (19 frames exact). Next red at h44:
   ENTITY_REPLAY_CONTEXT_UNCONSUMED, one source Entity frame. The tagged ACK pair must
   stage both legs against the same pre-pair sibling view and publish both before
   normal AccountWork sees updated views; Rust exposed the first leg too early. Fix
   this narrow publication boundary with its regression, then replay R6. The fix passes
   its named regression and advances the same R6 through that boundary. A second h44
   mismatch came from projecting Cross-J venues into same-J pair policies; the corrected
   derived policy projection passes three focused tests. The next failure was only
   source orderbookExt metadata: target 23/23 sections, source 22/23, all four individual
   books and the complete ordered outbox were exact. Rust inserted pairDimensions for
   a Cross-J book; TS keeps that metadata only for same-J. The corrected writer and
   restore validation pass three tests, preserving canonical Cross route validation
   and explicitly rejecting the former incorrect persisted shape. R6 then advances
   through h64. At h65, remote runtimeOutput wrongly split an ordinary deferred input
   from its preceding Account ACK; the corrected grouping passes its real regression
   and R6 now matches h66. The three h67 corrections preserve the pre-trade published
   Cross book, execute the existing reveal without an extra offer-presence condition,
   and count only committed matches in runtime metrics. Named regressions pass; R6
   now matches every root and ordered digest through h67.
   At h68, scheduling the existing hub-rebalance kick from each
   successful Account input's immediate readiness restores all 46 Entity sections,
   the canonical state hash and the outbox. The remaining frame event incorrectly said
   an absent order was removed merely because a book existed. Exact indexed membership
   fixes the event, with a named regression. R6 now passes h68 fully (44/65 frames).
   h69 now executes the scheduled collective self-action in the same signed Entity
   frame, records exactly the rebalance Account touch, and compares the same eight
   financial effect kinds as TS. Debug diagnostics remain in production outputs;
   receipt removal, mutation and reordering still change the financial-effect digest.
   R6 passes through h72 fully (48/65). The verified transport-retirement witness
   preserves exact prior native WAL evidence, current routes, sender-pending pruning
   and positional delivery merging. Seven regressions pass, including a real payment
   whose new output cannot be hidden by an empty recorded outbox. Release 26.70 s;
   all 406 source hashes match before/after. That candidate's first red h73 has exact Entity
   roots, contexts, replica metadata and ordered outbox, but TS records 16 old Account
   touches and two book owners while Rust records none. This is the first live frame
   after restart. TS replay accumulates currentStorageOverlayMarks without the cleanup
   performed by live commits. The real regression reproduces a payment of 10, six
   replayed WAL frames and two stale Account touches in the next no-account frame.
   Clear only per-frame marks after successful authority finalization. The same test
   now passes 31 assertions in 2.12 s, with the cumulative four-record overlay and
   financial roots preserved. Fresh R7 above replaces this defective production
   artifact; no historical dirty-mark behavior was added to Rust.
   The old TS replay evidence verifies roots/events/outbox, not independent regeneration
   of the recorded touch list. Evidence: /tmp/xln-cross-j-parity-r6-20260905/
   recording-native-import.json.w1.diffs/first-divergence-h73.json and
   rust-h72-transport-complete-l1.log in the same directory.
   Evidence: /tmp/xln-cross-j-parity-r6-20260905/rust-w1-policy.log.stderr and
   ts-h44-diagnostic/section-comparison.json within the same evidence directory.
   Production r5 cross-swap plus full process replacement/recovery passed in 42.866 s;
   swap 627 ms, all Account/runtime pending work drained. Initial base remains immutable.
   Evidence: /tmp/xln-cross-j-wal-r5-20260905.log.
5. Quorum remains standalone in /Users/zigota/quorum. Record useful independent judgments,
   provenance and costs; paid review must resolve a concrete uncertainty, not displace work.
6. Full check exposed and resolved import cycles, two new lint violations and 14 GiB of
   disposable Rust incremental cache exceeding the test workspace budget. Newly added
   tests/helpers are grouped by their existing responsibility; folder-width now passes
   without increasing thresholds. Full-check r4 passed 15 contract invariant tests in
   8.23 seconds; a new parity test exceeded folder width and has since been grouped.
   Finish full check on the stable candidate after the current replay boundary works.
7. Company IPO/governance: actual Anvil RPC scenario passes 211 frames and exact recovery.
   One buyback moves 10 billion CONTROL against 1 trillion six-decimal USDT fixture units;
   eight bilateral asset copies verify the movement, with fee 0 under that fixture's policy.
   Four focused EDR Solidity tests pass: initial 100 billion supplies, old-board financial
   rejection and retained historical dispute authorization. Logs:
   /tmp/xln-company-ipo-20260905.log and /tmp/xln-company-governance-20260905.log.

## Historical overnight external-model authorization

The newer USD 10/hour instruction above supersedes this expired grant for prospective
work. The following records and unresolved billing remain historical evidence.

One cumulative **USD 100** budget for this overnight session, across every model, harness,
agent, retry, reasoning/output token and paid tool. It does not reset per wave or wakeup.
The reported USD 200 OpenRouter account balance is not extra authorization.
USD 1 remains an economical default wave target; the owner now permits autonomous
reallocation within the USD 100 session total. Future nights do not inherit another USD 100.

Owner-reported routes: Grok subscription, OpenCode Go, pi with OpenRouter, GLM 5.3
subscription, Cursor CLI and Claude. Verify actual installed version, exact model,
subscription/API billing route and available account access before dispatch. Prefer
confirmed subscriptions. Do not silently fall back to paid API billing.

The Quorum budget owner alone reserves and dispatches external calls. All other agents
request allocations through that owner. Use one shared reservation ledger; uncertain
bills remain reserved until reconciled. No independent per-agent spending counters.
Two controlled GLM 5.3 subscription requests: first timed out at 60 seconds, second
returned a final answer in 19.481 seconds after reducing the packet and effort. Actual
cost remains unknown; USD 0.50 stays reserved. The completed review contained an unsafe
boundary formula, which independent checking rejected. Do not invent a quality score
from one response. Other independently running harness costs are unknown; this ledger
is not a claim about total account usage or the Codex subscription. The BrainVault task
reports USD 0.288243 from three finished harness receipts (not billing-reconciled), plus
four Qwen calls with unknown cost. Its last pi/OpenRouter Qwen ended output_limit after
550.119 seconds without a final answer. No model calls remain active there. Reconcile
these receipts in the central ledger before allocating another paid review. Reconciliation
now preserves all seven BrainVault observations and fourteen source hashes. Receipts lack
provider generation IDs; aggregate account usage cannot establish this session's cost.
A USD 99.50 administrative hold plus the existing USD 0.50 reservations blocks new paid
calls. This is a conservative reservation, not a claim that USD 100 was spent. Evidence:
/Users/zigota/quorum/docs/budget-reconciliation.md.

At 03:38, an independent UI receipt reconciliation confirms USD 0.494164962 through
16 provider generation lookups. This is a partial billed subtotal, not the total
night spend. Two pi estimates were half the actual billed amount. Nine ZAI costs,
20 errored UI turns, one unfinished turn and previous BrainVault/GLM observations
remain unresolved. Keep the existing single hold unchanged. Evidence:
/Users/zigota/quorum/data/reconciliations/2026-09-05-ui-review.json.

## Final gates still required

Focused L1/L2, real UI/F12, synchronized contract artifacts and explicit bytecode/hash
review for Solidity changes, exact replay, live J, production and test Rust compilation,
transaction-kind coverage, bun run check and valid live TPS. Preserve unrelated changes;
stop concurrent writers and inspect the specific diff before commit or push on main.

### Owner-requested Claude audit — 2026-09-09 22:00 UTC

Scope: one read-only audit each of keys/unlock, payment state, and recovery/publication,
against 57b48293e8161513c39e0154d167b1968f9ed4a7. Authorization is this request only;
no retries or model substitution. Claude Code2.1.259, requested claude-fable-5-1,
effort high, Read/Grep/Glob only, immutable source snapshot in
/tmp/xln-audit-57b48293e. Auth status confirmed claude.ai Max subscription, first-party.
First invocation returned “out of usage credits”, modelUsage empty, reported cost0;
no audit was produced and the other two were not launched. No paid API route used.
Prepared packets and exact failure are in that directory. Quorum paid reservations unchanged.
