# XLN Native Wallet Product Plan

## Non-negotiable Architecture

XLN Wallet is local-first and self-custodial by default. The TypeScript runtime is the single source of truth across browser, iOS, Android, desktop, and future extension surfaces. Server infrastructure may relay frames, notify users, provide discovery, and act as a watchtower, but it must not hold spend-capable user keys in the default consumer product.

The runtime split is:

- `runtime/*`: deterministic protocol/runtime code; avoid platform forks.
- `frontend/*`: shared wallet UI and runtime adapter wiring.
- `frontend/ios` and `frontend/android`: Capacitor native shells.
- `native/desktop`: Electron shell for always-on desktop wallet behavior.
- `native/extension`: browser companion for `xln://` links and wakeups, not a default key store.
- `scripts/native/build-platforms.ts`: one build entrypoint for selective or all-platform assembly.

## Background And Wake Model

iOS and Android should not pretend they can run an unrestricted wallet daemon forever in the background. The product model is:

1. Incoming payment/update lands at relay/watchtower/counterparty.
2. Relay sends APNs/FCM push with no private key material.
3. User opens the wallet from the push to inspect, sign, accept, reject, or settle.
4. The local runtime verifies the full frame/proof before any state transition.
5. If the user is offline too long, 24h liveness reminders ask them to open the wallet.
6. Desktop Electron can stay alive in the background and provide stronger always-on liveness.
7. Future watchtower delegation can use receive-only or narrowly scoped Hanko permissions, never an unrestricted spend key.

## First Apps

1. **iOS and Android wallet**
   - Same shared Svelte/TypeScript wallet UI.
   - Local runtime inside the app webview.
   - Key storage target: iOS Keychain/Secure Enclave adapter, Android Keystore adapter.
   - Push: APNs/FCM wake notifications for pending payments and 24h liveness.
   - Deep links: `xln://pay`, `xln://invoice`, `xln://runtime`, `xln://app`.

2. **Desktop wallet/daemon**
   - Electron shell around `frontend/build`.
   - Runs from the same UI/runtime artifact.
   - Keeps process alive when window closes.
   - Handles `xln://` links and local desktop notifications.
   - Good first test target on Mac Studio without Apple mobile signing.

3. **Browser extension companion**
   - Opens `xln://` payment links into local wallet.
   - Receives external wake messages from trusted web surfaces.
   - Does not hold default wallet signing keys until isolated signing/storage is audited.

4. **Merchant checkout and POS**
   - Payment request links/QRs for any EVM token supported by XLN.
   - Invoice expiry, partial fill policy, settlement chain preference, and fee visibility.

5. **Watchtower/relay**
   - Stores pending envelopes and liveness proofs.
   - Pushes wake notifications.
   - Publishes verifiable state/proof availability.
   - Optional scoped delegate only after permissions are explicit and revocable.

## Product-Market-Fit Bets

- Instant EVM token payments through bilateral credit, with on-chain settlement as fallback.
- Receive-any-token invoices: merchant names amount/token/chain, payer routes through XLN.
- Safer default than exchange wallets: keys stay local, watchtower only wakes and proves.
- Desktop always-on mode for power users, market makers, merchants, and operators.
- Mobile push-to-accept for normal users who do not want a server wallet.
- Contact-scoped limits: "Alice can request up to 100 USDC/day, auto-accept below 10 USDC."
- Payment intents with proof previews: user sees exact route, credit exposure, collateral, expiry, and settlement path before signing.
- Token/chain scope controls for all EVM tokens: allowlist, denylist, per-token limits, per-counterparty limits.
- Merchant no-chargeback profile: invoice state is cryptographically final at XLN layer, with optional on-chain exit.

## Next Implementation Prompt

Use this prompt for the next coding pass:

```text
You are implementing the XLN self-custodial native wallet. Do not fork or rewrite runtime/*.

Goal:
Build the iOS/Android/desktop wallet from the same TypeScript runtime and shared frontend. Keys must remain local by default. Servers may relay, notify, discover, and watch, but must not hold spend-capable keys.

Tasks:
1. Wire native secure storage adapters:
   - iOS: Keychain/Secure Enclave-backed storage for wallet seed/session keys.
   - Android: Keystore-backed storage.
   - Desktop: encrypted OS keychain where available, file fallback only with explicit warning.
2. Add a runtime wake contract:
   - pending payment envelope payload shape;
   - APNs/FCM payload with no private material;
   - local verification before accepting/signing;
   - 24h liveness reminder policy.
3. Connect mobile notification permission UI:
   - opt-in push token registration;
   - token upload to user-selected relay/watchtower;
   - local notification fallback for dev.
4. Add payment intent UX:
   - xln://pay and xln://invoice links;
   - QR generation and scanning;
   - accept/reject/sign screens;
   - token, chain, route, credit, collateral, and expiry preview.
5. Keep the build pipeline:
   - bun run native:mobile for iOS+Android;
   - bun run native:desktop for Mac desktop testing;
   - bun run native:extension for companion extension;
   - bun run native:all for everything.
6. Add tests:
   - runtime adapter parity stays green;
   - no server-held spend key path;
   - notification payload cannot mutate state without local verification;
   - xln:// links route to wallet payment intent.

Acceptance:
- `bun run native:mobile` syncs iOS and Android.
- `bun run native:desktop:smoke` launches and exits Electron successfully.
- The app opens `/app` by default on native shells.
- Existing runtime tests are not weakened.
```
