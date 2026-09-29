// SRFI-128 — comparators. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it,
// so this module is the sole definition site.
//
// DEPS: every body below calls `pair?`/`eq?`/`null?`/`boolean?`/`string?`/`symbol?`/
// `symbol->string`/`equal?`/`not` (scheme/equality), `number?`/`=`/`<` (scheme/numeric),
// `char?`/`char<?` (scheme/chars), `string<?` (scheme/strings) — JS-native packs —
// AND `list` (scheme/lists), a BASE_PACKS member. `deps: [equality, numeric,
// chars, strings, lists]` is the complete set, each a declared edge. `car`/`cdr`/`cadr`/
// `caddr`/`cadddr` need NO edge — the resolver-synth `c[ad]+r` family is recognized
// directly, unconditionally. JS-native packs are not BASE_PACKS roots; deps is enough.
// `lists` is already positioned in the C3 tail block (see base-packs.ts's own header).
//
// Contract choices:
//   - `comparator` is modeled precisely, not as opaque `z.schemeValue`: SRFI-128's own
//     representation here is `(list 'comparator type-test equality ordering)` — a
//     FIXED 4-element proper list (tag symbol + 3 procedures) — so `comparatorSchema
//     = z.list([z.symbol, z.lambda, z.lambda, z.lambda])` is the honest structural
//     contract, catching a malformed/foreign comparator at the call boundary instead
//     of an opaque `cadr`-on-wrong-shape crash deep inside an accessor body.
//   - `comparator?` is the one exception: a type PREDICATE must accept arbitrary
//     values (that is its entire job) — `{ input: [z.schemeValue], output: [z.boolean] }`,
//     mirroring r7rs/equality.ts's own `null?`/`boolean?` convention. Using the
//     strict `comparatorSchema` here would make `(comparator? 5)` THROW instead of
//     answering `#f` — the opposite of a predicate's contract.
//   - `comparator-hashable?` is not merely `z.boolean` but the literal
//     `z.booleanFalse`: arrival has no value-hash, so this SRFI-128 slot always
//     answers `#f` — the tightest honest contract available.
//   - the private `%`-prefixed helpers (`%chain-rel`, `%type-rank`, `%default-less`)
//     get real per-define contracts too (one `symbol.define` per value/procedure
//     define, not per public API member). `%chain-rel`'s `rest` is `z.list()` (a
//     proper, possibly-empty list of arbitrary values — walked via `car`/`cdr`/
//     `null?`, never indexed), not the shapeless shortcut.
//   - `=?`/`<?`/`>?`/`<=?`/`>=?` share the `c a b . rest` shape: fixed
//     `[comparatorSchema, z.schemeValue, z.schemeValue]` + `inputRest: z.schemeValue` (the chain can
//     hold arbitrarily many further elements of any type — the comparator's own
//     predicates judge them, not this contract) + `output: [z.boolean]`.
//   - `%type-rank` returns one of the literal exact integers 0..7 — `z.exact`, not
//     the looser `z.number`/`z.integer` union (these are always exact literal
//     counts).
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";
import numeric from "../r7rs/numeric.js";
import chars from "../r7rs/chars.js";
import strings from "../r7rs/strings.js";
import lists from "../r7rs/lists.js";

