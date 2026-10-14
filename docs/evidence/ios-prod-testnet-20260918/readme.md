# Physical iPhone public-testnet demo preparation

Outcome: a real payment through the SwiftUI iPhone simulator passed; physical
installation and payment on the public deployment remain blocked.

## Exact asset headlines on native and web

The main Home headline now shows the selected asset's exact committed balance,
with payment capacity in the same token. The unsupported aggregate dollar
valuation was removed from the native snapshot and from React Home. No new
pricing source or financial formula was introduced. EN/RU copy distinguishes
payment capacity, which can include credit, from owned balances.

Native acceptance passed on iPhone 17 Pro / iOS 26.5 in 97.170 seconds:
the real 25-USDC swap filled, its receipt matched both balances, and selecting
WETH changed the headline from 75.000001 USDC to 0.0099970002 WETH. Both menu
implementations left the menu open during the initial selection tests; the
canonical UI now uses a native asset-selection sheet with full-width rows.
Log: `docs/evidence/archive-tmp/xln-balance-sheet-e2e.log`; stand:
`/var/folders/zq/fvt20j1s0fx3v9c8l41czctr0000gn/T/xln-native-session-jyo189`.

The real Chromium swap regression also passed, comparing both selected
headlines with committed account balances through independent base-unit
conversion. No page/auth errors. Final browser run plus startup/shutdown:
32.4 seconds, exit zero, stand released. Log: `docs/evidence/archive-tmp/xln-web-balance-final.log`.
Playwright now requests graceful dev-launcher shutdown, so it can stop its
separately owned service groups; the initial default shutdown required targeted
cleanup. Its temporary data directory must exist before launching the stand:
macOS Bash currently rejects the launcher's empty-array expansion for a missing
data root. That separate launcher limitation was not changed here.

Artifacts: `output/ios-balance-2026-09-18/swap-demo.mp4` (44.417-second excerpt),
full recording, native screenshots under `attachments/`, and
`web-weth-balance.png`. Native and web screenshots were visually inspected.
Web allocation charts still use the existing fixed reference table and are
explicitly labeled as reference prices, not live market value. A live portfolio
valuation remains unimplemented; the new headline does not imply one.

Final validation: UI TypeScript check passes, unsigned physical-device build
passes with both bundled origins `https://xln.finance`, and `bun run check`
passes all 39 source gates (44.801-second source phase). Logs:
`docs/evidence/archive-tmp/xln-balance-device-final.log`, `docs/evidence/archive-tmp/xln-balance-final-check.log`.
Whitespace check passes and stand is free. A fresh device/signing inspection
still finds only simulators and zero valid signing identities; no install claim.

## Native swap UI acceptance

`PaymentUITests/testMarketSwap` passed through the real iPhone 17 Pro simulator
UI on iOS 26.5 in 89.866 seconds. The isolated local stand includes the real
market maker and three hubs; health remained green and cleanup released the lock.
The UI created/funded a BrainVault, reviewed a 25-USDC swap, explicitly authorized
unsecured test receiving capacity, confirmed, opened the filled order and checked
both balances against the receipt using exact decimal arithmetic.

- Debited: 24.999999 USDC; final USDC: 75.000001.
- Gross received: 0.009998 WETH; fee: 0.0000009998 WETH.
- Net received/final WETH: 0.0099970002.
- Closed order: `swap-mu6g68vn-7-06tdl4q1ecjzz`; confirmed frame 7.
- Video: `output/ios-swap-2026-09-18/swap-demo.mp4` (39.039 seconds);
  full recording and five screenshots are beside it.

Runner: `bun run stand:run --reason native-swap-ui-exact-receipt --timeout-ms
180000 -- bun scripts/native/run-session.ts ios-ui-swap`. It requires the local
runtime bundle compiled into `docs/evidence/archive-tmp/xln-ios-ui-derived` and the English simulator
keyboard. Log: `docs/evidence/archive-tmp/xln-ios-swap-ui-final.log`; data:
`/var/folders/zq/fvt20j1s0fx3v9c8l41czctr0000gn/T/xln-native-session-6sFBsD`.
The first run reached an actual fill but its assertion searched for `Closed`
instead of the exposed accessibility label `Status, Closed`; only the test
selector/navigation and exact receipt comparisons changed. No financial fix or
mock was needed. Production API/recovery resources were restored afterward.
Final `bun run check` passes all 39 source gates (44.248-second source phase),
`git diff --check` passes, and the stand is free. Log:
`docs/evidence/archive-tmp/xln-ios-swap-check.log`.

