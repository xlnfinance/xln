/**
 * SRFI-28 basic format strings (env/srfi/srfi-28.ts) — the string-destination subset.
 *
 * LLM agents reach for `(format ...)` from CL / SRFI-28 training data. This pack binds
 * the pure, string-returning subset honestly: SRFI-28 proper `(format fmt arg ...)`
 * plus the SRFI-48/CL `#f` destination `(format #f fmt arg ...)`. A `#t`/port
 * destination is a teaching door (no IO here). Directives: ~a ~s ~d ~% ~~.
 *
 * The pack is NOT registered globally (srfi/index.ts is single-writer / off-limits), so
 * every test ASSEMBLES the capability explicitly onto a fresh env via `applyCapability`
 * (src/__tests__/_fresh-env.ts) — the EnvCapability idiom from env/__tests__/srfi.test.ts.
 *
 * Provenance discipline mirrors srfi-13-strings.test.ts: format is a COLLAPSING op, so
 * the fresh string carries the union of the fmt string's + every arg's lineage.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../AmbientRuntime.js";
import { execOverFrame, execStateOverFrame } from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { AString } from "../../../values/primitives/AString.js";
import { AValue } from "../../../values/primitives/AValue.js";
import srfi28 from "../srfi-28.js";
import { requireEagerOracle } from "../../../__tests__/_require-eager-oracle.js";

// Q20b: format's provenance assertions run real programs through exec/execState —
// force the oracle ON for this file's lifetime.
requireEagerOracle();

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// A literal-only result comes back as a raw JS string; a provenanced input boxes it to
// an AString. Unwrap either shape to the plain JS value.
const js = (x: unknown) => (x instanceof AValue ? x["arrival/toJS"]() : x);

let seq = 0;
async function run(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = sandboxedEnv.child(`srfi-28-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
  await applyCapability(env, [srfi28]);
  for (const [k, v] of Object.entries(bindings)) env.bind(k, v);
  const [r] = await execOverFrame(src, { env });
  return r;
}

// execState (COMPLEX tier): the provenance cells below assert box discipline
// directly (`toBeInstanceOf(AValue)`, `.provenance` — RULINGS.md R1).
async function runBoxed(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = sandboxedEnv.child(`srfi-28-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
  await applyCapability(env, [srfi28]);
  for (const [k, v] of Object.entries(bindings)) env.bind(k, v);
  const [r] = (await execStateOverFrame(src, { env })).values;
  return r;
}

describe("format — SRFI-28 proper (format fmt arg ...)", () => {
  it.each([
    {
      name: "plain string with no directives is returned verbatim",
      input: '(format "hello world")',
      value: "hello world",
    },
    { name: "~a — display style, string arg", input: '(format "~a" "hi")', value: "hi" },
    { name: "~a — display style, number arg", input: '(format "n=~a" 42)', value: "n=42" },
    { name: "~a — display style, two args", input: '(format "~a and ~a" 1 2)', value: "1 and 2" },
    { name: "~s — write style", input: '(format "~s" 42)', value: "42" },
    { name: "~d — decimal number", input: '(format "~d" 42)', value: "42" },
    { name: "~d — decimal number with label", input: '(format "count: ~d" 7)', value: "count: 7" },
    { name: "~% — newline", input: '(format "a~%b")', value: "a\nb" },
    { name: "~~ — literal tilde", input: '(format "100~~")', value: "100~" },
    { name: "mixed directives fill in order", input: '(format "~a = ~d~%" "x" 5)', value: "x = 5\n" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("format — ~F / ~w,dF fixed-point (SRFI-48 bounded subset)", () => {
  it.each([
    {
      name: "~,2f — no width, 2 decimals (the #1 CL-style habit this door completes)",
      input: '(format "~,2f" 3.14159)',
      value: "3.14",
    },
    {
      name: "~F alone — no width, no decimals, free-format render",
      input: '(format "~f" 3.5)',
      value: "3.5",
    },
    {
      name: "~w,dF — width AND decimals, left-padded with spaces",
      input: '(format "[~8,2f]" 3.14159)',
      value: "[    3.14]",
    },
    {
      name: "width-only (no comma, no decimals) — free-format render, left-padded",
      input: '(format "[~6f]" 3.5)',
      value: "[   3.5]",
    },
    // Rounding follows JS's own `toFixed` semantics (pins implementation, not behavior —
    // a different rounding library would be an equally valid ~f).
    { name: "rounds via toFixed semantics — half rounds up", input: '(format "~,0f" 2.5)', value: "3" },
    { name: "rounds via toFixed semantics — pads decimals", input: '(format "~,2f" 1)', value: "1.00" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });

  it("a genuinely unsupported SRFI-48 directive (~r, radix) still errors, listing ~F in the supported set", async () => {
    await expect(run('(format "~r" 42)')).rejects.toThrow(/unknown directive ~r/);
    await expect(run('(format "~r" 42)')).rejects.toThrow(/~F/);
  });

  it("case-insensitive: ~F and ~f behave identically", async () => {
    const upper = await run('(format "~,1F" 2.25)');
    const lower = await run('(format "~,1f" 2.25)');
    expect(js(upper)).toBe(js(lower));
  });

  it("~,2f with a non-number argument is an error, naming the directive", async () => {
    await expect(run('(format "~,2f" "not-a-number")')).rejects.toThrow(/~,2f directive expects a number/);
  });
});

describe("format — ~s vs ~a on a string (quoted vs bare)", () => {
  it.each([
    { name: "~a renders a string bare", input: '(format "~a" "hi")', value: "hi" },
    { name: "~s renders a string quoted", input: '(format "~s" "hi")', value: '"hi"' },
    {
      name: "~s escapes embedded quotes and backslashes (re-readable write form)",
      input: '(format "~s" "a\\"b")',
      value: '"a\\"b"',
    },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("format — SRFI-48/CL #f destination", () => {
  it.each([
    {
      name: "(format #f fmt arg ...) returns the same string as SRFI-28 — with args",
      input: '(format #f "~a-~a" 1 2)',
      value: "1-2",
    },
    {
      name: "(format #f fmt arg ...) returns the same string as SRFI-28 — no args",
      input: '(format #f "plain")',
      value: "plain",
    },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });

  it("#f destination with a non-string second arg is an error", async () => {
    await expect(run("(format #f 42)")).rejects.toThrow(/format string as its second argument/);
  });
});

describe("format — non-#f destinations are teaching doors (string-only, no IO)", () => {
  it("#t destination is rejected with the IO teaching message", async () => {
    await expect(run('(format #t "~a" 1)')).rejects.toThrow(/string-only/);
    await expect(run('(format #t "~a" 1)')).rejects.toThrow(/no IO surface/);
  });

  it("a non-string, non-#f, non-#t first argument (a port-like value) is rejected too", async () => {
    // A vector stands in for any non-string, non-boolean destination the model might pass.
    await expect(run('(format (vector 1 2) "~a" 1)')).rejects.toThrow(/string-only/);
  });
});

describe("format — directive and arity errors are clear", () => {
  it("unknown directive names the directive and lists the supported five", async () => {
    await expect(run('(format "~z" 1)')).rejects.toThrow(/unknown directive ~z/);
    await expect(run('(format "~z" 1)')).rejects.toThrow(/~a.*~s.*~d.*~%.*~~/);
  });

  it.each([
    { name: "dangling ~ at end of string is an error", input: '(format "abc~")', error: /dangling ~/ },
    {
      name: "too few arguments for the directives",
      input: '(format "~a ~a" 1)',
      error: /too few arguments/,
    },
    {
      name: "too many arguments for the directives",
      input: '(format "~a" 1 2)',
      error: /too many arguments/,
    },
    {
      name: "~d with a non-number argument is an error",
      input: '(format "~d" "not-a-number")',
      error: /~d directive expects a number/,
    },
    { name: "no arguments at all is an error", input: "(format)", error: /expected a format string/ },
  ])("$name", async ({ input, error }) => {
    await expect(run(input)).rejects.toThrow(error);
  });
});

describe("format — provenance (collapsing op, carries the union of fmt + args)", () => {
  it("the result carries an arg's lineage", async () => {
    const r = await runBoxed('(format "hello ~a" name)', { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
    expect(js(r)).toBe("hello Alloy");
  });

  it("the result carries the DEEP union of several stamped args", async () => {
    const r = await runBoxed('(format "~a/~a" a b)', { a: stamped("x", 3), b: stamped("y", 9) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([3, 9]);
    expect(js(r)).toBe("x/y");
  });

  it("a literal-only format carries no provenance (empty-provenance AString)", async () => {
    const r = await runBoxed('(format "~a" "lit")');
    // Boxed under the Face split (taintString always returns the AString scheme face);
    // "no provenance" means an EMPTY provenance set, not a raw unboxed string.
    expect(r).toBeInstanceOf(AValue);
    expect(((r as AValue).provenance as Set<number>).size).toBe(0);
    expect(js(r)).toBe("lit");
  });
});
