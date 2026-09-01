# xlnd

Run the complete local xln TypeScript runtime and open its wallet UI:

```sh
bunx --bun xlnd
```

For a first login whose BrainVault credentials never enter the browser:

```sh
bunx --bun xlnd --derive-cli
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
xlnd [start|daemon|open|status|stop|logs|version] [--derive-cli]
```

The package currently ships the canonical TypeScript runtime. There is no
`--rs` switch until the Rust runtime can provide the same complete daemon,
storage, custody, and browser protocol without changing semantics.
