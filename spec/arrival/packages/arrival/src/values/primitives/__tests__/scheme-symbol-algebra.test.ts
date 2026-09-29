// Algebras-in-entities migration: Setoid + Ord on SchemeSymbol.
// Setoid mirrors `SchemeSymbol.is` (compares `__name__`); Ord is lexicographic
// over STRING names (gensym ES6-symbol names are an impl edge handled by
// `String(...)` fallback, not part of the law domain here).
import fc from "fast-check";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { ASymbol } from "../ASymbol.js";
import { ordLaws, setoidLaws } from "./algebra-laws.js";

// STRING-named symbols over a small domain so symmetry/transitivity bite, plus
// the hard cases: empty string, unicode, and operator/predicate-style names.
const nameArb = fc.oneof(
  fc.constantFrom("a", "b", "c", "foo", "bar", "+", "list?", "", "λ", "café", "x"),
  fc.string({ minLength: 0 }),
);

const symbolArb = nameArb.map((n) => new ASymbol(n));

// INVARIANT: reflexivity/symmetry/transitivity of symbol equality (by __name__), incl.
// distinct-heap clones (pins implementation, not behavior — compares __name__ directly).
setoidLaws("SchemeSymbol", {
  arb: symbolArb,
  equalClone: (s) => new ASymbol(s.__name__),
});

ordLaws("SchemeSymbol", symbolArb);
