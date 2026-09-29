// capability — EnvCapability: the ONE shape every palette pack uses. The IMPLEMENTATION of the
// capability contract:
//
//   `export default EnvCapability.define(name, { configuration, resources, prelude, symbols, deps })`
//
// The model — the five-key CLOSED taxonomy and the MODULE-SINGLETON rule — is
// docs/environments.md §CAPABILITY; this file is the enforcement site. A capability's `spec` is
// consumed by `env/vocabulary.ts`'s `buildVocabulary` (bootstrap bind loop + per-kind helpers).
// `new EnvCapability(name, spec)` is internal only (`DefinedEnvCapability` / raw-ctor tests /
// external MCP `{fn}` packs); `EnvCapability.define` is the sanctioned authoring path.

import { z } from "zod";

import { type Ref, type Resource, ResourceCell, windDownAll } from "./resources.js";
import {
  type RestSpec,
  type VectorSpec,
  type BakeRuntimeOpts,
  type ContourContract,
  type CrossingContract,
  type DecodedArgsWithRest,
  type DecodedReturn,
  type DefineSymbolDef,
  type DefineSyntaxSymbolDef,
  type Face,
  type MacroSymbolDef,
  type MetadataRecord,
} from "./symbols/_bake.js";
import { CallCtx } from "../run/CallCtx.js";
// Value imports for `EnvCapability.define`'s injected `(symbol, z)` factory pair.
// No cycle: `./symbols/index.js` and `./scheme-zod.js` sit below this file (capability imports
// `./symbols/_bake.js` / ACallable; neither imports back up to `capability.ts`).
import * as symbolFactories from "./symbols/index.js";
import * as schemeZod from "./scheme-zod/index.js";
import { computeCapabilityExports } from "./symbols/define-bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../values/primitives/ARosettaProcedure.js";
import type { AmbientValue } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";
import type { MaybePromise } from "../types/utility.js";
import { onRunContextDispose } from "../run/run-lifecycle.js";
import { type DegradationInfo } from "./degradation.js";

type ZodMap = Record<string, z.ZodType>;
type InferCfg<C extends ZodMap> = { [K in keyof C]: z.infer<C[K]> };
type HandleOf<T> = T extends Resource<infer H> ? H : never;
type RefsOf<R extends Record<string, Resource<unknown>>> = { readonly [K in keyof R]: Ref<HandleOf<R[K]>> };

/** The per-env binding context a method's `this` sees: validated config + live resource Refs. */
export interface Activation<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  readonly configuration: InferCfg<C>;
  readonly resources: RefsOf<R>;
  /** Door-set degradation (`./degradation.js`). Present on every activation; informational —
   *  config-gating a verb is `Contract.requiresConfig` (auto-door calls `.door(...)` internally).
   *  Model: docs/environments.md §DEGRADATION. */
  readonly degradation: DegradationInfo;
}

/** A symbol is one of one family:
 *
 *  The `symbol.*` factories mint the runtime A-value directly —
 *  `native`/`sequence`/`tagless`/`tagless-guard` → `ANativeProcedure`, `rosetta` →
 *  `ARosettaProcedure`, `door`/`notImplemented` → `DoorProcedure`, `keyword` →
 *  `AKernelKeyword`, `value` → the boxed `AmbientValue` itself. Every one is already
 *  `instanceof AValue` (or a raw `AmbientValue` leaf for `value`'s bigint/Promise/binary
 *  passthrough) — `AmbientValue` alone covers the family, dispatched by `instanceof` in
 *  apply(), not by a `kind` tag. `symbol.define`/`symbol.defineSyntax` are the two-phase
 *  carve-out (scheme body evaluates in Pass 2) and `symbol.macro` hands over an already-built
 *  `Macro` — all three stay plain, `kind`-tagged declarative records.
 *
 *  Bare `{ fn, withContext, type, options }` host-fn records (`fn` reading `this: Activation`)
 *  are NOT in this union. A TS-authored `symbols` record inside this package cannot declare
 *  them — the ban lives at the TYPE level (no runtime refusal). External packs that still mint
 *  that shape do so outside this union.
 *
 *  Named `SymbolDeclaration`, not `SymbolDef`: the wider authoring shape a `symbols` record
 *  entry can be, vs. `symbol.js`'s narrower `AEntity` (contract-data only — rides
 *  `.contract`/`.door` on a minted value).
 *
 *  `AliasSymbolDef` (`symbol.alias`) never binds directly (resolve in the apply loop) — it
 *  stands in for a sibling entry's already-baked value.
 *
 *  `AmbientValue` admits ACallable (a class instance, not `typeof "function"`) and
 *  excludes a bare `{ fn }` host function. Matches `capability.test-d.ts`. */
