// ----------------------------------------------------------------------
// The syntax-rules macro engine — pattern matching (extract_patterns), template
// transcription (transform_syntax), and data-position un-renaming
// (restore_data_gensyms). Consumed by the syntax-rules builtin (env/macros/macros.ts).
//
// EVALUATE-FREE: rewrites code, never runs it.
//
// NO MODULE-LEVEL ENV: hygiene identity flows in through the injected HygieneScope
// (useResolver, captured defResolver, capabilities.globalRoot as unshadowed-base
// identity) and the per-run ctx — the syntax-rules caller threads them.
//
// MINT DOOR: every cell the matcher/expander constructs goes through
// consCell/listFromArray via the explicitly threaded `ctx` PARAMETER — not a
// per-value stamp. A walk of the output cannot tell fresh cells from call-site
// fragments shared by reference, so minting goes through this door.
//
// SPAN PROPAGATION: expansion-built pairs carry the TEMPLATE's span (same template
// node → same span on every instantiation); pattern-variable substitutions are
// call-site pairs by reference and keep their own spans. carrySpan/carrySpanSpine
// only stamp span-less pairs, never overwrite.
//
// LAST-PAIR INVARIANT: last_pair() on a non-empty pair spine is always a pair
// (or undefined on a cycle), never ANil. The repeated invariant guards make that
// runtime fact explicit instead of casting the union away.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
// Lineage: hygienic macro expansion (Kohlbecker et al. 1986; Clinger & Rees 1991);
// R7RS §4.3 syntax-rules; ellipsis sub-patterns per SRFI-46.
// ----------------------------------------------------------------------
import invariant from "tiny-invariant";
import type { RunContext } from "../run/RunContext.js";
import type { Resolver } from "./Resolver.js";
import type { LexicalScopeWithInternals } from "./LexicalScope.js";
import type { Capabilities } from "./Capabilities.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AValue } from "../values/primitives/AValue.js";
import { Macro } from "./Macro.js";
import { APair, __tieKnot } from "../values/primitives/APair.js";
import { eqv } from "../values/structural-equal.js";
import { AListAlike, type SchemeValue } from "../values/types.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { type } from "../membrane/typecheck.js";
import { gensym, hidden_prop, is_atom, is_gensym } from "../values/values-repr.js";

// The type()-vs-kind fold for same_atom's discriminator: `a` is always a boxed AValue
// atom here (the `is_atom` guard at the call site restricts it), but `b` (the code
// fragment being matched) can still be a raw JS string/RegExp — same_atom's own arms
// below handle those. Reading `.kind` directly (skipping type()'s membrane arms /
// foreign fallback, neither of which an atom ever needs) is the "kind-equality"
// collapse: AExact and AInexact both carry kind "number", so `(= 1 1.0)`-shaped literal
// comparisons collapse correctly without a numeric-tower special case.
function atomKind(x: unknown): string {
  return x instanceof AValue ? x.kind : type(x);
}

function same_atom(a, b) {
  if (atomKind(a) !== atomKind(b)) {
    return false;
  }
  if (!is_atom(a)) {
    return false;
  }
  if (a instanceof RegExp) {
    return a.source === b.source;
  }
  if (a instanceof AString) {
    return b instanceof AString && a.valueOf() === b.valueOf();
  }
  return eqv(a, b);
}

// `concatPair`'s Semigroup contract (list ⋄ list) requires a list-alike tail. A dotted-tail
// ellipsis template — `(a ... . b)` matched against `(m 1 2 . 3)` — legitimately binds `b` to
// a bare scalar, so the tail feeding these can be an arbitrary SchemeValue, not a list. Same
// cons-loop as `concatPair` (values/primitives/APair.ts), typed for that wider arbitrary-tail
// domain instead of forcing a scalar into AListAlike.
function concatPairLoose(_ctx: RunContext, a: SchemeValue, b: SchemeValue): SchemeValue {
  const cars: SchemeValue[] = [];
  let node: unknown = a;
  while (node instanceof APair) {
    cars.push(node.car);
    node = node.cdr;
  }
  let result: SchemeValue = b;
  for (let i = cars.length; i--; ) {
    result = new APair(cars[i], result);
  }
  return result;
}

// The MINT DOOR (see file preamble).
function consCell<Car extends SchemeValue, Cdr extends SchemeValue>(
  _ctx: RunContext,
  car: Car,
  cdr: Cdr,
): APair<Car, Cdr> {
  return new APair(car, cdr);
}

/** `APair.fromArray` through the mint door — n elements ⇒ n fresh spine cells. */
function listFromArray<T extends SchemeValue>(ctx: RunContext, array: readonly T[], deep = false): AListAlike<T> {
  return APair.fromArray(ctx, array, deep);
}

/** Stamp the template's span onto a single fresh, span-less Pair (preamble SPAN
 *  PROPAGATION). Location is IMMUTABLE — a stamp mints a clone via withLocation.
 *  Every direct caller treats the return as the value of record (applied to a
 *  cell JUST minted inline). deferred: expansion-chain slot recording the call
 *  site per expansion, for a consumer that needs both template and call-site. */