Observed product gap: the $109.99 headline after swapping from 100 USDC uses
the shared frontend's fixed WETH reference price ($3,500), while this test market
trades near $2,500. Token balances and swap accounting are exact; that estimated
headline is not trading profit or a live portfolio valuation. Source:
`frontend/src/lib/utils/assetPricing.ts`. Live valuation or removal of that
aggregate estimate remains required before production-quality presentation.
This run does not prove public-testnet, physical-device or cross-chain swaps.

## Latest: SwiftUI payment with independent recipient verification

The iPhone 17 Pro simulator on iOS 27 completed normal wallet creation,
funding, invoice review, confirmation and the Activity receipt in 81.341 seconds.
The complete isolated stand took 105.889 seconds and exited successfully.
It used the canonical TS Runtime, real local three-hub services, recovery tower,
custody and Anvil chains. No financial mocks or wallet-only test hooks were used.

- Funding: 100 test USDC; recipient credit: 1.000001; fee: 0.000001.
- Sender final balance: 98.999998 USDC.
- Custody independently confirmed finalized receipt `deposit:26:0` for
  `usr_f4352b9e4a54437eafdd`; see [receipt](ios-ui-custody-receipt.json).
- Genuine invoice text was entered through the native Send screen. Camera QR
  capture and a physical-device transaction are not covered by this run.
- Recovery work was explicitly set to six shards in visible settings for the
  test wallet; this does not measure default-work derivation performance.

Artifacts: `output/ios-payment-2026-09-18/payment-full.mp4` (86.055 seconds),
`payment-demo.mp4` in the same directory (34.279-second excerpt), and screenshots
under `attachments/`. Full log: `docs/evidence/archive-tmp/xln-ios-ui-e2e-7.log`. Stand data:
`/var/folders/zq/fvt20j1s0fx3v9c8l41czctr0000gn/T/xln-native-session-vrNfmX`.

This work fixed an iOS 27 launch failure by adopting UIKit's scene lifecycle,
separated password entry and confirmation, and collapsed payment route choices
so the Confirm action remains accessible. The focused iOS 27 password test also
passed mismatch rejection, returning to the entered password and clearing it
when backgrounded (27.511 seconds). The same regression passed on iOS 26.5 in
28.285 seconds. The initial iOS 26.5 failure was isolated to the simulator's
Russian keyboard while XCTest injected English characters. Selecting English
and restarting that simulator fixed the test with the existing app code;
experimental field substitutions were reverted. The English UI test requires
an English simulator keyboard; setting the app locale does not change it.
This does not establish Russian keyboard or password-manager coverage.

The complete iOS 26.5 UI payment then passed in 92.977 seconds, including the
updated Confirmed receipt and background lock of the funded wallet. Independent
custody verification confirmed 1.000001 USDC for `usr_fe10be0a78aa498f95e8`;
see [iOS 26.5 receipt](ios26-ui-custody-receipt.json). Full stand: 114.975 seconds,
exit zero, lock released. Log: `docs/evidence/archive-tmp/xln-ios26-payment-final.log`. The recording
and six screenshots are under `output/ios-payment-2026-09-18/ios26/`.
Production API/recovery resources were restored to `https://xln.finance` after
the local runs; test products remain isolated in `docs/evidence/archive-tmp/xln-ios-ui-derived`.

Final candidate: unsigned device compilation passes, and `bun run check`
passes all 39 source gates (43.713-second source phase). `git diff --check`
passes and the stand is free. Logs: `docs/evidence/archive-tmp/xln-ios-final-device-build.log` and
`docs/evidence/archive-tmp/xln-ios-final-check.log`. Device artifact:
`docs/evidence/archive-tmp/xln-ios-prod-testnet-device/Build/Products/Debug-iphoneos/App.app`.
This artifact has the verified public API/recovery origins but cannot be
installed until device signing is configured. The latest 51.1-second video
excerpt is `output/ios-payment-2026-09-18/ios26/payment-demo.mp4`.

Fresh device inspection still finds only simulators and zero valid signing
identities. Public health still reports `coreOk=false` and `systemOk=false`.
No production state was reset, migrated or deployed by this work.

The earlier sections below describe prior candidates and checks; they are not
additional coverage of this UI run.

## Latest: native invoice-to-custody payment and simulator launch

Xcode is now version 27.0 (27A266a); its license blocker has cleared. Both device
and simulator compilation pass with the QR scanner. The physical device list
currently contains only simulated devices, and Xcode Apple Accounts shows no
signed-in account. There are still zero valid physical-device signing identities.

