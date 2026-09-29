import { defineConfig } from "vitest/config";

// Whitelist, never an exclude list (.claude/rules/tests.md): the default gate runs
// exactly `src/__tests__/**/*.test.ts`. The index/analysis barrels' capture-primitive
// re-exports of core are tested in core CI; this package's own suite covers its real
// modules — verdict.ts, plus (post provenance analysis-stack relocation) the analysis
// stack now native to `src/analysis/*` (e.g. mdl-collapse.test.ts).
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // First `execState` pays BASE_ROSTER vocabulary + prelude — same bound as arrival.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
