// ─────────────────────────────────────────────────────────────────────────────
// `@` / `@?` / `@keys` / `@values` / `@entries` — the keyword/field accessor family
// (the sift moat).
//
// Scheme semantics:
//   (@ obj key)    → the value at `key`, PRECISE (mis-keying bites — A4 keystone).
//   (@? obj key)   → boolean presence check (open key).
//   (@keys obj)    → the object's own key strings, as a list.
//   (@values obj)  → the object's own values, as a list (element = value union).
//   (@entries obj) → the object's own (key, value) pairs, as a list of tuples.
//
// `@` is generic over the object O and the key K (`K extends keyof O`) so a typo'd
// key (`(@ row :badkey)`) bites with 2345, and the result carries the precise
// `Field<O, K>` type so wrong-typing it downstream bites with 2322. `@values` /
// `@entries` stay generic over O so a require-face does not collapse to SchemeValue.
// Runtime returns a vector; PRE List is T[] this pass (list ≡ vector in the lens).
// ─────────────────────────────────────────────────────────────────────────────

declare function $at$<O, K extends keyof O>(obj: O, key: K): Field<O, K>;
declare function $at$$qmark$<O extends object, K extends string>(obj: O, key: K): HasField<O, K>;
declare function $at$keys<O extends object>(obj: O): List<string>;
declare function $at$values<O extends object>(obj: O): List<O[keyof O]>;
declare function $at$entries<O extends object>(obj: O): List<Tuple<keyof O & string, O[keyof O]>>;
