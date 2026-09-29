// SRFI-151 — bitwise operations. DOORED IN FULL: here lieth the dragons.
//
// See docs/design-history/arrival-one-number-rework.md for the full rationale.
//
// WHY THE DRAGONS: under the one-number representation, scheme exact integers are
// safe-range JS numbers (|x| ≤ 2^53−1) — and JavaScript's native bitwise operators
// (`|` `&` `^` `~` `<<` `>>`) silently coerce their operands to **32 bits** before
// operating. Every bitwise result on a value wider than 2^31 is silent corruption:
// no error, no warning, a confidently wrong number. That is precisely the
// wrong-value class the one-number rework exists to abolish, and correct wide
// bitwise needs the arbitrary-precision ALU the representation deliberately gave up.
//
// Arrival's domain (LLM orchestration — counts, indices, scores, temperatures) has
// produced zero demand for bitwise: no in-repo .scm uses any of these verbs. If a
// real demand ever lands, the honest implementation is split-limb arithmetic over
// safe integers (word = limbs of ≤ 26 bits, ops composed limb-wise) — NEVER the JS
// operators, whose 32-bit truncation is the dragon. Until then: doors, not dragons
// (errors-as-doors — the rejection teaches, a wrong answer doesn't).
//
// The r7rs/numeric.ts pack doors the core five (`bitwise-and`/`bitwise-ior`/
// `bitwise-xor`/`bitwise-not`/`arithmetic-shift`) and the polyglot aliases
// (`|` `&` `~` `>>` `<<`) with the same rationale; this pack doors the one verb it
// ever owned, `bit-count`.

import { EnvCapability } from "../../common/capability.js";

export default EnvCapability.define("scheme/srfi-151", {
  symbols: (symbol) => ({
    "bit-count": symbol.notImplemented`bit-count: doored under the one-number representation (safe-integer exacts, no bigints) — JS bitwise truncates to 32 bits, silent corruption above 2^31; here lieth the dragons. See this file's header and arrival-one-number-rework.md`,
  }),
});
