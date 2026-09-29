// vectors-contract-precision.test.ts — RUNTIME proof that the scheme/vectors Contract-
// precision audit's fixes land on the REAL exported ops (not a synthetic mirror — see the
// sibling `vectors.test-d.ts` for the type-level mechanism proofs, which must stay synthetic
// because NativeSymbolDef erases `I`/`O` on any real export). Mirrors numeric-contract-
// precision.test.ts / contract-precision-fixes.test.ts's established pattern: a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run this
// validation during evaluation, so this is a HARVEST/type-surface proof, not a behavior change.
//
// ★A genuine zod subtlety, calibrated empirically against the pinned 4.3.6 (`node -e` against
// the real package, not assumed): `z.schemeValue` (`z.custom<SchemeValue>()`, called with NO
// predicate) accepts EVERYTHING at runtime — byte-identical to the `z.unknown()` it replaces
// (scheme-zod.ts's own doc comment on `value` says this explicitly). So three of the six
// vectors.ts fixes — `vector`'s elements, and `vector-ref`/`vector->list`'s RETURN — have NO
// runtime-observable delta; they are STATIC-ONLY precision gains (the decoded TS type tightens
// from `unknown` to `SchemeValue`), provable only in `vectors.test-d.ts`. `z.svector` DOES carry
// a real predicate (`arrival/tagless-final/vector?` presence, checked structurally), so
// `vector-append`'s elements, `vector-ref`'s vec arg, and `vector-map`/`vector-for-each`'s rest
// elements ARE runtime-discriminating — those three are what this file exercises.
import { describe, expect, it } from "vitest";
import vectorsPack from "../vectors.js";
import dedent from "dedent";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";
import { ANativeProcedure } from "../../../values/primitives/ANativeProcedure.js";

const fn = new ANativeProcedure({
  name: "probe-fn",
  arity: { min: 0, max: null },
  contract: undefined,
  impl: () => undefined as never,
});

