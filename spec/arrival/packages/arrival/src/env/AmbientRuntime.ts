import { type ResolverSpec, type SchemeEnv } from "../common/scheme-env.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { Macro } from "../eval/Macro.js";
import type { SchemeValue } from "../values/types.js";
import type { Syntax } from "../eval/Syntax.js";
import invariant from "tiny-invariant";
import { isSchemeValue } from "../membrane/membrane.js";
import { quote } from "../values/values-repr.js";
import { APair } from "../values/primitives/APair.js";
import type { RunContext } from "../run/RunContext.js";
import { unboundVariableError } from "../unbound-variable.js";
import { RawCrossingError } from "../errors.js";
import { INTEROP_BOUNDARY } from "../well-known/symbols.js";

export type BindingName = string | symbol | ASymbol | AString;

/** Anything storable in an environment: SchemeValues plus runtime types (Macro, Syntax, etc).
 *  Bare host functions are NOT ambient — callables are ACallable AValues already inside
 *  SchemeValue. EOF is a reader-internal sentinel, not a binding. */
export type AmbientValue = SchemeValue | Macro | Syntax | AmbientRuntime | RegExp;

function ownProps(obj: object): (string | symbol)[] {
  return [...(Object.keys(obj) as (string | symbol)[]), ...Object.getOwnPropertySymbols(obj)];
}

/** File-local constructor captures — protected ctor is only callable from each class's
 *  static block. {@link AmbientRuntime.root} / {@link AmbientRuntime.child} are the
 *  public-to-internals birth doors. */
let mintPlainFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => AmbientRuntime;
let mintResolvingFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => ResolvingAmbient;

/**
 * Lexical FRAME STORAGE: `__name__` / `__env__` / `__parent__`. One parent-linked chain
 * is a scope. Storage the evaluator's resolution model wraps — NOT the model itself:
 *
 *   - {@link LexicalScope} — let/lambda/letrec frames a program introduces
 *   - {@link Capabilities} — assembled base (builtins / preludes / host resolvers)
 *   - {@link Resolver} — `scope.lookup ?? capabilities.lookup`; the evaluator threads
 *     `EvalContext.resolver`; `resolver.env` is the underlying lexical frame
 *
 * Fallback resolvers live ONLY on {@link ResolvingAmbient}. A plain frame is
 * own-bindings → parent. Production resolvers sit on baked capability roots, so
 * program-introduced frames carry no resolver array. A plain frame parented under a
 * `ResolvingAmbient` still consults that root's resolvers via polymorphic walk.
 *
 * INTERNAL-ONLY (index.ts). Cross-package consumers type against structural `SchemeEnv`
 * (common/scheme-env.ts), never this class. Name is deliberate: not "Scope"
 * ({@link LexicalScope}) or "Frame".
 *
 * HERMETIC FROM JS (docs/environments.md §HERMETIC). `SchemeEnv` is the hermetic JS
 * face — read-only: `get`/`registerResolver`/`list`/`allBoundNames`, no `set`, no
 * `inherit`, no `merge`. Frame birth is {@link AmbientRuntime.child} / {@link AmbientRuntime.root}
 * (and the {@link ResolvingAmbient} overrides). Storage write lives on the prototype at
 * runtime but is **absent from this class type** — a public `LexicalScope.env` does not
 * type `.bind`. Writers extend the declaration at the definition that intends to write
 * (`scope as LexicalScopeWithInternals`, `env as EnvWithInternals`). After that,
 * `.env.bind` / `.bind` is ordinary method use.
 */

/**
 * Privileged write face of a handle that has `.env` (`LexicalScope`, `Resolver`).
 * Extends that handle with {@link EnvWithInternals} on `.env`. Fuse at the
 * definition that intends to write — see {@link LexicalScopeWithInternals}.
 */
export interface LexicalScopeInternals<E extends AmbientRuntime = AmbientRuntime> {
  readonly env: EnvWithInternals<E>;
}

/**
 * A frame extended with the privileged write. `bind` is not on {@link AmbientRuntime}'s
 * type (so a public `.env` cannot call it). Assign at the definition that intends to write:
 *   `const env = parent.child("frame") as EnvWithInternals`
 * Then `env.bind` is in type. Each such annotation is an access site.
 *
 * This is `T & { bind }` — an extension, not a visibility change — so `as EnvWithInternals`
 * overlaps directly.
 */
