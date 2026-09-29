// Every arrival callable is an AValue with an EXPLICIT `run(args, callCtx)` surface.
// `callCtx` is the ONLY threaded context — wraps run-level state (strict, channels,
// via `callCtx.runCtx`) with the per-call invocation (provenance minting), built ONCE
// at dispatch and threaded whole. Provenance is NOT threaded separately: it rides
// the values and is minted only at the rosetta membrane, as `union(args)`.
//
// Three concrete callables, sibling classes each extending AValue directly — NO abstract
// parent. Exported `ACallable` is a UNION (narrows better than an abstract base):
//   • ALambda            — scheme body + captured lexical scope
//   • ANativeProcedure   — host-JS CONTOUR (stays in the value algebra)
//   • ARosettaProcedure  — host-JS MEMBRANE (decode → host → encode → mint)
//
// toJS IS the membrane: a callable's `arrival/toJS` returns a HOST-CALLABLE function —
// reverse-membrane projection (JS args cross IN, apply term runs, result crosses OUT).
// Not display (that's `arrival/print`). Crossings call `jsToScheme`/`toJS` directly.
//
// REGION-DISCIPLINED (docs/membrane.md §REGION): wrapper closes over
// `currentRegionScope() ?? DETACHED_SCOPE`, minted/cached on THAT scope's own `cache` —
// one cache a callable's host projection ever lives in, regardless of which door reached it.

import { AValue } from "./AValue.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue, WrapperKey } from "../types.js";
import { tf } from "../tagless-final.js";
import { applyMembraneClosure, type RunContext } from "../../run/RunContext.js";
// CallCtx lives here-ward specifically so this file never transitively imports
// common/scheme-zod.ts (would close a cycle that could leave z.instanceof codecs undefined).
import { makeCallCtx, type CallCtx } from "../../run/CallCtx.js";
import { PurityError } from "../../errors.js";
// TYPE-ONLY: erased at compile — a real value import would close the scheme-zod cycle.
import type { DoorSymbolDef } from "../../common/symbols/_bake.js";
import { jsToScheme, toJS, type InvocationLike } from "../../membrane/rosetta.js";
// Region discipline sits BELOW this file — safe runtime edge, no cycle.
import { currentRegionScope, DETACHED_SCOPE, withRegionCall, withRegionScope } from "../../membrane/region-scope.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import invariant from "tiny-invariant";
import { ARosettaProcedure, _linkRosettaHostProjection } from "./ARosettaProcedure.js";
import { ANativeProcedure, _linkNativeHostProjection } from "./ANativeProcedure.js";
import type { MaybePromise } from "../../types/utility.js";

export type CallResult = SchemeBounceMarker | MaybePromise<SchemeValue>;

/** Arity bounds. `max: null` ⇒ variadic. Drives arity check and MCP/type-lens introspection. */
export interface Arity {
  readonly min: number;
  readonly max: number | null;
}

// Shared leaf behavior as free functions. Procedure identity is load-bearing
// (`(eq? car car)`), so provenance stamping is a no-op and equality is reference identity.
const callableEquals = (self: object, other: unknown): boolean => other === self;

// ── Inbound reverse-membrane lens (hostFnToCallable) — bifunctor's OTHER leg ──
// hostProjectionOf is outbound (scheme callable → host fn); this is js→scheme.
// Lives here for the same reason hostProjectionOf does — one module owns both
// directions off the injected marshal seam.

/** Reverse of WRAPPER_KEY cache: reverse-membrane wrapper → original ACallable.
 *  Re-admission claim: a wrapper crossing back IN re-admits as its original callable
 *  (`eq?`) instead of double-wrapping — round-trip-to-identity law. */
const WRAPPER_ORIGIN = new WeakMap<object, ACallable>();

/** Inverse of hostProjectionOf's mint: undefined for anything not one of this
 *  module's own reverse-membrane wrappers under the scope it was minted under. */
export function originalCallableOf(fn: object): ACallable | undefined {
  return WRAPPER_ORIGIN.get(fn);
}

/** Run-scoped mint-or-reuse: `(RunContext, host fn) → the ONE ARosettaProcedure`.
 *  Run-scoped so provenance ids from run A never pollute run B's numbering. */
