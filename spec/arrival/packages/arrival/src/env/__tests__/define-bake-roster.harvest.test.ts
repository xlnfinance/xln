/**
 * define-bake roster harvest — real-instantiate every pack that migration
 * receipts used to pin, plus the full BASE_ROSTER.
 *
 * Addresses eng-review G1/G2 and longcat Attacks 1+6 (arrival-test-redundancy
 * proposal): a synthetic `(define x 1)` law is not pack coverage. This harvest
 * calls `buildVocabulary([pack], …)` on each real capability export.
 *
 * Meta-gate: every BASE_ROSTER name appears in the harvested set (no silent
 * drift when packs are added to the roster).
 *
 * Does NOT replace:
 * - `symbol-define.law.test.ts` (mechanism / FV / sequential-RHS on test-local caps)
 * - Per-pack *behavior* suites (semantic verb equivalence)
 * - Negative pre-fix throw pins (catalogued in
 *   docs/design-history/test-redundancy-receipts-2026-07-25.md — must move home
 *   before migration-file delete)
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { execInFrame } from "../../eval/generator-exec.js";
import { buildVocabulary } from "../vocabulary.js";
import { BASE_ROSTER } from "../base-roster.js";
import type { EnvCapability } from "../../common/capability.js";
import type { ResolvingAmbient } from "../AmbientRuntime.js";

// Migration-set packs (Appendix A of the redundancy proposal) that are NOT already
// co-roots of BASE_ROSTER as independent imports — overridable/schema are opt-in.
import { overridableCapability } from "../overridable/overridable.js";
import { schemaCapability } from "../schema/schema.js";

// Explicit imports for migration-set packs so the harvest never depends on
// "whatever happens to be in BASE_ROSTER today" for opt-ins / named receipts.
import core from "../core/core.js";
import binding from "../r7rs/binding.js";
import control from "../r7rs/control.js";
import lists from "../r7rs/lists.js";
import strings from "../r7rs/strings.js";
import syntax from "../r7rs/syntax.js";
import srfi1 from "../srfi/srfi-1.js";
import srfi8 from "../srfi/srfi-8.js";
import srfi26 from "../srfi/srfi-26.js";
import srfi43 from "../srfi/srfi-43.js";
import srfi128 from "../srfi/srfi-128.js";
import srfi189 from "../srfi/srfi-189.js";
import srfi235 from "../srfi/srfi-235.js";
import polyglot from "../polyglot/polyglot.js";
import polyglotClojure from "../polyglot/polyglot-clojure.js";
import polyglotLisp from "../polyglot/polyglot-lisp.js";
import polyglotRacket from "../polyglot/polyglot-racket.js";

/** Mirrors `_fresh-env.ts` evalScheme for standalone vocabulary builds. */
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

/**
 * Union of:
 * - every BASE_ROSTER co-root (real self-host surface)
 * - every pack that had a `*symbol-define*` migration receipt (Appendix A)
 *
 * Deduped by `cap.name`. Order is stable for readable failure messages.
 */
const MIGRATION_AND_ROSTER_PACKS: readonly EnvCapability[] = (() => {
  const byName = new Map<string, EnvCapability>();
  const add = (cap: EnvCapability) => {
    if (!byName.has(cap.name)) byName.set(cap.name, cap);
  };
  for (const cap of BASE_ROSTER) add(cap);
  for (const cap of [
    core,
    binding,
    control,
    lists,
    strings,
    syntax,
    srfi1,
    srfi8,
    srfi26,
    srfi43,
    srfi128,
    srfi189,
    srfi235,
    polyglot,
    polyglotClojure,
    polyglotLisp,
    polyglotRacket,
    overridableCapability,
    schemaCapability,
  ]) {
    add(cap);
  }
  return [...byName.values()];
})();

