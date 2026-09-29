// Named-generic printing for the `list`/`cons` collections: List<T> / Tuple<Car, Cdr>.
//
// schema-to-ts.ts's named-generic pre-check sources the `list`/`cons` element registry from the
// scheme-zod vocabulary and prints the ambient carrier reference by name instead of decomposing
// the codec structurally.
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { printType } from "../schema-to-ts.js";

describe("printType — named-generic collections (List<T> / Tuple<Car, Cdr>)", () => {
  it("prints list(string) as List<string>, not the structural Cons<string> | null", () => {
    expect(printType(z.list(z.string))).toBe("List<string>");
  });

  it("prints bare list() as List<SchemeValue> (element defaults to `schemeValue`)", () => {
    expect(printType(z.list())).toBe("List<SchemeValue>");
  });

  it("prints list(char) as List<string> (char's JS image is a 1-char string)", () => {
    expect(printType(z.list(z.char))).toBe("List<string>");
  });

  it("prints cons(string, boolean) as Tuple<string, boolean>, not the structural [string, boolean]", () => {
    expect(printType(z.cons(z.string, z.boolean))).toBe("Tuple<string, boolean>");
  });

  it("a fixed-heads list([A, B]) has no single element → falls through to structural tuple", () => {
    expect(printType(z.list([z.string, z.boolean]))).toBe("[string, boolean]");
  });
});

describe("scheme-zod — COLLECTION_ELEMENT registry (name + element lookup)", () => {
  it("registers list's element schema, resolvable by identity", () => {
    const l = z.list(z.char);
    expect(z.lookupName(l)).toBe("list");
    expect(z.lookupCollectionElement(l)).toBe(z.char);
  });

  it("registers cons's [car, cdr] pair", () => {
    const c = z.cons(z.string, z.boolean);
    expect(z.lookupName(c)).toBe("cons");
    expect(z.lookupCollectionElement(c)).toEqual([z.string, z.boolean]);
  });

  it("resolves the name + element THROUGH a .optional() wrapper (core walk)", () => {
    const wrapped = z.list(z.string).optional();
    expect(z.lookupName(wrapped)).toBe("list");
    expect(z.lookupCollectionElement(wrapped)).toBe(z.string);
  });

  it("returns undefined for a fixed-heads list (no single element)", () => {
    expect(z.lookupCollectionElement(z.list([z.string, z.boolean]))).toBeUndefined();
  });
});
