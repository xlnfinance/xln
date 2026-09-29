// Caveat-sweep finding (2026-06-11): list spine-walking builtins spun forever or
// stack-overflowed on a circular list (the metadata-only have_cycles() can't see
// it). Fixed with an active Floyd cycle check (Pair.isCircularList) that the ops
// guard on: a circular list now terminates (list? → #f) or raises a clean error.
//
// PURITY RE-BASELINE (2026-06-11): set-cdr! is now OMITTED by the purity invariant
// (frozen entities), so a circular list can no longer be CONSTRUCTED by mutation —
// only READ via a datum-label literal (`'#0=(1 2 3 . #0#)`, self-reference in the
// last cdr). That reader path still builds a (frozen) cycle, so the cycle-safety
// guard still matters; the inputs just move from set-cdr! to the reader.
//
// NOTE: each cyclic case must TERMINATE — a regression reintroduces a sync spin
// that hangs the worker (testTimeout can't interrupt a sync loop). That loud hang
// IS the regression signal.
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";

const env = await freshEnv();
// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format,
// e.g. "#f"/"#t") — a boxed-state read, not the SIMPLE tier's plain-JS exit.
const run = async (form: string) => String((await execState(form, { env })).values[0]);
// c = a reader-built circular list: (1 2 3 …) whose last cdr points back at itself.
const cyclic = (op: string) => `(let ((c '#0=(1 2 3 . #0#))) ${op})`;

describe("list ops on a RUNTIME-cyclic list terminate (no spin / stack overflow)", () => {
  it("list? on a circular list → #f", async () => {
    expect(await run(cyclic("(list? c)"))).toBe("#f");
  });

  // circular-doors: op run on the cyclic list rejects. Most report the /circular/i door;
  // append's non-last-arg cycle just needs to reject at all (no specific message pinned).
  it.each([
    {
      title: "length on a circular list raises a clean error",
      op: "(length c)",
      matcher: /circular/i,
    },
    {
      title: "reverse on a circular list raises a clean error (was 'Invalid array length')",
      op: "(reverse c)",
      matcher: /circular/i,
    },
    {
      title: "list-copy on a circular list raises a clean error (was 'Maximum call stack')",
      op: "(list-copy c)",
      matcher: /circular/i,
    },
    {
      title: "memq on a circular list raises a clean error",
      op: "(memq 99 c)",
      matcher: /circular/i,
    },
    {
      title: "append with a circular non-last arg raises",
      op: "(append c (list 9))",
      matcher: undefined,
    },
  ])("$title", async ({ op, matcher }) => {
    if (matcher) {
      await expect(run(cyclic(op))).rejects.toThrow(matcher);
    } else {
      await expect(run(cyclic(op))).rejects.toThrow();
    }
  });
});

describe("acyclic list ops unaffected", () => {
  it.each([
    { title: "list? proper → #t", src: `(list? (list 1 2 3))`, expected: "#t" },
    { title: "list? improper → #f", src: `(list? (cons 1 2))`, expected: "#f" },
    { title: "length proper → 3", src: `(length (list 1 2 3))`, expected: "3" },
    { title: "reverse proper", src: `(reverse (list 1 2 3))`, expected: "(3 2 1)" },
    { title: "list-copy proper", src: `(list-copy (list 1 2 3))`, expected: "(1 2 3)" },
    { title: "member proper finds", src: `(member 2 (list 1 2 3))`, expected: "(2 3)" },
  ])("$title", async ({ src, expected }) => {
    expect(await run(src)).toBe(expected);
  });
});
