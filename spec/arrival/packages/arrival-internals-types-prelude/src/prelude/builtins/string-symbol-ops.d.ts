// ─────────────────────────────────────────────────────────────────────────────
// symbol↔string + string-indexing / regex string family:
//   `symbol->string`, `string->symbol`, `string-ref`, `substring`, `split`,
//   `join`, `replace`, `search`, `match`, `escape-regex`.
//
// Scheme semantics (R7RS + arrival extensions):
//   (symbol->string sym)        → the symbol's name as a string
//   (string->symbol s)          → the interned symbol named s
//   (string-ref s i)            → the character at index i (a 1-char string;
//                                  nil when out of range)
//   (substring s start [end])   → the substring [start, end) of s
//   (split sep s)               → list of pieces of s split on sep (sep FIRST)
//   (join sep list)             → the list's string elements joined by sep
//   (replace pat repl s)        → s with pat replaced by repl
//   (search pat s)              → the index of the first match of pat in s, or -1
//   (match pat s)               → list of match groups, or #f when no match
//   (escape-regex s)            → s with regex metacharacters escaped
//
//   Inline (highest precedence): `string-ref` = (s,i) => s[i] ?? nil ·
//   `join` = (sep,list) => String(schemeJoin(...)).
//   scheme builtins via SAFE_BUILTINS: substring / split / replace / match / search /
//   repr / escape-regex — these scheme impls WIN over any former Ramda alias.
//
// ★ Precedence corrections that change the signatures:
//   • `search` is NOT a Ramda `find`. SAFE_BUILTINS' arrival
//     `search` (string `.search` → an index) overrides it → returns number.
//   • `split`/`replace`/`match` take (sep|pat) FIRST then the string — scheme arg
//     order — and `split`/`match` return Scheme LISTS (`array->list`), not arrays.
//   • `match` honestly returns `List<string> | boolean`: scheme returns #f on no match,
//     so a downstream list use SHOULD bite — a latent bug, not lens noise (same
//     shape as `string->number`'s `number | boolean`).
//
// `string-ref` returns `string | null`: scheme yields `nil` on an out-of-range index,
// so the absence must be accounted for downstream.
// ─────────────────────────────────────────────────────────────────────────────

declare function symbol$dash$$greater$string(sym: unknown): string;
declare function string$dash$$greater$symbol(s: string): unknown;
declare function string$dash$ref(s: string, i: number): string | null;
declare function substring(s: string, start: number, end?: number): string;
declare function split(separator: string, s: string): List<string>;
declare function join(separator: string, list: List<unknown>): string;
declare function replace(pattern: string, replacement: string, s: string): string;
declare function search(pattern: string, s: string): number;
declare function match(pattern: string, s: string): List<string> | boolean;
declare function escape$dash$regex(s: string): string;
