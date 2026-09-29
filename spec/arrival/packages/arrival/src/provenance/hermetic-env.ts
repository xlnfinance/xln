/**
 * Hermetic assembler for replay: γ applies a wire lambda to recorded ingress
 * under region discipline. Composition of `assembleRun` / `execState` /
 * `LexicalScope` over the self-hosted vocabulary path — not a second env stack.
 *
 *   1. `assembleRun` mints `RunContext` over `basePacks` as the function argument
 *      (tape decides roster). This module never folds `BASE_ROSTER` — callers that
 *      need standard base (`gamma.ts` / `replay.ts` / `replay-walk.ts`) fold it
 *      into `basePacks` at their own call site (`env/base-roster.ts`).
 *   2. Fresh `LexicalScope.fresh()` root — isolation; top-level lexical home for
 *      replayed defines (not the ambient/vocabulary map).
 *   3. PRELUDE — pure top-level defines as source (`buildPreludeSource`), evaluated
 *      via `execState` into that root scope as REAL bindings. Capability-prelude
 *      discard discipline from `assembleRun` is wrong here: wires must resolve
 *      prelude names as ordinary bindings for the whole base lifetime.
 *   4. Ingress binds into the SAME root AFTER prelude (ingress wins on collision).
 *      Multi-wire callers (`applyWireInEnv`, graph replay) pass `{}` and bind
 *      per-wire in child scopes so wires never share ingress.
 *
 * Callers MUST partition with `classifyProgramPrelude` / `assertPreludeEligible`
 * first — a port-reaching define must never enter `prelude` (source smuggling).
 */
import invariant from "tiny-invariant";
import { isAmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js";
import { LexicalScope, type LexicalScopeWithInternals, type SessionScope } from "../eval/LexicalScope.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../common/scheme-env.js";
import { assembleRun } from "../env/assemble-run.js";
import { execState, execInFrame } from "../eval/generator-exec.js";
import type { RunContext } from "../run/RunContext.js";

/** Bake seam for basePack `symbol.define` / `defineSyntax` — `execInFrame`, same
 *  internal path as generator-exec's capability bake (no public-exec bootstrap gate). */
const replayEvalScheme: EvalSchemeInto = (env, source) => {
  invariant(isAmbientRuntime(env), "hermeticEnv: expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};

/** Bake seam for basePack `.spec.prelude` via assembleRun's per-run pass. */
const replayEvalPrelude: EvalPreludeInto = (env, source, runCtx) => {
  invariant(isAmbientRuntime(env), "hermeticEnv: expected a concrete AmbientRuntime");
  return execInFrame(source, env, runCtx);
};

/** Recorded port/slot payloads a wire's parameters resolve to — already-boxed
 *  `AmbientValue`s (`.bind`'s honest type), not raw JS. */
export type IngressBindings = Readonly<Record<string, AmbientValue>>;

/**
 * Hermetic handle: reusable `RunContext` (tuple-identity for multi-γ reuse) +
 * root scope. `capabilities`/`config` echoed so subsequent `exec` calls repeat
 * the identical assemble-run reuse tuple.
 */
export interface HermeticEnv {
  readonly runCtx: RunContext;
  readonly scope: SessionScope;
  readonly capabilities: readonly EnvCapability[];
  readonly config?: object;
}

export async function hermeticEnv(
  basePacks: readonly EnvCapability[],
  prelude: string,
  ingress: IngressBindings = {},
  config?: object,
): Promise<HermeticEnv> {
  // Own RunContext (not via execState, which would dispose it at its call's end) —
  // must outlive prelude eval and every later γ against this base.
  const runCtx = await assembleRun({
    capabilities: basePacks,
    config,
    evalScheme: replayEvalScheme,
    evalPrelude: replayEvalPrelude,
  });
  const scope = LexicalScope.fresh("provenance-hermetic-replay") as LexicalScopeWithInternals<SessionScope>;
  // Prelude as ordinary top-level into persistent root (header: non-discarded bindings).
  if (prelude.length > 0) {
    await execState(prelude, { capabilities: basePacks, config, scope, runCtx });
  }
  // Ingress after prelude — wins on name collision.
  for (const [name, value] of Object.entries(ingress)) scope.env.bind(name, value);
  return { runCtx, scope, capabilities: basePacks, config };
}
