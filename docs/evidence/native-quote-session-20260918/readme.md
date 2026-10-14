# Native quote/session release boundary

2026-09-18. Actual macOS WKWebView, the production native TS host and
`NativeSockets.swift`, two local Anvil chains and the existing local hubs.
The initial session regression is native-host evidence. Actual iPhone UI
acceptance is recorded separately below; neither proves native Tron/public testnet.

Current result: the native session regression passes all four cases on a new,
isolated live local stand (`docs/evidence/archive-tmp/xln-native-release-zEZarI`). An unexpired old
quote rejects after lock, an invalid boot and an invalid BrainVault attempt;
balance stays at 100 USDC. A fresh quote pays one USDC, leaves 99 USDC and rejects
a second confirmation. See `quote-session-result.json`. This is real WebKit and
Swift transport evidence, not iPhone SwiftUI or native-Tron acceptance.

The first isolated attempt uncovered another bug: starting a replacement native
session disconnected the UI adapter without closing the prior Runtime. After an
invalid boot, the next open collided with the still-live identity. Native boot
and BrainVault entry now await canonical runtime shutdown before beginning a
replacement. Logs: `docs/evidence/archive-tmp/xln-isolated-native-quote.log` (failure),
`docs/evidence/archive-tmp/xln-native-session-fixed.log` (four passes).

The original saved dev stand remains separate and unrepaired. Independently
hashing the saved Anvil header for block 90211 reproduces the reported RPC hash,
not the hash accepted by XLN. No alternative header was found in its available
cache. This identifies inconsistent saved histories; it does not establish why
the original header was lost. No accepted finality or history was rewritten.

The updated iPhone simulator app builds successfully, including the native host
fix. Three transport/controller files moved into `frontend/ios/App/App/runtime`;
Xcode references were updated and the folder-width check now passes. Build log:
`docs/evidence/archive-tmp/xln-ios-session-build.log`; artifact:
`docs/evidence/archive-tmp/xln-ios-derived/Build/Products/Debug-iphonesimulator/App.app`.
This artifact targets the configured local API. The subsequent actual iPhone
acceptance and its scope are recorded below.

## iPhone creation/payment and swap minimum — 2026-09-18

Actual SwiftUI acceptance on iPhone 17 Pro / iOS 26.5 simulator
`59209751-39EB-4274-AF6C-A88DE1099CAD`: explicit BrainVault creation,
verified initial encrypted backup, 100 local test USDC funding, a one-USDC
payment to H1, and a visible confirmed balance of 99 USDC. This uses the
packaged canonical TS Runtime and Swift native sockets. No fake financial
responses. The installed runtime is TS in WKWebView, not Rust.

Video: `output/ios-release-2026-09-18/payment-proof.mp4` (125.15 seconds).
Screenshot: `output/ios-release-2026-09-18/payment-confirmed.png`.
The video also shows a real below-minimum swap rejection after submission;
it does not show successful swap execution. A subsequent ten-USDC attempt
outlasted the bounded stand and is not a swap result.

The first-run screen previously only allowed recovery. It now separates
Create from Open, confirms the password, checks recovery absence before
creation and verifies the initial encrypted backup before exposing the wallet.
Ordinary Open still rejects absent verified recovery without creating storage.
Five live WebKit cases pass (`brainvault-create-result.json`). Test wallets use
explicit work factor 1; the app default remains 3. Initial backup does not prove
continuous backup of later payments.

The swap quote bug is repaired in the shared web/native quote layer: the hub's
committed minimum is published per source in its market feed, strictly decoded,
and applied to the canonical planner's rounded quote amount. Unknown policy
never becomes a zero minimum. The updated feed requires coordinated server and
client artifacts; no old-wire fallback is added. No consensus rule changed.

