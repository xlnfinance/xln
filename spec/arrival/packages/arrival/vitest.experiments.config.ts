import { defineConfig } from "vitest/config";

// `__experiments__/` — proof-of-concept spikes, opt-in (`pnpm experiments`), NEVER a
// CI gate (rule: .claude/rules/tests.md). Current contents: the walking-driver
// emission-seam spike (docs/working-proposals/arrival-walking-driver-design-2026-07-11.md).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/__experiments__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
