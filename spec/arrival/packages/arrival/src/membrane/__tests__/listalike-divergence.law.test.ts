// THE LIST-CHART LAW — the acceptance gate for the AJSArrayVector/AJSArrayList rework.
//
//   A list verb MUST NOT be able to tell whether its argument arrived as a tool-returned JSON
//   array or as a native pair-list. Same elements in ⇒ same answer out. Always.
//
// This is the manifold law made executable (V, 2026-07-14): "the membrane's design purpose is to
// provide a seamless experience, with adjustments and attunements unnoticeable, in multiple layers
// of computation." A SEAM IS A BUG. This file is the seam detector — one row per verb, the same
// program run twice over the same elements, once through each chart. Every row must agree.
//
// ─── WHY THIS FILE EXISTS (and why the previous two attempts didn't catch it) ────────────────
//
// `listalike-exhaustion.test.ts` (its sibling) pins TERMINATION for the `listAlike`-contracted
// verbs. It is necessary and it is not sufficient — twice now a fix has gone green against a test
// that could not observe the defect:
//
//   1. T1's codec test used `(any? odd? [2,4,6,7])` — the predicate matches the LAST element, so
//      the walk never reaches the empty tail and the infinite loop cannot fire. FALSE GREEN.
//   2. The exhaustion suite's `find-tail` case used a NO-MATCH fixture — which returns `nil` and
//      never exercises the returned tail. With a MATCH, `find-tail` hands back the stopgap's
//      AVector tail, the `z.union([z.pair, z.nil])` OUTPUT contract rejects it, and the model
//      eats a raw ZodError dump. FALSE GREEN — in the very test written to prove the fix.
//
// Both escapes have the same shape: the test asserted a PROPERTY (it terminated / it returned
// something list-ish) instead of asserting the ONE thing that actually matters — that the two
// charts are indistinguishable. A property test can be satisfied by a broken chart. A DIFFERENTIAL
// test cannot: the pair-list arm is the oracle, and it is always right by construction.
//
// So: never assert "the array arm did something reasonable". Assert "the array arm did EXACTLY
// what the list arm did." That is the only formulation the bug cannot hide from.
//
// ─── THE DEFECT CLASS THIS PINS ──────────────────────────────────────────────────────────────
//
// Measured on the stopgap tree (2026-07-14), 13 of 31 list verbs diverge. Three failure modes,
// in ascending order of harm:
//
//   THROWS (8)      find · find-tail · list-ref · list-tail · reverse · for-each · append · last
//                   Loud. A model can read the door and re-plan. Survivable.
//
//   SILENT-WRONG(5) member → #f   ·  list->vector → []  ·  list->string → ""
//                   (null? []) → #f  ·  (delete-duplicates []) → '(())
//                   CATASTROPHIC. `(member x results)` answers "#f — not found" about a list that
//                   CONTAINS x. The model has no way to know it was lied to; it will confidently
//                   report the wrong answer to the user. This is the defect register's governing
//                   diagnosis ("the return channel lies, and we are selecting against the models
//                   that trust it") relocated into the LIST SURFACE ITSELF.
//
// ROOT CAUSE (one line): a tool array arrives as the vector chart, and ~14 native list verbs
// declare `z.union([z.pair, z.nil])` — a contract that ADMITS NO ARRAY — while `symbol.native`
// contracts are type-only and never validated at runtime (srfi-1.ts:199-202). So the array sails
// past the unenforced contract into an impl that FIELD-READS `.car`/`.cdr` (findImpl,
// srfi-1.ts:208-221) on a class that has no such member ⇒ `undefined` ⇒ void, empty, or #f.
// srfi-1.ts:45 even calls that union "SHALLOW pair-or-nil (listAlike)" — the two were conflated in
// the comments long before they diverged in the code.
//
// THE FIX THIS GATE ACCEPTS: the contract names the chart. The
// `z.union([z.pair, z.nil])` INPUT slots adopt to `listAlike`, and adoption mints an
// `AJSArrayList` view (extends APair, lazy car/cdr, exhaustion → ANil at MINT). The impls then
// field-read a real APair subclass and are correct by construction. Empty array adopts to `nil`,
// which is the only thing that can ever make `(null? xs)` honest — `null?` is `instanceof ANil`
// and no term-level tolerance can fake that.
//
// ─── STATUS ──────────────────────────────────────────────────────────────────────────────────
//
// RED until the rework lands. That is intentional and correct: this file is the specification of
// DONE. Do not weaken a row to make it pass — a weakened row is how the last two false greens got
// written. If a row here is red, the medium is still lying to the model.
import { describe, expect, it } from "vitest";

