// ─────────────────────────────────────────────────────────────────────────────
// `dict` — the homoiconic record constructor (THE MOAT).
//
// Scheme semantics: (dict :a 1 :b "x") → a record { a: 1, b: "x" } whose keys are
// the keyword keys and whose values are the paired values. The emitter lowers a
// `(dict …)` form to an object literal; the LENS lowers it to a typed
// `__arr.dict([[key, value], …] as const)` so each entry's value type is captured
// precisely and reflected into PRE's `Dict<Pairs>` mapped type.
//
// The `Pairs` type param is captured from the entry-tuple the caller passes
// (often `as const` in tests; the lens itself lowers dict → object literals).
// Constraint is structural (`{0,1}` + length) so both mutable and const-tuple
// entry arrays unify — no PRE `readonly` keyword needed.
// ─────────────────────────────────────────────────────────────────────────────

declare function dict<const Pairs extends { length: number; [n: number]: { 0: string; 1: unknown } }>(
  entries: Pairs,
): { [K in Pairs[number] as K[0] & string]: K[1] };
