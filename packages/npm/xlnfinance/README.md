# xlnfinance

Run a persistent local xln runtime and open its wallet UI in your system browser:

```sh
bunx xlnfinance
```

The runtime listens only on `127.0.0.1:8080`. The launcher opens
`http://localhost:8080/app`, exchanges a single-use pairing token for full admin
runtime control, and removes the pairing token from browser history. Closing the
browser does not stop the runtime.

Fresh installs create one deterministic local owner entity before the daemon reports
ready. Its seed and signer remain in the node runtime; the browser controls it through
the paired admin capability.

Commands: `daemon`, `open`, `status`, `stop`, `logs`, `update`, and `version`.