import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS, jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";

/** A hang is a FAILURE, never a CI wall-clock death: the walk is raced against a deadline and the
 *  loser is reported as a value we can assert on. (The original B3 bug was an infinite loop — a
 *  suite that hangs instead of failing teaches nobody anything.) */
const DEADLINE_MS = 4000;

const runOne = async (code: string, bindings: Record<string, unknown>): Promise<string> => {
  try {
    const { values } = await Promise.race([
      execState(code, {
        env: inferenceEnv.child(
          "listalike-divergence",
          Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
        ),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("__DEADLINE__")), DEADLINE_MS)),
    ]);
    return `OK ${JSON.stringify(toJS(values[0], {}))}`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Errors are normalized to their FIRST LINE: the two charts may legitimately word a door
    // differently, but a verb that succeeds on one chart and throws on the other is a seam
    // regardless of the wording — and that is what the assertion below compares.
    return message.includes("__DEADLINE__") ? "HANG (infinite walk)" : `THREW ${message.split("\n")[0].slice(0, 60)}`;
  }
};

/** Render a JS fixture as the equivalent scheme pair-list LITERAL — the oracle arm. Chars are
 *  written `#\a` so `list->string` has real chars to fold, exactly as its contract wants. */
const asPairListLiteral = (xs: readonly unknown[]): string =>
  `'(${xs.map((x) => (typeof x === "string" ? `#\\${x}` : String(x))).join(" ")})`;

/** `xs` is bound through `jsToScheme` ⇒ it arrives as the borrowed VECTOR chart, which is exactly
 *  and only what an MCP tool returning a JSON array hands the model. That receiver is the point. */
const bothCharts = async (code: string, fixture: readonly unknown[]) => ({
  viaToolArray: await runOne(code, { xs: fixture }),
  viaPairList: await runOne(code.replace(/\bxs\b/g, asPairListLiteral(fixture)), {}),
});

/** [verb, program over `xs`, fixture] — the fixture is chosen so the verb WALKS TO EXHAUSTION or
 *  MATCHES, never short-circuits on the head. (Short-circuiting fixtures are how both prior false
 *  greens were written.) */
