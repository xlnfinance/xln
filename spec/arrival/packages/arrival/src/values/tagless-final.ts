// tagless-final.ts — the NAME/KEY machinery for arrival's tagless-final algebra.
//
// "Primitives introduce the algebra ('I know how to handle it'); an EnvCapability introduces the
// symbol that hands off to it." The algebra ITSELF — the closed set of operations a primitive MAY
// implement, each with a fixed signature — now lives as OPTIONAL members on `AValue`
// (primitives/AValue.ts), the single source of truth: a value that knows how to map/sort/compare
// declares the matching `arrival/tagless-final/<op>` method and is type-checked there. This file
// holds only the shared PREFIX, the op-name type (DERIVED from AValue), the runtime op-name list
// (pinned to AValue in lock-step), and the `tf()` key builder.
//
// THE DISPATCH CONVENTION (symbol.tagless): a call `(op ...args tail)` lowers to
// `tail["arrival/tagless-final/op"](...args, runCtx)` — the LAST operand is the receiver (it
// carries the algebra), the leading operands are the args, the run's RunContext threads last
// so the term can apply callbacks, read strict, and honor signal through the live run.

import type { AValue } from "./primitives/AValue.js";

/** The ONE spelling of the tagless-final method-name prefix. Every consumer imports THIS. */
const TAGLESS_PREFIX = "arrival/tagless-final/";
type TaglessPrefix = typeof TAGLESS_PREFIX;

type StripTaglessPrefix<K> = K extends `${TaglessPrefix}${infer Op}` ? Op : never;

/** The declared op names — the type-wired range of `symbol.tagless` keys, DERIVED from AValue's
 *  `arrival/tagless-final/<op>` members (the single source of truth). Add an op by declaring its
 *  optional method on AValue and it appears here automatically. */
export type TaglessOp = StripTaglessPrefix<keyof AValue>;

/** Build a prefixed tagless method-name from an op name, type-safe:
 *  `tf("map")` → `"arrival/tagless-final/map"`. The one place callers form the key. */
export function tf<K extends TaglessOp>(name: K): `${TaglessPrefix}${K}` {
  return `${TAGLESS_PREFIX}${name}`;
}

/** The ONE control-form term that lives in the tagless namespace but is NOT an `AValue` op.
 *  It marks the RAW-ARG calling discipline (a macro: unevaluated operands → a replacement form)
 *  the way `tf("apply")` marks the EVAL-ARG discipline (a procedure). It is spelled here for
 *  namespace consistency, but declared as a standalone constant — NOT via `tf()`/`TaglessOp` —
 *  because its carriers (`Macro`/`Syntax`, eval/) are control forms OUTSIDE `SchemeValue`, not
 *  `AValue`s: a macro is never a first-class value, so its dispatch term must not widen the
 *  value algebra. The evaluator's head gate reads it structurally via `is_expandable`. */
export const TF_EXPAND = `${TAGLESS_PREFIX}expand` as const;
