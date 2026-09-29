/**
 * Pass B — golden-loose pins for mode-split forms (M5 dual chibi-alike foundation).
 *
 * Pass A (strict / chibi goldens) lives in `chibi-srfi1.spec.ts` with
 * `CorpusRunner.create(manifest, { strict: true })` — chibi's
 * `(test-error (car '()))` / `(test-error (cdr '()))` are real green rows there.
 *
 * Pass B (this file) pins **current Arrival loose product** so tolerance cannot regress
 * silently: under `strict: false`, `(car '())` / `(cdr '())` must return nil (scheme
 * `equal?` to `'()`, not a JS duck-tolerance). If loose starts throwing again → red.
 *
 * Misalignment inventory seed (form | loose | strict | site | intentional):
 *   see `../chibi/registries-srfi1.ts` → `MODE_SPLIT_INVENTORY`.
 *
 * How to grow fail-if / dual-pass next:
 *   1. Append a MODE_SPLIT_INVENTORY row.
 *   2. Pass A: ensure the corpus form runs under strict (or add an explicit strict pin).
 *   3. Pass B: add a golden-loose row here (or `it.each` over the inventory).
 *   4. Never re-introduce permanent EXPECTED_FAILURE only because the harness was loose.
 */
import { describe, expect, it } from "vitest";
import { exec, execState } from "../../../eval/generator-exec.js";
import { is_false } from "../../../values/value-guards.js";
import { ANil } from "../../../values/primitives/ANil.js";
import { MODE_SPLIT_INVENTORY } from "../chibi/registries-srfi1.js";

describe("Pass B — golden-loose car/cdr empty (chibi-alike equal?)", () => {
  it("inventory seed covers car/cdr empty as intentional mode-splits", () => {
    const forms = MODE_SPLIT_INVENTORY.map((r) => r.form);
    expect(forms).toEqual(expect.arrayContaining(["(car '())", "(cdr '())"]));
    for (const row of MODE_SPLIT_INVENTORY) {
      expect(row.intentional).toBe(true);
      expect(row.loose).toBe("nil");
      expect(row.strict).toMatch(/throw/i);
    }
  });

  it("(car '()) under loose → nil (scheme equal? to '())", async () => {
    // chibi-alike: scheme equal?, not valueOf/String duck-tolerance
    const [eq] = await exec("(equal? (car '()) '())", { strict: false });
    expect(is_false(eq)).toBe(false);
    const boxed = (await execState("(car '())", { strict: false })).values[0];
    expect(boxed).toBeInstanceOf(ANil);
  });

  it("(cdr '()) under loose → nil (scheme equal? to '())", async () => {
    const [eq] = await exec("(equal? (cdr '()) '())", { strict: false });
    expect(is_false(eq)).toBe(false);
    const boxed = (await execState("(cdr '())", { strict: false })).values[0];
    expect(boxed).toBeInstanceOf(ANil);
  });

  it("strict still throws (Pass A mirror / anti-collapse of dual goldens)", async () => {
    await expect(exec("(car '())", { strict: true })).rejects.toThrow(/not a pair/);
    await expect(exec("(cdr '())", { strict: true })).rejects.toThrow(/not a pair/);
  });
});
