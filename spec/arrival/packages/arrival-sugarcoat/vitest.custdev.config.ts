import { defineConfig } from "vitest/config";

// Custdev category: LLM-as-user loops (fires a real model; opt-in, never a CI gate).
export default defineConfig({
  test: {
    include: ["src/__custdev__/**/*.test.ts"],
    testTimeout: 600_000,
  },
});
