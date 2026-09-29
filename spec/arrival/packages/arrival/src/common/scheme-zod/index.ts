// scheme-zod — the codec layer over values/membrane: per-arg schemas that decode Scheme
// arguments into JS and encode JS results back, both faces (`z.input`/`z.output`) of one
// contract. A member of the declared two-interpreter core (values ⇄ eval ⇄ membrane ⇄ run
// ⇄ common/symbols ⇄ common/scheme-zod ⇄ env — the knot; tagless-final means value classes
// implement both interpreters, so this stratum sees run/eval-adjacent machinery).
// Value-imports `run/CallCtx` (`makeCallCtx`, §region-scope call-site below) for the SAME
// reason CallCtx.ts's own header gives for housing it outside `_bake.ts`: a cycle through
// `_bake` would close badly (z.instanceof captures its class arg BY VALUE at call time — a
// TDZ undefined would stick). `lookupName` + `defOf` are the ONLY sanctioned `_zod.def`
// introspection doors (E2 consolidation — see their drift-pin comment). Nothing outside
// this module imports back except type-only edges.

import * as z from "zod";
import { applyMembraneClosure, CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import { makeCallCtx } from "../../run/CallCtx.js";
import { jsToScheme, type InvocationLike } from "../../membrane/rosetta.js";

import { APair } from "../../values/primitives/APair.js";
import { ANil } from "../../values/primitives/ANil.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AVector } from "../../values/primitives/AVector.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { AString } from "../../values/primitives/AString.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AVoid } from "../../values/primitives/AVoid.js";
import { AValue } from "../../values/primitives/AValue.js";
import { AOpaqueHandle } from "../../values/primitives/AOpaqueHandle.js";
import { ADict, foldKeyName, isDictShaped, type DictKey } from "../../values/primitives/ADict.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { AJSArray } from "../../membrane/AJSArray.js";
import { markSpineAdopting } from "../spine-adoption.js";
import { CodecFidelityError, R7RSError } from "../../errors.js";
import { ALambda, DoorProcedure, applyCallback, ACallable } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { currentRegionScope, DETACHED_SCOPE, withRegionCall } from "../../membrane/region-scope.js";
// Leaf with ZERO own imports — safe from scheme-zod cycles (same as rosetta.ts).
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";

/**
 * Codec vocabulary — membrane per-arg codecs.
 *
 * **Faces.** `z.input` = SCHEME face, `z.output` = JS face. Frame:
 * `docs/environments.md` §CONTRACT; membrane mechanics: `docs/membrane.md`.
 * Primitive names stay ambiguous on purpose (not Scheme's `AExact`, not JS's
 * `bigint`) — codecs are not tied to either ontology.
 *
 * **ContourOnly / CrossingOnly (named brands).** Phantom type-only tags, erased
 * at compile. The same `isSchemeValue` predicate mints two exports:
 * - `schemeValue` (`ContourOnly`) — honest top type for native/contour/define/
 *   sequence/tagless. Compile-banned from rosetta (`CrossingSlot` in `_bake.ts`).
 *   Prints `SchemeValue`.
 * - `dynamic` (`CrossingOnly`) — special kind for a FULLY-GENERIC rosetta slot
 *   (∀-quantified: the verb is polymorphic in the slot, the value passes through
 *   whole), never a default fallback — an awkward shape has an honest codec
 *   (union/dict/box/instance). Compile-banned from contour (`ContourSlot`).
 *   Prints `unknown`.
 * Every other schema in this vocabulary carries NEITHER brand (legal in both
 * kinds). Rejected alternative: positive double-tagging of every codec — would
 * force re-typing zod combinator re-exports to propagate the tag, for the same
 * observable ban.
 *
 * **Round-trip laws.** A real codec transforms both ways. A predicate
 * (`schemeValue`/`dynamic`/`lambda`/`listAlike`) does not — identity
 * on both faces. Returning a procedure *from* rosetta is banned (provenance
 * untraceable); procedures as arguments travel wrapped. Use `z.procedure` for
 * a declared callable crossing; a callable through `z.dynamic` is a teaching
 * door (`docs/membrane.md` §REGION / `docs/environments.md` §MEMBRANE-SEAM).
 *
 * | scheme face      | JS image              | notes                    |
 * |------------------|-----------------------|--------------------------|
 * | `boolean`        | `boolean`             |                          |
 * | `integer`        | `number` (int)        | exact or inexact domain  |
 * | `inexact`        | `number`              | lossy acknowledged       |
 * | `char`           | `string` (len 1)      |                          |
 * | `string`         | `string`              |                          |
 * | `symbol`         | JS symbol (opaque)    |                          |
 * | `nil`            | `null`                |                          |
 * | `undefinedResult`| `undefined`           | void; reserved word      |
 * | `list` / `cons`  | array / `[car,cdr]`   | list input; cons pair    |
 * | `vector`         | array                 | AVector \| AJSArray      |
 * | `bytevector`     | `Uint8Array`          |                          |
 * | `dict`           | object                | fixed-key struct or open boxed |
 * | `dictRecord`     | `Record<K,V>`         | open homogeneous record  |
 * | `foldName`       | `string`              | keyword/string name fold |
 * | `box`            | object (unwrap)       | preserves class identity |
 * | `error`          | `Error`               |                          |
 * | `procedure`      | bound function        | input only               |
 * | `instance(Ctor)` | `Ctor` instance       | CrossingOnly opaque      |
 *
 * Casts: `number` / `bigint` / `exact` / `inexact` / `looseNumber` (permissive
 * arithmetic half). Zod's own `array` is re-exported for native arg-vectors —
 * no scheme-collection `array()`; use `list`/`vector`.
 */

export {
  array,
  tuple,
  union,
  record,
  enum,
  decode,
  encode,
  custom,
  object,
  strictObject,
  literal,
  codec,
  config,
  toJSONSchema,
  fromJSONSchema,
} from "zod";
export type { input, output, infer, ZodType, ZodTypeAny, ZodCustom, ZodRawShape } from "zod";

// ── Name registry ──────────────────────────────────────────────────────────

const NAMES = new WeakMap<z.ZodType, string>();

// Element schema(s) for named-generic printing (`List<T>` / `Pair<Car,Cdr>`).
// Only `list`/`cons` register — vector/dict print structurally.
const COLLECTION_ELEMENT = new WeakMap<z.ZodType, z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny]>();

