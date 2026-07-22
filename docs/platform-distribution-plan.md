# xln distribution

Snapshot: 2026-07-22. Product name: **xln finance**. Package name: `xlnfinance`.

## Release contract

Every artifact comes from one tagged commit and one version. `release/channels.json`
defines the channels; `bun run release:manifest` records each downloadable asset,
byte size, SHA-256 hash, commit, tag, and immutable GitHub Release URL.

No unsigned build is presented as trusted. Web delivery always retains the fundamental
mutable-server warning. Release gates are L1 tests, targeted browser/native flows,
screenshots at iPhone/laptop/wide viewports, and `bun run check`.

## Surfaces

| Surface | Build | Distribution | Update path |
| --- | --- | --- | --- |
| Web | Static `/app` | `xln.finance/app` | Reload; server code remains mutable |
| Local runtime | Bun daemon + static wallet | `bunx xlnfinance` | `bunx xlnfinance update` |
| Desktop | Hardened Electron shell | GitHub Releases, then signed installers | Signed release feed |
| iPhone/iPad | Capacitor iOS | TestFlight, then App Store | App Store |
| Android | Capacitor Android | APK + Play internal testing | Google Play |
| Chrome | Complete MV3 wallet | Unsigned ZIP, then Chrome Web Store | Chrome Web Store |

## Local runtime security and parity

The launcher creates stable local runtime/auth seeds, starts a loopback-only Bun daemon,
and opens `http://localhost:8080/app` with a one-time 60-second pairing token. The token
is exchanged same-origin for a short-lived `full` capability; the browser receives
`access: admin`, never the persistent daemon control secret.

On first start the daemon derives its local owner signer from the node seed and commits
one deterministic lazy entity before reporting ready. The signer key stays in the node;
the browser receives the projected entity and admin action surface, never the seed.

The daemon survives browser and terminal closure. Embedded and remote wallets share the
same `RuntimeAdapter` contract for reads, payments, accounts, swaps, entity/settings
commands, cross-jurisdiction intent, history, and admin chain verification. Browser QA
proves a profile write through remote admin, daemon restart, reconnect, and persisted
height/state. Direct BrowserVM trie mutation is a developer backdoor, not a wallet
capability, and is not exposed over remote admin RPC.

## Platform work

### Desktop

- Produce macOS ZIP/DMG, Windows installer, and Linux AppImage/deb from the same web bundle.
- Sign/notarize macOS and Authenticode-sign Windows before enabling automatic install.
- Reject downgrade and unsigned update metadata; test offline start, native links, and upgrade.

### Mobile

- Apple: enroll, configure the signing team and privacy metadata, archive in CI, upload to TestFlight.
- Android: create an offline release keystore, build AAB, publish to Play internal testing.
- Test recovery, deep links, notification permissions, fresh install, and upgrade on real devices.

### Chrome

- Keep Chrome-only MV3 packaging. No Firefox, Safari, or Edge scope.
- Upload the same tested ZIP to Chrome Web Store for signed delivery and automatic updates.
- Keep signing keys in the wallet vault/runtime; never in extension storage or service-worker messages.

## Accounts required

- npm account and trusted publisher for `xlnfinance`.
- Apple Developer Program and App Store Connect.
- Google Play Console developer account.
- Chrome Web Store developer account.
- macOS Developer ID/notarization credentials and a Windows code-signing certificate.

GitHub Releases and unsigned Chrome ZIPs need none of those store accounts and can ship first.