The real local integration passed through the production native WebKit host,
native socket transport, canonical TS Runtime and custody service:
- Invoice: 1.000001 test USDC, credited to `usr_f8bccfb44faf4f7cb8fa`.
- Quoted and actual debit: 1.000002 USDC; fee: 0.000001 USDC.
- Sender balance: 100 → 98.999998 USDC; custody balance: 0 → 1.000001 USDC.
- Modified invoice amount, modified recipient and duplicate confirmation reject.
- Custody receipt `deposit:11:0` is finalized, with matching attribution and
  hashlock `0x01c6a7504a980c01d6ceb6714bae4586e46340cde91264430fb8a83b608a4fb0`.
  Full receipt: [local-qr-custody-receipt.json](local-qr-custody-receipt.json).
- Local system health remained green; the stand shut down and released its lock.

This run uses real local services and Anvil test chains. It does not prove
physical camera capture, an iOS UI payment or payment on xln.finance. The test
delivers the genuine custody invoice payload to the native command bridge.
The reusable runner is `bun run stand:run --reason native-qr-real-custody-payment
--timeout-ms 180000 -- bun scripts/native/run-session.ts payments/qr-payment.js`.
Log: `docs/evidence/archive-tmp/xln-native-qr-custody-e2e.log`. Data:
`/var/folders/zq/fvt20j1s0fx3v9c8l41czctr0000gn/T/xln-native-session-NNXZEE`.

This run found and fixed a real integration failure: custody uses catalog key
`arrakis`, whereas the wallet displays `Testnet`. Native invoice validation now
resolves catalog keys only where both chain ID and depository match the active
wallet. A matching display name on another chain or contract does not qualify.

The app is installed and running on the iPhone 17 Pro simulator named XLN Release
Acceptance (iOS 26.5). The first unsigned simulator build exposed Keychain error
-34018. Rebuilding with ordinary simulator signing resolved it; no Keychain
fallback or error suppression was introduced. Current launch screenshot:
`output/ios-qr-2026-09-18/launch-signed.png`. Physical build remains unsigned.

Final verification: 14 focused tests / 63 assertions; UI TypeScript check green;
full `bun run check` green (39 source gates, 41.872-second source phase). An
additional standalone strict check of the older native stand runner reports
existing `scripts/dev/run-dev.ts` optional-port and process signal typing errors,
plus its existing signal cleanup calls in `scripts/native/run-session.ts`.
That extra check is not green; the actual stand and its cleanup completed.

Earlier license and unsigned-scanner limitations below are historical.

## Scan-to-pay follow-up

The prior unsigned `App.app` predates this change; it is not an installable or
camera-tested QR payment artifact. The current device build stops at Xcode's
unaccepted license (exit 69), and signing still reports zero valid identities.
The Xcode license dialog is now open successfully. Earlier GUI launch failures
below are historical.

Source now includes a native VisionKit QR scanner under Send, camera permission
handling, payment-link entry, and a review-only invoice draft. It reuses the web
invoice parser. The request's custody `uid:` attribution is retained in the
quoted payment description and passed through the canonical payment command.
Specified asset and amount are locked in the draft and revalidated before
quoting; reading a new request invalidates the previous quote. Scanning does
not submit a payment.

A failing regression exposed token `1.5` silently becoming token `1` in the
shared invoice parser. It now rejects invalid token IDs, duplicate payment
fields and overlong amount/custody/network fields instead of rounding or
truncating them.

Verification completed:
- 13 focused tests / 60 assertions, including exact amounts, locale handling,
  custody attribution, unsupported networks/assets and malformed invoices.
- UI TypeScript check, bundled iOS runtime build, Swift syntax parsing and
  Xcode-project/plist syntax checks pass. Syntax parsing is not iOS compilation.
- Real Chromium imports the production modules through Vite at port 8080:
  custody draft matches, invalid fractional token rejected, zero page errors.
- Full `bun run check` passes: 39 source gates, 41.022-second source phase.
  The first run caught the app directory's file-count limit; the scanner was
  moved into `payment/`, then the full check passed without weakening the rule.
  Log: `docs/evidence/archive-tmp/xln-native-qr-final-check.log`. Stand released; diff whitespace clean.

Logs: `docs/evidence/archive-tmp/xln-native-qr-tests.log`, `docs/evidence/archive-tmp/xln-native-qr-types.log`,
`docs/evidence/archive-tmp/xln-native-qr-runtime-build.log`, `docs/evidence/archive-tmp/xln-native-qr-browser.log`,
`docs/evidence/archive-tmp/xln-native-qr-device-build.log`.

Still required: native compilation, camera permission/scan tests on the phone,
signed installation and an actual public-testnet payment receipt. Fresh public
health still reports `coreOk=false`, `systemOk=false` and `HUB_MESH_NOT_READY`.
No production mutation or payment was performed in this follow-up.

