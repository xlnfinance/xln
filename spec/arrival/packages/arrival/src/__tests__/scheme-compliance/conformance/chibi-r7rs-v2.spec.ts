/**
 * Chibi harness v2 — the official chibi-scheme R7RS test suite, run per-form instead of
 * per-section (docs/test-suite-architecture.md F4).
 *
 * Landed ALONGSIDE v1 (`../chibi-r7rs.spec.ts` + `../chibi-harness.ts`), untouched and still
 * gating — v1/v2 coexistence was the deliberate migration plan. This is the SUNRISE runner
 * (`vitest.sunrise.config.ts`): red here is information (a documented gap becomes `it.fails`,
 * which flips loudly the day it's fixed), not the CI gate.
 *
 * Three phases, one spec file:
 *   1. `buildManifest` (top-level await) — structural split + per-form reader parse + head-
 *      symbol classification → an ordered `Manifest` of steps.
 *   2. `CorpusRunner.create` (top-level await) — one shared, capability-assembled env; the
 *      runner drives `exec()` per step on demand, cursor-guarded against out-of-order calls.
 *      Dual-pass foundation (M5): pass `{ strict: true }` for Pass A (R7RS goldens). This
 *      file still uses the default loose mode; SRFI-1 is the first corpus on Pass A
 *      (`chibi-srfi1.spec.ts`). See conformance/README.md "Dual pass".
 *   3. Registration (this file, synchronous) — ONE describe/it/it.fails/it.skip/it.todo row
 *      per test form, in CORPUS ORDER (a plain loop dispatching per row — NOT `it.each`
 *      partitioning, which would reorder registration and therefore execution).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildManifest, normalizeText, type Manifest, type Step, type TestStep } from "../chibi/manifest.js";
import { registryCoherenceFindings, verdictFor } from "../chibi/registries.js";
import { CorpusRunner } from "../chibi/runner.js";

const CHIBI_TESTS_PATH = path.resolve(import.meta.dirname, "../../../../vendor/chibi-scheme/tests/r7rs-tests.scm");

if (!fs.existsSync(CHIBI_TESTS_PATH)) {
  throw new Error("r7rs-tests.scm — submodule not initialized (run: git submodule update --init)");
} else {
  const manifest: Manifest = await buildManifest(CHIBI_TESTS_PATH);
  const runner = await CorpusRunner.create(manifest);

  describe("Chibi R7RS v2", () => {
    let registeredCount = 0;

    const rowLabel = (step: TestStep): string =>
      `${normalizeText(step.text).slice(0, 160)}  ${CHIBI_TESTS_PATH}:${step.line}`.slice(0, 300);

    const registerTest = (step: TestStep): void => {
      registeredCount++;
      const verdict = verdictFor(step);
      const label = rowLabel(step);
      switch (verdict.run) {
        case "it":
          it(label, async () => {
            const outcome = await runner.outcomeFor(step);
            if (outcome.kind !== "pass") throw runner.failureError(step, outcome);
          });
          return;
        case "skip":
          it.skip(`${label} — excluded: ${verdict.feature}`.slice(0, 300), () => {});
          return;
        case "fails":
          // vitest `fails` semantics: this row is green iff the body THROWS; it flips red the
          // day the underlying gap closes (P15) — so the body is the SAME assertion an `it`
          // row would run, not an inverted one.
          it.fails(`${label} — expected failure: ${verdict.reason} (gate: ${verdict.gate})`.slice(0, 300), async () => {
            const outcome = await runner.outcomeFor(step);
            if (outcome.kind !== "pass") throw runner.failureError(step, outcome);
          });
          return;
        case "todo":
          it.todo(`${label} — staged: ${verdict.spec}`.slice(0, 300));
          return;
      }
    };

    const registerUnreadable = (step: Extract<Step, { kind: "unreadable" }>): void => {
      // Read-time door (design §6 point 3) — visible/counted in the vitest tree instead of
      // vanishing pre-parse, but NOT part of `manifest.tests` (the anti-vacuity floor below is
      // about parseable, classifiable test forms).
      //
      // The label used to hardcode "complex tower (R7RS §6.2.3 omitted)" for EVERY unreadable
      // step — accurate when the complex tower was the only reader door in the corpus. The
      // one-number rework (docs/design-history/arrival-one-number-rework.md §0.3/§2.5)
      // added a second, unrelated reader door: an exact integer literal beyond
      // Number.isSafeInteger range now ParseErrors at read time instead of silently minting a
      // bigint (e.g. `4611686018427387904`, `9007199254740993`, and several
      // exact-integer-sqrt-of-a-huge-power results in "4.2 Derived expression types"). Labeling
      // those as "complex tower" was self-contradicting the door message printed right next to
      // it — classify by the actual reader error instead of assuming a single cause.
      const label = `${normalizeText(step.text).slice(0, 160)}  ${CHIBI_TESTS_PATH}:${step.line}`.slice(0, 300);
      const feature = step.readerError.includes("exceeds safe-integer range")
        ? "exact literal beyond safe-integer range (docs/design-history/arrival-one-number-rework.md §0.3 — RATIO's safe-int-only exact components)"
        : "complex tower (R7RS §6.2.3 omitted)";
      it.skip(
        `${label} — excluded: ${feature} [reader door: ${step.readerError.slice(0, 100)}]`.slice(0, 300),
        () => {},
      );
    };

    // One flat, corpus-ordered row list — standalone tests, block members (flattened in their
    // block's position), and unreadable forms — each carrying its `sectionPath` for the
    // recursive describe-grouping below.
    interface Row {
      sectionPath: readonly string[];
      emit(): void;
    }
    const rows: Row[] = [];
    for (const step of manifest.steps) {
      if (step.kind === "test") rows.push({ sectionPath: step.sectionPath, emit: () => registerTest(step) });
      else if (step.kind === "block")
        for (const member of step.members)
          rows.push({ sectionPath: member.sectionPath, emit: () => registerTest(member) });
      else if (step.kind === "unreadable")
        rows.push({ sectionPath: step.sectionPath, emit: () => registerUnreadable(step) });
    }

    // Group consecutive rows sharing a sectionPath PREFIX into nested `describe`s — corpus
    // order is preserved exactly (a plain forward scan, never a partition/sort).
    const registerRows = (group: readonly Row[], depth: number): void => {
      let i = 0;
      while (i < group.length) {
        const name = group[i].sectionPath[depth];
        if (name === undefined) {
          group[i].emit();
          i++;
          continue;
        }
        let j = i;
        while (j < group.length && group[j].sectionPath[depth] === name) j++;
        const slice = group.slice(i, j);
        describe(name, () => registerRows(slice, depth + 1));
        i = j;
      }
    };
    registerRows(rows, 0);

    // ── Anti-vacuity (design §9) — structural, computed at registration time, not runtime
    //    survival. Mirrors v1's `executed (sanity floor)` test, tightened to per-row counts. ──
    it("manifest floor: at least 1000 parsed test forms", () => {
      expect(manifest.tests.length).toBeGreaterThanOrEqual(1000);
    });
    it("runnable floor: more than 500 rows registered to actually run (verdict = it)", () => {
      const runnable = manifest.tests.filter((t) => verdictFor(t).run === "it").length;
      expect(runnable).toBeGreaterThan(500);
    });
    it("every manifest test form is registered exactly once", () => {
      expect(registeredCount).toBe(manifest.tests.length);
    });

    // ── Registry self-check (P16, design §4) — dead-rule + over-match alarms. ───────────────
    it("registry coherence: no dead or over-matching rules", () => {
      expect(registryCoherenceFindings(manifest)).toEqual([]);
    });
  });
}
