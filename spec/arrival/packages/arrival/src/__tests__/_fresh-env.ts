// Per-test capability-assembled environments.
//
// STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) retired the realm-singleton
// `global_env`/`user_env` (env-roots.ts) and the ambient bootstrap (`ensureBaseAssembled`/
// `initBridge`) this file used to ride. STAGE C CUT 4 retired `lower()`/`assembleEnv`
// themselves — `envFromCapabilities` (below) is the replacement idiom: `buildVocabulary` a
// capability closure, then flatly `.bind` its `.map` onto a fresh frame — the SAME idiom
// `eval/generator-exec.ts`'s own `ensureInferenceEnvPopulated` uses to populate `inferenceEnv`.
// Three flavors survive, all rebuilt over the self-hosted vocabulary (env/vocabulary.ts,
// env/base-roster.ts):
//
//   • `freshEnv()` — a FRESH, ISOLATED env carrying the FULL base surface (`BASE_ROSTER`: every
//     BASE_PACKS `.scm` capability + the two standalone native extras, transitively reaching
//     every native cluster — env/base-roster.ts's own doc). A private child of the shared,
//     lazily-populated `inferenceEnv` root (env/inference-env.ts) — isolation for the test's OWN
//     `(define …)`s / directly-applied test capabilities, same as before this cut.
//   • `nativeOnlyRoot()` — a FRESH env carrying ONLY the native (JS-implemented) clusters —
//     chars/strings/vectors/bytevectors/equality/numeric/error-objects — and NOTHING from
//     BASE_PACKS (`cons`/`list`/`error`/… absent). The pre-cut `global_env` gave tests exactly
//     this distinction (a migration-pin suite proving "standalone `.apply()`, bypassing
//     `assembleEnv`'s C3 dep-walk, leaves BASE_PACKS-only names genuinely unbound" needs a root
//     that has natives but NOT the base stdlib) — reconstructed here directly from the surviving
//     native pack MODULES (the `NATIVE_PACKS` roster array itself died with `global_env`, its
//     only consumer; the member modules are untouched). NOTE (Stage C Cut 4): since
//     `buildVocabulary` ALWAYS walks a capability's OWN declared `deps` (there is no longer a
//     "standalone, deps unwalked" mechanism at all — that's what `lower().apply()` used to be),
//     this root's "natives but no BASE_PACKS" distinction is purely about WHICH capabilities are
//     in the closure, not about deps being skipped.
//   • `envFromCapabilities(caps, config?)` — bind exactly one capability closure's `Vocabulary`
//     onto a fresh, otherwise-empty frame. The general-purpose replacement for the retired
//     `assembleEnv(env, [cap.lower({evalScheme})])` fixture idiom.
import { AmbientRuntime, type EnvWithInternals, ResolvingAmbient } from "../env/AmbientRuntime.js";
import type { EnvCapability } from "../common/capability.js";
import { buildVocabulary } from "../env/vocabulary.js";
import { BASE_PACKS } from "../env/base-packs.js";
import { inferenceEnv } from "../env/inference-env.js";
import { ensureInferenceEnvPopulated, execInFrame } from "../eval/generator-exec.js";
import chars from "../env/r7rs/chars.js";
import strings from "../env/r7rs/strings.js";
import vectors from "../env/r7rs/vectors.js";
import bytevectors from "../env/r7rs/bytevectors.js";
import equality from "../env/r7rs/equality.js";
import numeric from "../env/r7rs/numeric.js";
import errorObjects from "../env/r7rs/error-objects.js";

// The evaluator injected into pack preludes/define-bake in this file — the SAME internal bake
// seam generator-exec.ts's own private `capabilityEvalScheme` uses, reached here because THIS
// file builds its own scratch vocabularies directly (`buildVocabulary`), independent of
// `execState`'s own tuple.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as AmbientRuntime);

let counter = 0;

/** A fresh, fully-assembled capability env: a private child of the shared `inferenceEnv` root,
 *  carrying the complete self-hosted `BASE_ROSTER` surface. Await once per test (or per file). */
export async function freshEnv(): Promise<ResolvingAmbient> {
  await ensureInferenceEnvPopulated();
  return inferenceEnv.child(`test-env-${++counter}`);
}

