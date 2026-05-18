# XLN Desktop Shell

Electron wrapper for the same `frontend/build` artifact used by mobile shells.

Run from the repo root:

```sh
bun run native:desktop
```

The shell binds a static server to `127.0.0.1`, loads `/app`, keeps the wallet running when the window is closed, and supports `xln://...` links plus local payment-wake notifications. It does not move keys to a remote server.
