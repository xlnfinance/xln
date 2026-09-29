/**
 * AOpaqueHandle — scheme-side face of a host class instance crossing the membrane under
 * the `@arrival.private`/`markInteropPrivate` brand (membrane/interop-access.ts's
 * `INTEROP_BOUNDARY`). OPAQUE-CROSSING CONTRACT:
 *
 *   - a rosetta impl RETURNING a branded instance (or one riding inside a returned
 *     container) crosses scheme-ward as ONE OF THESE — identity-preserving, printable
 *     as its class face (`#<McpServer>`), and exposing NOTHING structurally (no reader
 *     term is declared here, so `(:field handle)` doors with a TypeError naming the
 *     "opaque" kind — same as any value with no member protocol; the class's OWN
 *     existing seal already blocks prototype reads, and this leaf adds no members);
 *   - the SAME handle arriving as a rosetta impl ARG (directly, or inside a container)
 *     UNWRAPS back to the raw instance at the next rosetta penetration — `arrival/toJS`
 *     below IS that unwrap, for every membrane exit uniformly (membrane/rosetta.ts for
 *     the scheme-ward mint; `z.instance`-codec / dynamic-slot-unwrap sibling in
 *     common/scheme-zod.ts / common/symbols/rosetta.ts for the host-ward direction);
 *   - round-trip: out then in is the SAME instance (`===`, never a copy — `.instance` is
 *     held by reference, never cloned).
 *
 * An UNbranded class instance is UNCHANGED by this file — it still borrows as an
 * AJSObject (rosetta.ts's "exotic object" inbound claim); the brand is the opt-in,
 * never ambient.
 *
 * IDENTITY, run-scoped (not global): `AOpaqueHandle.for` keys its mint-or-reuse cache by
 * `(RunContext, instance)`, not `instance` alone. `.provenance` (inherited from `AValue`)
 * carries this handle's crossing origin as call-ids MINTED BY ONE RUN's own invocation
 * numbering (RunContext.ts PLACEMENT TEST: anything that varies between concurrent runs
 * belongs run-scoped) — a global cache would let a handle minted under run A accumulate
 * provenance points from run B onto the SAME JS object, and those ids mean nothing (or
 * something ELSE) under run A's numbering. Within one run, "same instance -> same handle"
 * holds by construction; a DIFFERENT run wrapping the same host object gets its OWN handle.
 *
 * `eq?`/`equal?` IDENTITY, independent of the cache: `arrival/tagless-final/equals`
 * compares `.instance` (the wrapped object), never `this === other`. Same "clone still
 * eq?" discipline structural-equal.ts documents for ASymbol/ANil/ACharacter/AExact/
 * AInexact/ABool (the provenance-clone trap: `withProvenance` mints a new wrapper on
 * every re-stamp, per AValue's immutability rule, so two independently-minted handles
 * over the SAME instance must still compare `eq?` true) — structural-equal.ts's `eq()`
 * routes `AOpaqueHandle` through this Setoid rather than pointer-grade `===`.
 */
import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "./AValue.js";
import { type RunContext } from "../../run/RunContext.js";

/** Run-scoped mint-or-reuse cache: `(RunContext, raw instance) -> its ONE canonical
 *  handle within that run`. See preamble for why run-scoped, not global. */
const HANDLE_CACHE = new WeakMap<RunContext, WeakMap<object, AOpaqueHandle>>();

export class AOpaqueHandle extends AValue {
  readonly kind = "opaque" as const;

  /** The raw host instance this handle wraps. Never read by a scheme-side reader term
   *  (none is declared — absence IS the seal: no `arrival/tagless-final/get` means
   *  `(:field handle)` doors with a `TypeError` naming the "opaque" kind — AKeywordSymbol's
   *  own B2 rule for any receiver that isn't nil-shaped and declares no member protocol —
   *  rather than silently answering nil, which would look like "a real field that happens
   *  to be absent" instead of "this value has no fields at all"). Read only by the
   *  membrane's own host-ward unwrap (`arrival/toJS` below) and by `scheme-zod.ts`'s
   *  `instance(Ctor)` codec decode. */
  readonly instance: object;

  /** The class face, printed as `#<ClassName>` — `instance.constructor.name`, falling back
   *  to `"Object"` for a null-prototype/anonymous instance (mirrors membrane/typecheck.ts's
   *  own `foreign:<CtorName>` fallback posture, minus the `foreign:` prefix — this face is
   *  a DELIBERATE, branded exotic, not a leak). */
  readonly className: string;

  private constructor(instance: object, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
    this.instance = instance;
    this.className = (instance as { constructor?: { name?: string } }).constructor?.name || "Object";
  }

  /**
   * Mint-or-reuse — the ONE constructor path (the private ctor above forces every handle
   * through here). `ctx` scopes identity to ONE run (see preamble); `instance` is the raw
   * host object; `provenance` is THIS crossing's origin, MERGED (never replacing —
   * AValue.ts's additive law) onto whatever the cached handle already carries. A merge
   * that changes nothing returns the cached handle UNCHANGED (no allocation); a merge that
   * adds an id mints a fresh wrapper and becomes the new cached canonical — `eq?`/`equal?`
   * stay true across either case (the Setoid override compares `.instance`, not wrapper
   * identity).
   */
  static for(ctx: RunContext, instance: object, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AOpaqueHandle {
    let byInstance = HANDLE_CACHE.get(ctx);
    if (byInstance === undefined) {
      byInstance = new WeakMap();
      HANDLE_CACHE.set(ctx, byInstance);
    }
    const cached = byInstance.get(instance);
    if (cached === undefined) {
      const handle = new AOpaqueHandle(instance, provenance);
      byInstance.set(instance, handle);
      return handle;
    }
    if (provenance === EMPTY_PROVENANCE || provenance === cached.provenance) return cached;
    const merged = mergeProvenance(cached.provenance, provenance);
    if (merged === cached.provenance) return cached;
    const restamped = new AOpaqueHandle(instance, merged);
    byInstance.set(instance, restamped);
    return restamped;
  }

  toString(): string {
    return `#<${this.className}>`;
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  /** THE UNWRAP — host-ward crossing. A leaf, like AVoid/ABytevector: ignores `exit`
   *  entirely (nothing to recurse into) and answers the raw instance directly — the
   *  handle's whole membrane face IS the wrapped object ("arrival/toJS on a semi-opaque
   *  = the instance itself — host gets the live object, it IS host JS"). Every
   *  `toJS`/`egressAValue` call (reverse-membrane results, nested container elements)
   *  unwraps through this ONE term uniformly. `symbol.rosetta` decode does not route args
   *  through `toJS` (codec vocabulary) — it has its own unwrap chokepoint; see
   *  `buildOpaqueHandleUnwrap` and scheme-zod's `instance(Ctor)`. */
  ["arrival/toJS"](): unknown {
    return this.instance;
  }

  /** Re-stamp — mints a NEW wrapper (AValue's ordinary immutability rule: a provenance
   *  update never mutates in place). NOT the identity a program should test with `===`
   *  after a re-stamp; see preamble for why `eq?`/`equal?` stay sound anyway. */
  withProvenance(p: ReadonlySet<number>): AOpaqueHandle {
    return new AOpaqueHandle(this.instance, p);
  }

  /** Setoid — identity of the WRAPPED instance, not of the wrapper. `structuralEqual`'s
   *  generic Setoid dispatch routes `equal?` here too: there is nothing to compare
   *  structurally on a value that declares no members, so `equal?` and `eq?` agree. */
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AOpaqueHandle && other.instance === this.instance;
  }
}
