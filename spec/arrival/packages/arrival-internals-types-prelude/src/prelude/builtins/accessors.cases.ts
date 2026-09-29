// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `@` / `@?` / `@keys` / `@values` / `@entries` accessor family (accessors.d.ts) — the
// A4 field-typo bite. expect-type assertions over the ambient global functions, against
// `as const` object literals (the shape the lens captures), so `(@ obj key)`
// returns a LITERAL `Field<O, K>`. Each literal-returning positive is pinned by a
// PAIR — `.toExtend<Brand>()` (the read's literal must extend its brand) and
// `.not.toBeAny()` (the explicit return→any guard, since `toExtend` is blind to
// `any`). `@?` is an OPEN presence check → boolean exactly; `@keys` → `List<string>`
// exactly — both pinned by a single `.toEqualTypeOf<T>()`. Negatives use
// `// @ts-expect-error`: a mis-key bites at the call (2345), a wrong-typed read at
// the assignment (2322).
// Base types (`Field`/`HasField`/`List`/`number`/`string`/`boolean`) are ambient from
// ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// (@ obj key) is a precise field read (literal extends the brand; never any)
expectTypeOf($at$({ name: "a", age: 30 } as const, "name")).toExtend<string>();
expectTypeOf($at$({ name: "a", age: 30 } as const, "name")).not.toBeAny();
expectTypeOf($at$({ name: "a", age: 30 } as const, "age")).toExtend<number>();
expectTypeOf($at$({ name: "a", age: 30 } as const, "age")).not.toBeAny();

// (@? obj key) is an OPEN presence check → boolean exactly
expectTypeOf($at$$qmark$({ name: "a" } as const, "name")).toEqualTypeOf<boolean>();

// (@keys obj) → the object's own key strings as a list
expectTypeOf($at$keys({ name: "a", age: 30 } as const)).toEqualTypeOf<List<string>>();
// (@values obj) → value union; does not collapse to any
expectTypeOf($at$values({ name: "a", age: 30 })).toEqualTypeOf<List<string | number>>();
expectTypeOf($at$values({ name: "a", age: 30 })).not.toBeAny();
// (@entries obj) → (key, value) tuples; keys are the object's key union
expectTypeOf($at$entries({ name: "a", age: 30 })).toEqualTypeOf<List<Tuple<"name" | "age", string | number>>>();

// @ts-expect-error mis-keyed field — `badkey` is not a key of the object (2345)
$at$({ name: "a", age: 30 } as const, "badkey");
// @ts-expect-error wrong-typing the precise result — `age` is number, not string (2322)
const s: string = $at$({ name: "a", age: 30 } as const, "age");
// @ts-expect-error @keys takes an object, not a primitive
$at$keys(42);
// @ts-expect-error @values takes an object, not a primitive
$at$values(42);
// @ts-expect-error @entries takes an object, not a primitive
$at$entries(42);
