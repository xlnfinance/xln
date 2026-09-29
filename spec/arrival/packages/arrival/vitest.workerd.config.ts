/**
 * vitest.workerd.config.ts — Q19 conjunct C2's OPT-IN suite (docs/PROVENANCE-PLAN.md
 * Q19; .claude/rules/tests.md's "browser/runtime-tooling signal" carve-out). Real
 * workerd via `@cloudflare/vitest-pool-workers` (miniflare) — local, cloud-free, no
 * deployment. NEVER part of the default `pnpm test`/`pnpm benchmarks` runs (see
 * `vitest.benchmarks.config.ts`'s own exclude for why the workerd file can't
 * silently ride along in that config) — invoked explicitly via `pnpm workerd`.
 *
 * MERGE BLOCKER, not routine CI noise: docs/PROVENANCE-PLAN.md Q19 states conjunct 2
 * "runs on workerd as a MERGE BLOCKER (fakes prove the fold logic; only workerd
 * proves real hibernation/output-gate behavior)." If this suite cannot run (the
 * pool fails to start — missing workerd binary, unsupported platform, no network
 * during postinstall), THAT is the correct failure mode: a hard, unmissable crash
 * at pool-startup time, not a graceful skip. A `describe.skipIf` guard would need a
 * signal to check from INSIDE a running worker — but if the test file is executing
 * at all, workerd is by definition available (the check would be tautological); the
 * real "unavailable" case fails outside any single test, at pool bootstrap, which
 * already refuses to run silently.
 */
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: path.resolve(import.meta.dirname, "src/__benchmarks__/workerd/provenance-do-worker.ts"),
      wrangler: {
        configPath: path.resolve(import.meta.dirname, "wrangler.provenance-budget.toml"),
      },
      miniflare: {
        compatibilityDate: "2026-03-17",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          PROVENANCE_DO: "ProvenanceRegionDO",
        },
      },
    }),
  ],
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/__benchmarks__/provenance-budget-workerd.bench.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