A separate real WebKit/Swift-transport test passes four cases:
1-USDC rejection, rounded 10-USDC rejection, valid 25-USDC execution, and exact
balances after lock/reopen. Debit 24.999999 USDC; gross receive 0.009998 WETH;
fee 0.0000009998 WETH; resulting balances 75.000001 USDC and 0.0099970002 WETH.
Evidence: `swap-minimum-result.json`; harness `scripts/native/tests/swap-minimum.js`.
Focused market/quote checks: 23 passed, 96 assertions. UI typecheck passes.
Full `bun run check` passes after this change: 39 source gates, source phase
40.313 seconds; frontend phase 23.092 seconds. Log:
`docs/evidence/archive-tmp/xln-market-min-final-check.log`. The rebuilt iPhone app then passed actual UI acceptance: a 25-USDC quote,
explicit incoming test credit, completed swap with exact fee, matching token
balances, and a one-USDC quote rejected before confirmation. Video
`output/ios-release-2026-09-18/swap-proof.mp4` (125.145 seconds) includes the
completed receipt around 80 seconds. Screenshots: `swap-confirmed.png`,
`swap-minimum-protected.png`, and `live-orderbook.png` in the same output folder.
The Market screen also displays real hub depth. This does not prove arbitrary
resting-order cancellation or every market flow. Build log:
`docs/evidence/archive-tmp/xln-ios-swap-build.log`. Stand: `docs/evidence/archive-tmp/xln-native-release-CoXOPY`.

The Home fiat total uses reference prices, which differ from the local market
price: after swapping, it displays $109.99 while exact token balances are
75.000001 USDC and 0.0099970002 WETH. This is not a realized gain; valuation
source/freshness remains a UX limitation to address before release.

A saved isolated stand failed restart because its Anvil state JSON was truncated
at column 439827. Data `docs/evidence/archive-tmp/xln-native-release-hGfpwg` was preserved; startup
log `docs/evidence/archive-tmp/xln-iphone-flow-preserve.log`. The payment recording used a separate
new stand `docs/evidence/archive-tmp/xln-native-release-rK735w`; the swap regression used
`docs/evidence/archive-tmp/xln-native-release-5P16QN`. This does not resolve saved-chain recovery or
the original immediate-close race. Both chains here are Anvil; native Tron,
ETH↔Tron execution, lending, and all-platform release acceptance remain open.

## Earlier failure evidence

Before the change, a real one-USDC payment quote survived lock and reopening:
confirmation returned "Payment submitted. Waiting for the confirmed receipt."
with 55,384 milliseconds left before expiry. This proves acceptance of a stale
session authorization, not final payment settlement.

The host now clears pending quotes before lock, boot and BrainVault entry.
The regression checks those boundaries, unchanged balances after rejection,
fresh confirmation and rejection of duplicate confirmation. Its live result
is still RED: the local hub halted during the original probe's shutdown, then
failed to recover. `hub-halt.json` contains the original event;
`recovery-failures.json` preserves the halt and subsequent restart failures.
Do not run further financial probes against this unhealthy stand or reset its
databases to erase the failure.

After the live hub/recovery boundary is repaired, reproduce from repository root:

```sh
mkdir -p docs/evidence/archive-tmp/xln-native-session-probe
xcrun swiftc -swift-version 5 frontend/ios/App/App/runtime/NativeSockets.swift scripts/native/tests/quote-session.swift -o docs/evidence/archive-tmp/xln-native-session-probe/probe
bun run stand:status
bun run stand:run --reason native-quote-session-regression --timeout-ms 60000 -- docs/evidence/archive-tmp/xln-native-session-probe/probe scripts/native/tests/quote-session.js
```

The harness opens a real WebKit window, uses isolated ephemeral storage and
fresh locally generated test keys, and terminates within 58 seconds. The local
native host must be served at `http://localhost:5183/native/index.html`, built
for the loopback API at port 8082. No mocks, downloaded keys, or real funds.


## Jurisdiction import recovery follow-up

The hub import waiter now requires the exact submitted `importJ` to commit and
its J replica to exist. It no longer requires all unrelated Runtime work to
become idle. The production transition still rejects conflicting chain or
contract metadata. No Runtime input bytes or financial transition changed.

