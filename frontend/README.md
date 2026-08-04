# xln frontend

The canonical frontend is React 19, TypeScript, and Vite. One build produces four isolated roots:

- `build/site` — public landing, install, releases, reviews, rcpan, and unicast
- `build/docs` — documentation
- `build/wallet` — `/app`, `/address`, and `/testnet`
- `build/ops` — health, QA, scenarios, runs, AI, and embed tools

Run `bun run dev` for the unified local origin, `bun run build` for all four roots, and `bun run check` for type checking plus the production build.
