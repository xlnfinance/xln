// srfi-95-contract-precision.test.ts — HARVEST-signature precision for srfi-95's `sort` (the
// `Contract.type` author-assertion axis; see srfi-1-contract-precision.test.ts's header). `sort`'s
// optional comparator is `z.custom<(a,b)=>unknown>().optional()`, unrepresentable to zod-to-ts, so
// `signatureOf` collapses the whole op to the degrade path `(...args: unknown[]) => unknown` — hiding
// the arity and the comparator's binary-callable shape. The author-asserted `type` recovers them.
//
// Representation-agnosticism is stated as an overload PAIR — `List<T> → List<T>`,
// `readonly T[] → readonly T[]` — so the receiver's representation is preserved rather
// than blurred to `unknown` (a bare `List` narrowing would falsify vector sorts; `sort`
// dispatches through the receiver's own `arrival/tagless-final/sort`).
// The comparator type mirrors AValue.ts's own declared `(a: unknown, b: unknown) => unknown` for the
// sort protocol — the override states that documented shape, not an invention.
import { describe, expect, it } from "vitest";
import srfi95 from "../srfi-95.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(srfi95.spec.symbols);
function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`srfi-95 pack: no symbol named ${name}`);
  return d;
}

describe("scheme/srfi-95 Contract harvest precision — author-asserted `type:` replaces the z.custom degrade path", () => {
  it("sort: recovers arity + the optional binary comparator as a receiver-preserving overload pair", () => {
    expect(signatureOf(def("sort"))).toBe(`{
  <T>(seq: List<T>, less?: (a: T, b: T) => unknown): List<T>;
  <T>(seq: readonly T[], less?: (a: T, b: T) => unknown): readonly T[];
}`);
  });
});
