// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `dict` leaf (dict.d.ts) — THE MOAT's record constructor.
// expect-type assertions over the ambient global functions, against `as const` entry-tuples
// (the shape the lens emits), so `(dict :name "a" :age 30)` infers a PRECISE
// ordinary record whose values are LITERALS (`"alice"`, `30`). Each positive is
// pinned by a PAIR — `.toExtend<{…}>()` (the inferred record must extend the
// claimed shape) and `.not.toBeAny()` (the explicit return→any guard, since
// `toExtend` is blind to `any`). Negatives use `// @ts-expect-error`: a wrong value
// type or a claimed-but-absent key bites at the assignment.
// Base vocab (`string`/`number`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// precise inference: keyword entries → precise object shape (literals extend brands)
expectTypeOf(
  dict([
    ["name", "alice"],
    ["age", 30],
  ] as const),
).toExtend<{ name: string; age: number }>();
expectTypeOf(
  dict([
    ["name", "alice"],
    ["age", 30],
  ] as const),
).not.toBeAny();
// single-entry dict
expectTypeOf(dict([["ok", true]] as const)).toExtend<{ ok: boolean }>();
expectTypeOf(dict([["ok", true]] as const)).not.toBeAny();

// @ts-expect-error wrong value type for a known key — age is number, not string
const row: { name: string; age: string } = dict([
  ["name", "alice"],
  ["age", 30],
] as const);
// @ts-expect-error claiming a key the dict does not have (missing property)
const row2: { name: string; age: number; extra: boolean } = dict([
  ["name", "alice"],
  ["age", 30],
] as const);
