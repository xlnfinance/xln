/**
 * Chibi harness v2 — SECOND corpus: chibi's OWN SRFI-1 list-library suite
 * (`vendor/chibi-scheme/lib/srfi/1/test.sld`), run through the identical per-form harness
 * as `chibi-r7rs-v2.spec.ts` (docs/test-suite-architecture.md F4; this file is
 * that harness design applied to a second corpus, not a new harness).
 *
 * Structurally identical to the main spec — same three phases (manifest → runner →
 * registration), same `it`/`it.fails`/`it.skip`/`it.todo` dispatch, same anti-vacuity +
 * registry-coherence self-checks — differing only in:
 *   - the manifest builder: `buildSrfi1Manifest` (srfi1-manifest.ts) instead of
 *     `buildManifest`, since test.sld's test forms sit inside a
 *     `(define-library … (begin (define (run-tests) …)))` wrapper rather than at the file's
 *     own top level;
 *   - the registry: `registries-srfi1.ts`'s own `EXCLUDED`/`EXPECTED_FAILURES` tables
 *     (driven by src/env/srfi/srfi-1.ts's DOORS inventory), not the main corpus's.
 *
 * Dual pass (M5): this file is **Pass A** — `CorpusRunner.create(manifest, { strict: true })`
 * so chibi goldens that require R7RS throws (notably `(test-error (car '()))` /
 * `(test-error (cdr '()))`) are real green rows, not permanent EXPECTED_FAILURES under a
 * loose harness. **Pass B** (golden-loose current product pins for those mode-splits) lives
 * in `golden-loose-car-cdr-empty.test.ts`. Misalignment inventory seed:
 * `registries-srfi1.ts` `MODE_SPLIT_INVENTORY`.
 *
 * `CorpusRunner`/the harness capability (test/test-error/test-values macros, the scheme-side
 * comparator) are shared verbatim with the main corpus — a fresh env per spec file.
 */
import fs from "fs";
import { describe, expect, it } from "vitest";
import { normalizeText, type Manifest, type Step, type TestStep } from "../chibi/manifest.js";
import { buildSrfi1Manifest, SRFI1_TEST_PATH } from "../chibi/srfi1-manifest.js";
import { registryCoherenceFindings, verdictFor } from "../chibi/registries-srfi1.js";
import { CorpusRunner } from "../chibi/runner.js";

if (!fs.existsSync(SRFI1_TEST_PATH)) {
  throw new Error("srfi/1/test.sld — submodule not initialized (run: git submodule update --init)");
} else {
  const manifest: Manifest = await buildSrfi1Manifest();
  // Pass A: R7RS-strict so car/cdr-of-empty test-error forms ride chibi goldens.
  const runner = await CorpusRunner.create(manifest, { strict: true });

  describe("Chibi SRFI-1 (Pass A — strict / chibi goldens)", () => {
    let registeredCount = 0;

    it("runner is Pass A (strict: true)", () => {
      expect(runner.isStrict).toBe(true);
    });

    const rowLabel = (step: TestStep): string =>
      `${normalizeText(step.text).slice(0, 160)}  ${SRFI1_TEST_PATH}:${step.line}`.slice(0, 300);

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
          // day the underlying gap closes — so the body is the SAME assertion an `it` row
          // would run, not an inverted one (matches the main corpus's own convention).
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
      const label = `${normalizeText(step.text).slice(0, 160)}  ${SRFI1_TEST_PATH}:${step.line}`.slice(0, 300);
      it.skip(
        `${label} — excluded: unreadable [reader door: ${step.readerError.slice(0, 100)}]`.slice(0, 300),
        () => {},
      );
    };

    // One flat, corpus-ordered row list — same shape as the main spec (standalone tests,
    // block members flattened in their block's position, unreadable forms).
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

    // ── Anti-vacuity (design §9, tightened to this corpus's own census: 150 `test` + 2
    //    `test-assert` + 4 `test-error` + 5 `test-values` = 161 non-commented forms). ────────
    it("manifest floor: at least 150 parsed test forms", () => {
      expect(manifest.tests.length).toBeGreaterThanOrEqual(150);
    });
    it("runnable floor: more than 50 rows registered to actually run (verdict = it)", () => {
      const runnable = manifest.tests.filter((t) => verdictFor(t).run === "it").length;
      expect(runnable).toBeGreaterThan(50);
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