/** Bind `caps`' own `Vocabulary` directly ONTO an EXISTING frame (mutating it in place) — the
 *  general-purpose replacement for the retired `cap.lower({evalScheme}).apply(env, undefined as
 *  never)` fixture idiom, for a test that already holds an `env` (typically `freshEnv()`, so
 *  BASE_ROSTER stays resolvable alongside the capability under test) and wants the capability's
 *  own symbols layered onto that SAME object. Rejects exactly when the old `.lower().apply()`
 *  call would have thrown (config validation, FV-locality/forward-reference/provenance-role
 *  bake doors) — now as a rejected Promise (`buildVocabulary` is async) rather than a
 *  synchronous throw, since the config-parse step that used to fire eagerly, synchronously,
 *  inside `lower()` now runs inside `processCapability`'s async walk.
 *
 *  ALSO RUNS EACH CAPABILITY'S OWN `spec.prelude` TEXT, against `env` itself, deps-first
 *  (`Vocabulary.preludes`'s own order) — `buildVocabulary` only COLLECTS prelude text
 *  (`Vocabulary.preludes`); EXECUTING it is `env/assemble-run.ts`'s per-run prelude-pass job in
 *  production, which this fixture doesn't otherwise invoke. Unlike that per-run pass (which
 *  evaluates against a scratch frame DISCARDED after the run — `(define …)` inside prelude TEXT
 *  never persists), this fixture evaluates directly against the CALLER's `env`, so a prelude
 *  `(define …)`/`(define-macro …)` DOES persist here — matching the retired `lower().apply()`'s
 *  own bootstrap-path behavior exactly (`ctx.preludeEvalScope` was `undefined` there too,
 *  falling back to evaluating straight against the real env). A capability whose OWN behavior
 *  is authored as `prelude:` TEXT (not `symbol.define`/`defineSyntax`) — e.g. a hand-rolled
 *  `define-macro` harness — needs exactly this to actually bind anything. */
export async function applyCapability(
  env: AmbientRuntime,
  caps: readonly EnvCapability[],
  config?: object,
): Promise<void> {
  const vocabulary = await buildVocabulary(caps, config, evalScheme);
  const writable = env as EnvWithInternals<ResolvingAmbient>;
  for (const [name, value] of vocabulary.map) writable.bind(name, value);
  for (const [name, value] of vocabulary.preludeOnly) writable.bind(name, value);
  for (const { text } of vocabulary.preludes) {
    await evalScheme(env, text);
  }
}

/** Bind exactly `caps`' own `Vocabulary` (deps walked, C3-ordered — `buildVocabulary` never
 *  skips a declared dep) onto a fresh, otherwise-empty frame — the general-purpose replacement
 *  for the retired `assembleEnv(env, [cap.lower({evalScheme})])` fixture idiom (this file's own
 *  header). `name` seeds the frame's debug label. Prelude text runs too — see
 *  {@link applyCapability}'s own doc for the full model (this is just that function against a
 *  freshly minted frame instead of a caller-held one). */
export async function envFromCapabilities(
  caps: readonly EnvCapability[],
  config?: object,
  name = "test-vocabulary",
): Promise<ResolvingAmbient> {
  const frame = ResolvingAmbient.root(`${name}-${++counter}`);
  await applyCapability(frame, caps, config);
  return frame;
}

/** A fresh env carrying ONLY the native clusters — see this file's own header for why a
 *  BASE_PACKS-free root is a genuinely distinct fixture, not an incidental subset. */
export async function nativeOnlyRoot(): Promise<ResolvingAmbient> {
  return envFromCapabilities(
    [chars, strings, vectors, bytevectors, equality, numeric, errorObjects],
    undefined,
    "test-native-only",
  );
}

/** A fresh env carrying the base-pack surface WITHOUT the native-only shortcut of `freshEnv`'s
 *  inferenceEnv parenting — a private, from-scratch assembly, for a suite that wants its OWN
 *  assembly (not a shared-root child) to apply a pack under test onto directly. Mirrors the
 *  pre-cut `freshEnv`'s own construction exactly: `BASE_PACKS`'s own declared `deps` already
 *  reach `chars`/`strings`/`vectors`/`equality`/`numeric` transitively (env/base-roster.ts's own
 *  finding), but NOT `bytevectors`/`errorObjects` (zero deps of their own, nothing depends on
 *  them) — so this closure is exactly `env/base-roster.ts`'s own `BASE_ROSTER`, not bare
 *  `BASE_PACKS`. */
export async function freshBasePacksEnv(): Promise<ResolvingAmbient> {
  return envFromCapabilities([...BASE_PACKS, bytevectors, errorObjects], undefined, "test-base-packs");
}