/** Register `schema` under `name`. Keyed by object identity — each `list(char)` mints its own. */
function named<S extends z.ZodType>(name: string, schema: S): S {
  NAMES.set(schema, name);
  return schema;
}

// Walk to the registered core. Check registry at EACH hop — a registered codec
// IS a pipe and carries `def.in`; unwrapping past it loses registration.
// Order: registered? → core. Else `_zod.parent` (set ONLY by `.refine()`/
// `.check()`, NOT `.extend()`) → walk. Else unwrap `.optional()`/`.default()`
// (`def.innerType`) or unregistered wrapper's `def.in`. Drift pin: zod 4.3.6.
function resolveCore(schema: unknown): z.ZodType | undefined {
  let s = schema as { _zod?: { parent?: unknown; def?: { innerType?: unknown; in?: unknown } } } | undefined;
  while (s) {
    if (NAMES.has(s as z.ZodType)) return s as z.ZodType;
    if (s._zod?.parent) {
      s = s._zod.parent as typeof s;
      continue;
    }
    const inner = s._zod?.def?.innerType ?? s._zod?.def?.in;
    if (inner) {
      s = inner as typeof s;
      continue;
    }
    break;
  }
  return undefined;
}

export function lookupName(schema: unknown): string | undefined {
  const core = resolveCore(schema);
  return core ? NAMES.get(core) : undefined;
}

/** Sole sanctioned `_zod.def` doorway for structural def introspection (tuple `items`,
 *  array `element`, object `shape`, tuple `rest`, …). Reads the schema's OWN def — no
 *  registry walk, unlike `resolveCore`. Loosely typed on purpose: callers narrow to the
 *  shape they need. Same drift pin as `resolveCore` above: zod 4.3.6. */
export function defOf(schema: unknown): Record<string, unknown> | undefined {
  return (schema as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
}

/** Element schema(s) a `list`/`cons` was built with — single schema / `[car,cdr]` /
 *  `undefined` for fixed-heads `list([A,B])` (structural print). Same core walk as `lookupName`. */
export function lookupCollectionElement(
  schema: unknown,
): z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny] | undefined {
  const core = resolveCore(schema);
  return core ? COLLECTION_ELEMENT.get(core) : undefined;
}

// ── schemeValue / dynamic (defined early: list/vector default element) ─────

// PREDICATE, never a union: a union makes `z.decode` pick a branch and TRANSFORM
// (collapse AExact → bare bigint) — wrong for identity-on-both-faces. Covers
// every `A*` via `instanceof AValue`, plus a JS fn used as a procedure.
function isSchemeValue(x: unknown): x is SchemeValue {
  return x instanceof AValue || typeof x === "function";
}

declare const CONTOUR_ONLY: unique symbol;
declare const CROSSING_ONLY: unique symbol;

/** Nominal tag for `z.schemeValue` only — never intersected onto anything else. */
export type ContourOnly<S> = S & { readonly [CONTOUR_ONLY]: true };
/** Nominal tag for `z.dynamic` / `instance` — never intersected onto anything else. */
export type CrossingOnly<S> = S & { readonly [CROSSING_ONLY]: true };

// Contour top type. Rosetta needs a real codec, `z.procedure`, or `z.dynamic`.
const schemeValueSchema = named("schemeValue", z.custom<SchemeValue>(isSchemeValue));
export const schemeValue = schemeValueSchema as ContourOnly<typeof schemeValueSchema>;

