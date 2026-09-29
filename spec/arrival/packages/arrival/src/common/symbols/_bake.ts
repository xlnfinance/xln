// _bake: shared machinery behind the `symbol.*` factories — contract/decoded-type layer,
// baked AEntity union, and helpers each per-tag factory (./native.ts, ./rosetta.ts, …)
// builds from. Factories live one-per-file, re-assembled into `symbol` by ./index.ts;
// package entry is `src/symbol/index.ts` (`@inhuman.tools/arrival`). Acyclic: factories
// import from here; nothing imports back through the namespace.
//
// docs/environments.md §CONTRACT — one zod contract, four readers (runtime validation,
// static impl types via z.infer, harvested .d.ts, JS↔Scheme membrane codec), two faces,
// contour-vs-crossing split. This module is the authored-extension layer.
// docs/environments.md §SYMBOL-KINDS — per-kind table; interfaces below carry field
// contracts the table cannot.
//
// CONTOUR vs CROSSING (brand bans — compile-time on the contract ARGUMENT, not the return):
//   Rosetta (crossing/membrane): slots must NOT carry ContourOnly (`z.schemeValue`).
//   Native/sequence/define (contour): slots must NOT carry CrossingOnly (`z.dynamic`,
//   `z.instance(Ctor)`). Brands: scheme-zod ContourOnly / CrossingOnly.
//   Pattern: NoContourBrand / NoCrossingBrand poison the bad *field* with
//   ContractKindMismatch so the editor glows `input`/`output`/`inputRest`.
//   Factories take CrossingContract / ContourContract — legal arm = type identity.
//   Runtime: procedure ctor re-checks axes (assert*) as the instance chokepoint.
//
// Two faces of one schema: codec `z.input` = SCHEME face; `z.output` = JS face.
// `symbol.native` (contour) projects scheme; `symbol.rosetta` (membrane) projects JS.
// Non-codec schemas: faces coincide (`input ≡ output`).

import * as z from "../scheme-zod/index.js";
import { type ANativeProcedure, type NativeSymbolDef } from "../../values/primitives/ANativeProcedure.js";
import type { SchemeValue } from "../../values/types.js";
import { type RunContext } from "../../run/RunContext.js";
import { type CallCtx } from "../../run/CallCtx.js";
import { Macro } from "../../eval/Macro.js";
import { ZodType, ZodUnion } from "zod";
import {
  CacheClassShapeError,
  ContractSealError,
  ContractSlotKindError,
  KeywordPairingError,
  ProvenanceRoleShapeError,
} from "../../errors.js";
// TYPE-ONLY (erased — no runtime edge into capability.ts): Activation for dynamic metadata.
import type { Activation } from "../capability.js";
// TYPE-ONLY, one-directional (`common/symbols` → `emit`): compiler rule surface a Contract may carry.
import type { EmitRule, RefPolicy } from "../../emit/emit-rule.js";
import type { MaybePromise } from "../../types/utility.js";

/** Resource-path producer — sole home is run/resource-paths.ts. */
import {
  ResourcePathRoleConflictError,
  ResourcePathShapeError,
  type ResourcePathFn,
} from "../../run/resource-paths.js";
import { AValue } from "../../values/primitives/AValue.js";

// ── 1. Args-vector spec + decoded-type inference ─────────────────────────────

/** Args/return vector: bare tuple of schemas (positional) OR array-ish schema
 *  (`z.array` / `z.tuple` / `z.union`). */
export type VectorSpec = readonly z.ZodTypeAny[] | z.ZodTypeAny;

/** Schema face: `"scheme"` → `z.input`; `"js"` → `z.output`. See preamble. */
export type Face = "scheme" | "js";
type ProjectFaceAtom<S extends z.ZodTypeAny, F extends Face> = F extends "scheme" ? z.input<S> : z.output<S>;
type ProjectFaceArray<S extends z.ZodTypeAny[], F extends Face> = S extends [
  infer Head extends z.ZodTypeAny,
  infer Tail extends z.ZodTypeAny[],
]
  ? ProjectFace<Head, F> | ProjectFaceArray<Tail, F>
  : never;
type ProjectFace<S extends z.ZodTypeAny, F extends Face> =
  S extends ZodUnion<infer T extends z.ZodTypeAny[]> ? ProjectFaceArray<T, F> : ProjectFaceAtom<S, F>;

/** Map a VectorSpec through the selected face. Tuple → element-wise mutable tuple;
 *  single schema → bare. `DecodedArgs`/`DecodedReturn`/`DecodedArgsWithRest` only differ
 *  in boundary handling (1-tuple wrap/unwrap), not how a spec decodes. */
export type SpecInfer<S extends VectorSpec, F extends Face = "js"> = S extends readonly z.ZodTypeAny[]
  ? { -readonly [K in keyof S]: ProjectFace<S[K] & z.ZodTypeAny, F> }
  : S extends z.ZodTypeAny
    ? ProjectFace<S, F>
    : never;

export type DecodedArgs<S extends VectorSpec, F extends Face = "js"> =
  SpecInfer<S, F> extends readonly unknown[] ? SpecInfer<S, F> : [SpecInfer<S, F>];

/** Return-face projection (world-flip ruling 2026-08-13): a `z.dynamic` OUTPUT slot's
 *  JS face is `unknown` — the impl returns RAW JS (the membrane boxes; an AValue return
 *  doors via `assertNoWorldFlip`). Input face is untouched: a dynamic ARG still arrives
 *  as the raw boxed SchemeValue. Scheme face (native contour) untouched. */
type ProjectReturnFace<S extends z.ZodTypeAny, F extends Face> = F extends "js"
  ? S extends z.DynamicHatch
    ? unknown
    : ProjectFace<S, F>
  : ProjectFace<S, F>;

type SpecInferReturn<S extends VectorSpec, F extends Face> = S extends readonly z.ZodTypeAny[]
  ? { -readonly [K in keyof S]: ProjectReturnFace<S[K] & z.ZodTypeAny, F> }
  : S extends z.ZodTypeAny
    ? ProjectReturnFace<S, F>
    : never;

export type DecodedReturn<O extends VectorSpec, F extends Face = "js"> = O extends readonly [z.ZodTypeAny]
  ? SpecInferReturn<O, F>[0]
  : SpecInferReturn<O, F>;

// ── 1.5 Metadata — per-field static-or-dynamic (read channel: ./metadata.js) ─

/** One field: STATIC data, or DYNAMIC `(this: Activation) => value`. Discriminant is
 *  `typeof === "function"` — a static field can never BE a function (no serialization story).
 *  Per-field union, not a whole-record builder: keeps the static subset enumerable pre-assembly.
 *  Dynamic fields resolve lazily at describe/catalog read (`./metadata.js` `resolveMetadata`). */
