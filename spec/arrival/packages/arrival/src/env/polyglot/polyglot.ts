// @inhuman.tools/arrival/polyglot — shared core of the cross-dialect idiom family.
//
// Four sibling packs:
//   scheme/polyglot          (this file) — shared core every dialect stands on
//   scheme/polyglot-clojure  — threading (->/->>), comp, stdlib completion
//   scheme/polyglot-lisp     — mapcar / remove-if / remove-if-not
//   scheme/polyglot-racket   — threading (~>/~>>), dict-*, assoc-ref
//
// HERE: member-access (@/@?/@keys/dict) + universal composition (compose/pipe/flow)
// + string folds: `str` (variadic display-concat — sugarcoat `@{…}` lowers here;
// was historically on polyglot-clojure as a Clojure name, but the product grain is
// shared) and `join` (sep-first twin of SRFI-13 `string-join`, list-first).
// Dialect aliases like `comp` live in dialect packs. `nil` (empty-list alias) and
// `%interleave` (cross-dialect dict/zipmap/alist helper) stay here (multi-consumer).
// `%dict-guard` lives in polyglot-racket (sole consumers).
//
// Member access model: docs/grammar.md §MEMBER-ACCESS; mechanism: docs/membrane.md
// §MEMBER-READ. Two syntaxes over one interop read → receiver's tf(get|has|keys).
// Bound via symbol.native (raw env.set — not rosetta — so the membrane primitive is
// not routed through the membrane it implements).
//
// FV locality (docs/environments.md §PRELUDE): every free name a define body reaches
// needs a deps edge (cxr exception). deps ORDER is a C3 merge input. This pack:
//   equality — null? · lists — reverse apply cons
// (both BASE_PACKS leaves). Polyglot is a deps TARGET (srfi-235 needs compose) and
// a dependent of every dialect pack — base-packs positions it after dialects, before lists.
//
// Wiring-only → pause-trivial. cut/cute ship as SRFI-26. Sole definition site.

import { EnvCapability } from "../../common/capability.js";
import type { CallCtx } from "../../run/CallCtx.js";
import dedent from "dedent";
import { schemeBool, stringValue } from "../../values/op-helpers.js";
import { collapseProvenance, taintString } from "../../provenance/provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ADict, foldKeyName, type DictKey } from "../../values/primitives/ADict.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { type SchemeValue } from "../../values/types.js";
import { type AValue } from "../../values/primitives/AValue.js";
import { printValue } from "../../values/print.js";
import { to_array } from "../pack-helpers.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";

// The `@`/`@?`/`@keys` verbs ARE the member-access protocol's face: key
// normalization + direct dispatch onto the receiver's own
// `arrival/tagless-final/get|has|keys` terms (ADict structurally, AJSObject/
// AJSArray through the interop read policy over their borrowed source) — no
// intermediate membrane face.
// ABSENCE IS THE SEMANTICS: a term-less receiver (scheme leaf, raw FFI value,
// function) answers nil/false/() — never a value's internal provenance/kind.

/** The ONE home of member-key normalization (`@`/`@?` + the `:key` accessor's
 *  string route): valueOf-unwrap a boxed key, refuse nil/null keys, stringify,
 *  strip the leading `:` accessor sigil. Receivers fold the RESULT (ADict's
 *  `foldKeyName` handles the SchemeValue route the keyword accessor takes). */
function normalizeMemberKey(key: unknown): string | null {
  const rawKey = (key as { valueOf?: () => unknown })?.valueOf?.() ?? key;
  if (rawKey == null || rawKey instanceof ANil) return null;
  let keyStr = String(rawKey);
  if (keyStr.startsWith(":")) keyStr = keyStr.slice(1);
  return keyStr;
}

/** Enumerate a receiver's own members through its OWN terms — `keys`, then `get` per key —
 *  and build an OWNED vector from the results.
 *
 *  NOT `toJS` + `Object.values` + `jsToScheme`. That round trip unwraps a borrowed
 *  container to its `source` by identity, enumerates whatever the store holds, and re-borrows
 *  the result: if the store was ever populated with already-crossed values, the rebuilt array
 *  carries `AValue`s into a JS-world store and violates §HYGIENE. Reading through the terms
 *  never leaves scheme space, so the hazard cannot arise regardless of what the receiver
 *  borrows.
 *
 *  Term-less receiver ⇒ empty vector, matching `@keys`: absence is the semantics.
 *
 *  A Promise-valued member (a lazy pending cell — pending-entry.ts) makes the whole read
 *  async: unlike `@`, which hands its single cell to the dispatch wrapper to await, a vector
 *  cannot be minted until every element has settled. */
