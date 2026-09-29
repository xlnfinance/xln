import { defineConfig } from "vitest/config";

// Whitelist, never an exclude list (.claude/rules/tests.md): the default gate runs
// exactly `src/__tests__/**/*.test.ts`.
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
});