export type MetadataField<A = Activation<any, any>, V = unknown> =
  | V // STATIC — enumerable pre-assembly
  | ((this: A) => MaybePromise<V>); // DYNAMIC — resolved lazily, per read

/** Kind-agnostic `metadata?` extension bag (MCP annotations, catalog text). Def-level facts
 *  (`doc`, `type`, `provenance`, `preludeOnly`) stay contract-derived, not here. */
export type MetadataRecord<A = Activation<any, any>> = Record<string, MetadataField<A>>;

/** Variadic tail after a fixed leading `input` tuple:
 *  - `z.ZodTypeAny` — repeated element (0+ times); OR
 *  - plain kwargs shape `{k: schema}` — trailing kwargs OBJECT (VALUES are schemas; CONTAINER
 *    is a plain object, NOT a ZodType — the `instanceof z.ZodType` discriminator).
 *  `undefined` = no rest. */
export type RestSpec = z.ZodTypeAny | Record<string, z.ZodTypeAny> | undefined;

/** Decoded args WITH rest: fixed-tuple types then spread of rest element type.
 *  Rest composes only with a FIXED leading tuple `input` (non-tuple `I` + real `Rest` → `never`).
 *  No rest reduces to `DecodedArgs<I>`.
 *  Fixed half uses `SpecInfer<I>` (named alias) — TS2574 can't see a mapped abstract `I` as
 *  array-shaped inside `[...X, ...Y[]]` when inlined. */
export type DecodedArgsWithRest<
  I extends VectorSpec,
  Rest extends RestSpec = undefined,
  F extends Face = "js",
> = Rest extends z.ZodTypeAny
  ? I extends readonly z.ZodTypeAny[]
    ? SpecInfer<I, F> extends infer Head extends readonly ("js" extends F ? unknown : AValue)[]
      ? [...Head, ...ProjectFace<Rest, F>[]]
      : never
    : never
  : Rest extends Record<string, z.ZodTypeAny>
    ? // kwargs: ONE trailing object param (face-projected fields), not a spread.
      // Mirrors runtime `[z.decode(z.object(inputRest), fold(args))]`. `I` is `[]` at kwargs sites.
      [{ [K in keyof Rest]: ProjectFace<Rest[K] & z.ZodTypeAny, F> }]
    : DecodedArgs<I, F>;

/** Declared-role vocabulary (P7: data in string key space; class/def is representation authority).
 *  `pipe`/`fan`/`source` are declaration defaults; `sink`/`transparent`/`loop`/`opaque` are
 *  graph-layer targets (lineage node kinds exist; union stays full so `Contract.provenance`
 *  stays stable as roles go live). */
export type ProvenanceRole = "pipe" | "fan" | "source" | "sink" | "transparent" | "loop" | "opaque";

/** Cache-class vocabulary — explicit declaration, never derived from lineage role. See `Contract.cacheClass`. */
export type CacheClass = "view" | "pure";

/** Per-z.lambda-arm dual of `ProvenanceRole` (host role). Shape extracts where it decides;
 *  `Contract.callbackRoles` declares where underdetermined (`extractCallbackRoles`):
 *  - `element-transformer` — return BECOMES the element (map). Parallel track composition.
 *  - `control` — boolean/ordering (filter pred, sort less?, member/assoc compare). One merged role.
 *  - `effect` — void under sink-ish hosts (for-each). Terminal — no egress.
 *  - `accumulator` — fold acc arm. DECLARES THE ACC CHAIN: `egress(Tᵢ) → ingress(Tᵢ₊₁)`, the
 *    ONLY sanctioned inter-track edge (track-separation law's one exception). */
export type CallbackRole = "element-transformer" | "control" | "effect" | "accumulator";

/** Per-arm roles in LAMBDA order (k-th entry = k-th lambda arm, NOT k-th input position).
 *  `undefined` = underdetermined-and-undeclared — honest hole, never a guessed default. */
export type CallbackRoles = readonly (CallbackRole | undefined)[];

export interface Contract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> {
  input: I;
  /** Variadic tail after fixed leading `input` positions. Only with fixed-tuple `input` —
   *  bare single-schema + rest is authoring error (`normalizeInputVector` throws). */
  inputRest?: Rest;
  output: O;
  /** Harvest signature override (e.g. `"(ip: SchemeIP) => SchemeIP"`), decoupled from
   *  zod membrane schemas. Author assertion, not derived; inert outside harvest —
   *  `signatureOf` prefers it over computing from `in`/`out`. Absent ⇒ zod-derived. */
  readonly type?: string;
  /** Declared provenance role. `undefined` ⇒ kind default: native/sequence/tagless/
   *  taglessGuard → `"pipe"`; rosetta → `"source"`. Resolved role lands on the baked def;
   *  capability.ts stamps `provenanceRole` on the bound callable for the lineage classifier
   *  (`env.get(op)` — never a duck-read). Shape checks: `assertProvenanceRoleShape`. */
  readonly provenance?: ProvenanceRole;
  /** Explicit cache class — declaration, never derived from lineage. docs/execution.md §MODE-LAW:
   *  - "view": cacheable across runs; demands serializable contract (`assertCacheClassShape`).
   *  - "pure": regenerateable from decoded args; recovery = re-call; never persisted; no shape gate.
   *  - absent: regenerateable (safe default).
   *  Orthogonal to lineage: this is the cache axis; `provenance` is the lineage axis.
   *  NAMING HAZARD: this `pure` is a cache class on a source — not a lineage "pipe" synonym. */
  readonly cacheClass?: CacheClass;
  /** Per z.lambda arm in LAMBDA ORDER — override where shape underdetermines (`z.lambda`
   *  carries no return shape). `extractCallbackRoles`: void-family host ⇒ every arm `effect`
   *  (contradiction throws); fan + value egress ⇒ default `element-transformer` (overridable);
   *  underdetermined+undeclared ⇒ `undefined`. Shorter than arm count OK; longer throws. */
  readonly callbackRoles?: readonly CallbackRole[];
  /** Assembly-time-only: binds into `Vocabulary.preludeOnly`; overlay only on the
   *  discarded per-run prelude frame (`assembleRun`). Unbound from user code.
   *  Closures minted during prelude keep lexical captures. */
  readonly preludeOnly?: boolean;
  /** Config keys this verb needs to be CALLABLE (docs/environments.md §DEGRADATION-D2).
   *  Bind loop: any declared key absent from validated `configuration` ⇒ cause-carrying
   *  `DoorProcedure` via `activation.degradation.door` instead of the real value.
   *  Keys named here must be `.optional()`/`.default()` on the capability schema — bare-required
   *  still throws at `schema.parse` before any door mints. Absent ⇒ binds unconditionally.
   *  An entry may be a key GROUP (`readonly string[]`) = ANY-OF (satisfied if ≥1 present;
   *  doors only when every key absent). Door `cause.needs` flattens the group. */
  readonly requiresConfig?: readonly (string | readonly string[])[];
  /** Idiomatic-residual rewrite for the compiler (fifth reader). Absent ⇒ RuntimeRef shim.
   *  STATIC data by law; inert outside the compiler harvest. */
  readonly emit?: EmitRule;
  /** Leaf narrows (is-predicate / non-empty overload); `witness` is the registered symbol whose
   *  runtime PROVES it (Law N — CI witness-registry). Type-pass narrowing only; independent of `emit`. */
  readonly narrows?: { readonly witness: string };
  /** Value-position behavior — `RefPolicy` (emit/emit-rule.ts). Default `"shim"` at harvest. */
  readonly refPolicy?: RefPolicy;
}

