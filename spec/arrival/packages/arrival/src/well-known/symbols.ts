// well-known/symbols.ts — ONE `Symbol.for` registry for arrival core.
//
// These brands are cross-cutting: set on one value/class, read polymorphically
// elsewhere (often by code that can't import the defining class). One registry
// of `Symbol.for(...)` keys gives every reader the same identity without a
// shared nominal type, and keeps brands off the object's enumerable surface.
//
// Naming: `Symbol.for("arrival/<name>")` namespaces brands in the global symbol
// registry so an unrelated `Symbol.for("data")` elsewhere can never collide.
// Exceptions keep the historical wire key (LOCATION, INTEROP_BOUNDARY, merge,
// reader/lexer intern names, ASymbol hidden slots) — renaming severs remints.
//
// Dynamic interns stay at the call site: `Symbol.for(token)` (lexer),
// `Symbol.for(name)` (hidden_prop), `Symbol.for("arrival/single-load/…")`.
// The key is data, not a brand. Module-local `Symbol(...)` (NOT_FOUND,
// OFFENDING_VALUE) is unforgeable on purpose — not this file.
//
// Importable from anywhere — a leaf by construction (zero imports).

// ── value stamps ────────────────────────────────────────────────────────────

/** Quoted data (`(quote …)`). Evaluator treats a marked Pair/symbol/array as a literal. */
export const DATA = Symbol.for("arrival/data");

/** Cycle-printing back-reference label (`#1=` … `#1#`) on a Pair. */
export const REF = Symbol.for("arrival/ref");

/** Detected cyclic edges on a Pair (`{ car?, cdr? }`), used by the printer. */
export const CYCLES = Symbol.for("arrival/cycles");

/**
 * Source location stamped on located Pairs by the parser.
 *
 * Wire key is `"__location__"` (not `arrival/location`): sibling packages
 * (`arrival-chain`, `arrival-provenance`) remint without importing the
 * interpreter — `Symbol.for("__location__")` and
 * `symbol.description === "__location__"`. Renaming severs those reads.
 */
export const LOCATION = Symbol.for("__location__");

// ── membrane ────────────────────────────────────────────────────────────────

/**
 * Opt-in interop-boundary stamp on a host class / prototype.
 * Wire key is `"scheme:interop-boundary"` (historical). Re-exported from
 * `membrane/interop-access.ts` as the stamp consumers already import.
 */
export const INTEROP_BOUNDARY = Symbol.for("scheme:interop-boundary");

// ── hygiene / frames ────────────────────────────────────────────────────────

/** Merge-frame identity. `Syntax.__merge_env__` and `LexicalScope.kind` compare this. */
export const MERGE = Symbol.for("merge");

// ── reader specials ─────────────────────────────────────────────────────────

/** Prefix expands to a single quoted/wrapped datum (`'x` → `(quote x)`). */
export const LITERAL = Symbol.for("literal");

/** Symbol token / lexer symbol-state. Reader specials and `Lexer.symbol` use this. */
export const SYMBOL = Symbol.for("symbol");

/** Kleene-star intern (`*`). */
export const GLOB = Symbol.for("*");

// ── ASymbol hidden slots ────────────────────────────────────────────────────
// `unique symbol` annotation so `declare [ASymbol.literal]` is a typed field
// (esbuild rejects a broad symbol index). `hidden_prop(obj, "__literal__", …)`
// remints the same registry key.

/** Gensym literal name slot. Written by `hidden_prop(..., "__literal__", name)`. */
export const ASYMBOL_LITERAL: unique symbol = Symbol.for("__literal__");

/** Gensym dotted-path slot. Written by `hidden_prop(..., "__object__", path)`. */
export const ASYMBOL_OBJECT = Symbol.for("__object__");

// ── lexer FSM ───────────────────────────────────────────────────────────────
// Interned so a syntax-extension (or a second Lexer evaluation) can name the
// same states. `symbol` is {@link SYMBOL} — one registry key, two faces.

export const LexerState = {
  string: Symbol.for("string"),
  string_escape: Symbol.for("string_escape"),
  symbol: SYMBOL,
  comment: Symbol.for("comment"),
  character: Symbol.for("character"),
  bracket: Symbol.for("bracket"),
  b_symbol: Symbol.for("b_symbol"),
  b_symbol_ex: Symbol.for("b_symbol_ex"),
  b_comment: Symbol.for("b_comment"),
  i_comment: Symbol.for("i_comment"),
  l_datum: Symbol.for("l_datum"),
  dot: Symbol.for("dot"),
} as const;