export type EnvWithInternals<T extends AmbientRuntime = AmbientRuntime> = T & {
  bind(name: BindingName, value: AmbientValue): void;
};
export class AmbientRuntime {
  // Outside the AValue/ArrivalError families (interop-access.ts FAMILY RULEs); own stamp.
  static [INTEROP_BOUNDARY] = true;
  // Module-dup-robust brand for `isAmbientRuntime` — plain STRING key survives Vite HMR
  // multi-instance loads where `instanceof` fails across copies.
  static ["arrival/is-environment"] = true;

  protected constructor(
    // `string | symbol`: merge-frame identity is MERGE (`well-known/symbols.ts`;
    // Syntax.__merge_env__). LexicalScope.kind compares by symbol identity —
    // string coercion would break hygiene. Display sites wrap with `String(...)`.
    public __name__: string | symbol = "anonymous",
    public __env__: Record<string | symbol, AmbientValue> = {},
    public __parent__: AmbientRuntime | null = null,
  ) {}

  static {
    mintPlainFrame = (name, bindings, parent) => new AmbientRuntime(name, bindings, parent);
  }

  /** Null-parent plain frame. Isolated root — no `__parent__`. */
  static root(name?: string | symbol, bindings?: Record<string | symbol, AmbientValue>): AmbientRuntime {
    return mintPlainFrame(name, bindings, null);
  }

  /**
   * Fresh child of this frame. Subtype-preserving: a {@link ResolvingAmbient} parent
   * yields a resolver-capable child; a plain parent yields a plain lexical frame.
   */
  child(
    this: ResolvingAmbient,
    name?: string | symbol,
    bindings?: Record<string | symbol, AmbientValue>,
  ): ResolvingAmbient;
  child(name?: string | symbol, bindings?: Record<string | symbol, AmbientValue>): AmbientRuntime;
  child(
    name: string | symbol = `child of ${String(this.__name__) || "unknown"}`,
    bindings: Record<string | symbol, AmbientValue> = {},
  ): AmbientRuntime {
    return this instanceof ResolvingAmbient
      ? mintResolvingFrame(name, bindings, this)
      : mintPlainFrame(name, bindings, this);
  }

  list(): (string | symbol)[] {
    return ownProps(this.__env__);
  }

  /**
   * Every name bound up the `__parent__` chain, de-duplicated (shadowed names once).
   * Unsorted — caller orders/filters.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>();
    for (let env: AmbientRuntime | null = this; env; env = env.__parent__) {
      for (const name of env.list()) names.add(name);
    }
    return [...names];
  }

  /**
   * One layer before parent. Own bindings win (closer module shadows). Resolver leg
   * lives only on {@link ResolvingAmbient}; plain frame is own → parent.
   */
  _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }

  toString(): string {
    return `#<environment:${String(this.__name__)}>`;
  }

  /**
   * Read face — INVARIANT DOOR (docs/environments.md §HERMETIC): storage is inside the
   * membrane; writers box before {@link AmbientRuntime.bind}. A raw JS scalar on read
   * means a writer bypassed the membrane — teach and refuse, never silently re-box.
   *
   * APair: cycle-mark + quote so host/hygiene reads get DATA the evaluator won't
   * re-evaluate (read-settling, not membrane coercion).
   */
  get(symbol: BindingName, options: { throwError?: boolean; ctx?: RunContext } = {}): AmbientValue | undefined {
    // `:`-prefixed symbols are not bindings; they fall through to the polyglot
    // keyword-accessor resolver (same catchall path as `c[ad]+r`).
    const { throwError = true, ctx } = options;

    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof ASymbol || symbol instanceof AString) {
      name = symbol.valueOf();
    }

    const directValue = this._lookupWithResolvers(name, ctx);
    if (directValue !== undefined) {
      if (directValue instanceof APair) {
        directValue.mark_cycles();
        return quote(directValue);
      }
      assertNotRawInStorage(directValue, name, `environment ${String(this.__name__)}`);
      return directValue;
    }

    if (throwError) {
      // Unbound wall + typo suggestions from THIS chain only. Well-known-but-absent
      // names are capability doors (`symbol.notImplemented`), resolved like any binding.
      throw unboundVariableError(name.toString(), this.allBoundNames());
    }
    return undefined;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.__env__, name);
  }
}

