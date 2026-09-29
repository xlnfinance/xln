/**
 * Q20b test-setup helper — install/restore the eager-stamp oracle for one suite.
 *
 * The production default (op-helpers.ts) flipped to OFF: production hot paths no
 * longer accumulate provenance unless something explicitly opts in. Every suite
 * written BEFORE Q20b — the CI agreement oracle itself (`wireframe-agreement.law.
 * test.ts`/`w1-harness.ts`, the Q16 replay laws' recorded-ground-truth side/
 * `q16-harness.ts`, `_lineage-test-helpers.ts`'s `runRaw`) plus every standalone
 * suite that asserts real accumulated stamps off a genuine interpreter run or a
 * direct native-op call — was written against the old always-on default and must
 * explicitly opt back IN for its own lifetime, or every such assertion goes to
 * empty/flyweight and fails.
 *
 * Call once, at the top level of a test file (outside any `describe`) — vitest's
 * `beforeAll`/`afterAll` at file scope apply to the whole file's root suite. This
 * is the "shared setup helper" shape (over per-file duplicated beforeAll/afterAll
 * blocks): ~8 standalone suites call this one line instead of repeating the same
 * three-line pair, and the three shared harnesses (`_lineage-test-helpers.ts`,
 * `w1-harness.ts`, `q16-harness.ts`) do their own PER-CALL save/restore instead
 * (narrower — they're imported by files that may run interleaved with others in
 * the same worker, so a file-wide beforeAll would over-widen their effect).
 */
import { beforeAll, afterAll } from "vitest";
import { setEagerProvenanceOracleEnabled } from "../values/op-helpers.js";

/** Force the oracle ON for this file's entire test run, restoring the (off) default
 *  afterward. Idempotent to call at most once per file, at the top level. */
export function requireEagerOracle(): void {
  beforeAll(() => setEagerProvenanceOracleEnabled(true));
  afterAll(() => setEagerProvenanceOracleEnabled(false));
}
