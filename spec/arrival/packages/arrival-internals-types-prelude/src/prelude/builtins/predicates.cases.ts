// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`,
// `eq?` (predicates.d.ts). expect-type assertions over the ambient global functions.
// These are NON-guard predicates — each returns an exact `boolean`, so positives pin
// with a single `.toEqualTypeOf<boolean>()` (it rejects a return→any rot on its own).
// Negatives use `// @ts-expect-error`: a wrong-typed arg bites at the call (2345);
// if the signature rots to `any` the line stops erroring and the unused directive
// becomes the failure.
// Base vocab (`number`/`boolean`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// numeric predicates accept number and return boolean
expectTypeOf(zero$qmark$(0)).toEqualTypeOf<boolean>();
expectTypeOf(even$qmark$(4)).toEqualTypeOf<boolean>();
expectTypeOf(odd$qmark$(3)).toEqualTypeOf<boolean>();
// list predicates accept List<unknown> and return boolean
expectTypeOf(null$qmark$([])).toEqualTypeOf<boolean>();
expectTypeOf(empty$qmark$([])).toEqualTypeOf<boolean>();
// not accepts any value and returns boolean
expectTypeOf(not(false)).toEqualTypeOf<boolean>();
// equal? and eq? accept any two values and return boolean
expectTypeOf(equal$qmark$(1, 1)).toEqualTypeOf<boolean>();
expectTypeOf(eq$qmark$("a", "a")).toEqualTypeOf<boolean>();

// @ts-expect-error zero? requires number, not a string
zero$qmark$("hello");
// @ts-expect-error null? requires List<unknown>, not a number
null$qmark$(42);
// @ts-expect-error even? requires number, not a boolean
even$qmark$(true);