// Fully-generic rosetta slot kind (∀ pass-through, never a default fallback — see
// the vocabulary table). Runtime door keys off the registered name `"dynamic"`
// specifically (`common/symbols/rosetta.ts`); `instance(Ctor)` is a separate real
// codec and never reaches those dynamic-only paths.
// DIRECTION ASYMMETRY (world-flip ruling 2026-08-13): as INPUT, decode is identity —
// the impl receives the raw boxed SchemeValue. As OUTPUT, the slot only skips
// z.encode; the impl still returns RAW JS and the membrane boxes it — returning an
// AValue (bare or nested) is an illegal world flip (`WorldFlipError`, the
// `assertNoWorldFlip` door in common/symbols/rosetta.ts). A verb that hands back
// scheme values belongs on the contour (`symbol.native` + `z.schemeValue`).
const dynamicSchema = named("dynamic", z.custom<SchemeValue>(isSchemeValue));
/** Phantom marker carried ONLY by `z.dynamic` — `_bake.ts`'s DecodedReturn keys the
 *  return-face flip off it (world-flip ruling: impl RECEIVES SchemeValue, RETURNS raw
 *  JS `unknown`). Optional-phantom: never present at runtime, never on other codecs. */
export interface DynamicHatch {
  readonly "arrival/dynamic-hatch"?: true;
}
export const dynamic = dynamicSchema as CrossingOnly<typeof dynamicSchema> & DynamicHatch;

// ── Marshal ctx ────────────────────────────────────────────────────────────
//
// Scalar `encode` receives a bare JS primitive — no per-value run-context to read.
// Minting under CONSTANT_CTX drops the crossing off the run's
// cache / effects / reads / signal; everything built from that value inherits
// the wrong run.
//
// Priority:
//   1. `_marshalRunCtx` — ambient this file installs. Callers with a live
//      RunContext: `procedure()` encode/decode (`callCtx.runCtx` / closed-over
//      `scope.runCtx`); `common/symbols/rosetta.ts` wraps its output-encode in
//      `withMarshalCtx` (also what `instance` encode needs — no boxed operand).
//   2. `currentRegionScope()?.runCtx` — same ambient `z.procedure` reverse-
//      crossing decode uses for its wrapper cache. Open only when
//      `carriesCallable` opens a scope; else absent.
//   3. CONSTANT_CTX — nothing live (unit test calling `.parse`/`.encode` bare).
let _marshalRunCtx: RunContext | undefined;

/** Install `ctx` as ambient marshal ctx for a SYNCHRONOUS `fn` — save/restore
 *  (same idiom as `withRegionScope`; nesting restores outer on the way out). */
export function withMarshalCtx<T>(ctx: RunContext, fn: () => T): T {
  const saved = _marshalRunCtx;
  _marshalRunCtx = ctx;
  try {
    return fn();
  } finally {
    _marshalRunCtx = saved;
  }
}

function marshalCtx(): RunContext {
  return _marshalRunCtx ?? currentRegionScope()?.runCtx ?? CONSTANT_CTX;
}

// ── Scalar primitives ──────────────────────────────────────────────────────

export const boolean = named(
  "boolean",
  z.codec(z.instanceof(ABool), z.boolean(), {
    decode: (b) => b["arrival/toJS"](),
    encode: (b) => new ABool(b),
  }),
);

export const booleanTrue = boolean.refine((v): v is true => v === true);
export const booleanFalse = boolean.refine((v): v is false => v === false);

export const char = named(
  "char",
  z.codec(z.instanceof(ACharacter), z.string().length(1), {
    decode: (c) => c["arrival/toJS"](),
    encode: (c) => new ACharacter(c),
  }),
);

export const string = named(
  "string",
  z.codec(z.instanceof(AString), z.string(), {
    decode: (s) => s["arrival/toJS"](),
    encode: (s) => new AString(s),
  }),
);

// ASymbol ↔ JS Symbol. Weak key = ASymbol (scheme→js); strong value under weak
// jsSymbol key (js→scheme). Rejected alternative: `Map<symbol, WeakRef<ASymbol>>`
// + FinalizationRegistry held ASymbol weakly and could collect it under a live
// jsSymbol, making encode throw nondeterministically. Here encode is TOTAL —
// ASymbol lives exactly as long as its jsSymbol. Valid only for unregistered
// symbols (`Symbol(desc)`); `Symbol.for(...)` is not a legal WeakMap key and
// this codec never mints those.
const symbolSchemeToJs = new WeakMap<ASymbol, symbol>();
const symbolJsToScheme = new WeakMap<symbol, ASymbol>();
export const symbol = named(
  "symbol",
  z.codec(z.instanceof(ASymbol), z.symbol(), {
    decode: (s) => {
      const existing = symbolSchemeToJs.get(s);
      if (existing) return existing;
      const js = Symbol(`arrival membrane symbol: ${String(s.__name__)}`);
      symbolSchemeToJs.set(s, js);
      symbolJsToScheme.set(js, s);
      return js;
    },
    encode: (js) => {
      const s = symbolJsToScheme.get(js);
      Error.invariant(s !== undefined, "symbol codec: encode received a jsSymbol never minted by decode");
      return s;
    },
  }),
);

// Real codecs (not bare instanceof): a union sibling that decodes to raw scheme
// while another decodes to JS breaks the uniform JS face every rosetta consumer
// depends on. `nil` is the null-value role only — empty-list is `list`'s decode.
export const nil = named(
  "nil",
  z.codec(z.instanceof(ANil), z.null(), {
    decode: () => null,
    encode: () => new ANil(),
  }),
);

