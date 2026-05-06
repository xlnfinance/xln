# XLN npm name reservations

Minimal publish-only packages used to reserve public npm names for XLN.

These packages intentionally do not bundle the runtime. They provide tiny CLI
stubs so the names can be claimed safely before the real installer/CLI is ready.

Publish after `npm adduser`:

```sh
./scripts/npm-reserve-names.sh
```

Dry-run:

```sh
./scripts/npm-reserve-names.sh --dry-run
```