// ── 1.7 Brand bans on contract ARGUMENT — see preamble CONTOUR vs CROSSING ───

/** Top-level brand check on VectorSpec/RestSpec. Schema via `ZodTypeAny` before kwargs-record
 *  (same `instanceof ZodType` discriminator as normalizeInputVector). */
type HasBrand<T, Tag> = T extends readonly unknown[]
  ? true extends { readonly [K in keyof T]: T[K] extends Tag ? true : false }[number]
    ? true
    : false
  : T extends z.ZodTypeAny
    ? T extends Tag
      ? true
      : false
    : T extends Record<string, z.ZodTypeAny>
      ? true extends { readonly [K in keyof T]: T[K] extends Tag ? true : false }[keyof T]
        ? true
        : false
      : false;

/** Teaching phantom — expected type of a poisoned `input`/`output`/`inputRest` field. */
export interface ContractKindMismatch<Msg extends string> {
  readonly "arrival/contract-kind-mismatch": Msg;
}

export type NoContourBrand<T> = HasBrand<T, z.ContourOnly<unknown>> extends true ? never : T;

export type NoCrossingBrand<T> = HasBrand<T, z.CrossingOnly<unknown>> extends true ? never : T;

type ContourMsgIn =
  "z.schemeValue is not legal in a rosetta contract's input — rosetta crosses the membrane, so this slot needs a real codec, z.procedure (callables), or z.dynamic (fully-generic pass-through slots only)";
type ContourMsgRest =
  "z.schemeValue is not legal in a rosetta contract's inputRest — same rule as input, see z.schemeValue's own doc";
type ContourMsgOut =
  "z.schemeValue is not legal in a rosetta contract's output — same rule as input, see z.schemeValue's own doc";
type CrossingMsgIn =
  "z.dynamic / z.instance is not legal in a native/sequence/define contract's input — this contour never crosses the membrane, so z.schemeValue (the honest top type) or a real codec is always the honest choice";
type CrossingMsgRest =
  "z.dynamic / z.instance is not legal in a native/sequence/define contract's inputRest — same rule as input";
type CrossingMsgOut =
  "z.dynamic / z.instance is not legal in a native/sequence/define contract's output — same rule as input";
/**
 * Rosetta `contract` param. Legal = identity; poisoned field glows via ContractKindMismatch.
 * Path producers (`queries`/`effects`) live ONLY here — not on base Contract — so annotated
 * ContourContract / `Contract<…>` values stay assignable (no optional-field type war).
 */
export type CrossingContract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> = Contract<
  I,
  O,
  Rest
> & {
  /**
   * Query path producer — domains this penetration READs (decoded args → path list).
   * Rosetta-only. Non-empty Q arms the CQS check against prior effect paths this run.
   * See run/resource-paths.ts; docs/working-proposals/cqs-reactivity/.
   */
  readonly queries?: ResourcePathFn;
  /**
   * Effect path producer — domains this penetration WRITES (decoded args → path list).
   * Rosetta-only. Non-empty E is recorded into the run's prior-effect set AFTER the
   * CQS check passes and BEFORE impl (self-door impossible — check never sees this E).
   */
  readonly effects?: ResourcePathFn;
} & // sink ∧ queries ban (ruling 2026-08-13): under gather a sink's impl is SKIPPED — a declared
  // Q would journal a read for a body that never ran. sink+effects stays legal (a sink IS an
  // effect). Runtime twin: ResourcePathRoleConflictError at bake.
  (| { readonly provenance: "sink"; readonly queries?: never }
    | { readonly provenance?: Exclude<ProvenanceRole, "sink"> }
  ) &
  // effects-only-return ban (ruling 2026-08-13): the return of an effectful verb is licensed
  // by its Q half — upsert-with-return is the hybrid shape. Effects-only must be void-family.
  // Runtime twin: ResourcePathRoleConflictError("effects-only-return") at bake.
  (| { readonly effects?: undefined }
    | { readonly queries: ResourcePathFn }
    | { readonly output: readonly (typeof z.undefinedResult)[] }
  ) &
  (HasBrand<I, z.ContourOnly<unknown>> extends true ? { input: ContractKindMismatch<ContourMsgIn> } : unknown) &
  (HasBrand<Rest, z.ContourOnly<unknown>> extends true
    ? { inputRest: ContractKindMismatch<ContourMsgRest> }
    : unknown) &
  (HasBrand<O, z.ContourOnly<unknown>> extends true ? { output: ContractKindMismatch<ContourMsgOut> } : unknown);

/**
 * Native/sequence/define `contract` param. Bans CrossingOnly instead of ContourOnly.
 * Path producers are absent (only on CrossingContract); object-literal excess-property
 * checks refuse `queries`/`effects` at the editor. Runtime throw remains for untyped callers.
 */
export type ContourContract<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec = undefined> = Contract<
  I,
  O,
  Rest
> &
  (HasBrand<I, z.CrossingOnly<unknown>> extends true ? { input: ContractKindMismatch<CrossingMsgIn> } : unknown) &
  (HasBrand<Rest, z.CrossingOnly<unknown>> extends true
    ? { inputRest: ContractKindMismatch<CrossingMsgRest> }
    : unknown) &
  (HasBrand<O, z.CrossingOnly<unknown>> extends true ? { output: ContractKindMismatch<CrossingMsgOut> } : unknown);

/** @deprecated Prefer CrossingContract on the contract param; factories return the procedure. */
export type CrossingResult<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec, Real> =
  HasBrand<I, z.ContourOnly<unknown>> extends true
    ? ContractKindMismatch<ContourMsgIn>
    : HasBrand<Rest, z.ContourOnly<unknown>> extends true
      ? ContractKindMismatch<ContourMsgRest>
      : HasBrand<O, z.ContourOnly<unknown>> extends true
        ? ContractKindMismatch<ContourMsgOut>
        : Real;