describe("define-bake roster harvest — real pack instantiation", () => {
  it("meta: every BASE_ROSTER name is in the harvest set (no silent roster drift)", () => {
    const harvested = new Set(MIGRATION_AND_ROSTER_PACKS.map((c) => c.name));
    const missing = BASE_ROSTER.map((c) => c.name).filter((n) => !harvested.has(n));
    expect(missing, `BASE_ROSTER packs missing from harvest: ${missing.join(", ")}`).toEqual([]);
  });

  it("meta: every harvest pack has a stable non-empty name", () => {
    for (const cap of MIGRATION_AND_ROSTER_PACKS) {
      expect(typeof cap.name).toBe("string");
      expect(cap.name.length).toBeGreaterThan(0);
    }
  });

  it.each(MIGRATION_AND_ROSTER_PACKS.map((cap) => [cap.name, cap] as const))(
    "buildVocabulary([%s]) does not throw (real pack bake)",
    async (_name, cap) => {
      // Standalone bake: pack + its declared deps only — same path migration
      // "bakes cleanly with its declared deps" rows used.
      await expect(buildVocabulary([cap], undefined, evalScheme)).resolves.not.toThrow();
    },
  );

  it.each(MIGRATION_AND_ROSTER_PACKS.map((cap) => [cap.name, cap] as const))(
    "%s has no residual prelude field (migration structural pin)",
    (_name, cap) => {
      expect(cap.spec.prelude, `${cap.name}: residual prelude must be undefined`).toBeUndefined();
    },
  );
});

/**
 * Filename gate (G4 / longcat Attack 7): new `*symbol-define*` migration receipts
 * must not appear outside the allowlist. As files are retired, remove them from
 * the set — when empty, any matching path fails CI.
 */
const ENV_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Paths relative to `src/env/`, posix-style. Shrink as receipts retire. */
const ALLOWED_MIGRATION_RECEIPTS = new Set([
  "__tests__/core/core-symbol-define-migration.test.ts",
  "__tests__/overridable/overridable-symbol-define.test.ts",
  "__tests__/polyglot/polyglot-symbol-define.test.ts",
  "__tests__/schema/schema-symbol-define-migration.test.ts",
  "r7rs/__tests__/binding-symbol-define-migration.test.ts",
  "r7rs/__tests__/control-symbol-define-migration.test.ts",
  "r7rs/__tests__/lists-symbol-define-migration.test.ts",
  "r7rs/__tests__/strings-symbol-define-migration.test.ts",
  "r7rs/__tests__/syntax-symbol-define-migration.test.ts",
  "srfi/__tests__/srfi-1-symbol-define.test.ts",
  "srfi/__tests__/srfi-8-symbol-define.test.ts",
  "srfi/__tests__/srfi-26-symbol-define.test.ts",
  "srfi/__tests__/srfi-43-symbol-define.test.ts",
  "srfi/__tests__/srfi-128-symbol-define.test.ts",
  "srfi/__tests__/srfi-189-symbol-define.test.ts",
  "srfi/__tests__/srfi-235-symbol-define.test.ts",
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTsFiles(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("migration-receipt filename gate", () => {
  it("no *symbol-define* test file exists outside the allowlist (blocks new receipts)", () => {
    const found = walkTsFiles(ENV_ROOT)
      .map((abs) => relative(ENV_ROOT, abs).split("\\").join("/"))
      .filter((rel) => /symbol-define/i.test(rel) && rel.endsWith(".test.ts"));
    const unexpected = found.filter((rel) => !ALLOWED_MIGRATION_RECEIPTS.has(rel));
    const missing = [...ALLOWED_MIGRATION_RECEIPTS].filter((rel) => !found.includes(rel));
    expect(unexpected, `new migration receipts (not on allowlist): ${unexpected.join(", ")}`).toEqual([]);
    // Allowlist shrink is intentional on retire — missing allowlist entries mean update the set.
    expect(
      missing,
      `allowlist stale (file gone — remove from ALLOWED_MIGRATION_RECEIPTS): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
