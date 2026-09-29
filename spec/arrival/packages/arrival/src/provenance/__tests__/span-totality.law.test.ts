/**
 * LAW W0 — span totality through syntax-rules expansion (PROVENANCE.md §7; plan Q6).
 *
 * Every Pair reachable in macro-expansion OUTPUT carries a span (`[LOCATION]`), so the
 * lineage classifier stops degrading expanded code to opaque and the wireframe (Q8a)
 * can key expanded forms by located-Pair identity. Two halves:
 *
 *   1. STRUCTURAL — a macro whose template is QUOTED data returns its expansion-
 *      constructed skeleton Pairs to the caller as a value; walking it asserts every
 *      Pair is located. (Template skeleton Pairs carry the TEMPLATE's span — the
 *      carrySpan ruling in eval/syntax-rules.ts; call-site fragments ride by
 *      reference with their own spans.)
 *   2. BEHAVIORAL — the trace only tracks LOCATED Pairs (provenance/trace.ts's
 *      tap-firing rule), so "the expanded form appears in the trace" is exactly the
 *      observable Q8a needs. Pre-W0, macro-expanded forms were invisible here.
 *
 * Corpus: flat template, nested/ellipsis template, nested macro-in-macro, and the
 * swap/or shapes the syntax-rules trio exercises.
 */
import { describe, expect, it } from "vitest";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { EvalTrace } from "../../provenance/trace.js";
import { APair } from "../../values/primitives/APair.js";
import { symbol } from "../../symbol/index.js";
import * as z from "../../common/scheme-zod/index.js";
import { parseDefineBody } from "../../common/symbols/define-bake.js";

/** Walk a boxed scheme value; return every reachable APair lacking a location. */
function spanless(value: unknown, out: APair<any, any>[] = [], seen = new Set<unknown>()): APair<any, any>[] {
  if (!(value instanceof APair) || seen.has(value)) return out;
  seen.add(value);
  if (value.getLocation() === undefined) out.push(value);
  spanless(value.car, out, seen);
  spanless(value.cdr, out, seen);
  return out;
}

const run = async (src: string) => {
  const env = inferenceEnv.child(`span-totality-${Math.random().toString(36).slice(2)}`);
  const { values } = await execState(src, { env });
  return values[values.length - 1]; // last top-level form's value (defines yield void)
};

describe("W0 span totality — structural (quoted template skeletons are fully located)", () => {
  it("flat template: every expansion-constructed Pair carries a span", async () => {
    const v = await run(`
      (define-syntax wrap (syntax-rules () ((_ x) (quote (alpha beta (gamma x))))))
      (wrap 42)
    `);
    expect(v).toBeInstanceOf(APair);
    expect(spanless(v).map((p) => String(p.car))).toEqual([]);
  });

  it("ellipsis template: repetition-constructed spine cells carry spans", async () => {
    const v = await run(`
      (define-syntax listify (syntax-rules () ((_ x ...) (quote ((x) ...)))))
      (listify 1 2 3)
    `);
    expect(v).toBeInstanceOf(APair);
    expect(spanless(v).map((p) => String(p.car))).toEqual([]);
  });

  it("nested macro: inner expansion output is fully located too", async () => {
    const v = await run(`
      (define-syntax inner (syntax-rules () ((_ y) (quote (deep y)))))
      (define-syntax outer (syntax-rules () ((_ z) (inner z))))
      (outer 7)
    `);
    expect(v).toBeInstanceOf(APair);
    expect(spanless(v).map((p) => String(p.car))).toEqual([]);
  });
});

describe("W0 span totality — behavioral (expanded forms are trace-visible)", () => {
  it("a macro expanding to (+ a b) yields a tracked, located `+` node in the trace", async () => {
    const trace = new EvalTrace();
    const env = inferenceEnv.child("span-totality-trace");
    const { values } = await execState(
      `
      (define-syntax my-add (syntax-rules () ((_ a b) (+ a b))))
      (my-add 1 2)
      `,
      { env, tap: trace },
    );
    expect(String(values[values.length - 1])).toBe("3");
    // The expanded (+ 1 2) Pair is expansion-constructed; pre-W0 it had no location and
    // the tap-firing rule filtered it — no record. Post-W0 it is located and tracked.
    const trackedHeads = [...trace.records.keys()]
      .filter((n): n is APair<any, any> => n instanceof APair && n.getLocation() !== undefined)
      .map((n) => String(n.car));
    // The head is the hygiene-renamed gensym (#:+) — its PRESENCE as a tracked,
    // located node is the law; pre-W0 the expanded form had no location and the
    // tap-firing rule filtered it entirely.
    expect(trackedHeads.some((h) => h === "+" || h === "#:+")).toBe(true);
  });
});

describe("W1 span totality — a symbol.define body is fully located, source-labeled capability#name", () => {
  it("every Pair in a parsed define body carries a span, sourced `«capability»#«name»`", async () => {
    const def = symbol.define`fold-right-ish: a nested body worth walking`(
      { input: [z.schemeValue, z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      `(lambda (kons knil lst) (if (null? lst) knil (kons (car lst) (fold-right-ish kons knil (cdr lst)))))`,
    );
    const form = await parseDefineBody("scheme/srfi-1", def);
    expect(form).toBeInstanceOf(APair);
    expect(spanless(form).length).toBe(0);
    const loc = (form as APair<any, any>).getLocation();
    expect(loc?.source).toBe("scheme/srfi-1#fold-right-ish");
  });

  it("the parse is MEMOIZED per def object — a second call returns the SAME (===) form", async () => {
    const def = symbol.define`memo-check: a trivial constant`(z.schemeValue, `42`);
    const first = await parseDefineBody("test/memo-cap", def);
    const second = await parseDefineBody("test/memo-cap", def);
    expect(second).toBe(first);
  });
});