/** @deprecated Prefer ContourContract on the contract param; factories return the procedure. */
export type ContourResult<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec, Real> =
  HasBrand<I, z.CrossingOnly<unknown>> extends true
    ? ContractKindMismatch<CrossingMsgIn>
    : HasBrand<Rest, z.CrossingOnly<unknown>> extends true
      ? ContractKindMismatch<CrossingMsgRest>
      : HasBrand<O, z.CrossingOnly<unknown>> extends true
        ? ContractKindMismatch<CrossingMsgOut>
        : Real;

// CallCtx / makeCallCtx: import from run/CallCtx.ts — importing here would cycle
// (ACallable → scheme-zod → _bake) and can leave z.instanceof class captures undefined.

export type Impl<
  I extends VectorSpec,
  O extends VectorSpec,
  Rest extends RestSpec = undefined,
  F extends Face = "js",
> = (this: CallCtx, ...args: DecodedArgsWithRest<I, Rest, F>) => MaybePromise<DecodedReturn<O, F>>;

// ── 2. AEntity — baked discriminated union (TYPE-ONLY plain objects).
// Runtime bound value: DoorProcedure/AKernelKeyword/Macro plain, or ANativeProcedure/
// ARosettaProcedure (ACallable) for native/rosetta/tagless/tagless-guard/sequence —
// never a bare callable fn.

type AnyFn = (...args: any[]) => unknown;

/** Rosetta symbol: JS-land impl. `in`/`out` are codecs. `M` = optional metadata bag. */
export interface RosettaSymbolDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  M extends Record<string, any> = Record<string, any>,
> {
  readonly kind: "rosetta";
  readonly name: string;
  readonly doc?: string;
  readonly in: I;
  readonly out: O;
  /** Authored JS impl (decoded args → result). Harvest/inspection only — apply spine lives
   *  on ARosettaProcedure's `arrival/tagless-final/apply`. */
  readonly impl: AnyFn;
  /** Resolved role (`contract.provenance ?? "source"`). `"pipe"` forwards; `"source"` mints. */
  readonly provenance: ProvenanceRole;
  /** Resolved cache class. Run-cache gates on this (docs/execution.md §CHOKEPOINT). Absent = regenerateable. */
  readonly cacheClass?: CacheClass;
  readonly callbackRoles?: CallbackRoles;
  readonly queries?: ResourcePathFn;
  readonly effects?: ResourcePathFn;
  readonly type?: string;
  readonly preludeOnly?: boolean;
  readonly requiresConfig?: readonly (string | readonly string[])[];
  readonly emit?: EmitRule;
  readonly narrows?: { readonly witness: string };
  readonly refPolicy?: RefPolicy;
  /** Extension bag — generic `M` so higher layers type their own bag. */
  readonly metadata?: M;
}

/** Tagless: no impl — dispatch to operand's `arrival/tagless-final/<name>` (receiver = last
 *  scheme arg). Throws when method absent. */
export interface TaglessSymbolDef {
  readonly kind: "tagless";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (...schemeArgs: readonly SchemeValue[]) => MaybePromise<SchemeValue>;
  /** Always `"pipe"` — no Contract param, no author override channel. */
  readonly provenance: ProvenanceRole;
  /** Harvest signature (shapeless binder; HOF generics set this for List/vector overloads). */
  readonly type?: string;
  /** Declared callback roles — shapeless `in`, so shape never extracts; `withCallbackRoles`
   *  is the only channel (e.g. reduce's acc chain). */
  readonly callbackRoles?: CallbackRoles;
  /** Declaration-site only (`withContractFields`); factory never sets. */
  readonly emit?: EmitRule;
  readonly narrows?: { readonly witness: string };
  readonly refPolicy?: RefPolicy;
  readonly metadata?: MetadataRecord;
}

/** Tagless guard: like tagless, but missing method yields `#f` (type predicates). */
export interface TaglessGuardSymbolDef {
  readonly kind: "tagless-guard";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (...schemeArgs: readonly SchemeValue[]) => Promise<SchemeValue>;
  /** Always `"pipe"`. */
  readonly provenance: ProvenanceRole;
  /** Harvest signature — type predicates set a TS type-guard form. */
  readonly type?: string;
  readonly callbackRoles?: CallbackRoles;
  readonly emit?: EmitRule;
  /** Self-witnessing predicate idiom (`pair?` proves itself). */
  readonly narrows?: { readonly witness: string };
  readonly refPolicy?: RefPolicy;
  readonly metadata?: MetadataRecord;
}

/** Ctx-aware op: scheme args + RunContext (dual of ctx-free native). */
export interface SequenceSymbolDef {
  readonly kind: "sequence";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  readonly run: (this: CallCtx, ...schemeArgs: readonly SchemeValue[]) => MaybePromise<SchemeValue>;
  readonly type?: string;
  /** Resolved role (`contract.provenance ?? "pipe"`). */
  readonly provenance: ProvenanceRole;
  readonly cacheClass?: CacheClass;
  readonly callbackRoles?: CallbackRoles;
  readonly emit?: EmitRule;
  readonly narrows?: { readonly witness: string };
  readonly refPolicy?: RefPolicy;
  readonly metadata?: MetadataRecord;
}

/** Structured door cause: owning capability + missing inputs so a static reader derives the
 *  causal chain without opening a throwing closure.
 *
 *  Stamped at bake by capability.ts (not by `notImplemented()` — factory runs inside a symbols
 *  literal before EnvCapability exists). `notImplemented` doors get `needs: []` (permanent
 *  purity omission). Non-empty `needs` = degradation door (declared config key absent).
 *  `needs` is configuration-only: a dependency need would name an unrooted capability
 *  (C3 pulls deps as object edges) — no policy yet; additive later. */
export interface DoorCause {
  readonly owner: string;
  readonly needs: readonly { readonly kind: "configuration"; readonly key: string; readonly hint?: string }[];
}

/** Omitted verb (errors-as-doors). `cause` stamped by capability.ts at bake; absent only
 *  outside that path. `preludeOnly` routes via the same `bindTarget(def)` every kind uses. */
export interface DoorSymbolDef {
  readonly kind: "door";
  readonly name: string;
  readonly reason: string;
  readonly cause?: DoorCause;
  readonly preludeOnly?: boolean;
  readonly metadata?: MetadataRecord;
}

/** Kernel keyword: special form made first-class. Bake binds `AKernelKeyword`; evaluator
 *  dispatches `SPECIAL_FORMS[name]` — aliasable + lexically shadowable. */
export interface KeywordSymbolDef {
  readonly kind: "keyword";
  readonly name: string;
  readonly doc?: string;
  readonly metadata?: MetadataRecord;
}

