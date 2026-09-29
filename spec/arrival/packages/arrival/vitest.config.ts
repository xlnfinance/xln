import { defineConfig } from "vitest/config";

// THE runner — one suite, green by law (docs/test-suite-v2/DESIGN.md, cutover
// executed per docs/REWORK-DAG.md G3). Red is a broken gate, never information:
// documented gaps are it.fails rows owned by src/__tests__/ledger/ (which maps
// every gap → the migration that flips it → the law row that replaces it).
//
// Whitelist, not exclude (rule: .claude/rules/tests.md). The v2 law families
// live in named subdirs of src/__tests__; surviving behavior suites are the
// TOP-LEVEL files of src/__tests__ plus each package-local __tests__ dir.
// `agreement/` is pre-declared per DESIGN.md §2 — a new law file just lands,
// no config edit required. src/__tests__/scheme-compliance/ holds the chibi
// harness + scheme-language-compliance suite; scheme-compliance/chibi/ holds
// harness modules (no .test suffix), picked up transitively via the
// scheme-compliance/** glob below, never globbed directly.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      // v2 law families
      "src/__tests__/laws/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/provenance/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/ledger/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/scheme-compliance/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/doors/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/__tests__/agreement/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/values/primitives/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/reader/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/run/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      // surviving behavior suites
      "src/__tests__/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/common/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/r7rs/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/env/srfi/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/membrane/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/type-layer/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/provenance/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      "src/provenance/store/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