export type SymbolDeclaration =
  | AmbientValue
  | MacroSymbolDef
  | DefineSymbolDef
  | DefineSyntaxSymbolDef
  | AliasSymbolDef;

// Bind-loop helpers (`isAliasDef`, `contractOf`, `missingRequiresConfig`, …) live in
// `./capability-internals.js` — sibling contract with `env/vocabulary.ts`, not authoring surface.

/** A `symbols` record. Config-bearing capabilities author through `EnvCapability.define`
 *  (impls read `this.configuration`/`this.resources` at dispatch); config-gate a verb via
 *  `Contract.requiresConfig` (auto-door), not conditional enumeration. No arm of
 *  `SymbolDeclaration` reads `this` off this record. */
export type SymbolsSpec<_C extends ZodMap, _R extends Record<string, Resource<unknown>>> = Record<
  string,
  SymbolDeclaration
>;

export interface CapabilitySpec<C extends ZodMap, R extends Record<string, Resource<unknown>>> {
  /** zod schemas for per-env config; values supplied + validated when consumed
   *  (`env/vocabulary.ts`'s `buildVocabulary`). */
  configuration?: C;
  /** Ports this capability OWNS — static, or a provider that reads the parsed config.
   *  Spawned per-RunContext, lazily, on first symbol touch (`["arrival/get-resources"]` —
   *  RunContext.capabilityResources store's producer). */
  resources?: { [K in keyof R]: R[K] | ((cfg: InferCfg<C>) => R[K]) };
  /** scheme bootstrap (`define-macro` + `define`s), eval'd into env on apply. */
  prelude?: string;
  /** DAG edges = capability grants. */
  deps?: readonly EnvCapability[];
  /** Verbs this capability exposes — baked `symbol.native`/`symbol.rosetta`/… declarations.
   *  Config-bearing packs use `EnvCapability.define` (impls read `this.configuration` at dispatch). */
  symbols?: SymbolsSpec<C, R>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvCapability.define — FLIPPED authoring API (docs/execution.md §CALLCTX).
//
// `symbols` receives an injected `(symbol, z)` factory pair — the module-singleton
// `symbol.rosetta`/`native`/… namespace + scheme-zod — typed so each impl's
// `this.configuration`/`this.resources` are the declared `Config`/`Resources`, not
// `unknown`. Reads ride the `associateActivation`/`CallCtx` channel every baked def
// (native/rosetta/sequence) already carries. `symbols` is invoked EAGERLY, ONCE, at
// `define()` time — the returned record does not depend on per-env config; only an
// IMPL BODY'S runtime read of `this.configuration`/`.resources` is per-dispatch.
//
// Resources: `spec.resources` is ONE factory over validated config
// (`(config) => Resources`), not a per-key `Record<string, Resource<H>>` map.
// `DefinedEnvCapability` overrides `["arrival/get-resources"]` to produce that bag
// and flips `producesRunResources`/`nativeReadsRunResources` so baked symbols read
// `this.resources` from the run store.
// ─────────────────────────────────────────────────────────────────────────────

/** The `this` every impl declared through {@link EnvCapability.define}'s injected `symbol`
 *  factory is invoked with — `CallCtx` (run/CallCtx.ts) narrowed so `configuration`/
 *  `resources` (runtime carrier: `unknown`, optional) are the capability's declared
 *  `Config`/`Resources`. Authoring-layer type overlay ONLY — runtime fields stay
 *  `unknown`; narrowing is applied ONCE at the `SymbolFactory` boundary
 *  (`makeSymbolFactory`'s cast) — the one sanctioned narrowing for this channel,
 *  mirroring the membrane's single-cast boundary. */
export type ImplThis<Config, Resources> = CallCtx & {
  readonly configuration: Config;
  readonly resources: Resources;
};

/** `Impl` (`./symbols/_bake.js`) with `this` parameterized instead of pinned to `CallCtx` —
 *  same decoded-args/return shape (`DecodedArgsWithRest`/`DecodedReturn`), so a
 *  `symbol.rosetta`/`native` impl through the injected factory infers the same arg/return
 *  types as the module-singleton factories — only `this` differs. */
type ImplWithThis<I extends VectorSpec, O extends VectorSpec, Rest extends RestSpec, F extends Face, This> = (
  this: This,
  ...args: DecodedArgsWithRest<I, Rest, F>
) => MaybePromise<DecodedReturn<O, F>>;

/** Injected `symbol.rosetta` — same as module-singleton `rosetta()` except impl `this` is
 *  {@link ImplThis}`<Config,Resources>`. Slot bans on `CrossingContract` (`_bake.ts`);
 *  returns bare `ARosettaProcedure`. */
export interface RosettaTag<Config, Resources> {
  (
    tpl: TemplateStringsArray,
    ...sub: (string | number)[]
  ): <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: CrossingContract<I, O, Rest>,
    impl: ImplWithThis<I, O, Rest, "js", ImplThis<Config, Resources>>,
    opts?: BakeRuntimeOpts,
  ) => ARosettaProcedure;
}

