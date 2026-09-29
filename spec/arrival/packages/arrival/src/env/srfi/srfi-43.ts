// SRFI-43 — vector library (pure ops only; arrival vectors are immutable). Scheme-bootstrap
// capability.
//
// DEPS: every body below calls `vector-length`/`vector-ref` (scheme/vectors),
// `=`/`+`/`-`/`<`/`>`/`quotient` (scheme/numeric), and `not` (scheme/equality) —
// the complete cross-capability free-name set, each a declared `deps` edge
// below. JS-native packs are not BASE_PACKS roots; deps is enough.
//
// Contract choices:
//   - vec slots: `z.vector(z.schemeValue)` (representation-blind, matches r7rs/vectors.ts's own
//     vocabulary for this exact domain).
//   - kons/pred/cmp slots: `z.lambda` (a callable value; no `type:` harvest override
//     needed the way `vector-map`'s inputRest'd HOF needed one — none of these eight
//     ops has an `inputRest`, so `signatureOf` loses nothing `symbol.define`'s
//     contract-derived harvest needs).
//   - knil/value slots (vector-fold['s knil], vector-binary-search's search value):
//     arbitrary accumulator/comparison target — `z.schemeValue`.
//   - count/index outputs (vector-count, vector-index, vector-binary-search): the
//     bodies build these PURELY from `0`/`1`/`vector-length`/`+`/`-`/`quotient` over
//     exact literals, so the runtime value is ALWAYS `AExact` — `z.exact` (not the
//     looser `z.number` r7rs/vectors.ts's own `vector-length` declares) is the honest,
//     tighter contract here; the design ruling is "enforced from day one," not "as
//     loose as a sibling file's own outward-facing native contract."
//   - vector-index / vector-binary-search: index-or-#f — `z.union([z.exact,
//     z.booleanFalse])`, mirroring r7rs/lists.ts's own `z.union([…, z.booleanFalse])`
//     convention for "found or #f" outputs (member/assoc family).
//   - vector-any / vector-every: arbitrary-pred-result-or-#f — `z.union([z.schemeValue,
//     z.booleanFalse])`, same lists.ts convention, generalized to an arbitrary value
//     (the predicate's own truthy return, not just an index).
//   - vector-empty?: a DEFINITE #t/#f (the body's whole result is `(= … 0)`, always an
//     ABool) — `z.boolean`, not the looser value-or-false union the search ops need.
import { EnvCapability } from "../../common/capability.js";
import dedent from "dedent";
import equality from "../r7rs/equality.js";
import numeric from "../r7rs/numeric.js";
import vectors from "../r7rs/vectors.js";

export default EnvCapability.define("scheme/srfi-43", {
  deps: [equality, numeric, vectors],
  symbols: (symbol, z) => ({
    "vector-fold": symbol.define`vector-fold: left fold over a vector — (kons acc elt) folded across indices 0..n-1`(
      {
        input: [z.lambda, z.schemeValue, z.vector(z.schemeValue)],
        output: [z.schemeValue],
        type: dedent`
          {
            <T, A>(kons: (acc: A, elt: T) => A, knil: A, vec: readonly T[]): A;
          }
        `,
      },
      `(lambda (kons knil vec)
         (let ((n (vector-length vec)))
           (let loop ((i 0) (acc knil))
             (if (= i n) acc
                 (loop (+ i 1) (kons acc (vector-ref vec i)))))))`,
    ),

    "vector-fold-right":
      symbol.define`vector-fold-right: right fold over a vector — (kons acc elt) across indices n-1..0`(
        {
          input: [z.lambda, z.schemeValue, z.vector(z.schemeValue)],
          output: [z.schemeValue],
          type: dedent`
          {
            <T, A>(kons: (acc: A, elt: T) => A, knil: A, vec: readonly T[]): A;
          }
        `,
        },
        `(lambda (kons knil vec)
         (let loop ((i (- (vector-length vec) 1)) (acc knil))
           (if (< i 0) acc
               (loop (- i 1) (kons acc (vector-ref vec i))))))`,
      ),

    "vector-count": symbol.define`vector-count: number of indices where (pred elt) is truthy`(
      {
        input: [z.lambda, z.vector(z.schemeValue)],
        output: [z.exact],
        type: dedent`
          {
            <T>(pred: (elt: T) => unknown, vec: readonly T[]): number;
          }
        `,
      },
      `(lambda (pred vec)
         (let ((n (vector-length vec)))
           (let loop ((i 0) (c 0))
             (if (= i n) c
                 (loop (+ i 1) (if (pred (vector-ref vec i)) (+ c 1) c))))))`,
    ),

    "vector-index": symbol.define`vector-index: first index where (pred elt) is truthy, else #f`(
      {
        input: [z.lambda, z.vector(z.schemeValue)],
        output: [z.union([z.exact, z.booleanFalse])],
        type: dedent`
          {
            <T>(pred: (elt: T) => unknown, vec: readonly T[]): number | false;
          }
        `,
      },
      `(lambda (pred vec)
         (let ((n (vector-length vec)))
           (let loop ((i 0))
             (cond ((= i n) #f)
                   ((pred (vector-ref vec i)) i)
                   (else (loop (+ i 1)))))))`,
    ),

    "vector-binary-search":
      symbol.define`vector-binary-search: index of value equal under (cmp elt value)=0 in sorted vec, else #f`(
        {
          input: [z.vector(z.schemeValue), z.schemeValue, z.lambda],
          output: [z.union([z.exact, z.booleanFalse])],
          type: dedent`
          {
            <T>(vec: readonly T[], value: T, cmp: (elt: T, value: T) => number): number | false;
          }
        `,
        },
        `(lambda (vec value cmp)
           (let loop ((lo 0) (hi (- (vector-length vec) 1)))
             (if (> lo hi) #f
                 (let* ((mid (quotient (+ lo hi) 2))
                        (c (cmp (vector-ref vec mid) value)))
                   (cond ((= c 0) mid)
                         ((< c 0) (loop (+ mid 1) hi))
                         (else (loop lo (- mid 1))))))))`,
      ),

    "vector-empty?": symbol.define`vector-empty?: #t iff the vector has length 0`(
      { input: [z.vector(z.schemeValue)], output: [z.boolean] },
      `(lambda (vec) (= (vector-length vec) 0))`,
    ),

    "vector-any": symbol.define`vector-any: first truthy (pred elt), scanning left to right, else #f`(
      {
        input: [z.lambda, z.vector(z.schemeValue)],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <T, R>(pred: (elt: T) => R, vec: readonly T[]): R | false;
          }
        `,
      },
      `(lambda (pred vec)
         (let ((n (vector-length vec)))
           (let loop ((i 0))
             (if (= i n) #f
                 (let ((r (pred (vector-ref vec i))))
                   (if r r (loop (+ i 1))))))))`,
    ),

    "vector-every": symbol.define`vector-every: last (pred elt) if all truthy, else #f (short-circuits on #f)`(
      {
        input: [z.lambda, z.vector(z.schemeValue)],
        output: [z.union([z.schemeValue, z.booleanFalse])],
        type: dedent`
          {
            <T, R>(pred: (elt: T) => R, vec: readonly T[]): R | true | false;
          }
        `,
      },
      `(lambda (pred vec)
         (let ((n (vector-length vec)))
           (if (= n 0) #t
               (let loop ((i 0))
                 (let ((r (pred (vector-ref vec i))))
                   (cond ((not r) #f)
                         ((= i (- n 1)) r)
                         (else (loop (+ i 1)))))))))`,
    ),
  }),
});
