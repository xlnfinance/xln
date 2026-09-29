/**
 * The carrier table — F1's column axis (docs/test-suite-architecture.md F1).
 *
 * Every term×carrier cell is either implemented (and then obeys the term's declared
 * box discipline — P8) or an EXPLICIT `unsupported` entry. Absence is not a state:
 * the DR4 divergence hid in an absent cell.
 */
export interface CarrierRow {
  readonly carrier: "APair" | "AVector" | "AJSArray" | "AString" | "ADict" | "ABytevector";
  /** scheme source snippet minting a 3-element instance with stamped elements */
  readonly mint3: string;
  /** terms this carrier deliberately does NOT implement, with the teaching reason */
  readonly unsupported: readonly { term: string; reason: string }[];
}

export const CARRIERS: readonly CarrierRow[] = [
  { carrier: "APair", mint3: "(list (src 1) (src 2) (src 3))", unsupported: [] },
  { carrier: "AVector", mint3: "(vector (src 1) (src 2) (src 3))", unsupported: [] },
  {
    carrier: "AJSArray",
    mint3: "(borrow-array (src 1) (src 2) (src 3))", // via membrane fixture, not a scheme verb
    // `concat` is deliberately NOT listed here even though AJSArray has no
    // arrival/tagless-final/concat method and no dedicated "array-append" verb either: the
    // only available verb (`append`, verbs[0]) doesn't door for a non-pair operand — it
    // silently returns the SECOND operand unchanged, discarding the first (a P5 "fails
    // loudly" violation, not a clean unsupported cell). See the grid body's own note there.
    unsupported: [],
  },
  {
    carrier: "AString",
    mint3: "(string (src #\\a) (src #\\b) (src #\\c))",
    // AString declares NO arrival/tagless-final/{car,cdr,filter,reduce,sort} at all (unlike
    // AVector, which implements car/cdr with a loose-tolerant/strict-throws gate) — every one
    // of these doors UNCONDITIONALLY, in both loose and strict mode (verified empirically: a
    // default-mode `(car str)` throws the same "does not support" invariant strict mode would).
    // `map` is the one subtlety: AString DOES implement the term
    // (`f: (char: string) => string`, AString.ts), but that signature is a private JS
    // char-mapper for internal/native use, not shaped for the scheme lambda the generic `map`
    // verb dispatches — calling `(map fn str)` still throws (a TypeError surfaces as
    // "object is not a function" from `Array.prototype.map`), just via a different, uglier
    // path than the clean "does not support" doors below. R7RS's own `string-map` is the real,
    // separate, correctly-shaped verb for this carrier — not exercised by this grid's
    // verbs[0]-only methodology.
    unsupported: [
      {
        term: "arrival/tagless-final/car",
        reason: "no arrival/tagless-final/car on AString (unconditional door, not a loose/strict gate like AVector's)",
      },
      {
        term: "arrival/tagless-final/cdr",
        reason: "no arrival/tagless-final/cdr on AString (unconditional door, not a loose/strict gate like AVector's)",
      },
      {
        term: "arrival/tagless-final/map",
        reason:
          "AString's own map is a private char-mapper (f: (char: string) => string) incompatible with a scheme lambda arg — the generic `map` verb still throws, via a different (uglier) path; R7RS's `string-map` is the real dedicated verb",
      },
      {
        term: "arrival/tagless-final/filter",
        reason:
          "no arrival/tagless-final/filter on AString; R7RS has no generic string filter — project through (list->string (filter pred (string->list s)))",
      },
      {
        term: "arrival/tagless-final/reduce",
        reason: "no arrival/tagless-final/reduce on AString; fold via (reduce fn seed (string->list s))",
      },
      {
        term: "arrival/tagless-final/sort",
        reason: "no arrival/tagless-final/sort on AString; sort via (list->string (sort (string->list s) less?))",
      },
    ],
  },
  {
    carrier: "ADict",
    mint3: "(dict :a (src 1) :b (src 2) :c (src 3))",
    // ADict.ts implements ONLY equals/get/toJS/print (arrival/tagless-final) — map/filter/
    // reduce/sort/length/car/cdr all resolve to `undefined` and door cleanly ("does not
    // support X (no arrival/tagless-final/X)"). `concat` is deliberately NOT listed here even
    // though ADict has no concat method either: the only available verb (`append`, verbs[0])
    // doesn't door for a non-pair operand — it silently returns the SECOND dict unchanged,
    // discarding the first (the P5 "fails loudly" violation, not a clean unsupported cell) —
    // see the grid body's own note at that cell.
    unsupported: [
      { term: "arrival/tagless-final/sort", reason: "dicts are unordered; no total order to sort by" },
      { term: "arrival/tagless-final/car", reason: "not a sequence" },
      { term: "arrival/tagless-final/cdr", reason: "not a sequence" },
      {
        term: "arrival/tagless-final/map",
        reason:
          "no arrival/tagless-final/map on ADict — dict values are keyed, not positionally sequenced; there is no generic dict-map term",
      },
      {
        term: "arrival/tagless-final/filter",
        reason:
          "no arrival/tagless-final/filter on ADict — keys aren't a sequence to filter; no generic dict-filter term",
      },
      {
        term: "arrival/tagless-final/reduce",
        reason: "no arrival/tagless-final/reduce on ADict — no generic dict-fold term",
      },
      {
        term: "arrival/tagless-final/length",
        reason: "no arrival/tagless-final/length on ADict — key-cardinality isn't wired through this generic term",
      },
    ],
  },
  {
    carrier: "ABytevector",
    mint3: "(bytevector (src 1) (src 2) (src 3))",
    // ABytevector.ts implements ONLY equals/lte/concat/length (arrival/tagless-final) —
    // map/filter/reduce/sort/car/cdr all resolve to `undefined` and door cleanly.
    unsupported: [
      { term: "arrival/tagless-final/map", reason: "R7RS has no bytevector-map; construct fresh" },
      { term: "arrival/tagless-final/filter", reason: "no bytevector filter in R7RS" },
      {
        term: "arrival/tagless-final/reduce",
        reason: "no arrival/tagless-final/reduce on ABytevector; R7RS has no generic bytevector fold",
      },
      {
        term: "arrival/tagless-final/sort",
        reason: "no arrival/tagless-final/sort on ABytevector; R7RS has no bytevector-sort",
      },
      { term: "arrival/tagless-final/car", reason: "not a pair" },
      { term: "arrival/tagless-final/cdr", reason: "not a pair" },
    ],
  },
] as const;