function carrySpan<T extends SchemeValue>(fresh: T, template: SchemeValue): T {
  if (fresh instanceof APair && fresh.location === undefined && template instanceof APair) {
    const loc = template.location;
    // withLocation on a narrowed-T intersection loses precise APair<Car,Cdr>
    // parametrization — cast is honest: same concrete class, only location differs.
    if (loc !== undefined) return fresh.withLocation(loc) as T;
  }
  return fresh;
}

/** carrySpan for a freshly-built SPINE (fromArray/concat): stamps every unlocated
 *  cdr-chain cell, not just the head. Spine interior cells are already LINKED by
 *  reference before this walk — when carrySpan mints a clone, the parent's cdr must
 *  be re-pointed, or the stamp is silently lost past the head. The spine is PRIVATE
 *  at this point (just minted, not yet handed out), so patching through __tieKnot
 *  is a sanctioned knot-tying use (same license as ellipsis surgery on private copies). */
function carrySpanSpine<T extends SchemeValue>(fresh: T, template: SchemeValue): T {
  let head: unknown = fresh;
  let prev: APair<SchemeValue, SchemeValue> | undefined;
  let node: unknown = fresh;
  while (node instanceof APair) {
    const stamped = carrySpan(node, template);
    if (stamped !== node) {
      if (prev === undefined) {
        head = stamped;
      } else {
        __tieKnot(prev, "cdr", stamped);
      }
    }
    prev = stamped;
    node = stamped.cdr;
  }
  return head as T;
}

// The hygiene-identity handles the syntax-rules caller injects (see file preamble, NO
// MODULE-LEVEL ENV). Plain JS resolver handles, NOT SchemeValues.
interface HygieneScope {
  useResolver: Resolver;
  defResolver: Resolver;
  capabilities: Capabilities;
  /** The live per-run context (`MacroInvokeContext.runCtx`, threaded by the syntax-rules
   *  caller) — the matcher's accumulation cells mint through it, so a metered run's match work
   *  observes its own allocation bound. */
  ctx: RunContext;
}

// The pattern-match accumulator. Its leaf cells hold a HETEROGENEOUS mix the matcher reads
// back through guards — a captured SchemeValue, an ellipsis APair list, a raw JS array (nested
// ellipsis), `nil`, or `null` (empty-ellipsis sentinel) — narrowed at each read site
// (`is_pair`/`is_nil`/`Array.isArray`). A plain binding cell holds MATCHED CODE FRAGMENTS; an
// ellipsis cell additionally holds per-repetition ARRAYS ((x ...) accumulation) and the `null`
// sentinel ("matched, zero repetitions") — never arbitrary host data.
type BindingCell = Record<string | symbol, SchemeValue | SchemeValue[] | null | undefined>;
// The TEMPLATE layer's value domain. Every template-domain value is a boxed, always-truthy
// AValue, so the ellipsis loops' `!== undefined` productive-iteration test is exact —
// `undefined` alone marks an unproductive iteration (no JS-falsy captured value can be mistaken
// for "produced nothing").
type TemplateValue = SchemeValue;
interface MatchBindings {
  "...": { symbols: BindingCell; lists: unknown[] };
  symbols: BindingCell;
}

interface MatchState {
  ellipsis?: boolean;
  trailing?: boolean;
  pattern_names?: (string | symbol)[];
}

