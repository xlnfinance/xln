/**
 * Resolver — the evaluator's name-resolution + scope-construction facade.
 *
 * Holds a {@link LexicalScope} and a {@link Capabilities} base as TWO separate
 * fields; resolution COMPOSES them (`scope.lookup(name) ?? capabilities.lookup(name)`,
 * with keyword/cxr synth wrapping that same composed lookup). Two modes, one
 * code path:
 *
 *   GLASS (custom-env + bare-ctx fallback): no explicit base, so capabilities
 *     wraps the SAME base-linked env the scope wraps. The scope walk already
 *     reaches the base, so the `?? capabilities` half never fires on a hit and
 *     composition collapses to `env_get(env, sym)`.
 *   CUT (default exec path): an explicit assembled base + a null-rooted lexical
 *     root — scope resolves program names, base resolves builtins. The base
 *     propagates verbatim through {@link Resolver.child}.
 *
 * One object to thread: seam wiring (glass vs cut) lives only at the exec
 * entry, not at every evaluator site.
 *
 * IMMUTABILITY: arrival is a pure-dataflow interpreter — `set!` is doored
 * (PurityError). No `assign`/`ref`/`set!` method here; `define` is a frame
 * rebind (let/lambda/letrec/define), not value mutation.
 */
import { AValue } from "../values/primitives/AValue.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { type BindingName, AmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import { LexicalScope } from "./LexicalScope.js";
import { Capabilities } from "./Capabilities.js";
import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import { unboundVariableError } from "../unbound-variable.js";
import { attachOffendingValue } from "../errors.js";
import { tf } from "../values/tagless-final.js";

// c[ad]+r is car/cdr COMPOSITION — the kernel unfolds it by composing each
// receiver's OWN tagless-final car/cdr algebra (innermost letter first),
// threading the run ctx. car/cdr are the 1-step base; cadr…caddddr are deeper
// compositions. Composites inherit the atoms' nil-tolerance (ANil reads
// runCtx.strict), provenance (APair re-stamps), and the totalic "primitive does
// not support car" throw for free.
const CXR_RE = /^c[ad]+r$/;
/** Memoized per name so `(eq? cadr cadr)` holds across two resolution misses —
 *  reference identity IS the equality contract for callables
 *  (ACallable's `arrival/tagless-final/equals`), and `withProvenance` on a
 *  callable is an identity-preserving no-op. */
const cxrCache = new Map<string, ANativeProcedure>();
function cxrUnfold(name: string): ANativeProcedure | undefined {
  if (!CXR_RE.test(name)) return undefined;
  const cached = cxrCache.get(name);
  if (cached !== undefined) return cached;
  const steps = [...name.slice(1, -1)].toReversed(); // innermost (rightmost) letter first
  // Synthesized as ANativeProcedure, never a bare fn. Every invocation route
  // dispatches apply with an EXPLICIT CallCtx, so strict mode never degrades.
  const proc = new ANativeProcedure({
    name,
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: ([arg], callCtx) => {
      // Receivers' car/cdr still take bare runCtx — read it off callCtx so
      // runCtx.strict still resolves (a raw callCtx has no .strict of its own).
      const runCtx = callCtx.runCtx;
      let v: unknown = arg;
      for (const t of steps) {
        const m = (v as Partial<Record<symbol, unknown>> | null | undefined)?.[tf(t === "a" ? "car" : "cdr")];
        // MODEL-REACHABLE door — (cadr 5) is one keystroke away; plain TypeError,
        // not invariant (which would prefix "Invariant failed:" and read like an
        // engine bug). See not-callable doors in evaluator.ts.
        if (typeof m !== "function") {
          throw attachOffendingValue(
            new TypeError(
              `${name}: the ${v instanceof AValue ? v.kind : v == null ? String(v) : typeof v} primitive does not support ${t === "a" ? "car" : "cdr"} (no ${t === "a" ? "arrival/tagless-final/car" : "arrival/tagless-final/cdr"}).`,
            ),
            v,
          );
        }
        v = (m as (...a: unknown[]) => unknown).call(v, runCtx);
      }
      // Walk result is the receivers' own car/cdr algebra output — scheme values
      // by construction; typed unknown by the spine-walk convention.
      return v as SchemeValue;
    },
  });
  cxrCache.set(name, proc);
  return proc;
}

/**
 * Synth tail shared by glass {@link env_get} and composed {@link Resolver.resolve}:
 * after a DIRECT binding miss, synthesize c[ad]+r composition (no env binding —
 * the family IS car/cdr composition over the unified tagless-final algebra).
 * Else throw Unbound.
 *
 * Dotted-path resolution (`foo.bar.baz` sugar → member-walk) is the NAMED
 * negative boundary of `docs/grammar.md §MEMBER-ACCESS` — deliberately
 * unsupported (would side-door both the membrane face and provenance field-step
 * classification). A dotted identifier is not special-cased here, so it resolves
 * as an ordinary (unbound) symbol and hits the unbound-variable door.
 */
function resolveSynth(name: string | symbol, vocabulary: () => Iterable<string | symbol>): AmbientValue | undefined {
  if (typeof name === "string") {
    const cxr = cxrUnfold(name);
    if (cxr !== undefined) return cxr;
  }
  // PLAIN unbound wall + typo suggestions from the caller's ACTUAL vocabulary
  // (thunk — enumerated only on the throwing path). Well-known-but-absent names
  // are declared `symbol.notImplemented` doors that ordinary lookup already finds.
  throw unboundVariableError(String(name), vocabulary());
}

