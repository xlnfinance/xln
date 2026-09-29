import { defineConfig } from "vitest/config";

// Whitelist, never an exclude list (.claude/rules/tests.md): the default gate runs
// exactly `src/__tests__/**/*.test.ts`.
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // First `exec` / `parse` pays BASE_ROSTER vocabulary + prelude. Locally that's
    // hundreds of ms; on a contended CI runner it exceeds vitest's 5s default.
    // Same bound as `@inhuman.tools/arrival`.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