// deferred: no cycle detection — a self-referential pattern/code pair can loop the matcher.
export function extract_patterns(
  pattern: unknown,
  code: unknown,
  symbols: unknown[],
  ellipsis_symbol: string | ASymbol | RegExp,
  scope: HygieneScope,
) {
  const bindings: MatchBindings = {
    "...": {
      symbols: {},
      lists: [],
    },
    symbols: {},
  };
  const { useResolver, defResolver, capabilities, ctx } = scope;
  // `pattern_names` distinguishes multiple matches of `((x ...) ...)` against `((1 2 3) (1 2 3))`:
  // each `x` added to the list marks it as this repetition's binding, not a duplicated ellipsis symbol.

  function traverse(pattern: unknown, code: unknown, state: MatchState = {}) {
    const { ellipsis = false, trailing = false, pattern_names = [] } = state;
    if (is_atom(pattern) && !(pattern instanceof ASymbol)) {
      return same_atom(pattern, code);
    }
    if (pattern instanceof ASymbol) {
      const literal = pattern.literal();
      if (symbols.includes(literal)) {
        const codeAsName = code instanceof ASymbol || typeof code === "string" || code instanceof RegExp;
        if (!ASymbol.is(code, literal) && !(codeAsName && ASymbol.is(pattern, code as ASymbol | string | RegExp))) {
          return false;
        }
        // refFrame walks USE-site scope frames THEN capabilities, returning the owning frame
        // (a LexicalScope for a lexical owner, the globalRoot env for an unshadowed builtin).
        // unbound (!ref) and unshadowed-base (=== globalRoot) match; `=== defResolver.scope`
        // compares the captured def frame. A literal shadowed by an intervening user `let`
        // returns that user frame (≠ both) → no match.
        const ref = useResolver.refFrame(literal);
        return !ref || ref === defResolver.scope || ref === capabilities.globalRoot;
      }
    }
    // deferred: vector PATTERNS. A `#(...)` literal parses to a boxed SchemeVector, so
    // `Array.isArray` is false and a vector-pattern macro fails to match LOUDLY ("no matching
    // syntax in macro (#<SchemeVector>)"), never corrupting silently. The fix — unwrap
    // SchemeVector → raw array here AND re-box at the template-output sites, which interleave
    // with the ellipsis machinery — is deferred (untested/unused feature, high-risk in this
    // fragile matcher; write vector-pattern tests first). Lists are Pairs, so only vector
    // patterns are affected.
    if (Array.isArray(pattern) && Array.isArray(code)) {
      if (pattern.length === 0 && code.length === 0) {
        return true;
      }
      if (ASymbol.is(pattern[1], ellipsis_symbol)) {
        if (pattern[0] instanceof ASymbol) {
          const name = pattern[0].valueOf();
          if (ellipsis) {
            const count = code.length - 2;
            const array_head = count > 0 ? code.slice(0, count) : code;
            const as_list = listFromArray(ctx, array_head);
            bindings["..."].symbols[name] = bindings["..."].symbols[name]
              ? // list-accumulation cell (the array style is the `??= []` cell in the symbol arm)
                concatPairLoose(ctx, bindings["..."].symbols[name] as SchemeValue, consCell(ctx, as_list, nil))
              : consCell(ctx, as_list, nil);
          } else {
            bindings["..."].symbols[name] = listFromArray(ctx, code);
          }
        } else if (Array.isArray(pattern[0])) {
          const names = [...pattern_names];
          const new_state = { ...state, pattern_names: names, ellipsis: true };
          if (!code.every((node) => traverse(pattern[0], node, new_state))) {
            return false;
          }
        }
        if (pattern.length > 2) {
          const pat = pattern.slice(2);
          return traverse(pat, code.slice(-pat.length), state);
        }
        return true;
      }
      const first = traverse(pattern[0], code[0], state);
      const rest = traverse(pattern.slice(1), code.slice(1), state);
      return first && rest;
    }
    // pattern (a b (x ...)) and (x ...) match nil
    if (
      pattern instanceof APair &&
      pattern.car instanceof APair &&
      pattern.car.cdr instanceof APair &&
      ASymbol.is(pattern.car.cdr.car, ellipsis_symbol) &&
      code instanceof ANil &&
      pattern.car.car instanceof ASymbol
    ) {
      const name = pattern.car.car.valueOf();
      invariant(!bindings["..."].symbols[name], "syntax: named ellipsis can only appear onces");
      bindings["..."].symbols[name] = code;
    }
    if (pattern instanceof APair && pattern.cdr instanceof APair && ASymbol.is(pattern.cdr.car, ellipsis_symbol)) {
      // pattern (... ???) - SRFI-46
      if (!(pattern.cdr.cdr instanceof ANil) && pattern.cdr.cdr instanceof APair) {
        // (x ... a b): trim the fixed-length tail off the end.
        const list_len = pattern.cdr.cdr.length();
        // last_pair is a pair here (see preamble, LAST-PAIR INVARIANT).
        const patternLastPair = pattern.last_pair();
        invariant(patternLastPair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
        const improper_list = !(patternLastPair.cdr instanceof ANil);
        if (!(code instanceof APair)) {
          return false;
        }
        let code_len = code.length();
        let list: SchemeValue = code;
        const trailing = improper_list ? 1 : 1;
        while (code_len - trailing > list_len) {
          invariant(list instanceof APair, "syntax: trailing-trim walk stays within the counted pair prefix");
          list = list.cdr;
          code_len--;
        }
        invariant(list instanceof APair, "syntax: trailing-trim walk stays within the counted pair prefix");
        const rest = list.cdr;
        // FRESH-PREFIX split: build the head segment as a fresh spine — elements SHARED
        // (provenance preserved), spine fresh — so the user's input form is never mutated in
        // place. Severing `list.cdr` would corrupt the source AST for every later reader.
        const prefixEls: SchemeValue[] = [];
        let n: SchemeValue = code;
        while (true) {
          invariant(n instanceof APair, "syntax: prefix walk stays within code's pair spine");
          prefixEls.push(n.car);
          if (n === list) break;
          n = n.cdr;
        }
        code = listFromArray(ctx, prefixEls) as AListAlike;
        const new_sate = { ...state, trailing: improper_list };
        if (!traverse(pattern.cdr.cdr, rest, new_sate)) {
          return false;
        }
      }
      if (pattern.car instanceof ASymbol) {
        const name = pattern.car.__name__;
        if (bindings["..."].symbols[name] && !pattern_names.includes(name) && !ellipsis) {
          throw new Error("syntax: named ellipsis can only appear onces");
        }
        if (code instanceof ANil) {
          bindings["..."].symbols[name] = ellipsis ? nil : null;
        } else if (code instanceof APair && (code.car instanceof APair || code.car instanceof ANil)) {
          if (ellipsis) {
            if (bindings["..."].symbols[name]) {
              let node = bindings["..."].symbols[name] as SchemeValue; // list-accumulation cell
              node =
                node instanceof ANil
                  ? consCell(ctx, nil, consCell(ctx, code as SchemeValue, nil))
                  : concatPairLoose(ctx, node, consCell(ctx, code as SchemeValue, nil));
              bindings["..."].symbols[name] = node;
            } else {
              bindings["..."].symbols[name] = consCell(ctx, code, nil);
            }
          } else {
            bindings["..."].symbols[name] = consCell(ctx, code, nil);
          }
        } else {
          if (code instanceof APair) {
            // cons (a . b) => (var ... . x)
            if (!(code.cdr instanceof APair) && !(code.cdr instanceof ANil)) {
              if (pattern.cdr.cdr instanceof ANil) {
                return false;
              } else if (!bindings["..."].symbols[name]) {
                bindings["..."].symbols[name] = consCell(ctx, code.car, nil);
                return traverse(pattern.cdr.cdr, code.cdr, state);
              }
            }
            // code is an improper list; last_pair is a pair (see preamble, LAST-PAIR INVARIANT).
            const last_pair = code.last_pair();
            invariant(last_pair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
            if (!(last_pair.cdr instanceof ANil)) {
              if (pattern.cdr.cdr instanceof ANil) {
                // case (a ...) for (a b . x)
                return false;
              } else {
                // case (a ... . b) for (a b . x)
                const copy = code.clone();
                invariant(copy instanceof APair, "syntax: clone of a non-empty pair spine is a pair");
                const copyLastPair = copy.last_pair();
                invariant(copyLastPair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
                // Ellipsis surgery on a PRIVATE clone — a sanctioned __tieKnot call site.
                __tieKnot(copyLastPair, "cdr", nil);
                // Ellipsis cell is a list of repetitions: wrap the proper prefix so
                // `(x ...)` iterates elements, not the prefix as one item.
                bindings["..."].symbols[name] = consCell(ctx, copy, nil);
                return traverse(pattern.cdr.cdr, last_pair.cdr, state);
              }
            }
            pattern_names.push(name);
            if (bindings["..."].symbols[name]) {
              const node = bindings["..."].symbols[name] as SchemeValue; // list-accumulation cell
              bindings["..."].symbols[name] = concatPairLoose(ctx, node, consCell(ctx, code as SchemeValue, nil));
            } else {
              bindings["..."].symbols[name] = consCell(ctx, code as SchemeValue, nil);
            }
          } else if (
            pattern.car instanceof ASymbol &&
            pattern.cdr instanceof APair &&
            ASymbol.is(pattern.cdr.car, ellipsis_symbol)
          ) {
            // empty ellipsis with rest  (a b ... . d)
            bindings["..."].symbols[name] = null;
            return traverse(pattern.cdr.cdr, code, state);
          } else {
            return false;
          }
        }
        // (x ... . b) never enters the trailing-trim loop (`cdr.cdr` is the
        // symbol `b`). A proper list has no remainder — bind `b` to ().
        if (pattern.cdr.cdr instanceof ASymbol) {
          return traverse(pattern.cdr.cdr, nil, state);
        }
        return true;
      } else if (pattern.car instanceof APair) {
        const names = [...pattern_names];
        if (code instanceof ANil) {
          bindings["..."].lists.push(nil);
          return true;
        }
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (node instanceof APair) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      if (Array.isArray(pattern.car)) {
        const names = [...pattern_names];
        let node = code;
        const new_state = { ...state, pattern_names: names, ellipsis: true };
        while (node instanceof APair) {
          if (!traverse(pattern.car, node.car, new_state)) {
            return false;
          }
          node = node.cdr;
        }
        return true;
      }
      return false;
    }
    if (pattern instanceof ASymbol) {
      invariant(!ASymbol.is(pattern, ellipsis_symbol), "syntax: invalid usage of ellipsis");
      const name = pattern.__name__;
      if (symbols.includes(name)) {
        return true;
      }
      if (ellipsis) {
        const cell = (bindings["..."].symbols[name] ??= [] as SchemeValue[]);
        invariant(Array.isArray(cell), "syntax: ellipsis binding cell must be an array");
        cell.push(code as SchemeValue);
      } else {
        bindings.symbols[name] = code as SchemeValue;
      }
      return true;
    }
    if (pattern instanceof APair && code instanceof APair) {
      const patternCar = pattern.car;
      const patternCdr = pattern.cdr;
      if (trailing && patternCar instanceof ASymbol && patternCdr instanceof ASymbol) {
        // (y . z) tail of (x ... y . z). A proper singleton (y) binds z to ();
        // a dotted remainder (y . w) binds z to w. A longer rest (cdr is a
        // pair) is not this tail — the empty-ellipsis arm on `(_ x ... y . z)`
        // would otherwise steal the match from the ellipsis-trim path.
        if (code.cdr instanceof APair) {
          return false;
        }
        const car = patternCar.valueOf();
        const cdr = patternCdr.valueOf();
        bindings.symbols[car] = code.car;
        bindings.symbols[cdr] = code.cdr;
        return true;
      }
      if (
        code.cdr instanceof ANil && // pattern (p . rest) against a one-element code (0)
        patternCar instanceof ASymbol &&
        patternCdr instanceof ASymbol
      ) {
        // SRFI-26: recursive call of (b) ⇒ (<> . x) where <> is a symbol.
        if (!traverse(patternCar, code.car, state)) {
          return false;
        }
        let name: string | symbol = patternCdr.valueOf();
        if (!(name in bindings.symbols)) {
          bindings.symbols[name] = nil;
        }
        name = patternCar.valueOf();
        if (!(name in bindings.symbols)) {
          bindings.symbols[name] = code.car;
        }
        return true;
      }
      // case (x y) ===> (var0 var1 ... warn) where var1 match nil
      // trailing: true start processing of (var ... x . y)
      if (
        pattern.cdr instanceof APair &&
        pattern.cdr.cdr instanceof APair &&
        pattern.cdr.car instanceof ASymbol &&
        ASymbol.is(pattern.cdr.cdr.car, ellipsis_symbol) &&
        pattern.cdr.cdr.cdr instanceof APair &&
        !ASymbol.is(pattern.cdr.cdr.cdr.car, ellipsis_symbol) &&
        traverse(pattern.car, code.car, state) &&
        traverse(pattern.cdr.cdr.cdr, code.cdr, { ...state, trailing: true })
      ) {
        const name = pattern.cdr.car.__name__;
        if (symbols.includes(name)) {
          return true;
        }
        bindings["..."].symbols[name] = null;
        return true;
      }
      const car = traverse(pattern.car, code.car, state);
      const cdr = traverse(pattern.cdr, code.cdr, state);
      if (car && cdr) {
        return true;
      }
    } else if (pattern instanceof ANil && (code instanceof ANil || code === undefined)) {
      // undefined: a recursive call with no body form left.
      return true;
    } else {
      // pattern (...)
      invariant(
        !(pattern instanceof APair) || !(pattern.car instanceof APair) || !ASymbol.is(pattern.car.car, ellipsis_symbol),
        "syntax: invalid usage of ellipsis",
      );
      return false;
    }
  }

  if (traverse(pattern, code)) {
    return bindings;
  }
}

// Restore hygiene-renamed gensyms to their literal symbols, but ONLY in DATA positions —
// under quote/quasiquote, EXCLUDING unquote(-splicing) holes (which are code). A template
// identifier under quote is DATA, not a reference, so hygiene must not rename it (standard
// expander behaviour). The renamer over-renames every identifier; this single pass un-renames
// the data positions of the transcribed FORM, so quote yields the literal symbol with no
// post-eval fixup.
//
// Runs on the FORM, not the evaluated result: a result-side fixup would ride the trampoline as
// an onResolve, composing through a tail chain → O(depth) for a deep macro tail loop. Restoring
// the form once per expansion is O(form) and never composes, so a macro in tail position keeps
// O(1) TCO.
export function restore_data_gensyms(node, gensyms, ctx: RunContext) {
  if (gensyms.length === 0) return node;
  const restore = (sym) => {
    const r = gensyms.find((g) => g.gensym === sym);
    // Interned mint: an already-known literal name is a flyweight HIT (no allocation,
    // no charge); a genuinely fresh name charges 1 inside ASymbol's own ctor.
    return r ? new ASymbol(r.name) : sym;
  };
  function walk(n, data) {
    if (n instanceof ASymbol) {
      return data ? restore(n) : n;
    }
    if (n instanceof APair) {
      const head = n.car;
      let childData = data;
      if (head instanceof ASymbol) {
        const lit = head.literal();
        if (lit === "quote" || lit === "quasiquote") childData = true;
        else if (lit === "unquote" || lit === "unquote-splicing") childData = false;
      }
      // head resolves in the CURRENT context (it is the operator); operands take childData.
      return carrySpan(consCell(ctx, walk(head, data), walk(n.cdr, childData)), n);
    }
    return n;
  }
  return walk(node, false);
}

// The renamed-gensym record kept so `restore_data_gensyms` can un-rename DATA positions.
interface GensymRecord {
  name: string | symbol;
  gensym: ASymbol;
}

// `transform_syntax`'s options — the template (`expr`), the matcher output (`bindings`),
// the literal-`symbols` name-list, the def-time syntax-child RESOLVER (`scope`), the
// `names` accumulator, and the `ellipsis` marker. These are plain JS handles, not a SchemeValue.
interface TransformOptions {
  bindings: MatchBindings;
  expr: SchemeValue;
  scope: Resolver;
  symbols: unknown[];
  names: GensymRecord[];
  ellipsis: string | ASymbol;
  /** The live per-run context — every template-instantiation mint (rebuilt pairs, relit
   *  symbols, dotted-access forms) goes through it, so expansion output carries the run's
   *  identity and charges its meter. The `gensym` mint itself rides values/values-repr.ts's
   *  own ctx. */
  ctx: RunContext;
}

export function transform_syntax({
  bindings,
  expr,
  scope: rawDefChild,
  symbols,
  names,
  ellipsis: ellipsis_symbol,
  ctx,
}: TransformOptions) {
  // `scope` is the def-time syntax-child RESOLVER (`defResolver.child("syntax")`); the
  // engine consults its refFrame/lookupSettled/define instead of raw env .ref/.get/.set.
  const defChild = rawDefChild as LexicalScopeWithInternals<Resolver>;
  const gensyms: Record<string | symbol, ASymbol> = {};

  function transform(symbol: SchemeValue): SchemeValue {
    invariant(symbol instanceof ASymbol, `syntax: internal error, need symbol got ${type(symbol)}`);
    const name = symbol.valueOf();
    invariant(name !== ellipsis_symbol, "syntax: internal error, ellipsis not transformed");
    // symbols are gensyms from nested syntax-rules
    const n_type = typeof name;
    if (["string", "symbol"].includes(n_type)) {
      if (name in bindings.symbols) {
        return bindings.symbols[name] as SchemeValue; // plain cell — never an array/null (ellipsis-only)
      } else if (typeof name === "string" && /\./.test(name)) {
        // calling method on pattern symbol
        const parts = name.split(".");
        const first = parts[0];
        if (first in bindings.symbols) {
          return listFromArray(
            ctx,
            [
              new ASymbol("."),
              bindings.symbols[first] as SchemeValue, // plain cell — never an array/null (ellipsis-only)
              ...parts.slice(1).map((x) => new AString(x)),
            ],
            true,
          );
        }
      }
    }
    if (symbols.includes(name)) {
      return symbol;
    }
    return rename(name, symbol);
  }

  function rename(name: string | symbol, symbol: ASymbol | string | symbol) {
    if (!gensyms[name]) {
      // Hygiene identity: does `name` resolve to a frame? refFrame walks own bindings only (no
      // resolvers/synth, scope then capabilities) and keys by string; a JS-symbol name (gensym
      // from nested syntax-rules) never owns a frame, so it resolves not-found and falls through
      // to the relit path below.
      const found = typeof name === "string" ? defChild.refFrame(name) : undefined;
      // A nested syntax-rules gensym must be renamed again from its original symbol.
      if (typeof name === "symbol" && !found && symbol instanceof ASymbol) {
        name = symbol.literal();
      }
      if (gensyms[name]) {
        return gensyms[name];
      }
      const gensym_name = gensym(name);
      // Copy the bound value (if any) onto the gensym so the expansion resolves it. lookupSettled
      // is settled (patch_value), resolver-aware, NON-synth and non-throwing, so a
      // template-introduced (unbound) identifier yields undefined and nothing is copied.
      const value = defChild.lookupSettled(name);
      if (value !== undefined) {
        defChild.env.bind(gensym_name, value);
      }
      // Record the rename so restore_data_gensyms can un-rename free output symbols post-eval.
      names.push({
        name,
        gensym: gensym_name,
      });
      gensyms[name] = gensym_name;
      // `name` is checked for string because it can be a gensym symbol from nested syntax-rules.
      if (typeof name === "string" && /\./.test(name)) {
        const [first, ...rest] = name.split(".").filter(Boolean);
        // save JavaScript dot notation for Env::get
        if (gensyms[first]) {
          hidden_prop(gensym_name, "__object__", [gensyms[first], ...rest]);
        }
      }
    }
    return gensyms[name];
  }

  function transform_ellipsis_expr(
    expr: SchemeValue,
    bindings: BindingCell,
    state: { nested: boolean },
    next: (name: string | symbol, value: unknown) => void = () => {},
  ): TemplateValue | undefined {
    if (Array.isArray(expr) && expr.length === 0) {
      return expr;
    }
    if (expr instanceof ASymbol) {
      const name = expr.valueOf();
      const bound = bindings[name];
      if (is_gensym(expr) && !bound) {
        // Unbound gensym — fall through.
      }
      if (bound) {
        if (bound instanceof APair) {
          if (state.nested) {
            if (bound.car instanceof APair) {
              if (bound.car.cdr instanceof ANil) {
                return bound.car.car;
              }
              next(name, consCell(ctx, bound.car.cdr, nil));
            }
            return bound.car;
          }
          if (bound.cdr instanceof ANil) {
            return bound.car;
          }
          next(name, bound.cdr);
        } else if (Array.isArray(bound)) {
          next(name, bound.slice(1));
          return bound[0];
        }
      }
      return transform(expr);
    }

    if (expr instanceof APair) {
      const first = expr.car;
      const second = expr.cdr instanceof APair && expr.cdr.car;
      if (first instanceof ASymbol && ASymbol.is(second, ellipsis_symbol)) {
        const name = first.valueOf();
        const item = bindings[name];
        if (item === null) {
          return;
        } else if (name in bindings) {
          if (item instanceof APair) {
            const rest_expr = expr.cdr instanceof APair ? expr.cdr.cdr : nil;
            if (state.nested) {
              if (!(item.cdr instanceof ANil)) {
                next(name, item.cdr);
              }
              // Dispatch on the runtime shape of `car`, not the template's shape. A JS-array
              // `car` concats with Array.prototype.concat; a pair `car` concats with concatPair.
              // Discriminating on `car` keeps a pair from ever reaching `.concat` (which APair
              // lacks → throw).
              if (!(rest_expr instanceof ANil) && item.car instanceof APair) {
                return carrySpanSpine(
                  concatPairLoose(
                    ctx,
                    item.car,
                    transform_ellipsis_expr(rest_expr, bindings, state, next) as SchemeValue,
                  ),
                  expr,
                );
              }
              return item.car;
            } else if (item.car instanceof APair) {
              if (!(item.car.cdr instanceof ANil)) {
                next(name, consCell(ctx, item.car.cdr, item.cdr));
              }
              return item.car.car;
            } else if (item.cdr instanceof ANil) {
              return item.car;
            } else if (expr instanceof APair) {
              const last_pair = expr.last_pair();
              invariant(last_pair instanceof APair, "syntax: last_pair of a non-empty pair spine is a pair");
              if (last_pair.cdr instanceof ASymbol) {
                next(name, item.last_pair());
                return item.car;
              }
            }
          }
          return item as TemplateValue;
        }
      }

      return carrySpan(
        consCell(
          ctx,
          transform_ellipsis_expr(first, bindings, state, next) as SchemeValue,
          transform_ellipsis_expr(expr.cdr, bindings, state, next) as SchemeValue,
        ),
        expr,
      );
    }
    return expr;
  }

  function have_binding(binding: Record<string | symbol, unknown>, skip_nulls = false) {
    const values = Object.values(binding);
    const symbols = Object.getOwnPropertySymbols(binding);
    if (symbols.length > 0) {
      values.push(...symbols.map((x) => binding[x]));
    }
    return (
      values.length > 0 &&
      values.every((x) => {
        if (x === null) {
          return !skip_nulls;
        }
        return x instanceof APair || x instanceof ANil;
      })
    );
  }

  function get_names(object) {
    return [...Object.keys(object), ...Object.getOwnPropertySymbols(object)];
  }

  function traverse(expr: SchemeValue, { disabled }: { disabled?: boolean } = {}): SchemeValue {
    if (expr instanceof APair) {
      const first = expr.car;
      // `second`/`rest_second` exist iff the cdr is a pair — derived off one narrowed handle so
      // TS threads that through the optional chain.
      const cdrPair = expr.cdr instanceof APair ? expr.cdr : undefined;
      const second = cdrPair?.car;
      const rest_second = cdrPair?.cdr;
      // Escape ellipsis (R7RS `(... <template>)`, e.g. `(... ...)`): `first` is the pair
      // `(... t)`, so `first.cdr` must itself be a pair carrying <template> in its car. A
      // bare `(...)` leaves `first.cdr` as nil, whose `.car` is undefined. Instantiate
      // `<template>` with ellipses disabled: pattern variables still substitute; `...`
      // is an ordinary identifier. Quote is just a symbol in the output — it does not
      // suppress that walk.
      if (!disabled && first instanceof APair && ASymbol.is(first.car, ellipsis_symbol) && first.cdr instanceof APair) {
        return carrySpan(
          consCell(ctx, traverse(first.cdr.car, { disabled: true }), expr instanceof APair ? traverse(expr.cdr) : nil),
          expr,
        );
      }
      if (second && ASymbol.is(second, ellipsis_symbol) && !disabled) {
        const symbols = bindings["..."].symbols;
        // Skip the expansion when pattern `(x y ... z)` matched code `(x z)`, so `y == null`.
        const values = Object.values(symbols);
        if (values.length > 0 && values.every((x) => x === null)) {
          return traverse(rest_second as SchemeValue, { disabled });
        }
        const keys = get_names(symbols);
        // List as first argument `((x . y) ...)` or `(x ... ...)` — recurse over the list. For
        // pattern `(_ (x y z ...) ...)` against code `(foo (1 2) (1 2))`, x/y become arrays
        // `[1 1]`/`[2 2]` and z the rest, while x/y also keep their own single mappings.
        const is_spread =
          first instanceof ASymbol && rest_second instanceof APair && ASymbol.is(rest_second.car, ellipsis_symbol);
        if (first instanceof APair || is_spread) {
          // Free ellipsis on pairs `((???) ...)`. Nested pair-ellipsis repetition is unverified.
          if (bindings["..."].lists[0] instanceof ANil) {
            if (!is_spread) {
              return traverse(rest_second as SchemeValue, { disabled });
            }
            return nil;
          }
          let new_expr = first;
          if (is_spread) {
            new_expr = carrySpan(consCell(ctx, first, consCell(ctx, second, nil)), expr);
          }
          let result: SchemeValue;
          if (keys.length > 0) {
            let bind: BindingCell = { ...symbols };
            result = nil;
            while (true) {
              if (!have_binding(bind)) {
                break;
              }
              const new_bind: BindingCell = {};
              const next = (key: string | symbol, value: unknown) => {
                // ellipsis decide if what should be the next value
                // there are two cases ((a . b) ...) and (a ...)
                new_bind[key] = value as SchemeValue;
              };
              const car = transform_ellipsis_expr(new_expr, bind, { nested: true }, next);
              // undefined can be null caused by null binding
              // on empty ellipsis
              if (car !== undefined) {
                if (is_spread) {
                  result =
                    result instanceof ANil
                      ? (car as SchemeValue)
                      : carrySpanSpine(concatPairLoose(ctx, result, car as SchemeValue), expr);
                } else {
                  result = carrySpan(consCell(ctx, car as SchemeValue, result), expr);
                }
              }
              bind = new_bind;
            }
            if (result instanceof APair && !is_spread) {
              result = carrySpanSpine(listFromArray(ctx, result.to_array(false).toReversed()), expr);
            }
            // case of (list) ... (rest code)

            if (
              expr instanceof APair &&
              expr.cdr instanceof APair &&
              !(expr.cdr.cdr instanceof ANil) &&
              expr.cdr.cdr instanceof APair &&
              !ASymbol.is(expr.cdr.cdr.car, ellipsis_symbol)
            ) {
              const rest = traverse(expr.cdr.cdr, { disabled });
              return concatPairLoose(ctx, result, rest);
            }
            return result;
          } else {
            const car = transform_ellipsis_expr(first, symbols, {
              nested: true,
            });
            if (car) {
              return carrySpan(consCell(ctx, car, nil), expr);
            }
            return nil;
          }
        } else if (first instanceof ASymbol) {
          if (rest_second instanceof APair && ASymbol.is(rest_second.car, ellipsis_symbol)) {
            // case (x ... ...)
          } else {
            // case (x ...) — handled below.
          }
          // case: (x ...)
          const name = first.__name__;
          let bind: BindingCell = { [name]: symbols[name] };
          const is_null = symbols[name] === null;
          let result: SchemeValue = nil;
          while (true) {
            if (!have_binding(bind, true)) {
              break;
            }
            const new_bind: BindingCell = {};
            const next = (key: string | symbol, value: unknown) => {
              new_bind[key] = value as SchemeValue;
            };
            const value = transform_ellipsis_expr(expr, bind, { nested: false }, next);
            if (value !== undefined) {
              result = carrySpan(consCell(ctx, value as SchemeValue, result), expr);
            }
            bind = new_bind;
          }
          if (result instanceof APair) {
            result = carrySpanSpine(listFromArray(ctx, result.to_array(false).toReversed()), expr);
          }
          // Trailing forms after the `(x ...)` spread: a second spread `(x ... y ...)` or a
          // dotted-tail symbol `(??? . x)`, neither consumed by this ellipsis pass.
          const exprCdr = expr instanceof APair ? expr.cdr : nil;
          if (exprCdr instanceof APair && (exprCdr.cdr instanceof APair || exprCdr.cdr instanceof ASymbol)) {
            const node = traverse(exprCdr.cdr, { disabled });
            if (is_null) {
              return node;
            }
            result =
              result instanceof ANil ? node : carrySpanSpine(concatPairLoose(ctx, result as SchemeValue, node), expr);
          }
          return result;
        }
      }
      const head = traverse(first, { disabled });
      let rest: SchemeValue;
      let is_syntax = false;
      if (first instanceof ASymbol) {
        const value = defChild.lookupSettled(first);
        is_syntax = value instanceof Macro && value.__name__ === "syntax-rules";
      }
      if (is_syntax && expr instanceof APair && expr.cdr instanceof APair) {
        const exprCdr = expr.cdr;
        rest =
          exprCdr.car instanceof ASymbol
            ? carrySpan(
                consCell(
                  ctx,
                  traverse(exprCdr.car, { disabled }),
                  exprCdr.cdr instanceof APair
                    ? carrySpan(
                        consCell(
                          ctx,
                          exprCdr.cdr.cdr instanceof APair ? exprCdr.cdr.cdr.car : nil,
                          traverse(exprCdr.cdr.cdr instanceof APair ? exprCdr.cdr.cdr.cdr : nil, { disabled }),
                        ),
                        exprCdr.cdr,
                      )
                    : nil,
                ),
                exprCdr,
              )
            : carrySpan(consCell(ctx, exprCdr.car, traverse(exprCdr.cdr, { disabled })), exprCdr);
      } else {
        rest = expr instanceof APair ? traverse(expr.cdr, { disabled }) : nil;
      }
      return carrySpan(consCell(ctx, head, rest), expr);
    }
    if (expr instanceof ASymbol) {
      if (disabled && ASymbol.is(expr, ellipsis_symbol)) {
        return expr;
      }
      const symbols = Object.keys(bindings["..."].symbols);
      const name = expr.literal();
      invariant(!symbols.includes(name), `syntax-rules: missing ellipsis symbol next to name \`${name}'`);
      const value = transform(expr);
      if (value !== undefined) {
        return value;
      }
    }
    return expr;
  }

  return traverse(expr, {});
}