export default EnvCapability.define("scheme/srfi-128", {
  deps: [equality, numeric, chars, strings, lists],
  symbols: (symbol, z) => {
    // The SRFI-128 comparator's own representation: `(list 'comparator type-test
    // equality ordering)` — see the file header's contract-choices note.
    const comparatorSchema = z.list([z.symbol, z.lambda, z.lambda, z.lambda]);
    return {
      "make-comparator":
        symbol.define`make-comparator: bundle (type-test equality ordering) into a comparator — a 4th hash arg is accepted for SRFI-128 source-compat but IGNORED (arrival has no value-hash)`(
          // `ordering` slot is `z.union([z.lambda, z.booleanFalse])`, NOT bare `z.lambda`:
          // SRFI-128 explicitly permits `ordering = #f` ("a procedure is provided that
          // signals an error on application"), and the body merely STORES ordering
          // (never calls it), so a bare `z.lambda` contract would wrongly reject the
          // legal call `(make-comparator t eq #f)`.
          {
            input: [z.lambda, z.lambda, z.union([z.lambda, z.booleanFalse])],
            inputRest: z.schemeValue,
            output: [comparatorSchema],
          },
          `(lambda (type-test equality ordering . hash)
           (list 'comparator type-test equality ordering))`,
        ),

      "comparator?": symbol.define`comparator?: #t iff obj is a comparator built by make-comparator`(
        { input: [z.schemeValue], output: [z.boolean] },
        `(lambda (x) (and (pair? x) (eq? (car x) 'comparator)))`,
      ),

      "comparator-type-test-predicate":
        symbol.define`comparator-type-test-predicate: the type-test procedure c was built with`(
          { input: [comparatorSchema], output: [z.lambda] },
          `(lambda (c) (cadr c))`,
        ),

      "comparator-equality-predicate":
        symbol.define`comparator-equality-predicate: the equality procedure c was built with`(
          { input: [comparatorSchema], output: [z.lambda] },
          `(lambda (c) (caddr c))`,
        ),

      "comparator-ordering-predicate":
        symbol.define`comparator-ordering-predicate: the ordering (less-than) procedure c was built with`(
          { input: [comparatorSchema], output: [z.lambda] },
          `(lambda (c) (cadddr c))`,
        ),

      "comparator-hashable?":
        symbol.define`comparator-hashable?: always #f — arrival has no value-hash, so the hash slot is decorative`(
          { input: [comparatorSchema], output: [z.booleanFalse] },
          `(lambda (c) #f)`,
        ),

      "%chain-rel":
        symbol.define`%chain-rel: rel holds for every adjacent pair in (a b . rest) — the shared chain-comparison engine behind =?/<?/>?/<=?/>=?`(
          { input: [z.lambda, z.schemeValue, z.schemeValue, z.list()], output: [z.boolean] },
          `(lambda (rel a b rest)
           (if (rel a b)
               (if (null? rest) #t (%chain-rel rel b (car rest) (cdr rest)))
               #f))`,
        ),

      "=?": symbol.define`=?: c's equality predicate holds for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.boolean] },
        `(lambda (c a b . rest) (%chain-rel (comparator-equality-predicate c) a b rest))`,
      ),

      "<?": symbol.define`<?: c's ordering predicate holds for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.boolean] },
        `(lambda (c a b . rest) (%chain-rel (comparator-ordering-predicate c) a b rest))`,
      ),

      ">?": symbol.define`>?: c's ordering predicate holds, reversed, for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.boolean] },
        `(lambda (c a b . rest)
         (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (lt y x)) a b rest)))`,
      ),

      "<=?": symbol.define`<=?: c's ordering predicate never holds in reverse for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.boolean] },
        `(lambda (c a b . rest)
           (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt y x))) a b rest)))`,
      ),

      ">=?": symbol.define`>=?: c's ordering predicate never holds forward for every adjacent pair in (a b . rest)`(
        { input: [comparatorSchema, z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.boolean] },
        `(lambda (c a b . rest)
           (let ((lt (comparator-ordering-predicate c))) (%chain-rel (lambda (x y) (not (lt x y))) a b rest)))`,
      ),

      "%type-rank":
        symbol.define`%type-rank: a type's position in the default total order (boolean < number < char < string < symbol < null < pair < other)`(
          { input: [z.schemeValue], output: [z.exact] },
          `(lambda (x)
           (cond ((boolean? x) 0) ((number? x) 1) ((char? x) 2) ((string? x) 3)
                 ((symbol? x) 4) ((null? x) 5) ((pair? x) 6) (else 7)))`,
        ),

      "%default-less":
        symbol.define`%default-less: the default-comparator's total order — by type rank, then the native within-type order`(
          { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
          `(lambda (a b)
           (let ((ra (%type-rank a)) (rb (%type-rank b)))
             (if (not (= ra rb)) (< ra rb)
                 (cond ((number? a) (< a b))
                       ((char? a) (char<? a b))
                       ((string? a) (string<? a b))
                       ((symbol? a) (string<? (symbol->string a) (symbol->string b)))
                       ((boolean? a) (and (not a) b))
                       (else #f)))))`,
        ),

      "make-default-comparator":
        symbol.define`make-default-comparator: a comparator over the total order %default-less imposes across all types`(
          { input: [], output: [comparatorSchema] },
          `(lambda () (make-comparator (lambda (x) #t) equal? %default-less))`,
        ),

      "default-comparator": symbol.define`default-comparator: the shared instance of make-default-comparator`(
        { input: [], output: [comparatorSchema] },
        `(lambda () (make-default-comparator))`,
      ),
    };
  },
});