Focused regression: a real in-process EVM adapter and Runtime receive continued
unrelated import requests. The old waiter failed after 10 seconds; the revised
waiter completes while subsequent input remains queued. A conflicting chain ID
still rejects. Two tests pass (five assertions). Runtime typecheck and production
function-size check pass. Logs: `docs/evidence/archive-tmp/xln-hub-j-import-final.log` and
`docs/evidence/archive-tmp/xln-runtime-types.log`.

A bounded restart used the existing canonical dev supervisor with
`XLN_MESH_PRESERVE_STATE_ON_RESET=1`, omitting the destructive preparation step.
It retained `db/dev/rdb` and `db/dev/jdb`. H1/H2/H3 imports completed in
272/428/482 ms. Their existing three bilateral hub pairs were present. The full
system was still not ready. `import-recovery-health.json` preserves that snapshot.

The next live failure was `J_HISTORY_FINALIZED_REORG` at chain 31337 block 90211:
expected `0xc7e63ffdac4034a30f2ee9e20d51ea1a10ab19916f0fedca012f4f43a95a8c82`,
RPC canonical `0xf081e3fab9f1fd9fb00f866e17b8357c482484e8d92c60101c2d8e87892fab37`.
`finalized-reorg.json` preserves the watcher report. This does not prove the cause
of the mismatch; the local chain snapshots and Runtime history need comparison.
The stand stopped after this failure. Do not clear accepted history or bypass
finality validation. The original native shutdown and quote regressions remain
open; the import fix is not proof of complete recovery or release readiness.


The earlier source check failed on iOS folder width. After the native session
fix and file grouping, full `bun run check` passes under the 60-second stand
lock: 39 source gates, source phase 54.646 seconds. Log:
`docs/evidence/archive-tmp/xln-native-session-check.log`. UI typecheck and the iPhone simulator build
also pass. Nothing was committed, pushed or deployed.


## Saved dev-chain shutdown repair — 2026-09-18

The truncated Anvil state is reproducible through the full canonical launcher:
a healthy fresh stand with a real one-megabyte test contract shut down into a
24,550-byte invalid JSON snapshot. Signalling the standalone role wrapper
produced valid snapshots, isolating the fault to launcher/supervisor shutdown.

A launcher process-group signal reaches both the shell and its supervisor.
The shell forwards the same signal; the supervisor formerly interpreted this
as a force-kill request, interrupting Anvil's dump. Meanwhile the shell's EXIT
cleanup could signal role wrappers before the supervisor finished. Shutdown
now treats duplicate requests idempotently, retains deadline-based forced
termination, and waits for the supervisor before owner-recorded cleanup.

The identical live reproduction now saves a valid 3,181,904-byte snapshot.
Restarting that same stand with preserved Runtime/chain data reports healthy
H1/H2/H3 and exactly restores the test contract; the second shutdown also writes
valid state. A permanent real-Anvil regression independently compares contract
code and a mined block's number/hash across reload: one test, five assertions,
20.88 seconds. See `dev-shutdown-result.json` for exact logs and preserved paths.
No mocks or finality bypass were used in this new regression.

This repairs normal dev shutdown, not arbitrary abrupt crashes. The original
`db/dev` inconsistent history and `docs/evidence/archive-tmp/xln-native-release-hGfpwg` truncated
snapshot remain unchanged. Immediate wallet lock during payment is still open.

Final verification for the shutdown fix: related lifecycle tests 30/30 (172
assertions), real-Anvil reload regression 1/1 (5 assertions), full `bun run check`
passed (39 source gates, source phase 40.564 seconds), and `git diff --check`
passed. Logs: `docs/evidence/archive-tmp/xln-dev-shutdown-lifecycle.log` and
`docs/evidence/archive-tmp/xln-shutdown-recovery-final-check.log`. An existing lifecycle test's PID
selection was corrected: its fixture process and the cache-pruner are separate
children, so parsing all PIDs as one number previously produced NaN. The new
snapshot/reload regression uses actual Anvil. No commit, push or deployment.

