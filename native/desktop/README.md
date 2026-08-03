# xln finance desktop

Electron wrapper for the wallet surface declared by the same strict frontend
release manifest used by mobile and extension shells. The native pipeline
validates every wallet asset hash before preparing `.native-wallet-build`.

Run from the repo root:

```sh
bun run native:desktop
```

The shell binds a static server to `127.0.0.1`, loads `/app`, keeps the wallet running when the window is closed, and supports `xln://...` links plus local payment-wake notifications. It does not move keys to a remote server.
