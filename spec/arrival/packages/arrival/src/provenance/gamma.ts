/**
 * γ = `hermeticApply(wire, ingress)`: apply the wire lambda to recorded ingress
 * in a hermetic env under a SILENT region (doors/discipline on, stream emission
 * off). Named composition, not new machinery:
 *
 *   1. `hermeticEnv` — base packs + program prelude + ingress on fresh
 *      `RunContext`/`LexicalScope`;
 *   2. `withSilentRegion` over the whole apply;
 *   3. textual application `` `(${wire.source} ${params…})` `` — wire params
 *      already bound by name into the hermetic root scope.
 *
 * Wire-locality (checked at emission by `unevalWire`) guarantees
 * `FV(body) ⊆ params ∪ prelude ∪ hermetic-base`. This runner relies on that
 * closure; it does not re-verify it.
 */
import invariant from "tiny-invariant";
import { exec, execState } from "../eval/generator-exec.js";
import type { EnvCapability } from "../common/capability.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import type { SchemeValue } from "../values/types.js";
import { withSilentRegion } from "../membrane/region-scope.js";
import { hermeticEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
import type { LexicalScopeWithInternals } from "../eval/LexicalScope.js";
import { IngressBindingError } from "../errors.js";
import type { EmittedWire } from "./wireframe/types.js";

/** Wire + name-keyed ingress (never positional — params are `unevalWire` port/slot
 *  names) + hermetic static layers. `basePacks`/`prelude` required, never defaulted:
 *  a forgotten prelude replays against the wrong static layer. */
export interface HermeticApplyOptions {
  readonly wire: EmittedWire;
  readonly ingress: IngressBindings;
  readonly basePacks: readonly EnvCapability[];
  readonly prelude: string;
  readonly config?: object;
}

/**
 * γ under silent region. Returns peeled egress (`exec` → plain JS) for comparison
 * with recorded mint payloads (`apply(wire, recorded ingress) === recorded egress`).
 *
 * Missing ingress for a declared param is a caller bug — fails here via
 * `IngressBindingError`, not as an opaque unbound-variable deep in `exec`.
 */
export async function hermeticApply(opts: HermeticApplyOptions): Promise<unknown> {
  const { wire, ingress, basePacks, prelude, config } = opts;
  assertIngressCovers(wire, ingress);
  return withSilentRegion(async () => {
    // Standard-base fold is THIS call site's job — `hermeticEnv` never hardcodes
    // `BASE_ROSTER` (see that module). Live ambient always inherited full base.
    const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], prelude, ingress, config);
    // Apply wire lambda to its own params by name — already bound in hermetic scope.
    // `capabilities`/`config`/`runCtx` match the assemble-run reuse-identity tuple.
    const [egress] = await exec(wireApplication(wire), {
      capabilities: base.capabilities,
      config: base.config,
      scope: base.scope,
      runCtx: base.runCtx,
    });
    return egress;
  });
}

// ── Boxed γ face (replay walks many wires against one prebuilt base) ─────────
// `hermeticApply` peels for value equality. Laws that need provenance stamps use
// `applyWireInEnv`: same apply idiom, boxed `SchemeValue`, caller owns silent
// region + one hermetic base, per-wire child-scope ingress.

function assertIngressCovers(wire: EmittedWire, ingress: IngressBindings): void {
  for (const name of wire.params) {
    if (!Object.hasOwn(ingress, name)) throw new IngressBindingError(wire.span, name);
  }
}

function wireApplication(wire: EmittedWire): string {
  return wire.params.length > 0 ? `(${wire.source} ${wire.params.join(" ")})` : `(${wire.source})`;
}

/**
 * γ against a prebuilt hermetic base; returns BOXED egress (provenance intact).
 * Caller owns silent region (one wrap per graph walk) and the base (empty ingress).
 * Each call binds this wire's ingress in a FRESH child of `base.scope`.
 * Reuses `runCtx` + the same capabilities/config tuple `hermeticEnv` minted.
 */
export async function applyWireInEnv(
  base: HermeticEnv,
  wire: EmittedWire,
  ingress: IngressBindings,
): Promise<SchemeValue> {
  assertIngressCovers(wire, ingress);
  const wireScope = base.scope.child(`gamma-wire-${wire.span}`) as LexicalScopeWithInternals<typeof base.scope>;
  for (const [name, value] of Object.entries(ingress)) wireScope.env.bind(name, value);
  const state = await execState(wireApplication(wire), {
    capabilities: base.capabilities,
    config: base.config,
    scope: wireScope,
    runCtx: base.runCtx,
  });
  const boxed = state.values.at(-1);
  invariant(boxed !== undefined, "applyWireInEnv: a wire application evaluates exactly one form — exec returned none");
  return boxed;
}
