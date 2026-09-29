// F6 — Doors (docs/test-suite-architecture.md F6, P5 errors-as-doors). Resource-cap
// doors: `make-string`/`make-vector` allocation limits, the parser's nesting-depth
// cap, and the execution wall-clock budget. STRONG-replaces the weak assertions in
// `../sandbox-escape.test.ts`'s "CRITICAL: resource exhaustion (DoS vectors)" block
// (per the 2026-07-08 invariant-verdict sweep) — those tests only checked "something threw fast"; these assert
// the ACTUAL teaching-door message, found by reading the real throw sites:
//   - allocation cap: values/op-helpers.ts's `assertAllocatable`
//   - nesting cap: reader/Parser.ts's `_enterNesting`
//   - wall-clock budget: eval/evaluator.ts's `run()` TICK check
//
// All three are, as of this writing, genuine teaching doors already (not engine
// leaks) — verified by reading the throw sites below, not assumed. Per task
// instructions: where a cap turned out to leak a raw engine error instead, the row
// would be `it.fails` with a `// @ledger: weak-door-<name>` comment; none of the
// three needed that treatment.

import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";

describe("F6 doors — resource caps teach (allocation limit)", () => {
  // values/op-helpers.ts's `assertAllocatable(len, fnName)` throws
  // `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`
  // BEFORE allocating (O(1) check) — `make-string`/`make-vector` both call it with
  // their own verb as `fnName`. Default cap is 2^24 (16,777,216); 1e8 is comfortably
  // over it while staying far under V8's own ~2^29/~2^32 engine ceilings, so this
  // exercises OUR policy door, not the engine's accidental one (see
  // sandbox-escape.test.ts's original audit comment for why 1e8 is the right probe
  // value: below V8's cap, above ours).
  it("(make-string 1e8 ...) errors with the allocation-cap teaching message, not an engine leak", async () => {
    await expect(exec("(make-string 100000000 #\\x)")).rejects.toThrow(
      /make-string: requested length \d+ exceeds allocation limit \d+/,
    );
  });

  it("(make-vector 1e8 ...) errors with the allocation-cap teaching message, not an engine leak", async () => {
    await expect(exec("(make-vector 100000000 #f)")).rejects.toThrow(
      /make-vector: requested length \d+ exceeds allocation limit \d+/,
    );
  });
});

describe("F6 doors — resource caps teach (parser nesting depth)", () => {
  // reader/Parser.ts's `_enterNesting` throws `ParseError("input nesting depth
  // exceeded ${maxNestingDepth}", ...)` at PARSE time, before the native JS stack
  // can overflow. Default cap is 2,000 open delimiters; 10,000-deep input blows
  // well past it. This REPLACES sandbox-escape.test.ts's weak assertion (which only
  // checked the message does NOT match /Maximum call stack/, per its own comment
  // "Ideally something like /nest|depth|too deep/i" — that "ideally" is made real
  // here, since the cap already exists and already teaches).
  it("deeply-nested input throws a graceful, named parse-depth door — not a stack overflow", async () => {
    const deep = "(".repeat(10000) + "1" + ")".repeat(10000);
    await expect(exec(deep)).rejects.toThrow(/nest|depth|too deep/i);
    // Doubly-confirms the negative the v1 test asserted: whatever this throws, it
    // is definitely not the native overflow message.
    await expect(exec(deep)).rejects.not.toThrow(/Maximum call stack/i);
  });
});

describe("F6 doors — resource caps teach (wall-clock execution budget)", () => {
  // eval/evaluator.ts's `run()` trampoline throws `ArrivalError("execution budget
  // exceeded (${budgetMs}ms)", ...)` at the TICK cadence once `budgetMs` elapses —
  // an infinite loop is bounded, not left to hang the host. `(let loop () (loop))`
  // is flat under TCO (task #46), so the budget check is what stops it, not a stack
  // overflow racing it.
  it("infinite loop is bounded by a wall-clock budget with a named teaching message", async () => {
    // `budgetMs` in the message is `performance.now() - deadline` arithmetic, so it
    // prints as a float (e.g. "149.9999...ms"), not an integer — match either shape.
    await expect(exec("(let loop () (loop))", { budgetMs: 150 })).rejects.toThrow(
      /execution budget exceeded \([\d.]+ms\)/,
    );
  }, 10000);
});
