# XLN Browser Extension Companion

This is intentionally a companion, not a default key-holding wallet. The first
extension surface opens `xln://...` payment links and can wake the local mobile
or desktop wallet. Keeping signing keys out of a broad browser-extension context
is the safer default until the extension has isolated signing, audited storage,
and permission minimization.

Build from the repo root:

```sh
bun run native:extension
```

Load `native/extension/dist` as an unpacked extension in Chromium-based browsers.
