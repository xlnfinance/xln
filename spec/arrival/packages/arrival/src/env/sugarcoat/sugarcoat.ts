// scheme/sugarcoat — JS-shaped sugar bindings for the sugarcoat authoring surface.
//
// The sugarcoat *syntax* lens lives in `@inhuman.tools/arrival-sugarcoat` (curly-infix,
// method-dot, etc.). This pack is the matching *runtime* vocabulary: short names models
// reach for from JS/Python that are NOT R7RS, NOT an SRFI, and NOT a Lisp dialect idiom.
// Each binding is a thin alias of a canonical core (or a door that points there).
//
//   **  → expt          (JS/Python exponentiation)
//   %   → remainder     (JS/Python remainder)
//   ==  → =             (JS equality spelling)
//   | & ~ >> <<         → doored (same dragon as R7RS bitwise; use SRFI-151 names)
//
// Not in scheme/numeric (R7RS shelf) — that pack keeps the real names only.
// Registered in BASE_PACKS so the zimmerframe is always present; lineage is honest.

import { EnvCapability } from "../../common/capability.js";
import numeric from "../r7rs/numeric.js";
import lists from "../r7rs/lists.js";

// Same dragon text as scheme/numeric's BITWISE_DOOR (word "dragons" is a test pin).
const BITWISE_DOOR =
  "doored under the one-number representation (safe-integer exacts, no bigints): JS bitwise operators truncate to 32 bits — silent corruption above 2^31; here lieth the dragons. Use the SRFI-151 names (bitwise-and / bitwise-ior / bitwise-xor / bitwise-not / arithmetic-shift) when those land, not the JS spellings";

export default EnvCapability.define("scheme/sugarcoat", {
  // expt / remainder / = live on scheme/numeric; apply on scheme/lists (for == rest).
  deps: [numeric, lists],
  symbols: (symbol, z) => ({
    "**": symbol.define`**: exponentiation — sugarcoat alias of expt (JS/Python spelling)`(
      {
        input: [z.schemeNumber, z.schemeNumber],
        output: [z.schemeNumber],
        type: "(base: number, exponent: number) => number",
      },
      `(lambda (base exponent) (expt base exponent))`,
    ),

    "%": symbol.define`%: remainder — sugarcoat alias of remainder (JS/Python spelling)`(
      {
        input: [z.schemeNumber, z.schemeNumber],
        output: [z.schemeNumber],
        type: "(n: number, d: number) => number",
      },
      `(lambda (n d) (remainder n d))`,
    ),

    "==": symbol.define`==: numeric equality — sugarcoat alias of = (JS spelling)`(
      {
        input: [z.schemeNumber],
        inputRest: z.schemeNumber,
        output: [z.boolean],
        type: "(...args: number[]) => boolean",
      },
      `(lambda args (apply = args))`,
    ),

    "|": symbol.notImplemented`|: bitwise-or sugarcoat spelling — ${BITWISE_DOOR}`,
    "&": symbol.notImplemented`&: bitwise-and sugarcoat spelling — ${BITWISE_DOOR}`,
    "~": symbol.notImplemented`~: bitwise-not sugarcoat spelling — ${BITWISE_DOOR}`,
    ">>": symbol.notImplemented`>>: right-shift sugarcoat spelling — ${BITWISE_DOOR}`,
    "<<": symbol.notImplemented`<<: left-shift sugarcoat spelling — ${BITWISE_DOOR}`,
  }),
});