/** Non-evaluating macro: raw JS `Macro`/`Syntax` transformer, bound as-is. */
export interface MacroSymbolDef {
  readonly kind: "macro";
  readonly name: string;
  readonly macro: Macro;
  /** Assembly-time-only (same as `Contract.preludeOnly`). Used by `require/register-extension`
   *  so the resolver name is UNEVALUATED. */
  readonly preludeOnly?: boolean;
  readonly metadata?: MetadataRecord;
}

/** Scheme-bodied value/procedure. Makes capability-owned scheme visible to freeVars /
 *  classifier. `in`/`out` always normalized VectorSchemas: procedure = real vectors;
 *  constant = empty-in / 1-tuple-out (0-ary convention so harvest never special-cases).
 *  `callable` is factory-derived (`instanceof ZodType` ⇒ constant) — not recoverable from
 *  shape alone (a 0-ary thunk also has empty `in`). */
export interface DefineSymbolDef {
  readonly kind: "define";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;
  readonly out: z.ZodTypeAny;
  /** Spine adoption from AUTHORED slots (normalized `in` lost per-slot identity).
   *  Applied before body runs — body walks a real spine, not a borrowed vector. */
  readonly adoptArgs?: (args: readonly SchemeValue[]) => SchemeValue[];
  /** Factory discriminator — not re-derivable from normalized vectors. */
  readonly callable: boolean;
  /** Single-value return from authored (pre-normalization) output. Always true for constants.
   *  Stored because normalized `out` is not a raw VectorSpec for `isSingleOutput`. */
  readonly singleOut: boolean;
  /** RHS expression source — not a whole `(define name …)` form. */
  readonly body: string;
  /** Derived via fixpoint over the capability's define set: port-free ⇒ `"pipe"`;
   *  port-reaching ⇒ `"opaque"`. Authored `provenance` is a drift door only (mismatch throws). */
  readonly provenance: ProvenanceRole;
  /** Authored role for drift check (procedure only). Never the resolved `provenance`. */
  readonly declaredProvenance?: ProvenanceRole;
  readonly type?: string;
  readonly preludeOnly?: boolean;
  /** Per-call zod validation (default true) — same cost valve as rosetta. */
  readonly validate: boolean;
  /** Procedure defines only — optional hand-polish for CoreForm-compiled bodies. */
  readonly emit?: EmitRule;
  readonly narrows?: { readonly witness: string };
  readonly refPolicy?: RefPolicy;
  readonly metadata?: MetadataRecord;
}

/** Scheme-bodied macro/expander. Contract-free (no call boundary; FVs would name expansion env).
 *  Body is a lambda over fexpr formals; baked into a Macro transformer at bind. */
export interface DefineSyntaxSymbolDef {
  readonly kind: "define-syntax";
  readonly name: string;
  readonly doc?: string;
  readonly body: string;
  /** `"opaque"` (default, safe under-report) | `"expression"` | `"binder"`. Authored verbatim. */
  readonly macroAttribute: "opaque" | "expression" | "binder";
  readonly preludeOnly?: boolean;
  readonly metadata?: MetadataRecord;
}

/** Host data constant, bound by name — never a scheme call target. Factory boxes at define time
 *  and stamps this onto the value's own `.contract` (non-enumerable, define-once — see value.ts)
 *  so `contractOf()` / harvest see presence. No nested `value` field: the box IS the value.
 *  Optional `value` only for primitive leaves too narrow for a hidden property (`bigint`). */
export interface ValueSymbolDef {
  readonly kind: "value";
  readonly name: string;
  readonly doc?: string;
  readonly value?: unknown;
  readonly metadata?: MetadataRecord;
}

export type AEntity =
  | NativeSymbolDef
  | RosettaSymbolDef
  | TaglessSymbolDef
  | TaglessGuardSymbolDef
  | SequenceSymbolDef
  | DoorSymbolDef
  | KeywordSymbolDef
  | MacroSymbolDef
  | DefineSymbolDef
  | DefineSyntaxSymbolDef
  | ValueSymbolDef;

// ── 3. Name/doc parsing + vector normalization ───────────────────────────────

/** Parse `"name: human description"` from a tagged template. Split on FIRST `": "`
 *  (colon-SPACE) — bare colon would truncate names that contain colons
 *  (`char-set:whitespace: …` → `"char-set"`). No `": "` ⇒ whole string is the name. */
export function parseNameDoc(tpl: TemplateStringsArray, sub: readonly unknown[]): { name: string; doc?: string } {
  let raw = "";

  for (let i = 0; i < tpl.length; i++) {
    raw += tpl[i];
    if (i < sub.length) raw += String(sub[i]);
  }
  const sep = raw.indexOf(": ");
  if (sep === -1) return { name: raw.trim() };
  return { name: raw.slice(0, sep).trim(), doc: raw.slice(sep + 1).trim() };
}

/** Whole args/return VECTOR schema — array-shaped so decode/encode infer `readonly unknown[]`. */
type VectorSchema = z.ZodType<readonly unknown[], readonly unknown[]>;

/** Kwargs key from a scheme arg: self-evaluating `:key` ASymbol → strip leading `:`. */
function kwargsKeyOf(arg: unknown): string {
  return String(arg).replace(/^:/, "");
}

/** Fold `(tool :k v …)` interleaved args into a raw kwargs object (reshape only — per-field
 *  decode is the caller's). Odd arg count → KeywordPairingError. */
export function collectKwargsObject(args: readonly unknown[]): Record<string, unknown> {
  if (args.length % 2 !== 0) {
    throw new KeywordPairingError("dangling-keyword", args.length);
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    obj[kwargsKeyOf(args[i])] = args[i + 1];
  }
  return obj;
}

/** VectorSpec → one VectorSchema: bare tuple → `z.tuple`; array-ish schema → itself.
 *  Kwargs never reach here (`input: []` + plain-record `inputRest` → `normalizeInputVector`). */
