/**
 * Vector value-domain primitives (R7RS Section 6.8). A vector is exactly a
 * boxed \`SchemeVector\` so the container carries provenance and hosts algebra
 * instances. The mutating members of the family (\`vector-set!\`,
 * \`vector-fill!\`, \`vector-copy!\`) are OMITTED by the purity invariant (frozen
 * entities, doored in this pack); only the non-mutating constructors,
 * accessors, and the higher-order \`vector-map\` / \`vector-for-each\` (which await
 * async membrane callbacks before settling) live here.
 *
 * Each op declares a SCHEME-IDENTITY zod contract (no codec, no runtime
 * validation — "zod for types purely") and an impl bound raw. Vector args are
 * \`z.vector()\`, indices the \`schemeNumber\` tower, predicate/length returns the
 * JS-boolean/number scheme-zod codecs. The representation-blind boundaries —
 * element/list returns (\`vector\`'s elements, \`vector-ref\`/\`vector->list\`'s
 * returns) — are \`z.schemeValue\` (same runtime acceptance, precise static output
 * \`SchemeValue\`). The HOF callback is the types-only \`z.custom\` procedure; its
 * variadic vector rest (\`vector-map\`/\`vector-for-each\`) and \`vector-append\`'s
 * args are \`inputRest\`/\`z.array\` over \`z.vector()\` (see the sibling
 * \`__tests__/vectors-contract-precision.test.ts\` / \`vectors.test-d.ts\`).
 */

