// dict-grammar.ts — the READER grammar of the `{…}` dict literal: the key-admissibility
// predicates only. Reader-layer by nature (Parser validates with these; the infix ban
// door and the evaluator's quasiquote re-instantiation are the other mouths). The NODE
// ITSELF — its type, its detection, its dual data/code nature, and the mint
// (`ADict.fromLiteralForms`) — is ADict's own algebra: see `ADict.isDictLiteral` /
// `DictLiteralNode` / `ADict.fromLiteralForms` (values/primitives/ADict.ts), where the
// `literalForms` field lives.
//
// The dict literal's dual data/code nature (why the node is an ADict, not a distinct AST
// kind — its CODE / `quote` / `quasiquote` faces), the read-time-static-or-unquote key
// shapes, and the AVector-parallel datum face (AJSObject plays no part) are the model of
// `docs/grammar.md §LITERALS`.
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import type { SchemeValue } from "../values/types.js";

/** The SUFFIX-KEYWORD FLIP: at KEY position inside a
 *  `{}` literal, a symbol token with a SINGLE trailing colon is an explicit key
 *  declaration — `{flight_number: "X"}` ≡ `{:flight_number "X"}` (the trailing colon is
 *  the commitment marker, symmetric to the `:x` prefix). Returns the flipped key name,
 *  or null when the datum is not a suffix-key shape (bare symbols stay E-DICT-BAD-KEY —
 *  they could be intended as references; `a::`/`:a`/`:` are not suffix keys). Dict-
 *  literal KEY-position rule only — outside `{}` `foo:` remains a plain symbol. */
export function suffixKeyName(datum: SchemeValue): string | null {
  if (!(datum instanceof ASymbol)) return null;
  const name = typeof datum.__name__ === "string" ? datum.__name__ : String(datum.valueOf());
  if (name.length < 2 || name.startsWith(":") || !name.endsWith(":") || name.endsWith("::")) return null;
  return name.slice(0, -1);
}

/** True iff the datum is an `(unquote …)` form — the one non-static key shape the
 *  literal admits (a quasiquote-substituted key, validated post-substitution). */
export function isUnquoteForm(datum: SchemeValue): boolean {
  if (!(datum instanceof APair)) return false;
  const head = datum.car;
  if (!(head instanceof ASymbol)) return false;
  const name = typeof head.__name__ === "string" ? head.__name__ : String(head.valueOf());
  return name === "unquote";
}
