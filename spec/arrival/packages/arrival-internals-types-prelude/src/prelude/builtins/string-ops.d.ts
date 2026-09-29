// ─────────────────────────────────────────────────────────────────────────────
// `string-append`, `string-length`, `string-upcase`,
//                 `string-downcase`, `string-contains`,
//                 `string=?`, `string-ci=?`,
//                 `string-join`
//
// Scheme semantics:
//   (string-append s ...) → concatenation of all `s` args into one string.
//   (string-length s)     → the number of characters in `s`.
//   (string-upcase s)     → `s` converted to uppercase.
//   (string-downcase s)   → `s` converted to lowercase.
//   (string-contains s sub) → #t/#f whether `sub` appears in `s`.
//   (string=? a b …)      → #t iff all strings are equal (case-sensitive).
//   (string-ci=? a b …)   → #t iff all equal ignoring case (R7RS §6.7).
//   (string-join list [delimiter]) → list of strings folded to one; default
//                                    delimiter is a single space (SRFI-13).
//                                    List-first — not polyglot `join` (sep-first).
//
// Runtime: R7RS family in arrival `env/r7rs/strings.ts`; `string-join` (and
// `string-contains`) in `env/srfi/srfi-13.ts`. Mercury `isBuiltin` already lists
// `string=?` / `string-ci=?` so emit lowers them to ambient calls — these leaves
// are what tsc resolves (metric.scm's `(string-ci=? prediction expected)`).
// LSP `builtinCompletions` harvests `declare function` names from this file, so
// a missing leaf here is a free-name suggestion even though the run env binds
// the verb via BASE_ROSTER.
// // ─────────────────────────────────────────────────────────────────────────────

declare function string$dash$append(...s: string[]): string;
declare function string$dash$length(s: string): number;
declare function string$dash$upcase(s: string): string;
declare function string$dash$downcase(s: string): string;
declare function string$dash$contains(s: string, sub: string): boolean;
declare function string$eq$$qmark$(...s: string[]): boolean;
declare function string$dash$ci$eq$$qmark$(...s: string[]): boolean;
declare function string$dash$join(list: List<string>, delimiter?: string): string;
