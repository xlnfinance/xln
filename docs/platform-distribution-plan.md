# xln platform distribution plan

Status snapshot: 2026-07-22.

## Current state

| Surface   | Existing code                                              | Distribution today                                            | Main blocker                                                              |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Web       | Full wallet at `/app`                                      | Public                                                        | Mutable server-delivered code is an unavoidable trust boundary            |
| Bun CLI   | Four local package placeholders                            | None; npm registry returns 404 for every proposed xln package | Implement a real launcher, claim/publish a package, add provenance        |
| Desktop   | Hardened Electron shell and macOS `.app` packager          | Source/build preview only                                     | Signed installers, notarization, Windows/Linux builders, verified updates |
| iOS       | Capacitor shell, Xcode project, deep links, notifications  | Local debug build only                                        | Apple team signing, entitlements, archive/export, TestFlight              |
| Android   | Capacitor shell, Gradle project, deep links, notifications | Local debug APK only                                          | Release keystore, AAB, Play Console internal testing                      |
| Extension | MV3 keyless companion                                      | Unpacked Chromium build only                                  | Store packaging/review, Firefox port, Safari wrapper                      |

The npm name `xln` is already used by an unrelated package. The intended short command is therefore:

```sh
bunx xlnfinance@<version>
```

Do not publish the current `0.0.0` placeholders. They print reservation messages and are not installers.

## Distribution contract

Every public channel must be produced from the same immutable commit and version. A generated release manifest should contain:

- commit SHA, version, build timestamp, minimum OS versions, and runtime/frontend hashes;
- artifact URLs, byte sizes, SHA-256 hashes, and detached signatures;
- signing identity or certificate fingerprint for each platform;
- release notes and an explicit security status (`preview`, `signed-beta`, or `stable`).

The install page must derive availability from this manifest at build time. Missing artifacts fail the release; the UI must never turn a source directory into a download claim.

## Phase 1: reproducible release foundation

1. Add a deterministic release job that builds the browser bundle once and feeds the identical artifact to Electron, Capacitor, and the extension.
2. Generate SBOM, SHA-256 hashes, signed provenance, and `distribution.json` from the immutable release commit.
3. Attach artifacts and manifest to a GitHub Release. Keep the public web app versioned at an immutable path for auditability, while explicitly retaining the mutable-origin warning.
4. Gate release on native unit tests, browser screenshots at iPhone/laptop/wide sizes, package smoke tests, and `bun run check`.

Exit: a release can be identified, reproduced, and verified before any store upload.

## Phase 2: Bun and Electron

### Bun CLI

1. Replace `packages/npm/xlnfinance` with a real, fail-fast launcher.
2. Make the launcher resolve an explicit version, verify the signed release manifest and artifact hash, install locally, then launch xln. Never execute mutable Git `main` as an install path.
3. Publish `xlnfinance` with npm provenance and public access; test `bunx xlnfinance@<version>` on clean macOS, Windows, and Linux machines.
4. Keep `create-xln`, `xln-cli`, and `@xln/cli` unpublished until each has a distinct real purpose.

### Electron desktop

1. Retain the current loopback-only static server, sandboxed renderer, isolated preload bridge, deny-by-default permissions, and `xln://` handling.
2. Add a cross-platform Electron packager (Electron Forge is the recommended default) without replacing the existing security boundary.
3. Produce signed macOS DMG/ZIP, Windows MSIX or installer, and Linux AppImage plus deb/rpm artifacts.
4. Configure macOS hardened runtime/notarization and Windows Authenticode. Add signed update metadata; never trust an unsigned update feed.
5. Test install, upgrade, downgrade rejection, deep links, notifications, single-instance behavior, offline startup, and uninstall on every OS.

Exit: all desktop buttons point to signed release artifacts and show version plus hash.

## Phase 3: iOS and Android

### Apple

1. Configure the Apple team, production bundle identifier, capabilities, universal/deep links, push environment, privacy manifest, and export options.
2. Archive the existing Capacitor app from CI, upload to App Store Connect, and release through an internal TestFlight group first.
3. Verify fresh install, upgrade, background wake, recovery, biometric/device-lock interaction, and iPhone/iPad layouts.

### Android

1. Create an offline-protected release keystore, configure signing outside the repository, and build an Android App Bundle.
2. Publish to Google Play internal testing, then closed testing, with data-safety declarations and deep-link verification.
3. Test fresh install, upgrade, backup-disabled storage, notification permission, recovery, and representative API levels.

Exit: TestFlight and Play internal links are real, versioned, and exercised by release QA.

## Phase 4: browser extensions

1. Preserve the extension as a keyless companion until isolated signing/storage has its own threat model and audit.
2. Add a minimal popup that reports the connected local wallet, requested permissions, and exact companion version.
3. Package and submit MV3 builds to Chrome Web Store and Edge Add-ons with the current origin allowlist and zero host permissions.
4. Port the constrained API surface to Firefox. Build Safari Web Extension packaging through the signed Apple app rather than expanding browser privileges.
5. Add store-policy documents, permission justifications, wake/deep-link integration tests, and update compatibility tests.

Exit: store links replace source links; the extension still holds no wallet signing keys.

## Readiness labels

- **Available now:** a public artifact or URL works for users today.
- **Build preview:** source and local build path pass focused tests, but no signed public artifact exists.
- **Signed beta:** public signed artifact exists in a staged channel such as TestFlight or Play internal testing.
- **Stable:** signed distribution, update path, recovery flow, and platform-specific release gates are green.

No channel advances by copy change alone. Its label changes only when the corresponding artifact and evidence exist.
