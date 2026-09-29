// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `number->string` / `string->number` (conversions.d.ts) — the
// R7RS conversion family. expect-type assertions over the ambient global functions; inputs
// are widened literals so the results are exact brands — positives pin with
// `.toEqualTypeOf<T>()`. `string->number` is honestly `number | boolean` (R7RS returns
// #f on a parse failure), so arithmetic on the unchecked result SHOULD bite — that
// is a latent bug, not lens noise. Negatives use `// @ts-expect-error`: a wrong arg
// type bites at the call, a too-narrow result type at the assignment.
// Base vocab (`number`/`string`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// (number->string n [radix]) → the decimal (or radix-) string of n
expectTypeOf(number$dash$$greater$string(42)).toEqualTypeOf<string>();
expectTypeOf(number$dash$$greater$string(255, 16)).toEqualTypeOf<string>();
// (string->number s [radix]) → parsed number, or #f when unparseable → number | boolean
expectTypeOf(string$dash$$greater$number("3.14")).toEqualTypeOf<number | boolean>();

// @ts-expect-error number->string wants a number, not a string
number$dash$$greater$string("x");
// @ts-expect-error string->number may return #f — not silently a precise number
const n: number = string$dash$$greater$number("3");
