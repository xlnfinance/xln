# Repository Restructure - October 11, 2025

**Essence-driven naming: Directories speak their purpose, not their location.**

## Changes

```
OLD                  →  NEW                   ESSENCE
─────────────────────────────────────────────────────────────────
/docs                →  /vibepaper            Philosophy, vision, specs
/src                 →  /runtime              Consensus engine + state machines
/contracts           →  /jurisdictions        On-chain J-machine layer
/scenarios           →  /worlds               Economic simulations
/e2e                 →  /proofs               E2E validation tests
                     →  /simnet (NEW)         BrowserVM genesis configs
```

## Why

**vibepaper/** - Documentation is energy, not bureaucracy. This is where the vibe lives.

**runtime/** - Pure consensus. Entity machines, account consensus, deterministic ticks. What it DOES.

**jurisdictions/** - Plural because multi-chain. Ethereum, Polygon, Arbitrum. Legal execution layers.

**worlds/** - Not "scenarios" (too abstract). These are complete simulated economies.

**proofs/** - Tests that PROVE correctness. More precise than "e2e" (which is implementation detail).

**simnet/** - The offline universe. BrowserVM configs, genesis states, network params.

## Migration Complete

✅ All git history preserved (`git mv`)
✅ Import paths updated (30+ references)
✅ Build scripts fixed (package.json, *.sh)
✅ Frontend fetch paths updated (/worlds/)
✅ TypeScript check passes

## Updated References

- `bun run build` → builds `runtime/runtime.ts`
- `bun run check` → validates `runtime/` + `frontend/`
- Contract scripts → use `cd jurisdictions`
- Scenario loading → fetches from `/worlds/`
- Docs → live in `vibepaper/`

## New Structure Benefits

1. **Clearer Intent**: Name reveals purpose immediately
2. **Multi-Chain Ready**: "jurisdictions" (plural) anticipates L2s
3. **Modular UI**: `/view` components, `/frontend` app that uses them
4. **BrowserVM Home**: `/simnet` for offline simulation configs
5. **Poetic**: "vibepaper" > "docs", "worlds" > "scenarios"

**Status:** COMPLETE - Ready to build.
