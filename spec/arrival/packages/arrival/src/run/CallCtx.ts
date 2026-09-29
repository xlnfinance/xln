// CallCtx lives here (not in common/symbols/_bake.ts): _bake imports scheme-zod, which
// imports ACallable back, and ACallable needs makeCallCtx as a real call. Housing
// makeCallCtx in _bake would close that cycle badly — z.instanceof captures its class
// argument BY VALUE at call time, so a TDZ undefined sticks for that schema instance's
// lifetime. CallCtx needs none of _bake's zod machinery. Import from this file directly.

import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { type InvocationLike } from "../membrane/rosetta.js";
// TYPE-ONLY: Resolver lives in eval/, above this leaf. Runtime stays run → (nothing in eval).
import type { Resolver } from "../eval/Resolver.js";

/**
 * The ONE `this` every callable body sees (docs/execution.md §CALLCTX) — dispatch-level
 * `runCtx` fused with call-site provenance `invocation` and optional deep `argProvenance`.
 * Flat carriers; nothing deferred.
 *
 * `invocation` is call-varying (unlike run-constant `runCtx`) — never lives on RunContext.
 * `argProvenance` aligns to scheme args; absent when the dispatch path doesn't request it.
 *
 * `resolver` is the composed name-resolution + frame object of the apply that minted this
 * CallCtx. Call-varying (a new lexical frame is a new `Resolver.child`), so it cannot live
 * on RunContext. Evaluator dispatch passes it; HOF / host-projection / `testCallCtx()`
 * sites omit it. `(require …)` reads it off `this` — a missing field is
 * `RunResolverUnreachableError`.
 *
 * `configuration`/`resources` (docs/execution.md §CALLCTX): the same per-env Activation a
 * builder-form `symbols` closes over is reachable off `this` at real dispatch — a PARALLEL
 * channel, not a replacement. Resolved at `makeCallCtx` off `runCtx`
 * (`capabilityConfigurations` / `capabilityResources`), keyed by the value's owning
 * capability ({@link associateCapability}). No owner, or no per-capability table (bare-env
 * glass) ⇒ both `undefined`. Typed `unknown` here; capability Activation generics narrow.
 */
export interface CallCtx {
  readonly runCtx: RunContext;
  readonly invocation: { currentInvocation: InvocationLike | undefined };
  readonly argProvenance?: readonly ReadonlySet<number>[];
  readonly resolver?: Resolver;
  readonly configuration?: unknown;
  readonly resources?: unknown;
}

/** Value → owning-capability association. Bind loop calls {@link associateCapability} once
 *  at BIND time, keyed on the bound callable VALUE (never its name — aliases share identity).
 *
 *  Payload: owning `capability` (opaque `object` — importing EnvCapability reopens the cycle
 *  this file's header avoids) + `readsResources` (define-time constant: does this value read
 *  the per-run resource channel at all). Neither configuration nor resources live here —
 *  both are per-RunContext, resolved at dispatch. A symbol factory mints ONE value at
 *  `define()` for every assembly; per-assembly config on a value-keyed WeakMap would
 *  silently overwrite. WeakMap keeps the capability type out of this leaf and costs a plain
 *  miss for unbound values. */
const capabilityByValue = new WeakMap<object, { readonly capability: object; readonly readsResources: boolean }>();

/** Record `value`'s owning capability — once per bound native/rosetta/sequence/tagless proc.
 *  Re-attributing to a DIFFERENT capability throws; same capability re-bind is allowed.
 *
 *  `readsResources` gates `this.resources` fetch. `true` for per-run-resource consumers
 *  (define-form; sequence/tagless/rosetta). `false` for constructor-form `native` (resources
 *  via builder closure — e.g. arrival/loader; triggering the store here would double-spawn). */
export function associateCapability(value: object, capability: object, readsResources: boolean): void {
  const existing = capabilityByValue.get(value);
  if (existing !== undefined && existing.capability !== capability) {
    throw new Error("associateCapability: value already owned by a different capability");
  }
  capabilityByValue.set(value, { capability, readsResources });
}

/** Owning capability if any — discovery-side query (docs/execution.md §CALLCTX). Plain
 *  lookup: `undefined` for anything never bound through the bind loop. Never throws.
 *  Exported via `/host-internals`; {@link symbolsOwnedBy} is the usual consumer composition. */
export function ownerOf(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return capabilityByValue.get(value)?.capability;
}

/** Every vocabulary NAME this run resolves whose bound value is owned by `capability`.
 *  Walks `runCtx.vocabulary` (opaque here so this leaf never imports the env layer).
 *  No vocabulary (`CONSTANT_CTX`, live-frame family) ⇒ empty map.
 *
 *  Two capabilities in one run never collide: associateCapability throws on re-attribution.
 *  Root-scope `(define ...)` lands in lexical scope, never vocabulary — not a candidate.
 *  Contract/introspection is a different door (`contractOf` on `/lsp-internals`). */
