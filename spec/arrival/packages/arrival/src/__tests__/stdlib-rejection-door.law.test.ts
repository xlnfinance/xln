// THE STDLIB BOUNDARY REJECTS LIKE A DOOR, NOT LIKE A STACK TRACE.
//
// Reported (real trajectory):
//   (define parsed (detect-parse csv-content))
//   (count parsed)
//   => Error: [ { "code": "custom", "path": [ 0 ], "message": "Invalid input" } ]
//
// That is zod v4's `ZodError.message` — the pretty-printed JSON of `.issues`. It names no verb, no
// argument, and no value. The model cannot act on it; worse, it READS AS A SCHEMA CONSTRAINT rather
// than as a mistake (one model in the 89×2 corpus misread such a dump as an invented `:limit max
// 500` rule and voluntarily shrank its own dataset from 388 records to 80).
//
// The actual fault was ordinary and teachable: SRFI-1's `count` is `(count pred . lists)`, and
// `parsed` is a vector, not a predicate.
//
// ─── WHY IT ONLY HAPPENED HERE ──────────────────────────────────────────────────────────────
//
// `symbol.rosetta` — the TOOL-CALL boundary — has humanized positional rejections since B4
// (rosetta.ts). `symbol.define` — which is EVERY R7RS/SRFI builtin (`count`, `some`, `any?`,
// `last`, `filter`, …) — never got the same treatment. So the tool surface TAUGHT and the entire
// stdlib surface DUMPED RAW ZOD, and nobody noticed because the two were tested separately and
// each looked fine on its own terms. (positional-decode-humanizer.test.ts, this file's sibling,
// covers the ROSETTA path and passed throughout.)
//
// Same formatter, both boundaries now.
//
// ─── AND WHY A `custom` ARM WAS NEEDED ──────────────────────────────────────────────────────
//
// `formatPositionalRejection` already named the type for `invalid_type` and `invalid_union` issues.
// But the PREDICATE primitives in this vocabulary — `z.lambda`, and now `z.listAlike` — are
// `z.custom`, and a custom issue carries NO `expected` field. So every predicate-slot mistake (the
// single most common shape: "you passed the collection where the function goes") degraded to the
// least useful string in the language:
//
//     count: arguments rejected — 1 problem(s):
//       arg 1 — Invalid input
//
// which names the slot but not the fault. The schema knows its own name (`z.lookupName`); the
// formatter simply was not asking.
import { describe, expect, it } from "vitest";

import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { toJS, jsToScheme } from "../membrane/rosetta.js";
import { CONSTANT_CTX } from "../run/RunContext.js";

/** Bindings cross via `jsToScheme`, so `xs` arrives as a borrowed array — exactly what a tool
 *  returning JSON hands the model, which is how the reported trace actually arose. */
const run = async (code: string, bindings: Record<string, unknown> = {}): Promise<string> => {
  try {
    const { values } = await execState(code, {
      env: inferenceEnv.child(
        "stdlib-door",
        Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
      ),
    });
    return `OK ${JSON.stringify(toJS(values[0], {}))}`;
  } catch (e) {
    return `DOOR ${e instanceof Error ? e.message : String(e)}`;
  }
};

const PARSED = { xs: [{ name: "Alice" }, { name: "Bob" }] };

describe("POSITIVE — a stdlib arg rejection is a door that names verb, slot, type, and value", () => {
  it("the reported trace: (count <vector>) — count is (count pred . lists)", async () => {
    const r = await run("(count xs)", PARSED);
    expect(r.startsWith("DOOR")).toBe(true);

    // It must name the VERB — the raw dump did not.
    expect(r).toContain("count");
    // It must name the SLOT.
    expect(r).toContain("arg 1");
    // It must name the EXPECTED type — this is what the `custom` arm buys. Without it, a z.lambda
    // slot degrades to a bare "Invalid input".
    expect(r).toContain("expected lambda");
    // It must name what was ACTUALLY passed, and show it.
    expect(r).toContain("got vector");
    expect(r).toContain("Alice");
  });

  it("the raw ZodError JSON never reaches the model", async () => {
    const r = await run("(count xs)", PARSED);
    // The exact shape of the original defect. If any of these appear, we are back where we started.
    expect(r).not.toContain('"code"');
    expect(r).not.toContain('"path"');
    expect(r).not.toContain("Invalid input");
    expect(r).not.toContain("[\n");
  });

  it("a listAlike slot also names its type (z.listAlike is z.custom too)", async () => {
    const r = await run("(any? even? 42)");
    expect(r).toContain("expected listAlike");
    expect(r).toContain("got number");
  });

  it("an invalid_type slot still names expected + got + value (the pre-existing arm, unbroken)", async () => {
    const r = await run("(last 42)");
    expect(r).toContain("expected APair");
    expect(r).toContain("got number: 42");
  });
});

// ─── THE NEGATIVE SIDE ────────────────────────────────────────────────────────────────────────
//
// A door that fires on CORRECT calls is worse than a raw dump — it breaks working programs. And it
// would be trivially easy to write: wrapping decode in a try/catch that is too eager, or an
// `expected` arm that rejects a shape it should accept. Everything below MUST keep working.
describe("NEGATIVE — the door must not fire on a CORRECT call", () => {
  it("count with a real predicate works, on a pair-list", async () => {
    expect(await run("(count even? '(1 2 3 4))")).toBe("OK 2");
  });

  it("count with a real predicate works, on a TOOL ARRAY (adoption, not rejection)", async () => {
    expect(await run("(count even? xs)", { xs: [1, 2, 3, 4] })).toBe("OK 2");
  });

  it("any?/every? still answer honestly rather than erroring", async () => {
    expect(await run("(any? even? '(1 3 5))")).toBe("OK false");
    expect(await run("(every? odd? '(1 3 5))")).toBe("OK true");
  });

  it("an EMPTY list is a legitimate argument, not a rejection", async () => {
    expect(await run("(count even? '())")).toBe("OK 0");
  });

  it("an EMPTY TOOL ARRAY is likewise legitimate (it adopts to nil, it does not door)", async () => {
    expect(await run("(count even? xs)", { xs: [] })).toBe("OK 0");
  });

  it("last on a genuine non-empty list still returns the last element", async () => {
    expect(await run("(last '(1 2 3))")).toBe("OK 3");
  });

  it("optional arguments stay optional — omitting one is not a rejection", async () => {
    // `member`'s 3rd arg (compare) is optional; a door that demands it would break every call.
    expect(await run("(member 2 '(1 2 3))")).toBe("OK [2,3]");
  });
});
