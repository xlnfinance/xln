# XLN Browser Extension Companion

This is intentionally a companion, not a key-holding wallet. The first extension
surface opens `xln://...` payment links and can wake the local mobile or desktop
wallet. Keeping signing keys out of a browser-extension context is the safer
default until the extension has isolated signing, audited storage, and permission
minimization.

External messages are accepted only from the production XLN origin and local dev
origins. The companion stores and opens only `xln://` URLs; arbitrary web URLs in
incoming wake messages are ignored.

Build from the repo root:

```sh
bun run native:extension
```

Load `native/extension/dist` as an unpacked extension in Chromium-based browsers.
