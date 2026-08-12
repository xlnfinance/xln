# xlnfinance

Run a persistent local xln runtime and open its wallet UI in your system browser:

Install and run the exact versioned GitHub Release archive linked from
`https://xln.finance/install`; do not resolve a mutable registry tag.

The runtime listens only on `127.0.0.1:8080`. The launcher opens
`http://localhost:8080/app`, exchanges a single-use pairing token for full admin
runtime control, and removes the pairing token from browser history. Closing the
browser does not stop the runtime.

Fresh installs create one deterministic local owner entity before the daemon reports
ready. Its seed and signer remain in the node runtime; the browser controls it through
the paired admin capability.

When BrainVault is used from this paired UI, Argon2 runs through the native node
backend and the resulting signer is stored in the node state directory with owner-only
permissions. Normal recovery returns only the public address/entity and timing. The
mnemonic crosses into the browser only after the separate **Show mnemonic** action.

Commands: `daemon`, `open`, `status`, `stop`, `logs`, and `version`.

The launcher does not install mutable tags. Upgrade by installing the exact versioned
GitHub Release archive shown on the xln install page after verifying its release manifest.