Subsequent read-only inspection confirms the same deployed SHA and the same
three hub frame-head failures (10,313,244 / 13,336,516 / 13,336,514 bytes against
5,666,667). The process manager has accumulated 4,876 server restarts. This is
an existing restart loop, not a missing camera feature or a successful recovery.
Health and filtered process metadata are saved in
`docs/evidence/archive-tmp/xln-native-payment-service-health.json` and
`docs/evidence/archive-tmp/xln-native-payment-service-processes.json`. Recovery/reset authorization
and Xcode setup remain unresolved; no remote files or services were changed.

Latest owner-confirmation recheck: `xcrun devicectl list devices` exits 69 because
the Xcode license is unaccepted. Current device reachability therefore cannot be
revalidated; the earlier unavailable status is historical. Signing inspection
still reports zero valid identities. The owner was asked to finish first-launch
setup and Apple-account signing. Fresh public `/api/health` returns HTTP 200 but
`coreOk=false` and `systemOk=false`, including `HUBS_NOT_READY` and
`MARKET_MAKER_CHILD_INACTIVE`. No physical install or public payment is claimed.

- Artifact: `docs/evidence/archive-tmp/xln-ios-prod-testnet-device/Build/Products/Debug-iphoneos/App.app`.
- Bundle: `finance.xln.wallet`, native SwiftUI with the canonical TS Runtime in WebKit.
- Both bundled API and recovery origins are `https://xln.finance`.
- Compilation command: `xcodebuild -project frontend/ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath docs/evidence/archive-tmp/xln-ios-prod-testnet-device -disableAutomaticPackageResolution CODE_SIGNING_ALLOWED=NO build`.
- Signed build fails: development team is required. `security find-identity -v -p codesigning` reports zero valid identities. An unsigned build is not installable acceptance.
- Known iPhone 17 Pro remains unavailable. CoreDevice lock-state request fails with error 1011; direct USB registry shows display/hubs but no iPhone. Owner reports USB connected, unlocked and Developer Mode enabled; the host observations still disagree.
- Xcode first-launch component setup was attempted. GUI relaunch reports `kLSIncompatibleApplicationVersionErr` (-10664); CLI compilation works. No credential was requested or read.

## Public service blocker

Read-only SSH and public health inspection found deployed SHA
`4dfabd621b913e9e79da315f33d21a1b9708778b` repeatedly failing hub startup.
Errors: `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:10313244:5666667`,
`13336516:5666667`, and `13336514:5666667` across H1/H2/H3.
The process manager showed 4,821 prior server restarts at inspection. This count
is existing operational evidence, not restarts initiated by this task.

Tower health is green. `/api/jurisdictions` advertises active EVM chains 31337 and
31338; the latter simulates Tron. Native Tron Nile and Ethereum Sepolia are pending.
No public financial transaction, production restart/reset or deployment was performed.

## Validation

Full `bun run check` passes, 39 source gates, 40.030-second source phase.
`git diff --check` passes; heavy stand released.

Logs on this Mac:
- `docs/evidence/archive-tmp/xln-ios-prod-testnet-runtime-build.log`
- `docs/evidence/archive-tmp/xln-ios-prod-testnet-device-build.log` (signing failure)
- `docs/evidence/archive-tmp/xln-ios-prod-testnet-device-compile.log` (unsigned compilation pass)
- `docs/evidence/archive-tmp/xln-ios-prod-testnet-check.log`
- `docs/evidence/archive-tmp/xln-prod-testnet-health.json`
- `docs/evidence/archive-tmp/xln-prod-testnet-jurisdictions.json`
- `docs/evidence/archive-tmp/xln-prod-testnet-tower-health.json`

Next: establish actual device connectivity and valid signing, then install. A
successful payment additionally requires repairing the production hub failure
and validating compatibility with its deployed Runtime; compilation alone proves neither.

## Upgrade diagnosis follow-up

The deployed protocol's frame limit is 10,000,000 bytes; current committed code
uses 100,000,000. The existing catch-up test now also covers a 150,000-block empty
prefix. Both prefix lengths pass; the full suite passes 19 tests / 141 assertions.
This is deterministic consensus coverage, not a replay of the production database.

Production source uses storage schema 7, current source schema 5, and current
contracts differ. A code-only upgrade cannot be presumed compatible. An owner
decision on archiving/rebuilding the public testnet is pending; no reset occurred.
Remote state sizes: JDB 680 MB, hub mesh 6.7 GB, tower 356 KB; remote free disk
8.6 GB. No backup has yet been taken. The canonical release preflight also rejects
the dirty shared source tree; unrelated changes must not be silently published.

Full repository check after the new test passes (39 source gates, 41.711-second
source phase), log `docs/evidence/archive-tmp/xln-release-recovery-final-check.log`. Physical device
access remains unavailable, and signing identity count remains zero.
