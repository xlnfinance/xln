// Static validation sees names bound by `define/overridable`.
//
// The first sweep collected only `define`/`define-macro`/`define-syntax` names, so a program
// that declared a typed input with `define/overridable` and then used it failed validation
// with "Unbound symbol" before anything ran, whenever `staticValidation: "on"`.
import { describe, expect, it } from "vitest";
import { exec } from "../index.js";
import { overridableCapability } from "../env/overridable/overridable.js";

const on = { capabilities: [overridableCapability], staticValidation: "on" } as const;

describe("static validation × define/overridable", () => {
  it("accepts a later reference to an overridable name", async () => {
    const src = `(define/overridable bound (s/integer) 3) (+ bound 1)`;
    expect((await exec(src, on)).at(-1)).toBe(4);
  });

  it("accepts a forward reference from a function body", async () => {
    const src = `(define (twice) (* 2 bound)) (define/overridable bound (s/integer) 5) (twice)`;
    expect((await exec(src, on)).at(-1)).toBe(10);
  });

  it("still reports a genuinely unbound name", async () => {
    const src = `(define/overridable bound (s/integer) 3) (+ bund 1)`;
    await expect(exec(src, on)).rejects.toThrow(/Unbound symbol `bund`/);
  });
});
