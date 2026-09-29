// scheme-env — the SCHEME-AWARE layer over the pure C3 kernel (kernel.ts).
//
// The kernel is env-agnostic: a pack's `apply(env)` may do anything, but the kernel
// itself never touches `env` or knows what scheme is. This module adds the ENV TYPE
// CONTRACT (`SchemeEnv`) a scheme env-build needs on top of that seam, WITHOUT
// modifying the kernel — the surface a pack contributes to, defined here (not
// imported from arrival-scheme) so the dependency only ever points arrival-scheme →
// arrival-scheme-env, never back (no cycle).
//
// The evaluator is INJECTED (`EvalSchemeInto`/`EvalPreludeInto`): arrival-scheme's
// `exec(src,{env})` satisfies it. This module never imports the interpreter, so it
// stays the lower, dependency-free layer the base sandbox can be re-expressed in
// terms of. Capability `symbols`/`prelude` bake through the vocabulary path directly —
// no separate bootstrap-lowering step.

// Type-only edges (no runtime import — AmbientRuntime.ts imports THIS module's types, so a
// value edge here would cycle; `import type` erases at emit): the storage union a resolver may
// answer with, and the run identity a resolving read threads.
import type { AmbientValue } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";
import type { MaybePromise } from "../types/utility.js";

/** A rosetta (host-fn) contribution config. Defined here, not imported, so this package
 *  needn't depend on the runtime. */
export interface RosettaSpec {
  fn: (...args: any[]) => unknown;
  /** Optional ambient `.d.ts` member-body type fragment, harvested by the type-lens. */
  type?: string;
  /** Rosetta options (e.g. `{ argProvenance: true }`) — passed through verbatim. */
  options?: unknown;
  /** PURE (provenance-PROPAGATING) rosetta — forwards its inputs' provenance instead of
   *  minting a fresh source point (`mintsPoint = pure !== true`). Absent ⇒ source/mint
   *  (the conservative default). Carried here so a cross-package pack declaring a
   *  pure verb (`(approve …)`, `(expose …)`) types against this surface. */
  pure?: boolean;
}

/** What a resolver may answer with: a BOXED scheme/runtime binding (the same union
 *  environment storage holds), or a membrane primitive — a bare fn like the `:key`
 *  pluck, which is NOT rosetta-wrapped because it IS part of the membrane, like `@`.
 *  Deliberately NOT `unknown`: a raw JS scalar answer is a contract violation the
 *  probe sites door on at runtime (`assertResolvedBinding`, AmbientRuntime.ts) and this
 *  type walls off at compile time. */
export type ResolvedBinding = AmbientValue | ((...args: never[]) => unknown);

/** A catchall resolver contribution, mirroring arrival-scheme's `FallbackResolver`
 *  structurally (kept here so we don't import the runtime). It fires when the env
 *  did NOT bind `name`, mapping a NAME to a value — the polyglot member accessors
 *  (`:key`) and the unbounded `c[ad]+r` family are exactly this. */
export interface ResolverSpec {
  readonly id: string;
  /** Resolve `name` to a boxed binding, or `undefined` for "not mine, keep looking".
   *
   *  `ctx` is the RESOLVING READ's RunContext when the lookup came from a live run
   *  (the evaluator threads it through `Resolver.resolve`/`lookup`); absent on
   *  run-less reads (host `env.get`, assembly probes). A resolver that MINTS a value
   *  boxes at its own boundary: under `ctx` when it computes per-read (impure), but a
   *  `pure` resolver mints RUN-NEUTRALLY (`CONSTANT_CTX`-class) — its hits are
   *  memoized by the sealed chain and served across runs, so stamping the first
   *  reader's ctx would leak run identity between runs. */
  resolve(name: string, ctx?: RunContext): ResolvedBinding | undefined;
  /** DECLARED purity (a drift alarm catches CONTRADICTIONS against this declaration,
   *  never lies outright): `true` promises NAME-STABLE results (same
   *  name ⇒ same value forever), which licenses the compiled resolution chain to
   *  memoize hits through this step — and, iff EVERY resolver in a chain is pure, to
   *  cache misses ("unbound") too. Absent/`false` (the safe default): nothing is cached
   *  through this step — a dynamic middleware may start answering tomorrow. */
  readonly pure?: boolean;
}

/** The minimal surface a scheme-env pack touches. arrival-scheme's `AmbientRuntime`
 *  satisfies this structurally — packs type against THIS, not the concrete class.
 *
 *  Deliberately NO `set`/`inherit`/`merge` member: the env is hermetic — born (assembled) and
 *  read only from JS, never mutated or extended (docs/environments.md §HERMETIC). This contract is
 *  defined HERE, not imported from arrival-scheme, so the dependency only ever points
 *  arrival-scheme → arrival-scheme-env (no cycle). A pack contributes bindings DECLARATIVELY
 *  (`symbols`/`resolvers`/`bootstrap`); binding is the assembly machinery's own act, through
 *  `AmbientRuntime.bind` / `.child` / `.root` (the concrete internals class, never barrel-exported). */
export interface SchemeEnv {
  get(name: string, options?: { throwError?: boolean }): unknown;
  /** Register a catchall resolver (fires on a name the env did not bind). This is the
   *  APPLY-TIME landing door for a capability's declared `resolvers` and assembly-time
   *  producers only. There is deliberately NO `unregisterResolver` on this contract:
   *  resolver REMOVAL is not a pack-facing operation. Prelude uses a discarded
   *  per-run frame (`assembleRun`), not a resolver overlay. */
  registerResolver(resolver: ResolverSpec): void;
  /** Own bound names of THIS scope layer (string keys + symbols), not chained. The
   *  per-layer primitive `allBoundNames` walks; a consumer wanting only own-scope
   *  names (e.g. inspecting a freshly-minted child frame) reads this directly. */
  list(): (string | symbol)[];
  /** Every name bound anywhere up this scope's `__parent__` chain, de-duplicated
   *  (a closer layer's name appears once). Encapsulates the chain-walk so a consumer
   *  reflecting the full vocabulary (the MCP discovery schema) never pokes the
   *  internal `__parent__`/`list` machinery itself. Unsorted — the caller orders. */
  allBoundNames(): (string | symbol)[];
}

/** Evaluate scheme `source` into `env`. arrival-scheme's `exec(source, { env })`
 *  is the canonical implementation; injected so this package is evaluator-agnostic. */
export type EvalSchemeInto<E = SchemeEnv> = (env: E, source: string) => MaybePromise<unknown>;

/** Evaluate PER-RUN PRELUDE `source` into `env`, THREADED WITH THIS RUN'S `runCtx`
 *  (`env/assemble-run.ts`'s `assembleRun`). Distinct from {@link EvalSchemeInto} — which stays
 *  runCtx-less because it also serves `symbol.define`'s Pass-2 bake, a BUILD-time (per-tuple,
 *  shared-across-runs) eval with no run to carry — this callback exists because a prelude's
 *  resource-touching verb (the loader's extension registry, a preludeOnly registration verb)
 *  must spawn/read THIS run's `capabilityResources` bag, not a bystander run's. arrival-scheme's
 *  `exec(source, { env, runCtx, skipBootstrapWait: true })` satisfies it (see
 *  `generator-exec.ts`'s `preludeEvalScheme`). */
export type EvalPreludeInto<E = SchemeEnv> = (env: E, source: string, runCtx: RunContext) => MaybePromise<unknown>;
