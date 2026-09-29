import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    // First `execState` pays BASE_ROSTER vocabulary + prelude — same bound as arrival.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
