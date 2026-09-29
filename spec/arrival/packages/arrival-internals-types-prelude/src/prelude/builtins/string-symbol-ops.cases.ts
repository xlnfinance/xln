// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the string-symbol-ops family (string-symbol-ops.d.ts). expect-type
// assertions over the ambient global functions; inputs are WIDENED string literals so the
// results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite). Negatives use `// @ts-expect-error`: a wrong-typed
// arg bites at the call (2345), a wrong-typed threaded result at the assignment
// (2322); if the signature rots to `any` the line stops erroring and the unused
// directive becomes the failure.
//
// ★ Precedence corrections baked into the asserted return types:
//   • `search` returns number (string `.search` index, NOT ramda `R.find`).
//   • `split`/`replace`/`match` take (sep|pat) FIRST then the string; `split`/`match`
//     return Scheme LISTS. `match` honestly returns `List<string> | boolean` (#f on no
//     match) so a downstream list use SHOULD bite.
//   • `string-ref` returns `string | null` (nil on out-of-range index).
// Base vocab (`string`/`number`/`boolean`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// symbol->string returns string (threading string->symbol's symbol back out)
expectTypeOf(symbol$dash$$greater$string(string$dash$$greater$symbol("x"))).toEqualTypeOf<string>();
// string-ref: string | null — absence accounted for downstream
expectTypeOf(string$dash$ref("hello", 0)).toEqualTypeOf<string | null>();
// substring with optional end → string
expectTypeOf(substring("hello", 1)).toEqualTypeOf<string>();
expectTypeOf(substring("hello", 1, 3)).toEqualTypeOf<string>();
// split → list of strings (sep first)
expectTypeOf(split(",", "a,b,c")).toEqualTypeOf<List<string>>();
// join collapses a list to one string
expectTypeOf(join(", ", ["a", "b"])).toEqualTypeOf<string>();
// replace pattern/replacement/string → string
expectTypeOf(replace("a", "b", "banana")).toEqualTypeOf<string>();
// search → an index (number)
expectTypeOf(search("an", "banana")).toEqualTypeOf<number>();
// match → list of groups OR #f
expectTypeOf(match("a", "banana")).toEqualTypeOf<List<string> | boolean>();
// escape-regex → string
expectTypeOf(escape$dash$regex("a.b")).toEqualTypeOf<string>();

// @ts-expect-error substring needs numeric start, not a string
substring("hello", "x");
// @ts-expect-error split separator/string both strings — number as string arg bites
split(",", 42);
// @ts-expect-error search returns number, not string
const x: string = search("an", "banana");
// @ts-expect-error string-ref index must be number
string$dash$ref("hello", "x");
// @ts-expect-error match may return #f — not silently a precise list
const y: List<string> = match("a", "banana");
// @ts-expect-error join wants a string separator, not a number
join(42, ["a", "b"]);
