import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    // The suite spawns the BUILT cli (node dist/cli.js) — build it first, always
    // fresh, so `pnpm test` is self-contained (no stale-dist false green).
    globalSetup: "./vitest.global-setup.ts",
    // First spawn bootstraps the interpreter's base packs; generous per-test bound.
    testTimeout: 120_000,
  },
});