import dedent from "dedent";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CallCtx } from "../../run/CallCtx.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { withContractFields } from "../../common/symbols/_bake.js";
import { AVector } from "../../values/primitives/AVector.js";
import { type AVoid, theVoid } from "../../values/primitives/AVoid.js";
import { AString } from "../../values/primitives/AString.js";
import { type SchemeValue } from "../../values/types.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { AExact } from "../../values/primitives/AExact.js";
import { APair } from "../../values/primitives/APair.js";
import { is_promise } from "../../values/value-guards.js";
import { promise_all } from "../../utils/promises.js";
import invariant from "tiny-invariant";
import {
  assertAllocatable,
  asVector,
  charValue,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../../values/op-helpers.js";

import { EnvCapability } from "../../common/capability.js";
import { attachOffendingValue } from "../../errors.js";
import { tf } from "../../values/tagless-final.js";

export default EnvCapability.define("scheme/vectors", {
  symbols: (symbol, z) => ({
    "make-vector": symbol.native`make-vector: a vector of length k, each slot fill`(
      {
        input: [z.schemeNumber, z.schemeValue.optional()],
        output: [z.vector()],
        // Harvest: fill T → readonly T[] (zod prints undeduped unknown[] | unknown[]).
        type: dedent`
          {
            <T>(k: number, fill?: T): readonly T[];
          }
        `,
      },
      function (this: CallCtx, k, fill): AVector {
        const len = Number(typeof k === "number" ? k : (k as AExact).valueOf());
        // O(1) cap check BEFORE Array.from materializes \`len\` slots — see
        // assertAllocatable. \`Array.from({length})\` on an oversized count hangs
        // for >10s.
        assertAllocatable(len, "make-vector");
        // Materialize the fill into every slot AT construction. The fill slot takes any
        // scheme value by design (z.schemeValue / SchemeValue) — a provided fill has crossed
        // the membrane (JS null→nil), and the no-fill case maps each slot to \`theVoid\`
        // (the membrane's own undefined→theVoid image) rather than a raw \`undefined\`,
        // which would leak an unboxed slot. Folding the slot into \`Array.from\`'s map
        // (vs a follow-up \`arr.fill\`) keeps it inside that single boundary.
        const slot: SchemeValue = fill === undefined ? theVoid : fill;
        const arr = Array.from({ length: len }, () => slot);
        // Boxed into SchemeVector so the container carries provenance and hosts
        // algebra instances. Elements (if AValues) still carry their own provenance.
        return withInputProvenance([fill], new AVector(arr));
      },
    ),

    vector: symbol.native`vector: a vector of the given objects`(
      // Elements are scheme values by design (any object may sit in a vector slot) — the
      // typed z.schemeValue replacement, matching make-vector's own fill-slot convention.
      // Same split as `bytevector` (`inputRest: z.schemeNumber`): empty fixed + rest of
      // ELEMENTS. `inputRest: z.vector()` is `vector-append` (rest of containers).
      {
        input: [],
        inputRest: z.schemeValue,
        output: [z.vector()],
        type: dedent`
          {
            <T>(...xs: T[]): readonly T[];
          }
        `,
      },
      function (this: CallCtx, ...objs) {
        return withInputProvenance(objs, new AVector([...objs]));
      },
    ),

    "vector-append": symbol.native`vector-append: concatenation of the given vectors`(
      // Args are vectors, not representation-blind values — z.vector(), matching every other
      // accessor in this file (vector-length/vector-copy/vector->string/…).
      {
        input: [],
        inputRest: z.vector(),
        output: [z.vector()],
        // Homogeneous concat — vectors have no dotted-tail residue (unlike list append).
        type: dedent`
          {
            <T>(...vs: (readonly T[])[]): readonly T[];
          }
        `,
      },
      // vector() decodes the scheme face to AVector | AJSArray (borrowed array), not AVector only.
      function (this: CallCtx, ...vectors): AVector {
        const arrays = vectors.map((v) => asVector(v, "vector-append"));
        // eslint-disable-next-line unicorn/prefer-spread -- dynamic list of arrays; concat(...arrays) is the variadic join
        return withInputProvenance(vectors, new AVector(([] as SchemeValue[]).concat(...arrays)));
      },
    ),

    // The obj answers `(vector? x)` ITSELF via its own arrival/tagless-final/vector? — both a
    // boxed SchemeVector and a borrowed AJSArray return #t; everything else declares no such
    // method, so the guard's graceful default (#f) is the answer. No `instanceof AVector`
    // reach-around in the builtin (the Family-2 "reached around the box" dissolution).
    "vector?": withContractFields(symbol.taglessGuard`vector?: #t iff obj is a vector`, {
      // Dual guard: unknown → readonly unknown[]; Extract preserves element types.
      type: dedent`
          {
            (x: unknown): x is readonly unknown[];
            <T>(x: T): x is Extract<T, readonly any[]>;
          }
        `,
    }),

    "vector-length": symbol.native`vector-length: number of elements in vec`(
      {
        input: [z.vector()],
        output: [z.number],
        // Monomorphic; override mainly kills unknown[] | unknown[] printer gap + readonly.
        type: dedent`
          {
            (v: readonly unknown[]): number;
          }
        `,
      },
      function (this: CallCtx, vec): AExact {
        return new AExact(asVector(vec, "vector-length").length);
      },
    ),

    "vector-ref": symbol.native`vector-ref: the element of vec at index k`(
      // vec is a vector (z.vector()); the returned element is a scheme value,
      // representation-blind by design (z.schemeValue) — same precision as vector->list's
      // element output.
      {
        input: [z.vector(), z.schemeNumber],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(v: readonly T[], k: number): T;
          }
        `,
      },
      // Dispatch to the operand's own arrival/tagless-final/vector-ref (a SchemeVector or a
      // borrowed AJSArray) — no asVector/instanceof reach-around. `vec` stays `unknown`
      // (not narrowed to AVector) deliberately: the protocol admits a borrowed AJSArray
      // too, which is NOT an AVector instance. A non-vector declares no such method →
      // a clear throw (vector-ref on a non-vector IS an error, unlike the #f of vector?).
      function (this: CallCtx, vec, k): SchemeValue {
        const m = vec[tf("vector-ref")];
        if (typeof m !== "function") {
          throw attachOffendingValue(
            new TypeError(`vector-ref: arg 1 is not a vector (declares no arrival/tagless-final/vector-ref)`),
            vec,
          );
        }
        const idx = typeof k === "number" ? k : (k as AExact).valueOf();
        return (m as (i: number, runCtx?: unknown) => SchemeValue).call(vec, idx as number, this.runCtx);
      },
    ),

    // ── PURITY DOORS — vector mutators OMITTED by design (R7RS §6.8) ─────────────
    // A vector is a frozen entity; an in-place write would falsify the construction-
    // site provenance it carries. The non-mutating vector-copy / vector-map below
    // construct fresh vectors instead.
    "vector-set!": symbol.notImplemented`vector-set!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (vector-map / vector-copy / a fresh vector)`,
    "vector-fill!": symbol.notImplemented`vector-fill!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (make-vector with the fill / vector-map)`,
    "vector-copy!": symbol.notImplemented`vector-copy!: every value is frozen by design — mutating its destination would falsify the provenance lineage it carries; construct a new value instead (vector-copy returns a fresh vector)`,

    "vector->list": symbol.native`vector->list: a list of vec's elements in [start, end)`(
      // A list of scheme values, representation-blind by design — z.schemeValue, matching
      // vector-ref's own element-output convention.
      {
        input: [z.vector(), z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.schemeValue],
        type: dedent`
          {
            <T>(v: readonly T[], start?: number, end?: number): List<T>;
          }
        `,
      },
      function (this: CallCtx, vec, start, end): SchemeValue {
        const arr = asVector(vec, "vector->list");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        // vec is unknown (asVector accepts raw arrays); CONSTANT_CTX — AValue carries no per-value ctx.
        return APair.fromArray(CONSTANT_CTX, arr.slice(s, e));
      },
    ),

    "list->vector": symbol.native`list->vector: a vector of the list's elements`(
      {
        input: [z.listAlike],
        output: [z.vector()],
        type: dedent`
          {
            <T>(xs: List<T>): readonly T[];
          }
        `,
      },
      function (this: CallCtx, list): AVector {
        const result: SchemeValue[] = [];
        let current: SchemeValue = list;
        while (current instanceof APair) {
          result.push(current.car);
          current = current.cdr;
        }
        return withInputProvenance([list], new AVector(result));
      },
    ),

    "vector->string": symbol.native`vector->string: a string from vec's character elements in [start, end)`(
      {
        input: [z.vector(), z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.string],
        // Char face is string in the carrier vocab (same as z.char / printType).
        type: dedent`
          {
            (v: readonly string[], start?: number, end?: number): string;
          }
        `,
      },
      function (this: CallCtx, vec, start, end): AString {
        const arr = asVector(vec, "vector->string");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        let result = "";
        for (let i = s; i < e; i++) {
          const ch = arr[i];
          result += ch instanceof ACharacter ? charValue(ch) : String(ch);
        }
        return withInputProvenance([vec], new AString(result));
      },
    ),

    "string->vector": symbol.native`string->vector: a vector of str's characters in [start, end)`(
      {
        input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.vector()],
        type: dedent`
          {
            (s: string, start?: number, end?: number): readonly string[];
          }
        `,
      },
      function (this: CallCtx, str, start, end): AVector {
        const s_str = stringValue(str);
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? s_str.length : toIndex(end);
        const result: SchemeValue[] = [];
        for (let i = s; i < e; i++) {
          result.push(new ACharacter(s_str[i]));
        }
        return withInputProvenance([str], new AVector(result));
      },
    ),

    "vector-copy": symbol.native`vector-copy: a fresh copy of vec over [start, end)`(
      {
        input: [z.vector(), z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.vector()],
        type: dedent`
          {
            <T>(v: readonly T[], start?: number, end?: number): readonly T[];
          }
        `,
      },
      function (this: CallCtx, vec, start, end): AVector {
        const arr = asVector(vec, "vector-copy");
        const s = start === undefined ? 0 : toIndex(start);
        const e = end === undefined ? arr.length : toIndex(end);
        return withInputProvenance([vec], new AVector(arr.slice(s, e)));
      },
    ),

    // (vector-set! / vector-fill! / vector-copy! are doored above, grouped with the
    // other vector mutators; the non-mutating vector-copy above returns a fresh copy.)

    "vector-map": symbol.native`vector-map: apply proc across the vectors, collecting results into a new vector`(
      // proc is the fixed HEAD (`input`); the spread vectors are the variadic TAIL
      // (`inputRest`) — mirrors apply/for-each/string-map's own head/rest split. The rest
      // is z.vector() (this file's own vector-identity schema), not representation-blind.
      {
        input: [z.lambda],
        inputRest: z.vector(),
        output: [z.vector()],
        provenance: "fan",
        type: dedent`
          {
            <T, B>(f: (x: T) => B, v: readonly T[]): readonly B[];
            <A, B, R>(f: (a: A, b: B) => R, a: readonly A[], b: readonly B[]): readonly R[];
            <A, B, C, R>(f: (a: A, b: B, c: C) => R, a: readonly A[], b: readonly B[], c: readonly C[]): readonly R[];
          }
        `,
      },
      function (this: CallCtx, proc, ...vectors) {
        invariant(vectors.length > 0, "vector-map: expected at least one vector argument");
        const arrays = vectors.map((v) => asVector(v, "vector-map"));
        const minLen = Math.min(...arrays.map((a) => a.length));
        const result: SchemeValue[] = [];
        for (let i = 0; i < minLen; i++) {
          const elements = arrays.map((a) => a[i]);
          // Seam-routed: `proc` is a callable VALUE now, not a bare fn. `this` IS the whole
          // CallCtx dispatch built — thread it, not just `this.runCtx`.
          result.push(applyCallback(proc, elements, this) as SchemeValue);
        }
        // proc may be an async membrane callback → its results are JS Promises. Mirror
        // the list \`map\` (r7rs/lists.ts): if any slot is a promise, await them all so the
        // returned vector holds SETTLED values (not "[object Promise]") and provenance
        // is preserved. (errors-as-doors note: silent leak defeats boxing goal-b.)
        if (result.some(is_promise)) {
          return (promise_all(result) as Promise<SchemeValue[]>).then((resolved) =>
            withInputProvenance(vectors, new AVector(resolved)),
          );
        }
        return withInputProvenance(vectors, new AVector(result));
      },
    ),

    "vector-for-each": symbol.native`vector-for-each: apply proc across the vectors for effect`(
      // Same head/rest migration as vector-map above (callable head, z.vector() rest).
      {
        input: [z.lambda],
        inputRest: z.vector(),
        output: [z.undefinedResult],
        type: dedent`
          {
            <T>(f: (x: T) => unknown, v: readonly T[]): void;
            <A, B>(f: (a: A, b: B) => unknown, a: readonly A[], b: readonly B[]): void;
            <A, B, C>(f: (a: A, b: B, c: C) => unknown, a: readonly A[], b: readonly B[], c: readonly C[]): void;
          }
        `,
      },
      function (this: CallCtx, proc, ...vectors): AVoid | Promise<AVoid> {
        invariant(vectors.length > 0, "vector-for-each: expected at least one vector argument");
        const arrays = vectors.map((v) => asVector(v, "vector-for-each"));
        const minLen = Math.min(...arrays.map((a) => a.length));
        const pending: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          const elements = arrays.map((a) => a[i]);
          // `this` IS the whole CallCtx dispatch built — thread it, not just `this.runCtx`.
          const ret = applyCallback(proc, elements, this);
          if (is_promise(ret)) pending.push(ret);
        }
        // Await any async side effects before returning, so for-each does not complete
        // while promises are still outstanding. R7RS "unspecified" is theVoid on the
        // scheme face (was a bare JS undefined).
        if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => theVoid);
        return theVoid;
      },
    ),
  }),
});
