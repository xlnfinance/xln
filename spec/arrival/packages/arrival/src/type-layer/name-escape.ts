// name-escape — the scheme-symbol-name ⇄ TS-identifier bifunctor lens.
//
// Scheme symbols range over far more than TS identifiers: `nil?`, `list->vector`, `+`, `1+`,
// `set!`. The lens compiles a lowered program against an ambient prelude, so every grant symbol
// must be NAMEABLE in TS — and not as a string key (`_["nil?"]`), because a `typeof` type query
// cannot bracket-index (only walk a dotted entity name) and the LSP cannot autocomplete a string
// index. So each non-identifier name is ESCAPED into a valid TS identifier and exposed as a
// DOTTED member (`_.nil$question$`): `typeof _.nil$question$` is legal, and `_.<TAB>` autocompletes.
//
// THE LENS (predicate-safe, stable iso):
//   • escapeName : scheme-name → TS-identifier      (forward)
//   • unescapeName: TS-identifier → scheme-name      (backward)
//   • LAW (round-trip): unescapeName(escapeName(x)) === x  for every scheme name x.
//   • IMAGE: escapeName(x) is ALWAYS a valid TS identifier (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`).
//   • FIXED POINT: an already-identifier-safe name passes through unchanged (`get_route` ⇄
//     `get_route`); only `-?!+./…`-bearing names move. Deterministic.
//
// `$` is the escape sigil — never occurs in a scheme symbol, so it's unambiguous (a literal `$`
// round-trips through `$dollar$`). Each non-identifier char becomes a `$token$`: a NAMED token
// for the R7RS extended set (`?`→`question`, readable), a bare digit for a leading digit
// (`1+`→`$1$plus$`), and a `$u<hex>$` codepoint fallback for the long tail.

/** The R7RS extended-identifier specials, named for readability. `_` is identifier-safe (never
 *  escaped); the un-named long tail (`'"()[]{}|\;,` space, …) routes through the `u<hex>` fallback,
 *  keeping the lens TOTAL without an exhaustive table. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ["!", "bang"],
  ["#", "hash"],
  ["$", "dollar"],
  ["%", "percent"],
  ["&", "amp"],
  ["*", "star"],
  ["+", "plus"],
  ["-", "dash"],
  [".", "dot"],
  ["/", "slash"],
  [":", "colon"],
  ["<", "lt"],
  ["=", "eq"],
  [">", "gt"],
  ["?", "question"],
  ["@", "at"],
  ["^", "caret"],
  ["~", "tilde"],
]);
const FROM_NAMED: ReadonlyMap<string, string> = new Map([...NAMED].map(([c, w]) => [w, c]));

/** A name that is already a valid TS identifier AND free of the `$` sigil — a fixed point of the
 *  lens (escape = id). The regex excludes `$`, so any `$`-bearing name is (re-)escaped. */
const IDENTIFIER = /^[A-Z_]\w*$/i;

/** ECMAScript RESERVED WORDS — never printable as a bare identifier/head, even though they match
 *  the `IDENTIFIER` char regex: `for`/`class`/`new`/`return`/… as a plain identifier or CALL head
 *  (`for(...)`) is a PARSE ERROR (the token starts a statement, not an expression). A scheme
 *  symbol equal to one of these is perfectly legal; the lexical IDENTIFIER position is not — so
 *  these are excluded from `isTsIdentifier`, routed through the escaped, dotted `_` member path
 *  instead (`_.for`, a legal property access). Deliberately NARROW: TS's *contextual* keywords
 *  (`any`, `string`, `type`, `declare`, `as`, `is`, `infer`, `keyof`, `readonly`, `undefined`, …)
 *  are NOT reserved (`const string = 1` is valid TS) and stay OUT — over-escaping them would be
 *  harmless but pointless, and this set's job is exactness. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // strict-mode reserved (every emitted TS file is a module ⇒ strict):
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

/** Is `name` a fixed point of the lens (passes through escape unchanged) — a valid TS
 *  identifier char-shape that is ALSO not an ECMAScript reserved word? */
export function isTsIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/** The `$token$` for one non-identifier char (or a leading digit): a named word, a bare digit, or
 *  a `u<hex>` codepoint fallback. */
function tokenFor(ch: string): string {
  const named = NAMED.get(ch);
  if (named !== undefined) return named;
  if (ch >= "0" && ch <= "9") return ch; // a leading digit — a bare-digit token
  return `u${ch.codePointAt(0)!.toString(16)}`; // total fallback for the long tail
}

function charFor(token: string): string {
  const named = FROM_NAMED.get(token);
  if (named !== undefined) return named;
  if (token.length === 1 && token >= "0" && token <= "9") return token;
  if (token.startsWith("u")) return String.fromCodePoint(Number.parseInt(token.slice(1), 16));
  return token; // unreachable for well-formed escaped names; identity is the safe default
}

/**
 * Forward leg of the lens: a scheme symbol name → a valid TS identifier. Each char that is not
 * `[A-Za-z0-9_]` — and a LEADING digit — becomes a `$token$`, so the result always starts with
 * `[A-Za-z_$]` and is a valid TS id.
 */
export function escapeName(name: string): string {
  if (isTsIdentifier(name)) return name;
  let out = "";

  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    const isIdentChar = /\w/.test(ch);
    // a mid-name digit/letter/underscore is literal; a special char — or a LEADING digit (i === 0,
    // which can't start an identifier) — becomes a token.
    out += isIdentChar && !(i === 0 && ch >= "0" && ch <= "9") ? ch : `$${tokenFor(ch)}$`;
  }
  return out;
}

/** A `$token$` run: a named word, a bare digit, or a `u<hex>` codepoint. */
const TOKEN = /\$([a-z][a-z0-9]*|\d|u[0-9a-f]+)\$/g;

/**
 * Backward leg of the lens: a TS identifier (an escaped name) → the original scheme symbol name.
 * Literal identifier runs pass through; each `$token$` decodes via `charFor`.
 */
export function unescapeName(escaped: string): string {
  return escaped.replaceAll(TOKEN, (_, token: string) => charFor(token));
}
