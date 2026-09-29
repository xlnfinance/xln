// ─────────────────────────────────────────────────────────────────────────────
// runtime type-tag predicate family:
//   `boolean?`, `number?`, `string?`, `symbol?`, `pair?`, `list?`, `object?`,
//   `function?`, `array?`, `regex?`, `real?`.
//
// Scheme semantics: each `(<type>? obj)` returns #t iff obj is of that type.
//   (number? x)   → #t iff x is a number (raw, bigint, or boxed Scheme exact/inexact)
//   (string? x)   → #t iff x is a string (raw or SchemeString)
//   (boolean? x)  → #t iff x is a boolean (raw or SchemeBool)
//   (symbol? x)   → #t iff x is a SchemeSymbol
//   (pair? x)     → #t iff x is a cons pair
//   (list? x)     → #t iff x is a proper list
//   (array? x)    → #t iff x is a JS array
//   (object? x)   → #t iff x is a plain object (not pair/string/regex/char/number…)
//   (function? x) → #t iff x is callable
//   (regex? x)    → #t iff x is a RegExp
//   (real? x)     → #t iff x is a real number (finite, non-NaN)
//
// ★ Granularity via TS type-GUARDS (rule 4): where the guard TARGET is expressible
// in PRE vocab, these narrow `unknown` so a guarded branch types precisely:
//   string?  → x is string        number? → x is number      boolean? → x is boolean
//   array?   → x is List<unknown> (Array.isArray)
//   pair?    → x is NonEmptyList<unknown> (the dotted-pair brand)
//   list?    → x is List<unknown> (proper list)
// The rest (`symbol?`, `function?`, `object?`, `regex?`) have no clean PRE brand
// for their target — PRE has no Symbol/Function/RegExp/plain-object alias — so
// they stay plain `(v: unknown): boolean`. `real?` is number-ISH but not exactly
// number (it rejects NaN / non-reals), so narrowing to `x is number` would over-claim;
// kept plain `boolean`.
// ─────────────────────────────────────────────────────────────────────────────

declare function string$qmark$(v: unknown): v is string;
declare function number$qmark$(v: unknown): v is number;
declare function boolean$qmark$(v: unknown): v is boolean;
declare function array$qmark$(v: unknown): v is List<unknown>;
declare function list$qmark$(v: unknown): v is List<unknown>;
declare function pair$qmark$(v: unknown): v is NonEmptyList<unknown>;
declare function symbol$qmark$(v: unknown): boolean;
declare function function$qmark$(v: unknown): boolean;
declare function object$qmark$(v: unknown): boolean;
declare function regex$qmark$(v: unknown): boolean;
declare function real$qmark$(v: unknown): boolean;
