import { INTEROP_BOUNDARY } from "../../well-known/symbols.js";

/** Reader-internal "source exhausted" sentinel. Compared by identity against {@link eof}
 *  so the lexer/parser can distinguish end-of-input from any datum (`#f`, `nil`, etc.).
 *  Not a SchemeValue — sibling of DatumReference; `eof-object` is an IO door. */
export class EOF {
  /** Outside AValue — explicit interop stamp (FAMILY RULE misses non-AValue).
   *  `type()` reports `foreign:EOF`. */
  static [INTEROP_BOUNDARY] = true;

  toString(): string {
    return "#<eof>";
  }

  ["arrival/print"](): string {
    return this.toString();
  }
}

/** The one EOF value — identity-compared everywhere; never construct another. */
export const eof = new EOF();
