# Contributing

Arrival is 0.x. The API is still settling. **Issues are welcome. We are not yet optimizing for external pull requests.**

A useful issue states: what you ran, what you expected, what happened, and a short reproduction (Scheme source or a TypeScript `exec(...)` snippet). Security reports go to [SECURITY.md](./SECURITY.md), not the public tracker.

## Develop

Node `>=22`, pnpm `10.3.0`.

```bash
git clone --recurse-submodules https://github.com/here-build/arrival.git
cd arrival
pnpm install
pnpm build
pnpm test
```

`--recurse-submodules` is required for the Chibi-scheme R7RS conformance corpus (gitlink-pinned; `pnpm install` sparse-checkouts the working tree to the two files the harness reads). A clone without it still builds; those tests skip.

This repository is a pnpm workspace of `@inhuman.tools/arrival*` packages. `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm format:check` run the turbo pipeline (and Prettier) across them. CI on `main` and pull requests runs format, lint, typecheck, and test against a frozen lockfile.

Every package uses the same floor: `@here.build/eslint-configs` (`nodejs`; the Ink CLI uses `shared`) plus the overlay in `eslint.arrival.mjs`, and `@here.build/tsconfig` (`purpose/lib` with `env/node` or `env/browser`). Prettier config lives at the repo root.

## License

Contributions are MIT, same as the rest of this repository. See [LICENSE.md](./LICENSE.md).