const HOST_FN_CACHE = new WeakMap<RunContext, WeakMap<(...args: unknown[]) => unknown, ARosettaProcedure>>();

/**
 * INBOUND REVERSE-MEMBRANE LENS: bare host function → scheme-callable ARosettaProcedure.
 * When scheme applies it: args scheme→js, host fn runs, result js→scheme under the
 * CALLING invocation's runCtx. IDENTITY: mint-or-reuse per `(RunContext, fn)`.
 * Provenance stamps ONLY the first mint — later crossings answer the cached value
 * unchanged (procedure identity is load-bearing; unlike AOpaqueHandle).
 */
export function hostFnToCallable(
  ctx: RunContext,
  fn: (...args: unknown[]) => unknown,
  provenance: ReadonlySet<number>,
): ARosettaProcedure {
  let byFn = HOST_FN_CACHE.get(ctx);
  if (byFn === undefined) {
    byFn = new WeakMap();
    HOST_FN_CACHE.set(ctx, byFn);
  }
  const cached = byFn.get(fn);
  if (cached !== undefined) return cached;
  const proc = new ARosettaProcedure(
    {
      name: fn.name || "host-function",
      // Unknown arity by construction — arbitrary host fn's arity is not introspectable.
      arity: { min: 0, max: null },
      contract: undefined,
      strategy: undefined,
      hostApply: (args, callCtx): CallResult =>
        applyMembraneClosure(callCtx.runCtx, () => {
          const jsArgs = args.map((a) => toJS(a));
          const result = fn(...jsArgs);
          return result instanceof Promise
            ? result.then((r) => jsToScheme(callCtx.runCtx, r))
            : jsToScheme(callCtx.runCtx, result);
        }),
    },
    provenance,
  );
  byFn.set(fn, proc);
  return proc;
}

/** Bounce-marker check — a host caller (this wrapper IS that boundary) must never see one. */
function isBounceMarker(x: unknown): x is SchemeBounceMarker {
  return typeof x === "object" && x !== null && (x as Partial<SchemeBounceMarker>).__bounce === true;
}

/** Wrapper cache key for this crossing family. Callable host projection never varies by
 *  RosettaOptions — `"mem"` is this family's fixed slot (alongside scheme-zod's `"typed"`). */
const WRAPPER_KEY: WrapperKey = "mem";

/**
 * Build (once per (callable, scope)) the host-callable reverse-membrane wrapper.
 * Region-disciplined: closes over scope AT MINT TIME, never re-reads ambient later.
 * `exit` when supplied is reused VERBATIM for the result leg; bare falls back to `toJS`.
 */
function hostProjectionOf(self: ACallable, exit?: MembraneExit): (...args: unknown[]) => unknown {
  const scope = currentRegionScope() ?? DETACHED_SCOPE;
  let byKey = scope.cache.get(self);
  if (byKey === undefined) {
    byKey = new Map();
    scope.cache.set(self, byKey);
  }
  const cached = byKey.get(WRAPPER_KEY);
  if (cached) return cached;
  const wrapper = (...jsArgs: unknown[]): Promise<unknown> =>
    applyMembraneClosure(scope.runCtx, () =>
      withRegionCall(scope, async () => {
        // Args mint under the ENCLOSING invocation's runCtx (scope.runCtx), never CONSTANT_CTX.
        const schemeArgs = (await Promise.all(
          jsArgs.map(async (a) => jsToScheme(scope.runCtx, await a)),
        )) as SchemeValue[];
        const callCtx = makeCallCtx(scope.runCtx, scope.dynSite as InvocationLike | undefined);
        // Re-entry trace nests under the exporting invocation.
        const raw = await withDynamicCallSite(scope.dynSite, () => applyCallback(self, schemeArgs, callCtx));
        invariant(!isBounceMarker(raw), "arrival/toJS: a reverse-membrane call resolved to a bounce token");
        return withRegionScope(scope, () => (exit === undefined ? toJS(raw) : exit.element(raw)));
      }),
    );
  byKey.set(WRAPPER_KEY, wrapper);
  // Register reverse-admission mapping at mint time (before returning).
  WRAPPER_ORIGIN.set(wrapper, self);
  return wrapper;
}

