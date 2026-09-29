import { defineConfig } from "vitest/config";

// TYPE-TESTS — the `*.test-d.ts` proofs run through `vitest --typecheck` (tsc, not the
// runtime evaluator). The symbol-contract inference (a zod contract → the decoded impl
// arg/return types) is the load-bearing proof of the `arrival.symbol*` API; these used to
// be inline `type _Assert = …` lines in src/common/symbol.ts because both package tsconfigs
// EXCLUDE the test dirs. This config compiles ONLY the type-tests (against tsconfig.typecheck.json,
// which re-includes them) so a type regression fails CI as a real test.
//
// Peer to vitest.config.ts (runtime gate) + vitest.benchmarks.config.ts. `ignoreSourceErrors`
// keeps the gate scoped to the test-d assertions — the build tsc (`pnpm build`) already gates
// the source tree, so unrelated source noise inside the program must not red the type-test run.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [],
    typecheck: {
      enabled: true,
      only: true,
      checker: "tsc",
      tsconfig: "./tsconfig.typecheck.json",
      include: ["src/**/__tests__/**/*.test-d.ts"],
      ignoreSourceErrors: true,
    },
  },
});
