/**
 * Reader-macro registry: maps a source prefix (`'`, `` ` ``, `,`, `,@`, `#(`, …) to the
 * SchemeSymbol it expands to and an expansion `type`. The lexer consults this table to
 * recognize special syntax at read time, before the evaluator ever sees a form. The
 * table is FIXED — no runtime add/remove reader-macro verb exists.
 */
import { ASymbol } from "../values/primitives/ASymbol.js";
import { LITERAL } from "../well-known/symbols.js";

export function names() {
  return Object.keys(__list__);
}
export function type(name) {
  try {
    return get(name).type;
  } catch {
    return null;
  }
}
export function get(name) {
  return __list__[name];
}

const defined_specials = [
  ["'", new ASymbol("quote"), LITERAL],
  ["`", new ASymbol("quasiquote"), LITERAL],
  [",@", new ASymbol("unquote-splicing"), LITERAL],
  [",", new ASymbol("unquote"), LITERAL],
  ["#(", new ASymbol("vector"), LITERAL],
  ["#u8(", new ASymbol("bytevector"), LITERAL],
  // Serializer extras: `#attachment "att-N (mime, size)"` is one datum so it can sit in a
  // `{…}` value slot. Bounded (not a user reader-macro) — same LITERAL wrap as quote.
  ["#attachment", new ASymbol("attachment"), LITERAL],
];

export const __builtins__ = Object.freeze(defined_specials.map((arr) => arr[0]));

// Frozen at module-eval — no runtime mutation; `names()`/`get()`/`type()` only read it.
const __list__ = Object.freeze(
  Object.fromEntries(defined_specials.map(([seq, symbol, type]) => [seq, { seq, symbol, type }])),
);