function collectMembers(
  ctx: CallCtx,
  obj: unknown,
  build: (key: string, value: SchemeValue) => SchemeValue,
): AVector | Promise<AVector> {
  const keysTerm = obj == null ? undefined : (obj as Partial<AValue>)["arrival/tagless-final/keys"];
  const getter = obj == null ? undefined : (obj as Partial<AValue>)["arrival/tagless-final/get"];
  if (typeof keysTerm !== "function" || typeof getter !== "function") return new AVector([]);
  const names = keysTerm.call(obj, ctx.runCtx);
  const reads = names.map((key) => getter.call(obj, key, ctx.runCtx));
  const isThenable = (v: unknown): v is Promise<SchemeValue> =>
    typeof (v as { then?: unknown } | null)?.then === "function";
  if (reads.some(isThenable)) {
    return Promise.all(reads.map((v) => Promise.resolve(v))).then(
      (settled) => new AVector(settled.map((value, i) => build(names[i]!, value as SchemeValue))),
    );
  }
  return new AVector(reads.map((value, i) => build(names[i]!, value as SchemeValue)));
}

// ─── Contract vocabulary local to this pack ─────────────────────────────────────
//
// `applicable` — a function-position argument in THIS pack: a callable value OR a
// symbol. Keyword accessors are first-class functions in the polyglot family (a
// keyword is a real ASymbol carrying its own `apply`, keyword-tagless-apply.md) —
// NOT a member of the `ACallable` union `z.lambda` tests. A bare `z.lambda` on
// these positions would reject the family's own documented idiom, so every
// position this pack APPLIES directly is `z.lambda | z.symbol`. Duplicated (not
// imported) in each sibling pack that needs it — polyglot-clojure.ts,
// polyglot-lisp.ts — a one-line local const is cheaper than a cross-pack named
// export for a pure contract-vocabulary helper.
export default EnvCapability.define("scheme/polyglot", {
  // See the header's DEPS note: `equality` (null?) and `lists` (reverse/apply/
  // cons) are the only cross-capability free names this core's define bodies
  // reach.
  deps: [equality, lists],
  // `:`-prefixed symbols are self-evaluating (keyword-tagless-apply.md) — `ASymbol`
  // itself carries `apply` — so this pack contributes no resolvers, only symbols.
  // A PLAIN record — a builder-function form would make the pack statically
  // un-enumerable, hiding `compose` from srfi-235's own FV allowlist.
  symbols: (symbol, z) => {
    const applicable = z.union([z.lambda, z.symbol]);
    return {
      // ═══════════════════════════════════════════════════════════════════════════
      // MEMBER-ACCESS PROTOCOL (every dialect reads through this)
      // ═══════════════════════════════════════════════════════════════════════════
      // `obj`/`key` stay `z.schemeValue` on BOTH `@`/`@?`/`@keys` — genuinely host-blind inputs:
      // the verbs normalize the key (normalizeMemberKey, above) and dispatch DIRECTLY to
      // the receiver's own `arrival/tagless-final/get|has|keys` terms (ADict/AJSObject/
      // AJSArray); a term-less receiver answers nil/false/() — absence IS the semantics.
      // Each op below has a single, unconditional real OUTPUT type, so the output sides
      // are typed precisely, not left blind.
      "@": symbol.native`@: read a member — origin-agnostic (dict / membrane-foreign / array)`(
        // The get term always returns a real scheme value (nil / a boxed read / an
        // AJSArray-wrapped array) — never something OUTSIDE SchemeValue — or, for a
        // Promise-valued entry, its lazy pending cell (a Promise OF the settled box —
        // pending-entry.ts), which the async dispatch wrapper awaits before encoding.
        // `z.schemeValue` is the identity term for "a polymorphic accessor's operand"
        // (scheme-zod.ts's own worked example).
        { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
        function (this: CallCtx, obj: unknown, key: unknown): SchemeValue | Promise<SchemeValue> {
          if (obj == null) return nil;
          const keyStr = normalizeMemberKey(key);
          if (keyStr === null) return nil;
          const getter = (obj as Partial<AValue>)["arrival/tagless-final/get"];
          return typeof getter === "function" ? getter.call(obj, keyStr, this.runCtx) : nil;
        },
      ),
      "@?": symbol.native`@?: #t iff obj has the member key`(
        // The verdict is the boxed scheme face (schemeBool flyweight — Face split; the
        // raw JS boolean the has term returns is a protocol-layer detail).
        { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
        function (this: CallCtx, obj: unknown, key: unknown) {
          if (obj == null) return schemeBool(false);
          const keyStr = normalizeMemberKey(key);
          if (keyStr === null) return schemeBool(false);
          const has = (obj as Partial<AValue>)["arrival/tagless-final/has"];
          return schemeBool(typeof has === "function" ? has.call(obj, keyStr, this.runCtx) : false);
        },
      ),
      "@keys": symbol.native`@keys: the own member keys of obj, as a vector`(
        // A VECTOR of AString, not a raw JS array of them. `symbol.native` applies no output
        // codec (native.ts), so whatever the impl returns IS the scheme value: a bare JS array
        // has no `arrival/tagless-final/*` terms, so `(car (@keys d))` and `(map f (@keys d))`
        // both refuse it and `toJS` doors it as a non-scheme value — while the dict stubs
        // teach `fold over (@keys d)` as the iteration idiom. Owned AVector, matching
        // `@values`/`@entries`: one return convention across the trio.
        { input: [z.schemeValue], output: [z.vector(z.string)] },
        function (this: CallCtx, obj: unknown) {
          const keys = obj == null ? undefined : (obj as Partial<AValue>)["arrival/tagless-final/keys"];
          const names = typeof keys === "function" ? keys.call(obj, this.runCtx) : [];
          // Mint each key string under the live invocation ctx — `this.runCtx`,
          // carried by `this: CallCtx` (dispatch's `hostImpl.apply(makeCallCtx(runCtx),
          // args)`, common/capability.ts). Under CONSTANT_CTX the result strings mint
          // run-invisible: outside the run's cache and effect tracking.
          return new AVector(names.map((k) => new AString(k)));
        },
      ),
      "@values": symbol.native`@values: the own member values of obj, as a vector`(
        { input: [z.schemeValue], output: [z.vector(z.schemeValue)] },
        function (this: CallCtx, obj: unknown) {
          return collectMembers(this, obj, (_key, value) => value);
        },
      ),
      "@entries": symbol.native`@entries: the own members of obj as (key . value) pairs, in a vector`(
        // BOTH carriers, each for its own reason. A member is a 2-product with no tail — ONE
        // cons cell, `assoc`-compatible — so an entry is an APair, never a 2-list `(k v)`.
        // The COLLECTION is enumeration over own keys, the same face `@keys`/`@values`
        // present, so it is a vector. Reading `(cdr entry)` yields the value itself; a
        // 2-list would yield a one-element list wrapping it.
        { input: [z.schemeValue], output: [z.vector(z.pair)] },
        function (this: CallCtx, obj: unknown) {
          return collectMembers(this, obj, (key, value) => new APair(new AString(key), value));
        },
      ),
      // `dict` — the Scheme-side companion to the `:key` accessor and the `@` read:
      // build an open-key map from interleaved `:key value` pairs. A keyword in arg
      // position self-evaluates to itself (a real ASymbol — keyword-tagless-apply.md),
      // so its key is read the same way a bare quoted symbol's would be: stringify and
      // strip a leading `:` if present. The serializer prints it back as `(dict …)`
      // and arrival-chain-view transpiles it to a JS/Python object literal. (Plain
      // `symbol.native`: dict reads no membrane primitive, so it needs no deferral.)
      dict: symbol.native`dict: an open-key map built from interleaved :key value pairs`(
        // Input stays flat `z.schemeValue` — each interleaved position is genuinely either a
        // key (a self-evaluating keyword symbol, a bare symbol, or a string) or an
        // arbitrary stored value; there's no well-typed way to express the alternation
        // over a flat variadic without a shape that no longer matches the real call
        // form. The OUTPUT is unconditional: this impl always builds (and only ever
        // builds) an ADict.
        // The output contract is `dict()` — the open/homogeneous ADict codec — because
        // this op always builds an open-key ADict.
        { input: z.array(z.schemeValue), output: [z.dict()] },
        // Duplicate keys are last-write-wins: a Map re-set on an existing fold-name
        // updates the value but keeps the FIRST occurrence's iteration position. ADict's
        // own constructor requires unique fold-names up front (throws otherwise), so
        // resolving duplicates down to one pair per name is this call site's job.
        //
        // A real `function(this: CallCtx, …)`, not an arrow: dispatch delivers the live
        // ctx via `this: CallCtx` (common/capability.ts's `hostImpl.apply(makeCallCtx(
        // runCtx), args)`), and an arrow-fn impl structurally cannot read `this` — every
        // `(dict …)` call would mint its ADict + every key's ASymbol run-invisible,
        // outside the run's ctx.
        function (this: CallCtx, ...args: unknown[]): ADict {
          const byName = new Map<string, [DictKey, SchemeValue]>();
          for (let i = 0; i + 1 < args.length; i += 2) {
            const raw = args[i];
            const key: DictKey =
              raw instanceof ASymbol || raw instanceof AString || raw instanceof ACharacter
                ? raw
                : new AString(String(raw).replace(/^:/, ""));
            byName.set(foldKeyName(key), [key, args[i + 1] as SchemeValue]);
          }
          return new ADict([...byName.values()]);
        } as unknown as (...args: SchemeValue[]) => ADict,
      ),

      // ═══════════════════════════════════════════════════════════════════════════
      // POLYGLOT EMPTY-LIST ALIAS
      // ═══════════════════════════════════════════════════════════════════════════
      // nil — polyglot alias for the empty list. Same principle as the sibling
      // packs' idioms: LLMs and humans reach for whichever Lisp idiom they already
      // know. R7RS spells the empty list '() ; many Lisps (and the Scheme the models
      // were trained on) also bind the symbol `nil` to it. '() reads to the ANil singleton,
      // so this binds exactly that. A CONSTANT define: the contract is the single
      // value schema `z.nil`, validated once at bake.
      nil: symbol.define`nil: the polyglot alias for the empty list '() (the ANil singleton)`(z.nil, `'()`),

      // ═══════════════════════════════════════════════════════════════════════════
      // STRING FOLDS — display concat + sep-first join (shared, not dialect-only)
      // ═══════════════════════════════════════════════════════════════════════════
      // `str` — (str arg…) → string. Strings pass through as content; everything else
      // via external representation (`printValue` / the same path as `repr`). Sugarcoat
      // headless `@{…}` lowers to `(str …)`; models reach for the Clojure name.
      // Native (not a define over string-append) so this pack stays free of a
      // scheme/strings dep edge — same discipline as `join` below.
      str: symbol.native`str: concatenate the display form of every arg (strings as-is, everything else via external representation)`(
        {
          input: [],
          inputRest: z.schemeValue,
          output: [z.string],
          type: "(...args: unknown[]) => string",
        },
        function (this: CallCtx, ...args: SchemeValue[]): AString {
          const parts = args.map((x) =>
            typeof x === "string" || x instanceof AString ? stringValue(x) : printValue(x),
          );
          return taintString(parts.join(""), collapseProvenance(...args));
        },
      ),
      // `join` — (join separator list) → string. Same fold as SRFI-13 `string-join`,
      // but separator FIRST (Clojure `clojure.string/join`, Python `"sep".join`, and
      // the form models reach for). Not R7RS; not an "arrival invention" in the core
      // string pack — lives here as the shared polyglot spelling. Impl is native (not
      // a define body calling string-join) so this pack stays free of an srfi-13 dep
      // edge (C3: srfi-13 sits earlier in BASE_PACKS than polyglot).
      join: symbol.native`join: list elements folded to one string with separator first — polyglot twin of SRFI-13 string-join`(
        {
          input: [z.string, z.listAlike],
          output: [z.union([z.string, z.string])],
          type: "(separator: string, list: List<string>) => string",
        },
        function (this: CallCtx, separator: SchemeValue, list: SchemeValue): AString {
          const joined = to_array("join")(list).map(stringValue).join(stringValue(separator));
          return taintString(joined, collapseProvenance(separator, list));
        },
      ),

      // ═══════════════════════════════════════════════════════════════════════════
      // COMPOSITION (shared lineage — compose/pipe are Racket/CL/Clojure-adjacent
      // alike; their dialect-specific spellings — `comp`, `~>` chains — live in the
      // sibling packs. `flow` is Ramda/F#-flavored, not any one Lisp dialect's own.)
      // ═══════════════════════════════════════════════════════════════════════════
      // compose — right-to-left: ((compose f g) x) => (f (g x)).
      // `applicable` (not bare z.lambda): keyword accessors are first-class — (compose :k f).
      // type: seed multi-arg (`apply`); rest unary. Depth 0–6; deeper is a type error (no catch-all).
      compose: symbol.define`compose: right-to-left composition — ((compose f g) x) => (f (g x)); zero fns = identity`(
        {
          input: [],
          inputRest: applicable,
          output: [z.lambda],
          type: dedent`
          {
            (): <T>(x: T) => T;
            <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
            <A extends unknown[], B, R>(f: (b: B) => R, g: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, R>(f: (c: C) => R, g: (b: B) => C, h: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, R>(f: (d: D) => R, g: (c: C) => D, h: (b: B) => C, i: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, E, R>(f: (e: E) => R, g: (d: D) => E, h: (c: C) => D, i: (b: B) => C, j: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, E, F, R>(f: (f: F) => R, g: (e: E) => F, h: (d: D) => E, i: (c: C) => D, j: (b: B) => C, k: (...args: A) => B): (...args: A) => R;
          }
        `,
        },
        `(lambda fns
         (lambda args
           (let ((rfns (reverse fns)))
             (if (null? rfns)
                 (if (null? args) #void (car args))
                 (let loop ((fs (cdr rfns)) (acc (apply (car rfns) args)))
                   (if (null? fs) acc (loop (cdr fs) ((car fs) acc))))))))`,
      ),
      // pipe — left-to-right twin of compose. Same ladder, seed first.
      pipe: symbol.define`pipe: left-to-right composition — ((pipe f g) x) => (g (f x)); zero fns = identity`(
        {
          input: [],
          inputRest: applicable,
          output: [z.lambda],
          type: dedent`
          {
            (): <T>(x: T) => T;
            <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
            <A extends unknown[], B, R>(f: (...args: A) => B, g: (b: B) => R): (...args: A) => R;
            <A extends unknown[], B, C, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, E, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, E, F, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => F, k: (f: F) => R): (...args: A) => R;
          }
        `,
        },
        `(lambda fns
         (lambda args
           (if (null? fns)
               (if (null? args) #void (car args))
               (let loop ((fs (cdr fns)) (acc (apply (car fns) args)))
                 (if (null? fs) acc (loop (cdr fs) ((car fs) acc)))))))`,
      ),
      // flow — CONSTANT alias of pipe (eq? identity). No Contract.type channel on constants.
      flow: symbol.define`flow: an alias of pipe (left-to-right composition) — the Ramda/F# name`(z.lambda, `pipe`),

      // ═══════════════════════════════════════════════════════════════════════════
      // PRIVATE HELPER — consumed cross-dialect (this pack's own `dict`, plus
      // polyglot-clojure.ts's zipmap/%dict-set and polyglot-racket.ts's
      // alist->dict), so it stays HERE rather than traveling with any one dialect.
      // ═══════════════════════════════════════════════════════════════════════════
      // %interleave — zip two equal-length lists into a flat (k v k v …) sequence,
      // the shape `dict`/`apply` expect. CONTRACT: `z.schemeValue` on both lists AND the
      // output — deliberate: the helper self-recurses through its own contract
      // boundary once per element, so a `z.list()` codec (an O(n) spine decode)
      // would turn one interleave into O(n²) decode work; `z.schemeValue`'s instanceof
      // check keeps the recursive boundary flat.
      "%interleave":
        symbol.define`%interleave: zip ks and vs into a flat (k v k v …) list — the dict/apply argument shape (private helper)`(
          { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
          `(lambda (ks vs)
         (if (or (null? ks) (null? vs))
             '()
             (cons (car ks) (cons (car vs) (%interleave (cdr ks) (cdr vs))))))`,
        ),
    };
  },
});
