import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // First `exec` pays BASE_ROSTER vocabulary + prelude — same bound as arrival.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