const CASES: readonly (readonly [string, string, readonly unknown[]])[] = [
  // --- verbs contracted `z.union([z.pair, z.nil])`: the array is admitted by no clause, and the
  //     contract is not enforced at runtime, so the impl field-reads `undefined`. -------------
  ["find", "(find even? xs)", [1, 2, 3]],
  ["find-tail (MATCH — returns a tail, the case the exhaustion suite missed)", "(find-tail even? xs)", [1, 2, 3]],
  ["member", "(member 2 xs)", [1, 2, 3]],
  ["list-ref", "(list-ref xs 1)", [1, 2, 3]],
  ["list-tail", "(list-tail xs 1)", [1, 2, 3]],
  ["list->vector", "(list->vector xs)", [1, 2, 3]],
  // NOTE: `list->string` is deliberately ABSENT from this matrix, and the reason is worth writing
  // down. It cannot be tested cross-chart: JSON has no character type, so a tool array can never
  // hold the `#\a` values a pair-list arm would — the two arms cannot carry the same value, and any
  // row comparing them is ill-posed by construction. Trying to write it anyway is what exposed the
  // `charValue` blind cast (op-helpers.ts), which is pinned on its own terms below instead.
  ["reverse", "(reverse xs)", [1, 2, 3]],
  ["for-each", "(for-each (lambda (x) x) xs)", [1, 2, 3]],
  ["append", "(append xs '(9))", [1, 2]],
  ["last", "(last xs)", [1, 2, 3]],

  // --- the EMPTY array: the case no term-level tolerance can ever fix, because `null?` is
  //     `instanceof ANil`. Only mint-time adoption (empty ⇒ nil) makes these honest. ----------
  ["null? on empty", "(null? xs)", []],
  ["delete-duplicates on empty", "(delete-duplicates xs)", []],
  ["length on empty", "(length xs)", []],
  ["reverse on empty", "(reverse xs)", []],

  // --- verbs already `listAlike`-contracted. GREEN TODAY — pinned so the rework cannot regress
  //     them while fixing the rows above. -------------------------------------------------------
  ["map", "(map (lambda (x) (* x 2)) xs)", [1, 2, 3]],
  ["filter", "(filter even? xs)", [1, 2, 3]],
  ["reduce", "(reduce + 0 xs)", [1, 2, 3]],
  ["fold-right", "(fold-right + 0 xs)", [1, 2, 3]],
  ["delete-duplicates", "(delete-duplicates xs)", [1, 2, 1]],
  ["delete", "(delete 2 xs)", [1, 2, 3]],
  ["partition", "(partition even? xs)", [1, 2, 3, 4]],
  ["any? (NO match — must walk to exhaustion)", "(any? even? xs)", [1, 3, 5]],
  ["every? (ALL match — must walk to exhaustion)", "(every? odd? xs)", [1, 3, 5]],
  ["count", "(count even? xs)", [1, 2, 3, 4]],
  ["sort", "(sort xs <)", [3, 1, 2]],
  ["car", "(car xs)", [1, 2, 3]],
  ["cdr", "(cdr xs)", [1, 2, 3]],
  ["length", "(length xs)", [1, 2, 3]],
  ["first", "(first xs)", [9, 8]],
  ["list-copy", "(list-copy xs)", [1, 2, 3]],
];

describe("LAW: no list verb may distinguish a tool array from a pair-list", () => {
  it.each(CASES.map(([verb, program, fixture]) => ({ verb, program, fixture })))(
    "$verb — $program",
    { timeout: DEADLINE_MS * 3 },
    async ({ verb, program, fixture }) => {
      const { viaToolArray, viaPairList } = await bothCharts(program, fixture);
      // A hang is a failure of THAT arm, never a comparable value — two HANG strings
      // would otherwise equal and the row would go green under load.
      expect(viaToolArray.startsWith("HANG"), `${verb} tool-array hung`).toBe(false);
      expect(viaPairList.startsWith("HANG"), `${verb} pair-list hung`).toBe(false);
      // The pair-list arm is the ORACLE. Asserting equality (rather than asserting some property
      // of the array arm) is what makes this test unable to go falsely green: there is no
      // "reasonable-looking" wrong answer that can satisfy it.
      expect({ verb, viaToolArray }).toEqual({ verb, viaToolArray: viaPairList });
    },
  );
});