export function normalizeVector(spec: VectorSpec): VectorSchema {
  // readonly-aware tuple probe — stock Array.isArray leaves readonly arrays in the union.
  if (isSchemaTuple(spec)) {
    return spec.length === 0 ? z.tuple([]) : z.tuple(spec as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  return spec as VectorSchema;
}

/** Bare-tuple member vs single array-ish schema (`readonly`-aware). */
function isSchemaTuple(spec: VectorSpec): spec is readonly z.ZodTypeAny[] {
  return Array.isArray(spec);
}

/** Input side + optional rest → one VectorSchema. Rest as plain record = kwargs object schema;
 *  rest as ZodType = `z.tuple(fixed, rest)`. Single-schema input + rest throws. */
export function normalizeInputVector(input: VectorSpec, inputRest: RestSpec): VectorSchema {
  if (inputRest === undefined) return normalizeVector(input);
  // kwargs: container is not ZodType — instanceof is the discriminator.
  if (!(inputRest instanceof ZodType)) return z.object(inputRest) as unknown as VectorSchema;
  if (!isSchemaTuple(input)) {
    throw new KeywordPairingError("input-rest-needs-tuple");
  }
  return z.tuple(input as [z.ZodTypeAny, ...z.ZodTypeAny[]], inputRest) as VectorSchema;
}

/** 1-tuple output ⇒ impl returns a single value (wrapped as 1-element vector). */
export function isSingleOutput(output: VectorSpec): boolean {
  return Array.isArray(output) && output.length === 1;
}

// ── 3b. Drift alarm — declared provenance vs contract SHAPE ──────────────────
// Shape catches CONTRADICTIONS, not LIES (a JS body that fans while declared pipe is
// invisible). Two decidable cases only.

/** Top-level slots of a normalized VectorSchema: tuple items, array element as 1-list, or
 *  undefined (kwargs object / bare). Local `_zod.def` copy — importing schema-to-ts would
 *  pull harvest into the bake layer. Exported for rosetta's z.dynamic-callable door. */
export function topLevelSchemas(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | undefined {
  const def = z.defOf(schema) as { type?: string; items?: readonly z.ZodTypeAny[]; element?: z.ZodTypeAny } | undefined;
  if (def?.type === "tuple") return def.items ?? [];
  if (def?.type === "array" && def.element) return [def.element];
  return undefined;
}

/** Throws ProvenanceRoleShapeError when declared role contradicts shape. Bake-time only.
 *  1. `sink`/`transparent` claim no egress — real return schema contradicts.
 *  2. `fan` claims apply-across-elements — no `z.lambda` arm contradicts. */
export function assertProvenanceRoleShape(
  name: string,
  role: ProvenanceRole,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (role === "sink" || role === "transparent") {
    const items = topLevelSchemas(outSchema);
    // Void family: zero-item OR all-`undefinedResult` (docs/execution.md §CHOKEPOINT sink-void proof).
    const hasEgress = items === undefined ? true : items.some((item) => z.lookupName(item) !== "undefinedResult");
    if (hasEgress) {
      throw new ProvenanceRoleShapeError(
        name,
        role,
        role === "sink"
          ? "a sink is a port with no egress wire, but this contract's output vector carries a real return value"
          : "a transparent crossing neither mints nor stamps a returned value, but this contract's output vector carries one",
      );
    }
  }
  if (role === "fan") {
    const items = topLevelSchemas(inSchema);
    const hasLambda =
      items === undefined ? z.lookupName(inSchema) === "lambda" : items.some((item) => z.lookupName(item) === "lambda");
    if (!hasLambda) {
      throw new ProvenanceRoleShapeError(
        name,
        role,
        "a fan op applies a proc across elements, but this contract's input vector has no z.lambda arm to apply",
      );
    }
  }
}

/** Cache-gate slots: topLevelSchemas + kwargs object fields + bare fallback. */
function cacheGateSlots(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const items = topLevelSchemas(schema);
  if (items !== undefined) return items;
  const def = z.defOf(schema) as { type?: string; shape?: Record<string, z.ZodTypeAny> } | undefined;
  if (def?.type === "object" && def.shape) return Object.values(def.shape);
  return [schema];
}

/** REGION-SCOPE GATE: does normalized INPUT carry a live-callable slot?
 *  - `z.procedure` — decode wraps into a host fn on ambient scope; without a real scope the
 *    wrapper binds DETACHED_SCOPE/CONSTANT_CTX — the burst-bypass hole (lambda → sink fires
 *    inline instead of enqueueing under live `effects`).
 *  - `z.dynamic` — raw escape hatch; impl may reverse-cross a callable on the same ambient scope.
 *    Included deliberately: shape cannot see whether a dynamic value is callable — under-gating
 *    reopens the hole. Err toward scoping.
 *  INPUT only: scheme→JS reverse calls need the gate; JS→scheme encode has no region concern.
 *  Rosetta uses this once at bake — lambda-free verbs pay zero. docs/membrane.md §REGION. */
export function contractMayCarryCallable(inSchema: z.ZodTypeAny): boolean {
  return cacheGateSlots(inSchema).some((slot) => {
    const slotName = z.lookupName(slot);
    return slotName === "procedure" || slotName === "dynamic";
  });
}

/** RUNTIME TWIN of the §1.7 brand bans (audit B2a, ruling 2026-08-13): the type-level
 *  ContourOnly/CrossingOnly walls are invisible to an untyped or `as never` caller, so every
 *  factory re-checks at bake — same pattern as `assertNoResourcePathProducers` (I9).
 *  - rosetta (crossing): `z.schemeValue` refuses — a crossing slot needs a real codec,
 *    `z.procedure`, or `z.dynamic`.
 *  - native/sequence/define (contour): `z.dynamic`/`z.instance` refuse — a contour never
 *    crosses the membrane; `z.schemeValue` is the honest top type there.
 *  Shallow scope — same top-level slot view (`cacheGateSlots`) as the sibling shape gates. */
export function assertSlotKinds(
  name: string,
  kind: "rosetta" | "native" | "sequence" | "define",
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  const banned: readonly string[] = kind === "rosetta" ? ["schemeValue"] : ["dynamic", "instance"];
  for (const [side, schema] of [
    ["input", inSchema],
    ["output", outSchema],
  ] as const) {
    for (const slot of cacheGateSlots(schema)) {
      const slotName = z.lookupName(slot);
      if (slotName !== undefined && banned.includes(slotName)) {
        throw new ContractSlotKindError(name, kind, side, slotName);
      }
    }
  }
}

/** View shape gate: `view` demands serializable contract — no `z.lambda`, no `z.schemeValue`/
 *  `z.dynamic`. Both vectors (key + entry). Escape hatch: declare `pure` or nothing.
 *  docs/execution.md §CHOKEPOINT. */
export function assertCacheClassShape(
  name: string,
  cacheClass: CacheClass | undefined,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (cacheClass !== "view") return; // pure / absent: regenerateable — no gate
  for (const [side, schema] of [
    ["input", inSchema],
    ["output", outSchema],
  ] as const) {
    for (const slot of cacheGateSlots(schema)) {
      const slotName = z.lookupName(slot);
      if (slotName === "lambda") {
        throw new CacheClassShapeError(
          name,
          cacheClass,
          `a view's cache entry must serialize, but this contract's ${side} vector carries a z.lambda arm — ` +
            `a callable is not a boundary snapshot; declare "pure" (recovery = re-call) or drop the declaration`,
        );
      }
      if (slotName === "schemeValue" || slotName === "dynamic") {
        throw new CacheClassShapeError(
          name,
          cacheClass,
          `a view's cache entry must serialize, but this contract's ${side} vector carries a z.${slotName} slot ` +
            `(a raw scheme-value slot — raw crossings don't serialize); declare "pure" (recovery = ` +
            `re-call) or narrow the slot to a data codec`,
        );
      }
    }
  }
}

/** Queries shape gate (ruling 2026-08-13): a queries-declaring contract must serialize on BOTH
 *  vectors — same slot rules as the `view` gate (`z.lambda` / `z.schemeValue` / `z.dynamic`
 *  refuse). Path producers name resources from decoded args; an unkeyable slot is not a
 *  resource id. (If the verb also declares `cacheClass: "view"`, those slots are the cache
 *  key — same gate, different axis.) Effects-only contracts are not gated (no keyed storage). */
export function assertResourcePathContractShape(
  name: string,
  queries: ResourcePathFn | undefined,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
): void {
  if (queries === undefined) return;
  for (const [side, schema] of [
    ["input", inSchema],
    ["output", outSchema],
  ] as const) {
    for (const slot of cacheGateSlots(schema)) {
      const slotName = z.lookupName(slot);
      if (slotName === "lambda" || slotName === "schemeValue" || slotName === "dynamic") {
        throw new ResourcePathShapeError(name, side, slotName);
      }
    }
  }
}

/** Path-role conflict doors (rulings 2026-08-13; hoisted from rosetta.ts inline ifs —
 *  hermeticity audit E1, "six doors, one home"): named beside their axis-door siblings
 *  instead of anonymous ifs at the rosetta call site.
 *  - sink ∧ queries: under gather a sink's impl is SKIPPED — a declared Q would journal a
 *    read for a body that never ran. sink+effects stays legal (a sink IS an effect).
 *  - effects-only-return: the return of an effectful verb is licensed by its Q half —
 *    upsert-with-return is the hybrid shape. Effects-only must be void-family. */
export function assertResourcePathRoles(
  name: string,
  provenance: ProvenanceRole,
  queries: ResourcePathFn | undefined,
  effects: ResourcePathFn | undefined,
  outSchema: z.ZodTypeAny,
): void {
  if (provenance === "sink" && queries !== undefined) {
    throw new ResourcePathRoleConflictError(name, "sink-queries");
  }
  if (effects !== undefined && queries === undefined) {
    const outItems = topLevelSchemas(outSchema);
    const voidFamily = outItems !== undefined && outItems.every((item) => z.lookupName(item) === "undefinedResult");
    if (!voidFamily) {
      throw new ResourcePathRoleConflictError(name, "effects-only-return");
    }
  }
}

/** Per z.lambda arm: derive CallbackRole from shape; declared roles override underdetermined arms.
 *  - DECIDED: void-family host egress ⇒ every arm `effect` (contradiction throws).
 *  - DEFAULT: fan + value egress ⇒ `element-transformer` (overridable — filter is fan-shaped
 *    like map but pred is `control`; under-trigger, never guess).
 *  - NOT extracted: `control`/`accumulator` — arrive by declaration only (z.lambda has no
 *    return shape; host boolean egress is not a proxy).
 *  Longer-than-arm-count declaration throws. No lambda arms ⇒ undefined. */
export function extractCallbackRoles(
  name: string,
  hostRole: ProvenanceRole,
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
  declared: readonly CallbackRole[] | undefined,
): CallbackRoles | undefined {
  const inItems = topLevelSchemas(inSchema) ?? [];
  // lookupName walks .optional() — z.lambda.optional() still counts.
  const lambdaCount = inItems.filter((item) => z.lookupName(item) === "lambda").length;
  if (declared !== undefined && declared.length > lambdaCount) {
    throw new ProvenanceRoleShapeError(
      name,
      declared.join(","),
      lambdaCount === 0
        ? "callbackRoles declared, but this contract's input vector has no z.lambda arm to carry a callback role"
        : `callbackRoles declares ${declared.length} role(s), but this contract's input vector carries only ${lambdaCount} z.lambda arm(s) — a role for a phantom callback`,
    );
  }
  if (lambdaCount === 0) return undefined;
  // Void family includes zero-output vector; non-introspectable output stays conservative.
  const outItems = topLevelSchemas(outSchema);
  const voidEgress = outItems !== undefined && outItems.every((item) => z.lookupName(item) === "undefinedResult");
  const roles: (CallbackRole | undefined)[] = [];
  for (let k = 0; k < lambdaCount; k++) {
    const decided: CallbackRole | undefined = voidEgress ? "effect" : undefined;
    const declaredRole = declared?.[k];
    if (declaredRole !== undefined && decided !== undefined && declaredRole !== decided) {
      throw new ProvenanceRoleShapeError(
        name,
        declaredRole,
        `callback arm ${k} is shape-DECIDED "${decided}" (void-family host egress — the callback's product has no egress wire), contradicting the declared "${declaredRole}"`,
      );
    }
    const dflt: CallbackRole | undefined = hostRole === "fan" && !voidEgress ? "element-transformer" : undefined;
    roles.push(declaredRole ?? decided ?? dflt);
  }
  return roles;
}

// ── 3c. One aggregator, six doors, one home (hermeticity audit E1) ───────────

/** Contract-bearing kinds `assertContractAxes` covers. Contract-less kinds
 *  (tagless/tagless-guard) never reach a factory that calls it. */
export type ContractAxesKind = "rosetta" | "native" | "sequence" | "define";

/** Everything a factory has on hand when it's ready to gate. Optional fields are the axes a
 *  given `kind` doesn't carry (e.g. `define`'s provenance/cacheClass resolve later, in
 *  `define-bake.ts` — see the `kind === "define"` arm below). */
export interface ContractAxesOpts {
  readonly inSchema: z.ZodTypeAny;
  readonly outSchema: z.ZodTypeAny;
  readonly provenance?: ProvenanceRole;
  readonly cacheClass?: CacheClass;
  readonly declaredCallbackRoles?: readonly CallbackRole[];
  /** Rosetta-only path producers — see `CrossingContract.queries`/`.effects`. */
  readonly queries?: ResourcePathFn;
  readonly effects?: ResourcePathFn;
}

/** The one call site every factory uses instead of sequencing the individual axis gates by
 *  hand (hermeticity audit E1 — "six pairwise axis doors, five sites, no legal-region map").
 *  Six doors + the slot-kind walls, one aggregator: `assertProvenanceRoleShape` (sink/
 *  transparent⇒void, fan⇒lambda), `assertCacheClassShape` (view⇒serializable),
 *  `assertResourcePathRoles` (sink∧queries ban, effects-only⇒void — hoisted from rosetta's
 *  former inline ifs), `assertResourcePathContractShape` (queries⇒serializable), and
 *  `assertSlotKinds` (contour/crossing brand runtime twin). `extractCallbackRoles` rides
 *  along in the same call (not a door — a shape-derived value the caller needs back) since
 *  its position in the sequence is load-bearing (voidEgress reads `outSchema` the same way
 *  the doors do).
 *
 *  ORDER is preserved PER KIND exactly as each factory called these before consolidation —
 *  not a single fixed order, because the pre-consolidation orders genuinely differed:
 *  - **rosetta**: provenance-shape → cache-shape → callback-roles → path-role-conflict doors
 *    → path-shape → slot-kinds (docs/environments.md §AXES legal-region table cites this).
 *  - **native / sequence**: slot-kinds → provenance-shape → cache-shape → callback-roles.
 *  - **define**: slot-kinds only — provenance/cacheClass are DERIVED later over the whole
 *    define set (`define-bake.ts`), not gated here.
 *  Individual gates stay exported — law tests pin them directly; this is a call-site
 *  consolidation, not a replacement API. */
export function assertContractAxes(
  name: string,
  kind: ContractAxesKind,
  opts: ContractAxesOpts,
): CallbackRoles | undefined {
  const { inSchema, outSchema } = opts;
  if (kind === "define") {
    assertSlotKinds(name, kind, inSchema, outSchema);
    return undefined;
  }
  const provenance = opts.provenance!; // rosetta/native/sequence always resolve one before baking
  if (kind === "rosetta") {
    assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
    assertCacheClassShape(name, opts.cacheClass, inSchema, outSchema);
    const callbackRoles = extractCallbackRoles(name, provenance, inSchema, outSchema, opts.declaredCallbackRoles);
    assertResourcePathRoles(name, provenance, opts.queries, opts.effects, outSchema);
    assertResourcePathContractShape(name, opts.queries, inSchema, outSchema);
    assertSlotKinds(name, kind, inSchema, outSchema);
    return callbackRoles;
  }
  assertSlotKinds(name, kind, inSchema, outSchema);
  assertProvenanceRoleShape(name, provenance, inSchema, outSchema);
  assertCacheClassShape(name, opts.cacheClass, inSchema, outSchema);
  return extractCallbackRoles(name, provenance, inSchema, outSchema, opts.declaredCallbackRoles);
}

// Declaration channels for contract-less kinds (tagless/tagless-guard). The contract is
// FROZEN at instantiation (ContractSealError doc, ruling 2026-08-13), so both channels
// RE-MINT via `_withDeclarationFields` — a new instance around the same #impl with a new
// frozen contract — never a stamp in place. Whitelists are runtime facts, not just types:
// an untyped caller pushing a gated field (queries/cacheClass/provenance/…) doors loudly.

const CALLBACK_ROLE_VOCAB: readonly CallbackRole[] = ["element-transformer", "control", "effect", "accumulator"];

function sealTargetName(value: ANativeProcedure): string {
  const contractName = (value.contract as { name?: string } | undefined)?.name;
  return contractName ?? (typeof value.name === "string" ? value.name : String(value.name));
}

function assertSealTarget(value: ANativeProcedure, channel: "withContractFields" | "withCallbackRoles"): void {
  if (value.contract === undefined) {
    throw new ContractSealError(
      sealTargetName(value),
      channel,
      "this value carries no contract (synthetic/host mint) — the declaration channel extends a baked contract, it does not create one",
    );
  }
}

/** Declaration channel for callback roles (shapeless `in` ⇒ shape never extracts;
 *  live use: reduce's `["accumulator"]`). Re-mints; chainable. */
export function withCallbackRoles(value: ANativeProcedure, callbackRoles: readonly CallbackRole[]): ANativeProcedure {
  assertSealTarget(value, "withCallbackRoles");
  for (const role of callbackRoles) {
    if (!CALLBACK_ROLE_VOCAB.includes(role)) {
      throw new ContractSealError(
        sealTargetName(value),
        "withCallbackRoles",
        `"${String(role)}" is not a callback role — the vocabulary is ${CALLBACK_ROLE_VOCAB.join("/")} (Contract.callbackRoles doc)`,
      );
    }
  }
  const contract = Object.freeze({
    ...(value.contract as object),
    callbackRoles,
  }) as NonNullable<ANativeProcedure["contract"]>;
  return value._withDeclarationFields(contract, callbackRoles);
}

const CONTRACT_FIELD_WHITELIST: readonly string[] = ["type", "emit", "narrows", "refPolicy"];

/** Declaration-site channel for `type`/`emit`/`narrows`/`refPolicy` on contract-less kinds.
 *  Re-mints; chainable. Any other key is a gated contract field — it belongs in the
 *  factory's contract param (where the bake doors see it), never here. */
export function withContractFields(
  value: ANativeProcedure,
  fields: Partial<Pick<TaglessSymbolDef | TaglessGuardSymbolDef, "type" | "emit" | "narrows" | "refPolicy">>,
): ANativeProcedure {
  assertSealTarget(value, "withContractFields");
  for (const key of Object.keys(fields)) {
    if (!CONTRACT_FIELD_WHITELIST.includes(key)) {
      throw new ContractSealError(
        sealTargetName(value),
        "withContractFields",
        `"${key}" is not a declaration-site field — the channel carries ${CONTRACT_FIELD_WHITELIST.join("/")} only; ` +
          `gated contract fields (queries/effects/cacheClass/provenance/…) are declared in the factory's ` +
          `contract param, where the bake doors check them`,
      );
    }
  }
  const contract = Object.freeze({
    ...(value.contract as object),
    ...fields,
  }) as NonNullable<ANativeProcedure["contract"]>;
  return value._withDeclarationFields(contract);
}

/** Acc-chain marker: true iff roles carry an `accumulator` arm.
 *  `egress(Tᵢ) → ingress(Tᵢ₊₁)` is the only sanctioned inter-track edge. */
export function declaresAccChain(callbackRoles: CallbackRoles | undefined): boolean {
  return callbackRoles !== undefined && callbackRoles.includes("accumulator");
}

// ── 4. Shared types the per-tag factories build from (no separate bake* ctors) ─

/** Sequence impl: one args array (not spread) + RunContext; scheme face; no Rest. */
export type SequenceImpl<I extends VectorSpec, O extends VectorSpec> = (
  args: DecodedArgs<I, "scheme">,
  runCtx: RunContext,
) => MaybePromise<DecodedReturn<O, "scheme">>;

export interface BakeRuntimeOpts {
  /** Zod validation on decoded args + encoded output. Default true. */
  validate?: boolean;
  metadata?: MetadataRecord;
}

/** Tagless-final term method: called with receiver as `this`. */
type TermMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Resolve a named term method off a (possibly non-object) receiver. Call site decides
 *  missing-policy (tagless throws; taglessGuard → #f). */
export function resolveMethod(receiver: unknown, method: string): TermMethod | undefined {
  if (receiver == null || (typeof receiver !== "object" && typeof receiver !== "function")) return undefined;
  const fn = (receiver as Record<string, unknown>)[method];
  return typeof fn === "function" ? (fn as TermMethod) : undefined;
}