// arrival/print display name — gensym'd names print their readable description.
function displayName(name: string | symbol): string {
  return typeof name === "symbol" ? name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : name;
}

/** Scheme lambda: body + lexical scope captured at definition. Evaluator injects the
 *  `runner` closure (value→eval cycle avoidance). `scope` is the captured Resolver. */
export class ALambda extends AValue {
  readonly kind = "lambda" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  /** Captured lexical scope (a Resolver). */
  readonly scope: unknown;
  /** Mutable display name — `(define foo (lambda …))` stamps it post-construction. */
  __name__?: string | symbol;
  /** Positional parameter names, for tracer↔param-slot correlation. */
  __params__?: string[];
  readonly #runner: (args: readonly SchemeValue[], callCtx: CallCtx, canBounce: boolean) => CallResult;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    scope: unknown;
    runner: (args: readonly SchemeValue[], callCtx: CallCtx, canBounce: boolean) => CallResult;
  }) {
    // Identity minted at bake/define time; live work threads callCtx per-call.
    super();
    this.name = opts.name;
    this.arity = opts.arity;
    this.scope = opts.scope;
    this.#runner = opts.runner;
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // see preamble, toJS IS the membrane
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.__name__ ?? this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: readonly SchemeValue[], callCtx: CallCtx, canBounce = false): CallResult {
    return this.#runner(args, callCtx, canBounce);
  }

  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

_linkNativeHostProjection((self, exit) => hostProjectionOf(self, exit));
_linkRosettaHostProjection((self, exit) => hostProjectionOf(self, exit));

/** Bound DOOR VALUE (errors-as-doors). Resolves like any other binding — bare reference
 *  is legal, only APPLICATION throws. Carries the teaching PurityError. Sibling of
 *  ACallable's other concretes so it fires through the same apply term. */
export class DoorProcedure extends AValue {
  readonly kind = "procedure" as const;
  /** Door fires unconditionally regardless of arg count. `{min: 0, max: null}` names that
   *  honestly and keeps `ACallable.arity` total across every union member. */
  readonly arity: Arity = { min: 0, max: null };

  constructor(readonly door: DoorSymbolDef) {
    // Bound once at capability-assembly; never mints run-tagged output.
    super();
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // Faithful: host-callable that THROWS the same PurityError — crossing does not disarm.
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${this.door.name}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
  ["arrival/tagless-final/apply"](): never {
    const owner = this.door.cause?.owner;
    const message = owner
      ? `${this.door.name} @ ${owner} is not available.\n  Why: ${this.door.reason}`
      : `${this.door.name} is not available.\n  Why: ${this.door.reason}`;
    throw new PurityError(message, this.door.name, owner);
  }
}

/** Callable union — concrete classes, not abstract parent. DoorProcedure joins so
 *  is_callable_value stays sound. */
export type ACallable = ALambda | ANativeProcedure | ARosettaProcedure | DoorProcedure;

/**
 * Single invocation seam every callback site routes through — evaluator call-head,
 * R7RS `apply`, every HOF element callback. Dispatches `arrival/tagless-final/apply`
 * when the callee is a callable VALUE. Bare host functions are DOORED.
 * `canBounce` stays false: HOF-applied callbacks are never in tail position.
 *
 * `args` is `readonly SchemeValue[]`. `callCtx` has no default — every remaining
 * `makeCallCtx(runCtx)` is a literal, grep-able confession (real CallCtx with no
 * invocation), not a silent fallback.
 */
export function applyCallback(
  fn: ACallable | null | undefined,
  args: readonly SchemeValue[],
  callCtx: CallCtx,
): MaybePromise<SchemeValue> {
  TypeError.invariant(typeof fn?.[tf("apply")] === "function", () =>
    typeof fn === "function"
      ? "not applicable: bare host function (mint an ANativeProcedure / ARosettaProcedure / hostFnToCallable)"
      : `not applicable: ${fn === null ? "null" : typeof fn === "object" ? "a non-callable value" : typeof fn}`,
  );
  return fn[tf("apply")](args, callCtx, false) as MaybePromise<SchemeValue>;
}
