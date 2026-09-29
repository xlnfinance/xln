import type { AmbientRuntime, AmbientValue } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";
import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import { INTEROP_BOUNDARY } from "../well-known/symbols.js";

/**
 * The CAPABILITY base — the builtins/preludes/host-supplied resolvers a run is
 * armed with. This is the shared root
 * that a {@link LexicalScope} falls through to: lexical names resolve in the
 * frame chain, everything else (car, map, `:key` accessors, the polyglot
 * resolvers) resolves here.
 *
 * GLASS mode: the lexical chain and the capability base are the SAME
 * `__parent__`-linked env, so this wraps it and keeps the LIVE walk (glass envs
 * don't bake — embedder-controlled mutability is a feature).
 * ASSEMBLED mode: the base is a SEALED artifact — a {@link CompiledResolutionChain} —
 * and `lookup` consults it instead of walking the env chain (zero live resolvers ⇒
 * ONE flat `Map.get`).
 * Either way the hygiene engine consults `globalRoot` (the unshadowed-builtin
 * identity, a STABLE singleton so `=== globalRoot` survives a topology change)
 * and `refFrame` (does the base OWN this name).
 */
export class Capabilities {
  // Interop boundary: Capabilities sits outside the AValue/ArrivalError families
  // the FAMILY RULEs in interop-access.ts cover, so it carries its own explicit
  // stamp.
  static [INTEROP_BOUNDARY] = true;

  /**
   * ASSEMBLED mode only — the sealed ambient artifact this base resolves through.
   * `undefined` ⇒ GLASS (live walk). This artifact IS `globalRoot`/`refFrame`'s
   * ASSEMBLED-mode return value — the "Frame vs BakedBase" type split's one
   * consequential frontier. `CompiledResolutionChain` **is** BakedBase: sealed at
   * bake, no `set`, no write surface — the write-window is a TYPE fact (BakedBase's
   * type has no mutator), not a convention. One identity per baked base: the
   * sentinel IS the artifact object itself, not a leaf env that merely stands in
   * for it.
   */
  private readonly chain: CompiledResolutionChain | undefined;

  /**
   * @param env  the base leaf this wraps (glass: the scope env; assembled: the base top).
   * @param chain  ASSEMBLED mode — the sealed resolution chain; `lookup`/`refFrame`
   *   consult it and `globalRoot` is the stable `env` sentinel. Absent (GLASS,
   *   default): the structural `chainRoot` probe over the live walk.
   */
  constructor(
    readonly env: AmbientRuntime,
    chain?: CompiledResolutionChain,
  ) {
    this.chain = chain;
  }

  /** The raw base bindings lookup (`undefined` on a miss, no synth) — the capability
   *  half of the Resolver's composed `scope.lookup(name) ?? capabilities.lookup(name)`.
   *  Glass: walks this scope's whole live `__parent__` chain (the lexical half never
   *  reaches here on a hit). Assembled: ONE probe of the sealed chain — the degenerate
   *  zero-resolver form is a single flat `Map.get`. */
  lookup(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    return this.chain === undefined ? this.env._lookupWithResolvers(name, ctx) : this.chain.lookup(name, ctx);
  }

  /** The base's enumerable VOCABULARY — assembled: the sealed chain's merged static
   *  `names` (resolver-synthesized names deliberately absent, per the chain's own
   *  contract); glass: the live `__parent__`-chain enumeration. The typo-suggestion
   *  source for the Resolver's unbound-variable throw. */
  allBoundNames(): Iterable<string | symbol> {
    return this.chain === undefined ? this.env.allBoundNames() : this.chain.names;
  }

  /** The capability base = the chain root, found structurally as the
   *  parent-less top of this scope's chain rather than by an env-roots import (which would
   *  cycle through the early-loaded eval modules). The hygiene literal check compares a
   *  resolved frame `=== globalRoot` to mean "an unshadowed base builtin"; the root is a
   *  stable identity across the scope's lifetime. GLASS mode only. */
  private chainRoot(): AmbientRuntime {
    let e: AmbientRuntime = this.env;
    while (e.__parent__) e = e.__parent__;
    return e;
  }

  /**
   * The stable "unshadowed base builtin" sentinel hygiene compares `=== globalRoot`.
   * ASSEMBLED: the sealed `CompiledResolutionChain` itself — the BakedBase artifact —
   * ONE identity per baked base, no structural chain-walk needed. GLASS: the
   * structural chain root, unaffected — glass envs don't bake.
   */
  get globalRoot(): AmbientRuntime | CompiledResolutionChain {
    return this.chain === undefined ? this.chainRoot() : this.chain;
  }

  /**
   * The base's claim on `name`, as the `globalRoot` sentinel (or `undefined`). ASSEMBLED:
   * ONE sealed-chain probe (merged maps + resolver steps — a
   * resolver-answered name counts as base-owned, exactly like the live
   * `_lookupWithResolvers` probe it replaces); a hit returns the CHAIN OBJECT itself
   * (the same one `globalRoot` returns), so a native owned on the base leaf and a
   * builtin on the structural root both resolve to the one sentinel. GLASS: the
   * own-binding probe on the structural chain root (unchanged).
   */
  refFrame(name: string): AmbientRuntime | CompiledResolutionChain | undefined {
    if (this.chain === undefined) {
      const root = this.chainRoot();
      return root.has(name) ? root : undefined;
    }
    return this.chain.lookup(name) === undefined ? undefined : this.chain;
  }

  toString(): string {
    return `#<capabilities:${String(this.env.__name__)}>`;
  }
}