export function symbolsOwnedBy(runCtx: RunContext, capability: object): ReadonlyMap<string, unknown> {
  const owned = new Map<string, unknown>();
  if (runCtx.vocabulary === undefined) return owned;
  for (const [name, value] of runCtx.vocabulary) {
    if (ownerOf(value) === capability) owned.set(name, value);
  }
  return owned;
}

/** Build the `this` every callable body is invoked with. THE ONE construction site —
 *  every dispatch calls this. `runCtx` has NO default (docs/execution.md §CALLCTX);
 *  `testCallCtx()` is the sanctioned CONSTANT_CTX door under test.
 *
 * `resolvedValue` (optional): the callable this dispatch will invoke — passed ONLY by
 * real evaluator sites that hold the resolved value. When it carries an
 * {@link associateCapability}-registered owner, enriches CallCtx from THIS run:
 *   - `configuration` — `runCtx.capabilityConfigurations?.get(owner)` (filled once at mint)
 *   - `resources` — lazy get-or-produce via `resolveCapabilityResources`
 *
 * Other call sites (HOF seams, membrane) omit `resolvedValue` and pay only the undefined check.
 *
 * `resolver` (optional): the apply's composed Resolver. Passed ONLY by evaluator
 * dispatch (`evaluatePair`, `applyArrowProc`), which already holds `ctx.resolver`. */
export function makeCallCtx(
  runCtx: RunContext,
  currentInvocation?: InvocationLike,
  argProvenance?: readonly ReadonlySet<number>[],
  resolvedValue?: unknown,
  resolver?: Resolver,
): CallCtx {
  const owner =
    typeof resolvedValue === "object" && resolvedValue !== null ? capabilityByValue.get(resolvedValue) : undefined;
  return {
    runCtx,
    invocation: { currentInvocation },
    argProvenance,
    ...(resolver === undefined ? {} : { resolver }),
    // eslint-disable-next-line unicorn/no-negated-condition -- include configuration/resources only when the value has an owner
    ...(owner !== undefined
      ? {
          configuration: runCtx.capabilityConfigurations?.get(owner.capability),
          resources: owner.readsResources ? resolveCapabilityResources(runCtx, owner.capability) : undefined,
        }
      : {}),
  };
}

/** Fetch (produce + cache on first touch) a capability's Resources bag for `runCtx`.
 *  On miss: call `capability["arrival/get-resources"]` with run-sourced configuration;
 *  pending Promise replaced in-slot on settle. Structural call (no capability-layer import).
 *  `has`-then-`set` is sound under single-dispatch (see CapabilityResourceStore). No store
 *  (CONSTANT_CTX) ⇒ undefined. */
function resolveCapabilityResources(runCtx: RunContext, capability: object): unknown {
  const store = runCtx.capabilityResources;
  if (store === undefined) return undefined;
  if (!store.has(capability)) {
    const configuration = runCtx.capabilityConfigurations?.get(capability);
    const produced = (capability as { ["arrival/get-resources"](runCtx: RunContext, configuration: unknown): unknown })[
      "arrival/get-resources"
    ](runCtx, configuration);
    store.set(capability, produced);
    if (produced instanceof Promise) void produced.then((resolved) => store.set(capability, resolved));
  }
  return store.get(capability);
}

/**
 * Sanctioned door for callers outside real verb dispatch that still need a capability's
 * per-run resource bag — e.g. arrival/loader's `require/register-extension` preludeOnly
 * MACRO (`Macro.invoke` / TF_EXPAND, never through makeCallCtx). Receives `ctx.runCtx` from
 * MacroInvokeContext; same bag a real dispatch would read as `this.resources`. Delegates to
 * the exact get-or-produce logic makeCallCtx uses.
 *
 * A run with no configuration table: check first — a resources factory that destructures
 * config unconditionally will throw on `undefined`.
 */
export function getCapabilityResources(runCtx: RunContext, capability: object): unknown {
  return resolveCapabilityResources(runCtx, capability);
}

/**
 * Sanctioned direct-call door (docs/execution.md §CALLCTX): tests/host invoking a verb
 * outside real dispatch build a real CallCtx over CONSTANT_CTX here — CONSTANT_CTX
 * survives only inside this constructor, never as an implicit `this?.` fallback.
 */
export function testCallCtx(overrides?: {
  runCtx?: RunContext;
  currentInvocation?: InvocationLike;
  argProvenance?: readonly ReadonlySet<number>[];
  resolver?: Resolver;
}): CallCtx {
  return makeCallCtx(
    overrides?.runCtx ?? CONSTANT_CTX,
    overrides?.currentInvocation,
    overrides?.argProvenance,
    undefined,
    overrides?.resolver,
  );
}

// Null-`this` is uninhabited: `this: CallCtx` on wrappers makes unbound call a compile
// error at typed sites (docs/execution.md §CALLCTX).