/** Table name `void` is reserved — exported as `undefinedResult`. */
export const undefinedResult = named(
  "undefinedResult",
  z.codec(z.instanceof(AVoid), z.undefined(), {
    decode: (v) => v["arrival/toJS"](),
    encode: () => new AVoid(),
  }),
);

export const error = named(
  "error",
  z.codec(z.instanceof(R7RSError), z.instanceof(Error), {
    decode: (e) => new Error(e.message, { cause: e.irritants.length > 0 ? e.irritants : undefined }),
    encode: (e) =>
      new R7RSError(e.message, ...(Array.isArray(e.cause) ? e.cause : e.cause === undefined ? [] : [e.cause])),
  }),
);

// ── Numbers ────────────────────────────────────────────────────────────────
//
// DOOR VS INVARIANT. Decode sites are model-reachable (a program's exact
// rational hitting a native arg) — plain `CodecFidelityError`, never
// `invariant` (the "Invariant failed:" prefix reads like an engine bug).
// Encode sites (host JS → scheme boxing) stay `invariant` — a bad host value
// IS an internal contract breach.

// JS face is plain `number`: every AExact is a safe-integer number by
// construction. A raw host `bigint` doors at the membrane — this encode does
// not auto-adopt; convert explicitly (or use `z.bigint`, which boxes first).
export const exact = named(
  "exact",
  z.codec(z.instanceof(AExact), z.number(), {
    decode: (n) => {
      if (n.denom !== 1) throw new CodecFidelityError("exact", `exact rational ${n.toString()} has no integer form`);
      return n.num;
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `exact codec: ${n} is not a safe integer`);
      return new AExact(n);
    },
  }),
);

// Also the AInexact ↔ number cast (no separate `rational` export).
export const inexact = named(
  "inexact",
  z.codec(z.instanceof(AInexact), z.number(), {
    decode: (n) => n["arrival/toJS"](),
    encode: (n) => new AInexact(n),
  }),
);

function exactToJsNumberOrDoor(n: AExact): number {
  // Door — model-reachable (preamble DOOR VS INVARIANT).
  if (n.denom !== 1) {
    throw new CodecFidelityError(
      "number",
      `exact rational ${n.toString()} cannot be a faithful JS number — use the integer codec, or looseNumber to accept the projected (divided) value`,
    );
  }
  // AExact.num is already a safe integer by construction.
  return n.num;
}

// Accepts either exact-domain kind; encode canonicalizes to AExact.
export const integer = named(
  "integer",
  z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number().int(), {
    decode: (n) => {
      if (n instanceof AInexact) {
        if (!Number.isSafeInteger(n.real)) {
          throw new CodecFidelityError("integer", `inexact ${n.toString()} is not a safe integer`);
        }
        return n.real;
      }
      return exactToJsNumberOrDoor(n); // rejects rationals + out-of-range
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `integer codec: ${n} is not a safe integer`);
      return new AExact(n);
    },
  }),
);

export const schemeNumber = named("schemeNumber", z.union([exact, inexact]));

// AInexact first so encode prefers AInexact over the safe-integer AExact arm.
export const number = named(
  "number",
  z.union([
    z.codec(z.instanceof(AInexact), z.number(), {
      decode: (n) => n["arrival/toJS"](),
      encode: (n) => new AInexact(n),
    }),
    z.codec(z.instanceof(AExact), z.number(), {
      decode: (n) => exactToJsNumberOrDoor(n),
      encode: (n) => {
        TypeError.invariant(Number.isSafeInteger(n), `number codec: ${n} is not a safe integer`);
        return new AExact(n);
      },
    }),
  ]),
);

// Prefer `integer` (safe-int number). bigint cast kept for declared consumers.
export const bigint = named(
  "bigint",
  z.union([
    z.codec(z.instanceof(AExact), z.bigint(), {
      decode: (n) => {
        if (n.denom !== 1) {
          throw new CodecFidelityError("bigint", `exact rational ${n.toString()} has no integer bigint form`);
        }
        return BigInt(n.num);
      },
      encode: (n) => {
        const num = Number(n);
        TypeError.invariant(
          Number.isSafeInteger(num),
          `bigint codec: ${n} exceeds safe-integer range — exact numbers are safe-integer-only post-rework`,
        );
        return new AExact(num);
      },
    }),
    z.codec(z.instanceof(AInexact), z.bigint(), {
      decode: (n) => {
        if (!Number.isInteger(n.real)) {
          throw new CodecFidelityError("bigint", `inexact ${n.toString()} has a fractional part`);
        }
        return BigInt(n.real);
      },
      encode: (n) => new AInexact(Number(n)),
    }),
  ]),
);

// ── Loose numeric (permissive arithmetic domain) ───────────────────────────
//
// `number`/`bigint` above are STRICT boundary casts: door on precision loss
// and reject IEEE non-finite (`z.number()` excludes NaN/±Infinity — zod 4.3.6).
// Wrong for R7RS math builtins that must (a) accept `+nan.0`/`+inf.0`/`-inf.0`
// and (b) lossily convert a non-integer exact rational (`(round 7/2)`).