## Immediate payment lock — 2026-09-18

The real WKWebView/native socket probe reproduced the original failure on a
fresh three-hub stand: confirm a one-USDC payment and immediately lock. The
wallet rejected the hub reply with `INBOUND_ENTITY_RUNTIME_QUIESCING`, causing
H1 to halt under the development fail-fast policy. See `immediate-lock-before.log`.

The shared web/native session shutdown now pauses chain watchers independently,
keeps peer replies admissible while accepted work drains, and only then raises
the persistence fence. Watcher pause state is restored under that fence so a
later resume retains its previous watcher policy. Peer rejection handling and
financial transitions are unchanged.

The same live test passes. A strengthened regression additionally asserts work
is actually pending at lock (active processing and one queued input observed).
Reopening restores the same identity, exactly 99 USDC from 100, one matching
HtlcInitiated/HtlcFinalized pair, no pending account work, and healthy hubs.
See `immediate-lock-result.json` and `immediate-lock-after.log`. Related lifecycle
tests pass 36/36 with 153 assertions; UI typecheck passes.

This is local Anvil evidence through the production TS/native bridge. Delayed
or disconnected peers, forced termination, and native Tron are not proved by
this test. Full `bun run check` passes (39 source gates, 39.231 seconds); the
updated runtime and Swift iOS simulator build pass and were installed on
XLNReleaseAcceptance, iPhone 17 Pro/iOS 26.5. No iPhone 18 simulator is available.
The live regression above uses the real macOS WKWebView/native socket probe;
installation itself is not another iPhone UI test. Logs:
`docs/evidence/archive-tmp/xln-immediate-lock-full-check.log`, `docs/evidence/archive-tmp/xln-immediate-lock-ios-build.log`.

## Delayed peer reply — 2026-09-18

Pausing the actual H1 process for 1,500 ms exposed a second lifecycle bug:
the wallet reported lock complete after 286 ms, before H1 could reply. Local
queues were quiet, but the bilateral proposal remained unfinished. Runtime
drain now also waits for Entity proposals/locked frames/mempools and the
existing indexed queued/pending Account work. This does not scan history,
change financial transitions, or introduce another durable state surface.

The same real-process pause test passes after the fix: lock completed after
1,895 ms, reopened balance was exactly 99 USDC, there was one matching finalized
payment, Account pending work was empty, and the three-hub stand stayed healthy.
The subsequent run compiled the probe from the repository source files below
and independently passed (lock completed after 1,892 ms). These timings are
individual functional observations, not latency benchmarks.

The reusable runner compiles the existing `quote-session.swift` with the iOS app's actual
`NativeSockets.swift`, launches the canonical dev stack under a fresh temporary
data directory, and verifies health after the probe. The paused PID must belong
to that stand's H1 database. Cleanup resumes it before stopping the stand.
No temporary precompiled probe or fake financial service is required:

```sh
bun run stand:status
bun run stand:run --reason native-delayed-lock --timeout-ms 180000 -- \
  bun scripts/native/run-session.ts immediate-payment-lock.js 1500
```

Omit `1500` for immediate lock without a peer pause. The focused signed-Entity
proposal timeout test and related suites pass 43/43 with 181 assertions.
Frozen core is unchanged. See `delayed-lock-result.json`, `delayed-lock-before.log`,
`delayed-lock-after.log`, and `delayed-lock-reproducible.log`. This covers graceful
lock/reopen in the same WebKit host, not force-kill, permanent peer loss, native
Tron, or public-network acceptance.

Final candidate validation: full `bun run check` passes (39 source gates,
39.887-second source phase). The updated runtime/Swift iPhone simulator build
passes and is installed; installed public resources exactly match the build.
No fresh SwiftUI interaction test is implied. Logs:
`docs/evidence/archive-tmp/xln-consensus-drain-final-check.log`, `docs/evidence/archive-tmp/xln-consensus-drain-ios-build.log`.
