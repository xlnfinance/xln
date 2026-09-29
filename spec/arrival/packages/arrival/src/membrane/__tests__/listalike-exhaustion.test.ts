// B3-REAL (the manifold benchmark-defect register §B3, private monorepo docs +
// LOAD-BEARING CONSTRAINT #1) — the `listAlike` codec is DEAD for scheme-bodied verbs, and the
// consequence is an INFINITE LOOP, not a wrong answer.
//
// The chain, verified against the code:
//   1. `listAlike` (env/srfi/srfi-1.ts) was made a `z.codec` materializing AJSArray → pair-list.
//   2. But its consumers are `symbol.define` (scheme bodies), and define-bake.ts's impl does
//      `if (def.validate) z.decode(def.in, args)` — the decoded value is DISCARDED, and NO verb in
//      the tree sets `validate: true` (0 of 207). So the raw AJSArray (kind="vector") reaches the body.
//   3. `AVector["arrival/tagless-final/cdr"]` returns `new AVector(slice(1))` — on an EMPTY vector it
//      returns ANOTHER EMPTY VECTOR, never ANil. And `null?` is `is_nil`/ANil-only.
//   4. Therefore every body shaped `(if (null? xs) <base> (loop (cdr xs)))` NEVER TERMINATES on a
//      vector — it spins on the empty-vector fixpoint until the test timeout kills the call.
//
// TRIGGER: `(delete-duplicates (any-tool-returning-a-json-array))` — the most ordinary
// compose-in-program idiom there is, over EVERY MCP tool that returns a JSON array. STRICTLY WORSE
// than the clean ZodError reject it replaced.
//
// The previously-shipped regression test was a FALSE GREEN: it only checked `(any? odd? [2,4,6,7])`,
// whose predicate matches on the LAST element — so the walk never reaches the empty tail and the bug
// cannot fire. EVERY case below is chosen to WALK TO EXHAUSTION.
//
// Each test carries an explicit short timeout: a regression must FAIL the test, never hang CI.
import { describe, expect, it } from "vitest";

import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS, jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";

/** `xs` is bound through `jsToScheme`, so it arrives as a real `AJSArray` — exactly what an MCP
 *  tool returning a JSON array hands the model. That receiver is the whole point of this file. */
const run = (code: string, bindings: Record<string, unknown> = {}) =>
  execState(code, {
    env: inferenceEnv.child(
      "listalike-exhaustion",
      Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
    ),
  });

const out = async (code: string, bindings: Record<string, unknown> = {}) => {
  const { values } = await run(code, bindings);
  return toJS(values[0], {});
};

const HANG_GUARD = { timeout: 8000 } as const;

describe("listAlike consumers must TERMINATE on an AJSArray receiver — §B3, constraint #1", () => {
  // Tabular: every row is the same shape — a code string over `xs`, walked to
  // exhaustion, compared against its expected value. `find-tail` (an OR-shaped
  // match, not a single expected value) and the two multi-assertion "must stay
  // green" checks below don't fit this shape and stay as narrative its.
  it.each([
    {
      name: "any? — predicate FALSE for every element (the false-green test matched the LAST element)",
      code: "(any? even? xs)",
      xs: [1, 3, 5],
      expected: false,
    },
    {
      name: "delete-duplicates — the register's canonical trigger",
      code: "(delete-duplicates xs)",
      xs: [1, 2, 1],
      expected: [1, 2],
    },
    {
      name: "fold-right — a right fold walks the whole spine",
      code: "(fold-right + 0 xs)",
      xs: [1, 2, 3],
      expected: 6,
    },
    {
      name: "partition — both arms consume the full spine",
      code: "(partition even? xs)",
      xs: [1, 2, 3, 4],
      expected: [
        [2, 4],
        [1, 3],
      ],
    },
    { name: "delete — removes matches, walks the rest", code: "(delete 2 xs)", xs: [1, 2, 3], expected: [1, 3] },
    {
      name: "append-reverse — consumes the head list to exhaustion",
      code: "(append-reverse xs '())",
      xs: [1, 2, 3],
      expected: [3, 2, 1],
    },
    {
      name: "every? — predicate TRUE for all (must reach the end to answer)",
      code: "(every? odd? xs)",
      xs: [1, 3, 5],
      expected: true,
    },
  ])("$name", HANG_GUARD, async ({ code, xs, expected }) => {
    expect(await out(code, { xs })).toEqual(expected);
  });

  it("find-tail — no match, so it must reach the empty tail to answer", HANG_GUARD, async () => {
    const r = await out("(find-tail even? xs)", { xs: [1, 3, 5] });
    expect(r === false || r === null || (Array.isArray(r) && r.length === 0)).toBe(true);
  });

  it("PRE-EXISTING GREEN must stay green: count / first on an AJSArray", HANG_GUARD, async () => {
    expect(await out("(count even? xs)", { xs: [1, 2, 3, 4] })).toBe(2);
    expect(await out("(first xs)", { xs: [9, 8] })).toBe(9);
  });

  it(
    "proper pair-lists are unaffected — the fix materializes the RECEIVER, never changes list semantics",
    HANG_GUARD,
    async () => {
      expect(await out("(delete-duplicates '(1 2 1))")).toEqual([1, 2]);
      expect(await out("(any? even? '(1 3 5))")).toBe(false);
    },
  );
});