/** Any scheme number ↔ JS `number`, LOSSY (non-integer exact divides; no door)
 *  and permissive of non-finite values. Encode: safe-integer → AExact, else
 *  AInexact — without `number`'s finite-only guard. */
export const looseNumber = named(
  "looseNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.custom<number>((v) => typeof v === "number"),
    {
      decode: (n) => (n instanceof AExact ? n.num / n.denom : n.real),
      encode: (n) => (Number.isSafeInteger(n) ? new AExact(n) : new AInexact(n)),
    },
  ),
);

/** Any scheme number ↔ JS `number | bigint`. The `bigint` decode arm is
 *  unreachable (no live AExact is out-of-safe-range) — kept so the JS-face
 *  union stays a strict superset of `looseNumber` for `schema-to-ts.ts`
 *  `IMAGE_BY_NAME`. No live caller; numeric builtins went box-native. */
export const looseAnyNumber = named(
  "looseAnyNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.union([z.custom<number>((v) => typeof v === "number"), z.bigint()]),
    {
      decode: (n) => (n instanceof AExact ? n.num / n.denom : n.real),
      encode: (v) => {
        if (typeof v === "bigint") {
          const num = Number(v);
          TypeError.invariant(Number.isSafeInteger(num), `looseAnyNumber: ${v} exceeds safe-integer range`);
          return new AExact(num);
        }
        return Number.isSafeInteger(v) ? new AExact(v) : new AInexact(v);
      },
    },
  ),
);

export const bytevector = named(
  "bytevector",
  z.codec(z.instanceof(ABytevector), z.instanceof(Uint8Array), {
    decode: (b) => b.__bytevector__ as Uint8Array<ArrayBuffer>,
    encode: (b) => new ABytevector(b),
  }),
);

/** Callable VALUE predicate — `ALambda` / `ANativeProcedure` / `ARosettaProcedure`
 *  / `DoorProcedure` only. Bare host functions refused (mint via
 *  hostFnToCallable / ANativeProcedure). `DoorProcedure` type-checks under
 *  `z.lambda` and still throws its teaching `PurityError` when invoked. */
export const lambda = named(
  "lambda",
  z.custom<ACallable>(
    (v) =>
      v instanceof ALambda ||
      v instanceof ANativeProcedure ||
      v instanceof ARosettaProcedure ||
      v instanceof DoorProcedure,
  ),
);

// ── Collections (head-tuple + optional tail, mirrors Contract.input/inputRest) ─

const listContainer = z.custom<AListAlike>((x) => x instanceof APair || x instanceof ANil);

// Walk pair spine → car array; reject cycles and improper lists. Out-schema
// validates elements/arity.
function spineToArray(l: AListAlike): unknown[] {
  const out: unknown[] = [];
  let node: unknown = l;
  while (node instanceof APair) {
    if (node.have_cycles("cdr")) throw new CodecFidelityError("list", "cannot decode a circular list");
    out.push(node.car);
    node = node.cdr;
  }
  if (!(node instanceof ANil)) throw new CodecFidelityError("list", "cannot decode an improper list");
  return out;
}

/**
 * Proper list, printed `List<T>` (see fixed-heads form):
 * - `list()` / `list(E)` — homogeneous unbounded E (default `schemeValue`)
 * - `list([A, B])` — exactly A then B, nil-terminated
 * - `list([A, B], E)` — fixed heads then zero-or-more E
 *
 * NOT `cons`: `list([carE])` is proper `(a)` = `(a . ())`; `cons(a, b)` is a
 * dotted pair whose cdr need not be nil-terminated.
 */