/** Injected `symbol.native` — same relationship to `native()` as {@link RosettaTag}
 *  to `rosetta()`. Slot bans on `ContourContract`; returns bare procedure. */
export interface NativeTag<Config, Resources> {
  (
    tpl: TemplateStringsArray,
    ...sub: unknown[]
  ): <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: ContourContract<I, O, Rest>,
    impl: ImplWithThis<I, O, Rest, "scheme", ImplThis<Config, Resources>>,
    opts?: { metadata?: MetadataRecord },
  ) => ANativeProcedure;
}

/** Factory `EnvCapability.define`'s `symbols` callback is invoked with. `rosetta`/`native`
 *  carry the `Config`/`Resources`-typed `this` overlay ({@link RosettaTag}/{@link NativeTag});
 *  every other tag matches its module-singleton (`./symbols/index.js`) — none of
 *  `sequence`/`tagless`/`taglessGuard`/`notImplemented`/`keyword`/`macro`/`alias`/`define`/
 *  `defineSyntax` read config/resources off `this` (sequence takes `(args, runCtx)`
 *  positionally; `define`/`defineSyntax` carry a two-phase scheme body; the rest carry no
 *  author impl). */
export interface SymbolFactory<Config, Resources> {
  readonly rosetta: RosettaTag<Config, Resources>;
  readonly native: NativeTag<Config, Resources>;
  readonly sequence: typeof symbolFactories.sequence;
  readonly tagless: typeof symbolFactories.tagless;
  readonly taglessGuard: typeof symbolFactories.taglessGuard;
  readonly notImplemented: typeof symbolFactories.notImplemented;
  readonly keyword: typeof symbolFactories.keyword;
  readonly macro: typeof symbolFactories.macro;
  readonly alias: typeof symbolFactories.alias;
  readonly define: typeof symbolFactories.define;
  readonly defineSyntax: typeof symbolFactories.defineSyntax;
  readonly value: typeof symbolFactories.value;
}

