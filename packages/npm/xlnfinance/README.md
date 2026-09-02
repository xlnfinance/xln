# xlnfinance

Run the complete xln TypeScript runtime, connect it to the current production
testnet published by `xln.finance`, and open its wallet UI:

```sh
bunx --bun xlnfinance
```

Every normal start refreshes `https://xln.finance/api/jurisdictions`, verifies
the active Arrakis deployment, connects to its RPC and
`wss://xln.finance/relay`, and caches the last verified config for temporary
offline restarts.

Run the isolated, self-contained local development network instead:

```sh
bunx --bun xlnfinance dev
```

Production-testnet and dev state live in separate directories. When invoked
from the root of an xln source checkout, `xlnfinance dev` is exactly `bun run dev`,
and every other root package script maps the same way: `xlnfinance <script>` runs
`bun run <script>` with the remaining arguments unchanged. Repo-only scripts
remain intentionally unavailable outside a source checkout.

For a first login whose BrainVault credentials never enter the browser:

```sh
bunx --bun xlnfinance --derive-cli
```

`--derive-cli` asks only for the BrainVault username and hidden password. It uses
the recommended defaults: factor 4 (1,000 shards), multiplier 1, and every CPU
available to the process. Argon2id runs in the local native node backend. The
mnemonic and signer remain in the node state directory; only the public owner
Entity and a single-use browser capability are sent to the UI.

The daemon listens only on `127.0.0.1:8080`. Closing the browser does not stop
it. State is stored with owner-only permissions in the platform state directory.

Commands:

```text
xlnfinance [start|dev|daemon|open|status|stop|logs|version] [--derive-cli]
```

Global installation also exposes `xlnd` as a short binary alias. The canonical
npm package and `bunx` command are `xlnfinance`.

The package currently ships the canonical TypeScript runtime. There is no
`--rs` switch until the Rust runtime can provide the same complete daemon,
storage, custody, and browser protocol without changing semantics.