export function list<E extends z.ZodTypeAny = typeof schemeValue>(
  element?: E,
): z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodArray<E>>;
export function list(
  heads: readonly z.ZodTypeAny[],
  tail?: z.ZodTypeAny,
): z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodType>;
export function list(headsOrElement: z.ZodTypeAny | readonly z.ZodTypeAny[] = schemeValue, tail?: z.ZodTypeAny) {
  const heads = Array.isArray(headsOrElement) ? (headsOrElement as readonly z.ZodTypeAny[]) : [];
  // Bare / single-arg form: lone schema is homogeneous tail, not a head.
  const effectiveTail = Array.isArray(headsOrElement) ? tail : (tail ?? (headsOrElement as z.ZodTypeAny));
  const out: z.ZodType =
    heads.length === 0
      ? z.array(effectiveTail ?? schemeValue)
      : effectiveTail
        ? z.tuple(heads as [z.ZodTypeAny, ...z.ZodTypeAny[]], effectiveTail)
        : z.tuple(heads as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
  const schema = named(
    "list",
    z.codec(listContainer, out as z.ZodArray<z.ZodTypeAny>, {
      decode: (l) => spineToArray(l) as never,
      // Heap-metering INERT (CONSTANT_CTX; restoration is workboard D1). The spine mint
      // inherits CONSTANT_CTX — no charge today.
      encode: (arr) => APair.fromArray(CONSTANT_CTX, arr as SchemeValue[], false) as AListAlike,
    }),
  );
  // Homogeneous form → `List<E>`. Fixed-heads register nothing (structural print).
  if (heads.length === 0) COLLECTION_ELEMENT.set(schema, effectiveTail ?? schemeValue);
  return schema as z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodType>;
}

// Own function, not subsumed by `list`'s tuple form: exactly one pair; cdr
// matches cdrE DIRECTLY (not "eventually after more cars"). `cons(char, nil)`
// accepts a 1-char list only. Prints `Pair<Car, Cdr>`, not a 2-tuple.
export function cons<C extends z.ZodTypeAny, D extends z.ZodTypeAny>(carE: C, cdrE: D) {
  const schema = named(
    "cons",
    z.codec(z.instanceof(APair), z.tuple([carE, cdrE]), {
      // `as never`: zod tuple input is a variadic conditional (generic boundary).
      decode: (p) => [p.car, p.cdr] as never,
      encode: ([c, d]) => {
        const carValue = c as SchemeValue;
        const cdrValue = d as SchemeValue;
        return new APair(carValue, cdrValue);
      },
    }),
  );
  COLLECTION_ELEMENT.set(schema, [carE, cdrE]);
  return schema;
}

// `cons(schemeValue, schemeValue)` as a real codec — bare `instanceof(APair)`
// never decodes, so a rosetta `z.pair` would hand the impl a raw APair.
// Spine-adopting: slot means "non-empty spine"; adoption runs BEFORE validation
// so a non-empty array passes and empty adopts to `nil` (correctly rejected).
export const pair = markSpineAdopting(cons(schemeValue, schemeValue));

/**
 * Spine-chart list identity (twin of `vector` as indexed chart). Bake adopts:
 * borrowed AJSArray → AJSArrayList (same array/provenance, O(1)); empty → nil
 * so `(null? xs)` is honest (`instanceof ANil`).
 *
 * INPUT ONLY — fresh-list output is `z.union([z.pair, z.nil])`.
 * Runtime admits AJSArray (pre-adoption); TS type is AListAlike post-adoption.
 * Scheme face only (not a codec; ban on symbol.rosetta). native/define consumers.
 */
export const listAlike = markSpineAdopting(
  named(
    "listAlike",
    z.custom<AListAlike>((v) => v instanceof APair || v instanceof ANil || v instanceof AJSArray),
  ),
);

// Representation-blind `AVector | AJSArray`; encode canonically produces AVector.
export function vector<E extends z.ZodTypeAny = typeof schemeValue>(element: E = schemeValue as unknown as E) {
  return named(
    "vector",
    z.union([
      z.codec(z.instanceof(AVector), z.array(element), {
        decode: (v) => v.__vector__ as z.input<E>[],
        // Heap-metering INERT (same rule as list encode; restoration is workboard D1).
        encode: (arr) => new AVector(arr as SchemeValue[]),
      }),
      // Borrowed arm is DECODE-ONLY. A borrowed array is membrane-minted from a
      // JS-world array with the crossing's ctx + provenance. Encoding scheme
      // values into that store would violate AJSArray's JS-world-only hygiene
      // and lose lineage (encode has neither ctx nor provenance for the mint).
      // Unreachable in practice (union encodes through the first matching arm)
      // — door guards a direction that cannot be re-aimed.
      z.codec(z.instanceof(AJSArray), z.array(element), {
        // BOXED elements (`__vector__`), not raw `.source` — both arms present
        // the same scheme face. Element schemas demand AValues; raw JSON off
        // `.source` would fail. Cost: materializes (`vec()`, cached) at decode;
        // only `symbol.define` validation walks it; a verb folding the vector
        // pays the walk anyway.
        decode: (v) => v.__vector__ as z.input<E>[],
        encode: () => {
          throw new CodecFidelityError(
            "vector",
            "cannot ENCODE a borrowed AJSArray — a borrowed array is minted by the MEMBRANE from a JS-world " +
              "array (with the crossing's ctx + provenance), never assembled from scheme values. A codec's " +
              "`encode` has neither, which is exactly why this direction cannot carry lineage. Encode produces " +
              "an AVector (the canonical first arm of this union).",
          );
        },
      }),
    ]),
  );
}

// ── dict / box ─────────────────────────────────────────────────────────────

const dictContainer = z.union([
  z.instanceof(ADict),
  z.instanceof(AJSObject).refine((o): o is AJSObject => isDictShaped(o.source)),
]);

/**
 * Native k/v map. Keyed `dict({a: integer()})` → per-key codec (struct); bare
 * `dict()` → open `Record<string, SchemeValue>` (values stay scheme-boxed).
 * For an open record with *typed* values, use {@link dictRecord}.
 *
 * Two overloads (same split as {@link list}): a runtime `keys.length ? object : record`
 * ternary does not narrow — TS would union the open-record face onto every shaped
 * dict (`Record<string, SchemeValue> | { a: string }`).
 */
export function dict(): z.ZodCodec<typeof dictContainer, z.ZodRecord<z.ZodString, typeof schemeValue>>;
export function dict<S extends Record<string, z.ZodTypeAny>>(
  shape: S,
): z.ZodCodec<typeof dictContainer, z.ZodObject<{ -readonly [P in keyof S]: S[P] }>>;
export function dict<S extends Record<string, z.ZodTypeAny>>(shape?: S) {
  const keys = shape === undefined ? [] : Object.keys(shape);
  const out = shape === undefined ? z.record(z.string(), schemeValue) : z.object(shape);
  return named(
    "dict",
    z.codec(dictContainer, out, {
      // Transform crosses ONLY the container boundary. Out-schema owns
      // per-field marshaling (`list`/`vector` same). Decoding fields here
      // would DOUBLE-decode. `as never`: record shape is generic.
      decode: (d) => {
        const src = d as ADict | AJSObject;
        // Shallow BOXED record — not `arrival/toJS` (that egresses an R9
        // lazy proxy with values already unwrapped — membrane exit, not
        // the inside-sandbox record this out-schema expects).
        // Shaped: only keys the source HAS. ADict.get/AJSObject.get return
        // nil for a miss; z.string.optional() then sees ANil, not absence.
        const names = shape === undefined ? src.keys() : keys.filter((k) => src.has(k));
        // Heap-metering INERT (restoration is workboard D1).
        return Object.fromEntries(names.map((k) => [k, src.get(k)])) as never;
      },
      encode: (rec: Record<string, unknown>) => {
        const entries = Object.entries(rec);
        // Heap-metering INERT (restoration is workboard D1).
        return new ADict(entries.map(([k, v]) => [new ASymbol(k), v as SchemeValue] as [DictKey, SchemeValue]));
      },
    }),
  );
}

/**
 * Open homogeneous record: `dictRecord(z.string, z.string)` → `Record<string, string>`.
 *
 * Distinct from:
 * - `dict({a: z.string})` — fixed-key struct
 * - `dict()` — open, but values stay scheme-boxed (`Record<string, SchemeValue>`)
 *
 * Keys fold to string identity (`:a` ≡ `"a"`, same as ADict). The key schema's
 * JS face must accept plain strings — when the author passes the scheme-zod
 * `string` codec (or `foldName`), the record-key position uses plain `z.string()`
 * because the fold already produced a JS string. The value schema is the
 * homogeneous element codec applied per entry (same container/element split as
 * `list`/`vector`).
 */
export function dictRecord<K extends z.ZodTypeAny, V extends z.ZodTypeAny>(key: K, value: V) {
  const keyName = lookupName(key);
  // Record property names are always plain JS strings after fold. Scheme-zod
  // `string`/`foldName` codecs expect AString/DictKey on their scheme face —
  // they are not valid z.record key schemas. Use plain string validation there.
  // (`as never` on the non-string arm: author-supplied key schemas that already
  // accept plain strings, e.g. z.enum([...]), are legal; the cast is the generic
  // boundary zod's $ZodRecordKey wants.)
  const keyOut: z.ZodType<string | number | symbol> =
    keyName === "string" || keyName === "foldName" ? z.string() : (key as z.ZodType<string | number | symbol>);
  const schema = named(
    "dictRecord",
    z.codec(
      z.union([z.instanceof(ADict), z.instanceof(AJSObject).refine((o) => isDictShaped(o.source))]),
      z.record(keyOut, value),
      {
        // Container boundary only — out-schema (`z.record`) owns per-value marshal.
        decode: (d) => {
          const src = d as ADict | AJSObject;
          // Heap-metering INERT (restoration is workboard D1).
          return Object.fromEntries(src.keys().map((k) => [k, src.get(k)])) as never;
        },
        encode: (rec: Record<string, unknown>) => {
          // Heap-metering INERT (restoration is workboard D1).
          return new ADict(
            Object.entries(rec).map(([k, v]) => [new ASymbol(k), v as SchemeValue] as [DictKey, SchemeValue]),
          );
        },
      },
    ),
  );
  COLLECTION_ELEMENT.set(schema, value);
  return schema;
}

/**
 * Folded name identity for name-position args that are keyword-native at the
 * call site: keyword `:foo`, bare symbol `foo`, or string `"foo"` → `"foo"`
 * (same fold as ADict keys / `foldKeyName`). Honest codec — not `z.dynamic`.
 */
export const foldName = named(
  "foldName",
  z.codec(z.union([z.instanceof(ASymbol), z.instanceof(AString), z.instanceof(ACharacter)]), z.string(), {
    decode: (k) => foldKeyName(k as DictKey),
    // Host-minted names re-enter as bare symbols (not re-keyworded). Call sites
    // that need a keyword on the scheme face mint `new ASymbol(":" + s)` themselves.
    encode: (s) => new ASymbol(s),
  }),
);

// Whole-object UNWRAP, not decomposition (unlike `dict`) — preserves class
// identity/methods for genuinely-foreign values.
export const box = named(
  "box",
  z.codec(z.instanceof(AJSObject), z.custom<object>(), {
    decode: (o) => o.source,
    encode: (o) => new AJSObject(o),
  }),
);

// ── instance — typed opaque-crossing codec ─────────────────────────────────

/**
 * Typed rosetta slot over a `@arrival.private`-branded host class:
 * `instance(LLMModel)` for `(chat/completion model ...)`. Scheme face:
 * `AOpaqueHandle` predicate; JS face: `z.instanceof(Ctor)`.
 *
 * Decode unwraps + asserts class (wrong handle → humanized door). Encode
 * mints/reuses via `AOpaqueHandle.for` under {@link marshalCtx} (no boxed
 * operand — same ambient channel as scalar encode).
 *
 * CrossingOnly (like `dynamic`): membrane concept, compile-banned from contour
 * slots. Composes free under `list`/`vector`/`dict` element marshaling — unlike
 * bare `z.dynamic`, no separate opaque-unwrap chokepoint.
 */
export function instance<T extends object>(Ctor: new (...args: any[]) => T) {
  const schema = named(
    "instance",
    // Predicate, not `z.instanceof(AOpaqueHandle)`: constructor is private
    // (mint only via `AOpaqueHandle.for`); private ctor fails zod's
    // `new (...args) => T` signature.
    z.codec(
      z.custom<AOpaqueHandle>((v) => v instanceof AOpaqueHandle),
      z.instanceof(Ctor),
      {
        decode: (handle) => {
          if (!(handle.instance instanceof Ctor)) {
            throw new CodecFidelityError(
              "instance",
              `expected an opaque handle wrapping ${Ctor.name}, got #<${handle.className}>`,
            );
          }
          return handle.instance;
        },
        encode: (inst) => AOpaqueHandle.for(marshalCtx(), inst),
      },
    ),
  );
  return schema as CrossingOnly<typeof schema>;
}

// ── procedure — contract-aware marshaling ──────────────────────────────────

/**
 * Callable crossing the membrane. With `input`/`output`, each call marshals
 * per-argument; untyped callbacks still box JS args via jsToScheme (same as
 * hostProjectionOf). `map`/`filter` HOF apply already-scheme elements and omit both.
 *
 * Return-direction ban: rosetta result is never a bare JS function — encode
 * only legitimate for an argument marshalled inward.
 *
 * Decode is the typed half of reverse-membrane crossing
 * (`docs/membrane.md` §REGION): reads ambient `currentRegionScope()`, falls
 * back to `DETACHED_SCOPE` when decoded with no live crossing.
 */
export function procedure<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(input?: I, output?: O) {
  return named(
    "procedure",
    z.codec(
      z.union([z.instanceof(ALambda), z.instanceof(ANativeProcedure), z.instanceof(ARosettaProcedure)]),
      z.custom<(...a: unknown[]) => unknown>((v) => typeof v === "function"),
      {
        // `as never` at marshal sites: generic ZodTypeAny makes in/out opaque.
        decode: (callable) => {
          const scope = currentRegionScope() ?? DETACHED_SCOPE;
          // `"typed"` key in the two-level wrapper cache — pre-split single key
          // let whichever family crossed first serve its wrapper to the other
          // (docs/membrane.md §REGION).
          let byKey = scope.cache.get(callable);
          if (byKey === undefined) {
            byKey = new Map();
            scope.cache.set(callable, byKey);
          }
          const cached = byKey.get("typed");
          if (cached) return cached;
          // Close over `scope` at decode — never re-read ambient at invoke time.
          // `withRegionCall` owns escape/pending/abort; this owns only marshaling.
          const wrapper = (...jsArgs: unknown[]) =>
            applyMembraneClosure(scope.runCtx, () =>
              withRegionCall(scope, async () => {
                // Install closed-over `scope.runCtx` — invoke may run long after
                // decode, when ambient scope is unrelated or undefined.
                const schemeArgs = input
                  ? withMarshalCtx(scope.runCtx, () => jsArgs.map((a) => z.encode(input, a as never)))
                  : jsArgs.map((a) => jsToScheme(scope.runCtx, a));
                // Re-entry nests under exporting invocation (`scope.dynSite`);
                // `withDynamicCallSite` for nested lambda re-entry.
                const callCtx = makeCallCtx(scope.runCtx, scope.dynSite as InvocationLike | undefined);
                const r = await withDynamicCallSite(scope.dynSite, () =>
                  applyCallback(callable, schemeArgs as SchemeValue[], callCtx),
                );
                return output ? withMarshalCtx(scope.runCtx, () => z.decode(output, r as never)) : r;
              }),
            );
          byKey.set("typed", wrapper);
          return wrapper;
        },
        encode: (jsFn) =>
          new ANativeProcedure({
            name: "<host-procedure>",
            arity: { min: input ? 1 : 0, max: null },
            contract: undefined,
            // `callCtx.runCtx` is THIS invocation's live run — direct channel,
            // no ambient guess. Installed for synchronous per-arg marshal below.
            impl: async (schemeArgs, callCtx) =>
              applyMembraneClosure(callCtx.runCtx, async () => {
                const jsArgs = withMarshalCtx(callCtx.runCtx, () =>
                  input ? schemeArgs.map((a) => z.decode(input, a as never)) : schemeArgs,
                );
                const r = await jsFn(...jsArgs);
                return withMarshalCtx(callCtx.runCtx, () => (output ? z.encode(output, r as never) : r)) as SchemeValue;
              }),
          }),
      },
    ),
  );
}
