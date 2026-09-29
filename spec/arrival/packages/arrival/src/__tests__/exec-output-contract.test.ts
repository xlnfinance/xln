/**
 * `exec`'s EXIT CONTRACT (B2, arrival-type-hardening-ladder.md §1.2 — RULED: generic
 * per-form tuple + zod `output` option). The LAST form's unwrapped result validates
 * against the declared schema at the exit boundary; a mismatch throws a teaching door
 * naming expected vs got — the outbound twin of `define/overridable`'s validation.
 * The schema's parse RESULT replaces the last element (transforms apply), which is
 * what makes the output-bearing overload's `[...unknown[], z.output<O>]` honest.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { exec } from "../eval/generator-exec.js";

describe("exec output contract — the exit boundary's outbound validation", () => {
  it("a passing contract hands back the parsed last element (earlier forms untouched)", async () => {
    const results = await exec("(define x 10) (+ x 5)", { output: z.number() });
    expect(results[results.length - 1]).toBe(15);
    // The overload's static shape: last element typed by the schema's output face.
    expectTypeOf(results).toEqualTypeOf<[...unknown[], number]>();
  });

  it("a mismatch throws the teaching door — expected vs got, plus the schema's own issues", async () => {
    await expect(exec('(list "not" "a" "number")', { output: z.number() })).rejects.toThrow(
      /exec output contract: expected .*number.*got/,
    );
  });

  it("schema transforms apply to the returned last element — the static type tells the truth", async () => {
    const results = await exec("(+ 1 2)", { output: z.number().transform((n) => `n=${n}`) });
    expect(results[results.length - 1]).toBe("n=3");
  });

  it("an empty program with a declared output contract doors instead of validating nothing", async () => {
    await expect(exec("", { output: z.number() })).rejects.toThrow(/got NO forms at all/);
  });

  it("the caller-asserted generic tuple composes with no output option — zero runtime change", async () => {
    const [, sum] = await exec<[void, number]>("(define y 1) (+ y 41)");
    expectTypeOf(sum).toEqualTypeOf<number>();
    expect(sum).toBe(42);
  });
});