/**
 * THE ONE storage write. Not on {@link AmbientRuntime}'s type — a public `.env`
 * cannot call it. The fused {@link EnvWithInternals} / {@link LexicalScopeWithInternals}
 * extend the declaration with `bind`; `as EnvWithInternals` at the write's
 * definition is the access site.
 *
 * Legitimate writers, restated as FAMILIES (audit S2a):
 *
 *   • evaluator / hygiene frame binds — `define`/let/lambda/letrec/catch, PLUS
 *     `env/macros/macros.ts`'s merge-frame gensym hoist (tagged at its own write site:
 *     an evaluator-frame-family write authored from an env pack file, not an assembly
 *     write — see P6).
 *   • assembly / chain seeding — capability assembly (symbol bind + define-bake Pass 2),
 *     `env/vocabulary.ts`'s bake-env mirror, `env/assemble-run.ts`'s prelude-seed /
 *     prelude-defines binds, `eval/generator-exec.ts`'s chain-frame / inference-env binds.
 *   • replay / γ ingress — `provenance/hermetic-env.ts` and `provenance/gamma.ts` bind
 *     recorded ingress into a fresh hermetic scope under region discipline (the env ⇄
 *     provenance charter, `docs/strata.md` §5); `provenance/replay.ts` playback-frame
 *     op registration binds an already-minted ARosettaProcedure.
 *   • mid-run prelude overlay — `@inhuman.tools/arrival-modules`' `require`/`extension`
 *     surface binds a discarded child prelude scope (R12: invocation survives, reference
 *     does not).
 *   • replay-scope post-hoc bind — `@inhuman.tools/arrival-provenance`'s `buildUneval`
 *     (`analysis/uneval.ts`) binds a finished run's output as `result` on the live
 *     `LexicalScope.env` rather than re-executing it (audit S2b).
 *
 * CARVE-OUTS (in the AmbientValue union, not isSchemeValue):
 *   • `Error` — catch-frame bind of a raised condition (R7RSError extends host `Error`,
 *     not AValue)
 *   • `RegExp` — syntax-rules literal pattern stored as itself
 *
 * Raw JS is refused. Box at the writer (`jsToScheme` / `symbol.value`).
 * Bare host functions are DOORED. Env-resident callables are ACallable values.
 * Replay playback mints ARosettaProcedure before this door.
 *
 * SANCTIONED RAW `__env__` READERS outside this class (audit S2c — the `.get()` door
 * above throws `RawCrossingError` on a raw JS scalar; these three bypass it on purpose):
 *   • `env/vocabulary.ts` — reads the just-bound entry back (`bakeEnv.__env__[name]`)
 *     because vocabulary must hold the chain-lookup SHAPE, and `.get()` would quote a
 *     `APair` for host consumption — the wrong shape here (stated at its own call site).
 *   • `env/assemble-run.ts` / `@inhuman.tools/arrival-modules` — copy a prelude frame's OWN
 *     already-bound names into the run's define frame (stated at each call site).
 *   • `oracle/env.ts` — Σ's static callability probe reads `frame.__env__[id]` directly so
 *     a malformed raw scalar (a writer bug) degrades to "not callable" instead of crashing
 *     introspection; see the sanction comment at that file for why rerouting through
 *     `_lookupWithResolvers` would NOT be behavior-identical (audit S3).
 */
function bind(this: AmbientRuntime, name: BindingName, value: AmbientValue): void {
  const keyName = String(name instanceof ASymbol ? name.__name__ : name instanceof AString ? name.valueOf() : name);

  if (typeof value === "function") {
    throw new TypeError(
      `bind: bare host function refused for "${keyName}" — mint an ANativeProcedure / ARosettaProcedure (hostFnToCallable) instead`,
    );
  }

  if (!isSchemeValue(value) && !(value instanceof Error) && !(value instanceof RegExp)) {
    throw new TypeError(
      `bind: raw JS ${typeof value} refused for "${keyName}" — env storage is inside the membrane; box at the writer (jsToScheme / symbol.value)`,
    );
  }

  let key: string | symbol;
  if (name instanceof ASymbol) {
    key = name.__name__;
  } else if (name instanceof AString) {
    key = name.valueOf();
  } else {
    key = name;
  }
  this.__env__[key as string] = value;
}

Object.defineProperty(AmbientRuntime.prototype, "bind", {
  value: bind,
  writable: false,
  enumerable: false,
  configurable: false,
});

/** JS leaf types that must never surface from inside the membrane. */
function isRawJsScalar(value: unknown): value is string | number | bigint | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