/** Build the injected `symbol` factory for one `define()` call: the REAL `./symbols/index.js`
 *  namespace, cast ONCE to the `Config`/`Resources`-typed {@link SymbolFactory} — the sanctioned
 *  narrowing {@link ImplThis}'s doc points at. No wrapping at runtime: `rosetta`/`native` are the
 *  same functions every hand-authored capability calls; only the TYPE seen by the `symbols`
 *  callback's impls differs. */
function makeSymbolFactory<Config, Resources>(): SymbolFactory<Config, Resources> {
  return symbolFactories as unknown as SymbolFactory<Config, Resources>;
}

/** `EnvCapability.define`'s spec — flipped shape. `configuration`/`prelude`/`deps` match
 *  `CapabilitySpec`'s own fields (reused, not re-declared). */
export interface DefineCapabilitySpec<Shape extends ZodMap, Resources> {
  readonly configuration?: Shape;
  /** ONE factory over the validated config — see the section header's Resources note. */
  readonly resources?: (config: InferCfg<Shape>) => Resources;
  readonly prelude?: string;
  readonly deps?: readonly EnvCapability[];
  /** Invoked EAGERLY, ONCE, at `define()` time — see the section header. */
  readonly symbols: (
    symbol: SymbolFactory<InferCfg<Shape>, Resources>,
    z: typeof schemeZod,
  ) => Record<string, SymbolDeclaration>;
}

/** A configured, lowerable env capability. The default export of every palette pack. */

export class EnvCapability<C extends ZodMap = any, R extends Record<string, Resource<unknown>> = any> {
  constructor(
    readonly name: string,
    readonly spec: CapabilitySpec<C, R>,
  ) {}

  /** Structural DAG-node view — `dag-linearize.ts` C3 core (env/vocabulary.ts's
   *  `buildVocabulary`) walks `{name, deps}` generically; dep edges live at `spec.deps`
   *  (authoring field). This getter surfaces them at top level for the generic `DagNode`
   *  shape — delegates, never duplicates. Prefer `.spec.deps` elsewhere. */
  get deps(): readonly EnvCapability<any, any>[] | undefined {
    return this.spec.deps;
  }

