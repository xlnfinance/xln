import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/__benchmarks__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    // Q19's workerd conjunct (C2) needs the REAL `@cloudflare/vitest-pool-workers`
    // pool (`vitest.workerd.config.ts`, `pnpm workerd`) — this plain-node config
    // cannot resolve the `cloudflare:workers`/`cloudflare:test` virtual modules
    // that file's worker source imports, so it must never glob it in (a crash on
    // an unresolvable import here would misreport as "the benchmarks gate broke,"
    // not "the opt-in workerd suite wasn't run" — the exclude keeps the two
    // failure modes distinct).
    exclude: ["**/node_modules/**", "**/dist/**", "src/__benchmarks__/**/*workerd*"],
  },
});