/**
 * Storage membrane door: raw JS scalar on read ⇒ writer bypass. Fires on READ so the
 * message names the binding; fix is always at the writer (docs/environments.md §HERMETIC).
 */
function assertNotRawInStorage(value: unknown, name: string | symbol, where: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("storage", String(name), typeof value, where);
}

/**
 * Resolver-boundary door: a {@link ResolverSpec} must hand back a BOXED scheme value
 * (or membrane primitive), never a raw JS scalar. Shared by the live walk
 * ({@link ResolvingAmbient}) and the sealed chain (eval/CompiledResolutionChain.ts).
 */
export function assertResolvedBinding(value: unknown, name: string | symbol, resolverId: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("resolver", String(name), typeof value, resolverId);
}

/**
 * BAKED-ROOT specialization — the only place fallback resolvers live
 * (docs/environments.md §PRELUDE). Production producers: kernel prelude-scope resolver
 * and pack-declared `EnvCapability.resolvers`. Apply targets stay `ResolvingAmbient`
 * (`.child` preserves parent class, so a capability-augmented base stays resolver-capable).
 *
 * Plain lexical frames are deliberately NOT `ResolvingAmbient` — only the baked capability
 * base is ambient middleware. A glass caller that wants a resolver layer builds that layer
 * as `ResolvingAmbient` explicitly; otherwise a miss falls through to parent.
 */
export class ResolvingAmbient extends AmbientRuntime implements SchemeEnv {
  private readonly __resolvers__: ResolverSpec[] = [];

  static {
    mintResolvingFrame = (name, bindings, parent) => new ResolvingAmbient(name, bindings, parent);
  }

  /** Null-parent resolving frame. Isolated root — no `__parent__`. */
  static override root(name?: string | symbol, bindings?: Record<string | symbol, AmbientValue>): ResolvingAmbient {
    return mintResolvingFrame(name, bindings, null);
  }

  override child(
    name: string | symbol = `child of ${String(this.__name__) || "unknown"}`,
    bindings: Record<string | symbol, AmbientValue> = {},
  ): ResolvingAmbient {
    return mintResolvingFrame(name, bindings, this);
  }

  /** Register a fallback resolver; tried in order when normal lookup fails. */
  registerResolver(resolver: ResolverSpec): this {
    // Fail loud — silent push surfaces later as "cannot read 'resolve'" at lookup.
    invariant(
      resolver != null && typeof resolver.resolve === "function" && typeof resolver.id === "string",
      "registerResolver: resolver must have a string id and a resolve() function",
    );
    if (!this.__resolvers__.some((r) => r.id === resolver.id)) {
      this.__resolvers__.push(resolver);
    }
    return this;
  }

  /** Unregister by id. No-op for unknown id. Production bake/seal does not call this —
   *  `compileResolutionChain` asserts no live resolver remains; prelude uses a discarded
   *  per-run frame (`assembleRun`). */
  unregisterResolver(id: string): this {
    const at = this.__resolvers__.findIndex((r) => r.id === id);
    if (at !== -1) this.__resolvers__.splice(at, 1);
    return this;
  }

  /** Seal-time read for the chain compiler: specs in registration (= C3 apply) order.
   *  Live view — compiler snapshots; callers must not mutate. */
  resolverSpecs(): readonly ResolverSpec[] {
    return this.__resolvers__;
  }

  /**
   * Direct bindings → resolvers → parent. Explicit binding wins over own lazy resolver
   * (pinned override not undone by same-layer catch-all); both win over parent.
   * Resolver returns `undefined` = "not mine" — never a found nil.
   */
  override _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    for (const resolver of this.__resolvers__) {
      const result = resolver.resolve(String(name), ctx);
      if (result !== undefined) {
        assertResolvedBinding(result, name, resolver.id);
        return result as AmbientValue;
      }
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }
}

/**
 * Brand check replacing `instanceof AmbientRuntime`. Vite HMR multi-instance loads make
 * `instanceof` fail across copies; the string brand on the constructor is universal.
 * Inherited by `ResolvingAmbient` via static inheritance.
 */
export function isAmbientRuntime(value: unknown): value is AmbientRuntime {
  if (typeof value !== "object" || value === null) return false;
  const ctor: unknown = Reflect.get(value, "constructor");
  return typeof ctor === "function" && Reflect.get(ctor, "arrival/is-environment") === true;
}