// A coercion helper may never answer with a value it had to invent. `charValue` did: it was a blind
// `(x as ACharacter).__char__`, so a non-character read `undefined` — and its only caller does
// `chars.join("")`, which turns `undefined` into `""` and destroys the evidence. `(list->string
// '(1 2))` therefore answered THE EMPTY STRING: not an error, not a wrong string, but a value
// indistinguishable from the correct answer over an empty list.
//
// Same class as the `String(nil)` → `"()"` bug in `stringValue` (B1) — which sits directly above it
// in the same file, and whose audit swept its own call sites without ever turning to look at its
// neighbour. Pinned here so the class, not just the instance, stays closed.
describe("LAW: a coercion helper refuses, it never invents (charValue — B1's sibling)", () => {
  it('(list->string \'(1 2)) must NOT silently answer ""', { timeout: DEADLINE_MS }, async () => {
    const r = await runOne("(list->string '(1 2))", {});
    expect(r).not.toBe('OK ""');
    expect(r.startsWith("THREW")).toBe(true);
  });

  it("a genuine character list still works", { timeout: DEADLINE_MS }, async () => {
    expect(await runOne("(list->string (list #\\a #\\b))", {})).toBe('OK "ab"');
  });
});

// ─── THE SAME LAW, ON THE VECTOR SURFACE ────────────────────────────────────────────────────
//
// A tool array arrives as the VECTOR chart, so it must be indistinguishable from a `#(1 2 3)`
// literal to every vector verb — same elements in, same answer out.
//
// This caught a live, pre-existing bug that had nothing to do with the list rework. `z.vector` is a
// union of two codecs, and they decoded into DIFFERENT WORLDS: the `AVector` arm yielded `__vector__`
// (boxed AValues, which the element codec can then decode), while the `AJSArray` arm yielded the raw
// `.source`. Since the element schema is a SCHEME-face codec (`z.schemeValue` demands an AValue), raw JSON
// elements failed validation every time — so every `symbol.define` verb contracted on `z.vector`
// (SRFI-43's vector-fold / vector-count / vector-index / vector-any / …) threw a raw ZodError on ANY
// tool-returned array, while working fine on a literal. The vector NATIVES (vector-ref/-length/-map)
// kept working, because `symbol.native` never validates — which is precisely what hid the split.
//
// It stayed green because the law fixture put boxed AStrings into a borrowed `source` — a value
// production cannot construct. The one arrangement under which that decode succeeded was the one
// arrangement that cannot exist. Pinned here so the two arms can never drift apart again.
const VECTOR_CASES: readonly (readonly [string, string, readonly unknown[]])[] = [
  [
    "vector-fold (symbol.define + z.vector — the family that threw)",
    "(vector-fold (lambda (acc e) (+ acc e)) 0 xs)",
    [1, 2, 3],
  ],
  ["vector-fold-right", "(vector-fold-right (lambda (acc e) (+ acc e)) 0 xs)", [1, 2, 3]],
  ["vector-count", "(vector-count even? xs)", [1, 2, 3, 4]],
  ["vector-index", "(vector-index even? xs)", [1, 2, 3]],
  ["vector-ref (native — never validated, so it always worked)", "(vector-ref xs 1)", [1, 2, 3]],
  ["vector-length", "(vector-length xs)", [1, 2, 3]],
  ["vector-map", "(vector-map (lambda (x) (* x 2)) xs)", [1, 2, 3]],
  ["vector-append", "(vector-append xs xs)", [1, 2]],
  ["vector->list", "(vector->list xs)", [1, 2, 3]],
  ["vector?", "(vector? xs)", [1, 2, 3]],
];

/** The oracle arm: the same elements as an R7RS vector LITERAL. */
const asVectorLiteral = (xs: readonly unknown[]): string => `#(${xs.map(String).join(" ")})`;

describe("LAW: no vector verb may distinguish a tool array from a #(…) literal", () => {
  it.each(VECTOR_CASES.map(([verb, program, fixture]) => ({ verb, program, fixture })))(
    "$verb — $program",
    { timeout: DEADLINE_MS * 3 },
    async ({ verb, program, fixture }) => {
      const viaToolArray = await runOne(program, { xs: fixture });
      const viaLiteral = await runOne(program.replace(/\bxs\b/g, asVectorLiteral(fixture)), {});
      expect({ verb, viaToolArray }).toEqual({ verb, viaToolArray: viaLiteral });
    },
  );
});