const symbols = harvestContracts(vectorsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`vectors pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`vectors pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const realVector = new AVector([]);
const idx = new AExact(0);

describe("scheme/vectors Contract precision — the real exported ops reject wrongly-typed args (z.svector-backed fixes)", () => {
  it("vector-append: elements must be vector-protocol objects — a non-vector used to slip through the old z.array(z.unknown())", () => {
    const def = nativeDef("vector-append");
    expect(def.in.safeParse([realVector, realVector]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector"]).success).toBe(false);
  });

  it("vector-ref: the vec arg (position 0) must be a vector-protocol object — a non-vector used to slip through the old z.unknown()", () => {
    const def = nativeDef("vector-ref");
    expect(def.in.safeParse([realVector, idx]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector", idx]).success).toBe(false);
  });

  it("vector-map: rest (vector) elements must be vector-protocol objects — a non-vector used to slip through the old combined z.tuple([head], z.unknown())", () => {
    const def = nativeDef("vector-map");
    expect(def.in.safeParse([fn, realVector]).success).toBe(true);
    expect(def.in.safeParse([fn, realVector, realVector]).success).toBe(true); // genuinely variadic — 2+ vectors
    expect(def.in.safeParse([fn, "not-a-vector"]).success).toBe(false);
  });

  it("vector-for-each: same rest-precision fix as vector-map", () => {
    const def = nativeDef("vector-for-each");
    expect(def.in.safeParse([fn, realVector]).success).toBe(true);
    expect(def.in.safeParse([fn, "not-a-vector"]).success).toBe(false);
  });
});

describe("scheme/vectors Contract precision — sanity: the six fixed ops still accept well-formed calls", () => {
  // Not a RED/GREEN precision proof (z.schemeValue has no predicate — see the file header) — just
  // confirming the schema tightening didn't accidentally reject a legitimate call shape.
  it("vector: accepts a flat list of scheme values", () => {
    const def = nativeDef("vector");
    expect(def.in.safeParse([idx, realVector]).success).toBe(true);
  });

  it("vector-ref: output accepts any scheme value (representation-blind by design)", () => {
    const def = nativeDef("vector-ref");
    expect(def.out.safeParse([idx]).success).toBe(true);
  });

  it("vector->list: input still gated on z.svector (unchanged); output accepts any scheme value", () => {
    const def = nativeDef("vector->list");
    expect(def.in.safeParse([realVector]).success).toBe(true);
    expect(def.in.safeParse(["not-a-vector"]).success).toBe(false);
    expect(def.out.safeParse([idx]).success).toBe(true);
  });
});

describe("scheme/vectors Contract.type overrides — product ops (element recovery + container bifunctors; zod alone loses T / prints unknown[] | unknown[])", () => {
  it("make-vector: fill T → readonly T[]", () => {
    expect(norm(signatureOf(nativeDef("make-vector")))).toBe(
      norm(dedent`
        {
          <T>(k: number, fill?: T): readonly T[];
        }
      `),
    );
  });
  it("vector: variadic T → readonly T[]", () => {
    expect(norm(signatureOf(nativeDef("vector")))).toBe(
      norm(dedent`
        {
          <T>(...xs: T[]): readonly T[];
        }
      `),
    );
  });
  it("vector-length: readonly unknown[] → number", () => {
    expect(norm(signatureOf(nativeDef("vector-length")))).toBe(
      norm(dedent`
        {
          (v: readonly unknown[]): number;
        }
      `),
    );
  });
  it("vector-ref: element recovery", () => {
    expect(norm(signatureOf(nativeDef("vector-ref")))).toBe(
      norm(dedent`
        {
          <T>(v: readonly T[], k: number): T;
        }
      `),
    );
  });
  it("vector->list: vector T → List<T>", () => {
    expect(norm(signatureOf(nativeDef("vector->list")))).toBe(
      norm(dedent`
        {
          <T>(v: readonly T[], start?: number, end?: number): List<T>;
        }
      `),
    );
  });
  it("list->vector: List<T> → readonly T[]", () => {
    expect(norm(signatureOf(nativeDef("list->vector")))).toBe(
      norm(dedent`
        {
          <T>(xs: List<T>): readonly T[];
        }
      `),
    );
  });
  it("vector->string: char vector → string", () => {
    expect(norm(signatureOf(nativeDef("vector->string")))).toBe(
      norm(dedent`
        {
          (v: readonly string[], start?: number, end?: number): string;
        }
      `),
    );
  });
  it("string->vector: string → char vector", () => {
    expect(norm(signatureOf(nativeDef("string->vector")))).toBe(
      norm(dedent`
        {
          (s: string, start?: number, end?: number): readonly string[];
        }
      `),
    );
  });
  it("vector-copy: slice preserves T", () => {
    expect(norm(signatureOf(nativeDef("vector-copy")))).toBe(
      norm(dedent`
        {
          <T>(v: readonly T[], start?: number, end?: number): readonly T[];
        }
      `),
    );
  });
  it("vector-append: homogeneous concat", () => {
    expect(norm(signatureOf(nativeDef("vector-append")))).toBe(
      norm(dedent`
        {
          <T>(...vs: (readonly T[])[]): readonly T[];
        }
      `),
    );
  });
});

describe("scheme/vectors Contract.type overrides — the harvest signature for the two HOFs whose z.custom callable HEAD is UNREPRESENTABLE (printer throws, degrading the whole signature to `(...args: unknown[]) => unknown` and losing the vector rest + the vector/void return)", () => {
  // vector-map/vector-for-each declare `input: [z.custom<callable>()], inputRest: z.svector`. The
  // callable head is unrepresentable to the harvest printer, so the WHOLE signature degrades to
  // the catch-all — throwing away the proc-first shape, the `readonly unknown[][]` rest (the same
  // image z.svector harvests as everywhere else in this file — cf. vector-append), and the
  // vector / void return. `Contract.type` restores the real shape (callable → `(...args:
  // unknown[]) => unknown`; a void HOF return → bare `void`).
  it("vector-map: proc-first over a vector rest → a new vector", () => {
    expect(norm(signatureOf(nativeDef("vector-map")))).toBe(
      norm(dedent`
        {
          <T, B>(f: (x: T) => B, v: readonly T[]): readonly B[];
          <A, B, R>(f: (a: A, b: B) => R, a: readonly A[], b: readonly B[]): readonly R[];
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: readonly A[], b: readonly B[], c: readonly C[]): readonly R[];
        }
      `),
    );
  });
  it("vector-for-each: proc-first over a vector rest, for effect → void", () => {
    expect(norm(signatureOf(nativeDef("vector-for-each")))).toBe(
      norm(dedent`
        {
          <T>(f: (x: T) => unknown, v: readonly T[]): void;
          <A, B>(f: (a: A, b: B) => unknown, a: readonly A[], b: readonly B[]): void;
          <A, B, C>(f: (a: A, b: B, c: C) => unknown, a: readonly A[], b: readonly B[], c: readonly C[]): void;
        }
      `),
    );
  });
});