/**
 * Look up a symbol in the environment — raw storage walk, no read-settling
 * (a stored pair is handed back as-is; AmbientRuntime.get owns the quote-on-read
 * face). For keyword symbols (:name), self-evaluates. The single-env glass form;
 * {@link Resolver.resolve} is the composed (cut) form.
 */
export function env_get(env: AmbientRuntime, sym: ASymbol, ctx?: RunContext): AmbientValue | undefined {
  const name = sym.__name__;

  // A keyword (`:name`) is self-evaluating — carries its own apply (ASymbol.ts).
  // Never bindable (this branch always wins over any binding attempt).
  if (typeof name === "string" && name.startsWith(":")) {
    return sym;
  }

  const value = env._lookupWithResolvers(name, ctx);
  if (value !== undefined) {
    return value;
  }

  return resolveSynth(name, () => env.allBoundNames());
}

/** Kind is debug-name metadata; every child is minted identically. */
export type ScopeKind =
  | "lambda"
  | "macro"
  | "syntax"
  | "let"
  | "let*"
  | "letrec"
  | "named-let"
  | "do"
  | "catch"
  | "user";

export class Resolver {
  readonly scope: LexicalScope;
  /** Capability base (builtins/preludes/polyglot resolvers) the scope falls through to. */
  readonly capabilities: Capabilities;

  /**
   * Hold lexical scope and capability base SEPARATELY. WITH explicit
   * `capabilities` (cut) → scope wraps the null-rooted lexical env, capabilities
   * is the assembled base, propagated unchanged to every child. WITHOUT (glass)
   * → `capabilities = new Capabilities(scopeEnv)`, same base-linked env the
   * scope wraps, so composed lookup collapses to one walk. `scope` is memoized
   * per env ({@link LexicalScope.for}) so hygiene's
   * `refFrame(name) === defResolver.scope` identity compare holds.
   */
  constructor(
    scopeEnv: AmbientRuntime,
    capabilities?: Capabilities,
    readonly kind?: ScopeKind,
  ) {
    this.scope = LexicalScope.for(scopeEnv);
    this.capabilities = capabilities ?? new Capabilities(scopeEnv);
  }

  /** Lexical frame env — kept for consumers that still expect `resolver.env`. */
  get env(): AmbientRuntime {
    return this.scope.env;
  }

  /**
   * Full name resolution — throwing, synth-aware lookup (`:key` accessors,
   * c[ad]+r composition) over composed `scope.lookup ?? capabilities.lookup`.
   * Glass collapses to `env_get(env, sym)`. Cut: lexical chain wins for program
   * names, base for builtins; keyword/cxr synth wraps the SAME composed lookup.
   */
  resolve(sym: ASymbol, ctx?: RunContext): AmbientValue | undefined {
    const name = sym.__name__;
    // Keyword (`:name`) is self-evaluating. Single branch covers plain-symbol
    // and call-head fast path (both call resolve()).
    if (typeof name === "string" && name.startsWith(":")) {
      return sym;
    }
    const value = this.lookup(name, ctx);
    if (value !== undefined) return value;
    return resolveSynth(name, () => this.allBoundNames());
  }

  /**
   * Every name this resolver's composed walk could find — lexical chain bindings
   * plus capability base's enumerable vocabulary, de-duplicated. Typo-suggestion
   * source for {@link resolveSynth}'s unbound throw.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>(this.scope.env.allBoundNames());
    for (const name of this.capabilities.allBoundNames()) names.add(name);
    return [...names];
  }

  /**
   * Raw direct-bindings → resolvers → parent walk; `undefined` on miss, no
   * synth. Used by keyword/special-form dispatch, which must distinguish a
   * miss (fall through to string-keyed SPECIAL_FORMS) from a found value.
   */
  lookup(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    return this.scope.lookup(name, ctx) ?? this.capabilities.lookup(name, ctx);
  }

  /**
   * Frame that OWNS `name` for hygiene IDENTITY — walk lexical scope frames,
   * then the capability base. Returns a stable LexicalScope for a lexical owner
   * (so `=== defResolver.scope` compares the captured def frame),
   * Capabilities.globalRoot for an unshadowed builtin, or undefined if unbound.
   * Own bindings only — no resolvers, no synth. NOT a value read and NOT a
   * mutation path.
   */
  refFrame(name: string): LexicalScope | AmbientRuntime | CompiledResolutionChain | undefined {
    return this.scope.refFrame(name) ?? this.capabilities.refFrame(name);
  }

  /**
   * SETTLED value read — bound value of `name` (scope then capabilities),
   * read-settled by AmbientRuntime.get (pair → quote; raw-in-storage doors),
   * resolver-aware, NON-synth, `undefined` on miss (never throws).
   * Used by hygiene's gensym rename to copy a bound value onto its gensym;
   * distinct from {@link resolve} (which synthesizes c[ad]+r and throws on miss).
   */
  lookupSettled(name: BindingName): AmbientValue | undefined {
    return this.env.get(name, { throwError: false });
  }

  /**
   * Fresh nested lexical frame carrying the SAME capability base —
   * `this.capabilities` propagates verbatim (never re-derived from the child
   * env), so the macro/hygiene seam keeps a stable globalRoot across expansion
   * frames. Frame mint is `this.env.child`; this class has no define —
   * evaluator frame-binds go straight through `env.bind`.
   */
  child(name?: string | symbol, kind?: ScopeKind): Resolver {
    return new Resolver(this.env.child(name), this.capabilities, kind);
  }

  /** Whether `name` is bound in THIS frame (not the chain). ≡ `env.has`. */
  has(name: string): boolean {
    return this.env.has(name);
  }

  toString(): string {
    return `#<resolver:${String(this.env.__name__)}>`;
  }
}
