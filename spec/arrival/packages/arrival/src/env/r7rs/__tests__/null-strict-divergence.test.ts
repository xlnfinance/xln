// null? — the ONE loose/strict divergence in equality.ts's type-predicate family
// (r7rs/equality.ts). Everywhere else in the predicate family loose and strict agree;
// `null?` alone tolerates an empty BORROWED array (`jsToScheme(ctx, [])` → AJSArray,
// exactly what a required data file or a tool result hands back) as "the empty list" in
// loose mode, and refuses with a teaching PortabilityError in strict mode. A genuine
// scheme vector (`#()`/`(vector)`) is NEVER "the empty list" in either mode — R7RS
// disjointness holds for values that were always vectors; the tolerance is scoped to
// the one value where the vector and list charts converge (the empty JSON array), never
// generalized to vectors at large. This file pins BOTH halves so neither can regress
// into the other: the tolerance widening to real vectors, or the tolerance vanishing
// from loose mode.
//
// Binding convention: an empty borrowed array is minted through `jsToScheme(CONSTANT_CTX,
// [])`, the same frame-mint idiom `listalike-divergence.law.test.ts` uses for its own
// borrowed-array fixtures — CONSTANT_CTX because the binding itself carries no run
// (mirrors every other cross-suite fixture bound this way).
import { describe, expect, it } from "vitest";

import { execOverFrame as exec, execStateOverFrame as execState } from "../../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { jsToScheme } from "../../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { PortabilityError } from "../../../errors.js";

let scratchCounter = 0;
const emptyArrayEnv = () => inferenceEnv.child(`null-strict-${scratchCounter++}`, { xs: jsToScheme(CONSTANT_CTX, []) });

describe("null? on an empty BORROWED array — the loose/strict divergence", () => {
  it("loose (default): (null? xs) on an empty borrowed array is #t", async () => {
    const [r] = await exec(`(null? xs)`, { env: emptyArrayEnv(), strict: false });
    expect(r).toBe(true);
  });

  it("strict: (null? xs) on an empty borrowed array throws PortabilityError", async () => {
    await expect(exec(`(null? xs)`, { env: emptyArrayEnv(), strict: true })).rejects.toThrow(PortabilityError);
  });

  it("strict: the error names the alternative — vector?/vector-length, or adopting the list chart", async () => {
    let caught: unknown;
    try {
      await exec(`(null? xs)`, { env: emptyArrayEnv(), strict: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PortabilityError);
    const err = caught as PortabilityError;
    expect(err.op).toBe("null?");
    // The teaching text names what a caller should check instead — vectorhood, not
    // list-ness — so the message must mention "vector" somewhere in rule+alternative.
    expect(err.message).toMatch(/vector/i);
  });

  it("a NON-EMPTY borrowed array never reaches the tolerance — it is not null? in EITHER mode", async () => {
    const env = inferenceEnv.child(`null-strict-nonempty-${scratchCounter++}`, {
      xs: jsToScheme(CONSTANT_CTX, [1]),
    });
    const [loose] = await exec(`(null? xs)`, { env, strict: false });
    expect(loose).toBe(false);
    const [strict] = await exec(`(null? xs)`, { env, strict: true });
    expect(strict).toBe(false);
  });
});

describe("null? disjointness that must NOT regress: list vs vector never converge outside the borrowed-array tolerance", () => {
  it("(null? (list)) is #t in BOTH modes — the real empty list", async () => {
    const looseEnv = inferenceEnv.child(`null-list-loose-${scratchCounter++}`);
    const [loose] = await exec(`(null? (list))`, { env: looseEnv, strict: false });
    expect(loose).toBe(true);
    const strictEnv = inferenceEnv.child(`null-list-strict-${scratchCounter++}`);
    const [strict] = await exec(`(null? (list))`, { env: strictEnv, strict: true });
    expect(strict).toBe(true);
  });

  it("(null? '()) is #t in BOTH modes — the literal empty list", async () => {
    const looseEnv = inferenceEnv.child(`null-quote-loose-${scratchCounter++}`);
    const [loose] = await exec(`(null? '())`, { env: looseEnv, strict: false });
    expect(loose).toBe(true);
    const strictEnv = inferenceEnv.child(`null-quote-strict-${scratchCounter++}`);
    const [strict] = await exec(`(null? '())`, { env: strictEnv, strict: true });
    expect(strict).toBe(true);
  });

  it("(null? (vector)) is #f in BOTH modes — a genuine scheme vector is never the empty list", async () => {
    const looseEnv = inferenceEnv.child(`null-vector-ctor-loose-${scratchCounter++}`);
    const [loose] = await exec(`(null? (vector))`, { env: looseEnv, strict: false });
    expect(loose).toBe(false);
    const strictEnv = inferenceEnv.child(`null-vector-ctor-strict-${scratchCounter++}`);
    const [strict] = await exec(`(null? (vector))`, { env: strictEnv, strict: true });
    expect(strict).toBe(false);
  });

  it("(null? #()) is #f in BOTH modes — the #() LITERAL form of the same disjointness", async () => {
    const looseEnv = inferenceEnv.child(`null-vector-lit-loose-${scratchCounter++}`);
    const [loose] = await exec(`(null? #())`, { env: looseEnv, strict: false });
    expect(loose).toBe(false);
    const strictEnv = inferenceEnv.child(`null-vector-lit-strict-${scratchCounter++}`);
    const [strict] = await exec(`(null? #())`, { env: strictEnv, strict: true });
    expect(strict).toBe(false);
  });
});

// Boxed-result cell (RULINGS.md R1 discipline — mirrors projection-nil-tolerance.test.ts's
// own `runBoxed`/`toBeInstanceOf` cells): a plain `is_false`-blind read can't distinguish
// "loose null? on an empty borrowed array answered #t" from any other truthy path, so this
// pins the ACTUAL boxed verdict class once, at the COMPLEX (execState) tier.
describe("null? — boxed verdict discipline", () => {
  it("loose: (null? xs) on an empty borrowed array boxes to the shared ABool #t flyweight, not a raw JS true", async () => {
    const { values } = await execState(`(null? xs)`, { env: emptyArrayEnv(), strict: false });
    expect(values[0]?.constructor.name).toBe("ABool");
  });
});