  /** Per-run resource producer — the run's `capabilityResources` store (RunContext.ts)
   *  calls it at most once per `RunContext` (DefaultedWeakMap semaphore), keyed on this
   *  capability object. Base form: a fresh unspawned `ResourceCell` record from
   *  `spec.resources` (config-resolved); `.get()` lazy-spawns per cell. Disposal
   *  registers on THIS RunContext so cells wind down at run teardown. `undefined` when
   *  no resources (verbs bind `readsResources: false`). MaybePromise by contract; base
   *  form is synchronous. */
  ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): MaybePromise<unknown> | undefined {
    const descriptors = Object.entries(this.spec.resources ?? {});
    if (descriptors.length === 0) return undefined;
    const cells: Record<string, ResourceCell<unknown>> = {};
    for (const [key, def] of descriptors) {
      const resource = (typeof def === "function" ? def(configuration as InferCfg<C>) : def) as Resource<unknown>;
      cells[key] = new ResourceCell(resource);
    }
    onRunContextDispose(runCtx, () => windDownAll(Object.values(cells)));
    return cells;
  }

  /** Does this capability produce a per-run resource bag (gating a verb's `readsResources`)?
   *  Base: it declares `spec.resources`. `native` verbs bind `false` regardless (see
   *  `nativeReadsRunResources`). */
  producesRunResources(): boolean {
    return Object.keys(this.spec.resources ?? {}).length > 0;
  }

  /** Does a `native` verb of this capability read `this.resources` from the run store? Base:
   *  NO — base-ctor path's native never reads `this.resources`; triggering the store here
   *  would double-spawn. `EnvCapability.define` overrides to `true` (injected `native`
   *  factory's point is a `this.resources`-reading impl). */
  nativeReadsRunResources(): boolean {
    return false;
  }

  /** Flipped authoring entry — builds the same `CapabilitySpec` shape the constructor
   *  consumes (plain literal `symbols` record; bind loop cannot tell authoring paths apart).
   *  Returns a {@link DefinedEnvCapability} so its `["arrival/get-resources"]` override
   *  produces this capability's per-run bag. */
  static define<Shape extends ZodMap = Record<string, never>, Resources = Record<string, never>>(
    name: string,
    defSpec: DefineCapabilitySpec<Shape, Resources>,
  ): EnvCapability<Shape, Record<string, never>> {
    const symbolFactory = makeSymbolFactory<InferCfg<Shape>, Resources>();
    const symbolsRec = defSpec.symbols(symbolFactory, schemeZod);
    return new DefinedEnvCapability<Shape, Resources>(
      name,
      {
        configuration: defSpec.configuration,
        prelude: defSpec.prelude,
        deps: defSpec.deps,
        symbols: symbolsRec,
      },
      defSpec.resources,
    );
  }

  private _exportsPromise?: Promise<ReadonlySet<string>>;

  /** Derived, memoized: every statically-enumerable name this capability contributes to a
   *  shared env — prefixed `spec.symbols` keys ∪ macro-aware `define`/`define-macro`/
   *  `define-syntax` names parsed from `spec.prelude`. Consumed by `symbol.define`'s
   *  bake-time FV law (`define-bake.ts`'s `bindCapabilityDefines`) to resolve
   *  CROSS-capability references. Async (parsing is async) and memoized per capability
   *  INSTANCE: a module-singleton capability's export set never changes across assemblies. */
  exports(): Promise<ReadonlySet<string>> {
    this._exportsPromise ??= computeCapabilityExports(this.spec);
    return this._exportsPromise;
  }
}

/** Runtime half of `EnvCapability.define`. Thin subclass: bind loop
 *  (`env/vocabulary.ts`'s `processCapability`) `associateCapability`s each symbol to THIS
 *  instance, so the run's `capabilityResources` store reaches this override — no per-proc
 *  rewrap. Virtual hooks:
 *   - `["arrival/get-resources"]` produces the single arbitrary `Resources` bag from
 *     `resourcesFactory(config)` (vs base form's `spec.resources` `ResourceCell` record);
 *   - `producesRunResources`/`nativeReadsRunResources` flip to `true` so baked symbols
 *     bind `readsResources: true`.
 *  Internal: never exported; constructed only by `EnvCapability.define`. */
class DefinedEnvCapability<Shape extends ZodMap, Resources> extends EnvCapability<Shape, Record<string, never>> {
  constructor(
    name: string,
    spec: CapabilitySpec<Shape, Record<string, never>>,
    private readonly resourcesFactory: ((config: InferCfg<Shape>) => Resources) | undefined,
  ) {
    super(name, spec);
  }

  override ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): MaybePromise<unknown> | undefined {
    const { resourcesFactory } = this;
    if (resourcesFactory === undefined) return undefined;
    // `resourcesFactory` is SYNCHRONOUS by contract (`DefineCapabilitySpec.resources`:
    // `(config) => Resources`, never a Promise) — bag is a plain value the store caches
    // as-is. Optional `[Symbol.asyncDispose]` on the bag runs once at THIS RunContext's teardown.
    const bag = resourcesFactory(configuration as InferCfg<Shape>);
    const disposable = bag as { [Symbol.asyncDispose]?: () => PromiseLike<void> | void };
    if (disposable[Symbol.asyncDispose] !== undefined) {
      onRunContextDispose(runCtx, async () => {
        await disposable[Symbol.asyncDispose]!();
      });
    }
    return bag;
  }

  override producesRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }

  override nativeReadsRunResources(): boolean {
    return this.resourcesFactory !== undefined;
  }
}
