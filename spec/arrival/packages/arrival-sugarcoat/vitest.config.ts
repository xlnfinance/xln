import { defineConfig } from "vitest/config";

// Default gate: ONLY __tests__ (boolean pass/fail). Opt-in categories get their own
// vitest.<category>.config.ts — whitelists, never exclude lists (.claude/rules/tests.md).
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
});
