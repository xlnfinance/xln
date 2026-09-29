// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the type-predicates family. References `/*__arr*/` + ambient PRE
// vocab (../types.d.ts).
//
// For the guard predicates (string?/number?/…) the bite is the NARROWING: we pin
// the predicate target with `expectTypeOf(...).guards.toEqualTypeOf<T>()`, and we
// exercise an in-branch narrowing whose wrong-type use is the `// @ts-expect-error`
// negative. Non-guard predicates just return boolean.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// guard predicates narrow to their target type
expectTypeOf(string$qmark$).guards.toEqualTypeOf<string>();
expectTypeOf(number$qmark$).guards.toEqualTypeOf<number>();
expectTypeOf(array$qmark$).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(list$qmark$).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(pair$qmark$).guards.toEqualTypeOf<NonEmptyList<unknown>>();

// the narrowing threads inside a guarded branch
{
  const v: unknown = "x";
  if (string$qmark$(v)) expectTypeOf(v).toEqualTypeOf<string>();
}
{
  const w: unknown = 1;
  if (number$qmark$(w)) expectTypeOf(w).toEqualTypeOf<number>();
}

// non-guard predicates return boolean
expectTypeOf(symbol$qmark$("x" as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(function$qmark$(0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(object$qmark$(0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(regex$qmark$(0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(real$qmark$(0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(boolean$qmark$(0 as unknown)).toEqualTypeOf<boolean>();

// after string? narrows to string, using it as number bites
{
  const v: unknown = "x";
  if (string$qmark$(v)) {
    // @ts-expect-error narrowed to string, not number
    const n: number = v;
    void n;
  }
}
// after number? narrows to number, using it as string bites
{
  const w: unknown = 1;
  if (number$qmark$(w)) {
    // @ts-expect-error narrowed to number, not string
    const s: string = w;
    void s;
  }
}
