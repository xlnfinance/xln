// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-128 comparators (srfi128-comparators.d.ts) — expect-type
// assertions over the ambient global functions. A comparator is the literal-tagged 4-tuple
//   ['comparator', (x)=>boolean, (a,b)=>boolean, (a,b)=>boolean]
// (written INLINE — PRE forbids a top-level `Comparator<T>` alias). Construction
// and default-comparator pin that exact tuple brand; the relational chain ops and
// `comparator?`/`-hashable?` return boolean exactly → single `.toEqualTypeOf<T>()`.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • default-comparator / make-default-comparator are NULLARY FUNCTIONS that
//     RETURN a comparator — they must be CALLED, not used as a value.
//   • The 4th `hash` arg to make-comparator is accepted (optional) but ignored.
//   • The three preds are NOT cross-parameterised over a shared T in v1 (honest-
//     coarse: type-test `(x:unknown)=>boolean`, equality/ordering `(a,b)=>boolean`).
//   • `=?`/`<?`/… take the comparator FIRST, then variadic values.
// Base vocab (`boolean`/`number`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// the comparator tuple shape, named once for the assertions below
type Cmp = [
  "comparator",
  (x: unknown) => boolean,
  (a: unknown, b: unknown) => boolean,
  (a: unknown, b: unknown) => boolean,
];

// make-comparator with the three predicates → a comparator tuple
expectTypeOf(
  make$dash$comparator(
    (x: unknown): boolean => true,
    (a: unknown, b: unknown): boolean => a === b,
    (a: unknown, b: unknown): boolean => true,
  ),
).toEqualTypeOf<Cmp>();
// 4th hash arg accepted (ignored at runtime) → still a comparator tuple
expectTypeOf(
  make$dash$comparator(
    (x: unknown): boolean => true,
    (a: unknown, b: unknown): boolean => true,
    (a: unknown, b: unknown): boolean => true,
    (x: unknown): number => 0,
  ),
).toEqualTypeOf<Cmp>();

// default comparators are NULLARY functions returning a comparator
expectTypeOf(default$dash$comparator()).toEqualTypeOf<Cmp>();
expectTypeOf(make$dash$default$dash$comparator()).toEqualTypeOf<Cmp>();

// comparator? returns boolean
expectTypeOf(comparator$qmark$(default$dash$comparator())).toEqualTypeOf<boolean>();

// extractors return the bundled predicates
expectTypeOf(comparator$dash$equality$dash$predicate(default$dash$comparator())).toEqualTypeOf<
  (a: unknown, b: unknown) => boolean
>();
expectTypeOf(comparator$dash$ordering$dash$predicate(default$dash$comparator())).toEqualTypeOf<
  (a: unknown, b: unknown) => boolean
>();

// relational chain ops over a comparator + values → boolean
expectTypeOf($eq$$qmark$(default$dash$comparator(), 1, 1)).toEqualTypeOf<boolean>();
expectTypeOf($less$$qmark$(default$dash$comparator(), 1, 2, 3)).toEqualTypeOf<boolean>();
expectTypeOf($greater$$eq$$qmark$(default$dash$comparator(), 3, 2)).toEqualTypeOf<boolean>();
expectTypeOf(comparator$dash$hashable$qmark$(default$dash$comparator())).toEqualTypeOf<boolean>();

// @ts-expect-error default-comparator is a comparator tuple, not a boolean value
const w: boolean = default$dash$comparator();
// @ts-expect-error =? requires a comparator first; a bare number is not a comparator tuple
$eq$$qmark$(5, 1, 1);
make$dash$comparator(
  // @ts-expect-error make-comparator's type-test must be a 1-arg predicate, not a number
  5,
  (a: unknown, b: unknown): boolean => true,
  (a: unknown, b: unknown): boolean => true,
);
// @ts-expect-error comparator-equality-predicate requires a comparator, not a list
comparator$dash$equality$dash$predicate([1, 2, 3]);
