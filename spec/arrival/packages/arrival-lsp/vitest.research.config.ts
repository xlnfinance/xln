// Research suites: produce study output (numbers a human reads), not CI
// verdicts — opt-in via `pnpm research` (see .claude/rules/tests.md).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__research__/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
