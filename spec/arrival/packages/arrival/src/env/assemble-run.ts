// assemble-run.ts — `assembleRun`: env-layer free function minting a RunContext from a
// capability-set + shared config via memoized {@link Vocabulary} (`./vocabulary.js`).
// `RunContext` stays a leaf — gains only opaque `vocabulary`/`degraded` fields this
// function fills; vocabulary-aware type narrowing lives here, at the env boundary.
//
// PER-RUN PRELUDE PASS (docs/environments.md §PRELUDE): prelude is per-run system code,
// executed inside RunContext instantiation, every run, C3 order (deps first).
// `Vocabulary.preludes` is already C3-ordered and identity-deduped (diamond DAG once) —
// this function's single pass IS the single-execution law.
//
// Sequence:
//   1. Obtain (or build) the tuple's memoized Vocabulary.
//   2. Mint RunContext (vocabulary/degraded/capabilityConfigurations attached, resource
//      store empty) so a prelude form already has a real run for resources.
//   3. Prelude pass (ruling 2026-08-13, audit B4): a DISCARDED null-rooted SEED frame
//      holds main map then the preludeOnly overlay (caller folds BASE_ROSTER into the
//      tuple so base builtins resolve as ordinary members — never parent-chain
//      fallback); the prelude TEXT evaluates against a child EVAL frame via
//      `opts.evalPrelude` carrying THIS run's runCtx. A `(define …)` lands in the eval
//      frame and is copied into the run's PERSISTENT prelude-define frame — a
//      main-phase binding ("invocation survives, reference does not": preludeOnly
//      names die with the seed; prelude-minted closures keep their captures into it).
//   4. Return the prelude-completed RunContext. Caller roots the user-facing scope at
//      the define frame over the shared Vocabulary chain; never re-runs prelude.
//
// `opts.evalScheme` is BUILD-time (feeds `buildVocabulary` Pass-2 bake, shared across
// runs of this tuple). `opts.evalPrelude` is RUN-time — required iff the closure has
// at least one `.spec.prelude`.
//
// RUNCTX REUSE: `opts.runCtx` supplied ⇒ reuse verbatim (REPL continuity), and the run's OWN
// vocabulary is authoritative — read it with `vocabularyOf`. Assembly is a spawn-time act, so a
// reusing call rebuilds nothing and re-preludes nothing (a second prelude pass would double-fire
// its effects). The caller does not re-supply `(capabilities, config)`: the run it holds already
// carries their product.
import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../common/scheme-env.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import type { ResourcePathLog } from "../run/resource-paths.js";
import { RunContext, type MembraneClosure } from "../run/RunContext.js";
import { buildVocabulary, type Vocabulary } from "./vocabulary.js";
import { type EnvWithInternals, ResolvingAmbient } from "./AmbientRuntime.js";
import invariant from "tiny-invariant";

export interface AssembleRunOptions {
  readonly capabilities: readonly EnvCapability[];
  /** ONE shared config bag — reference-identity dedup across root + dep appearances
   *  (see `ExecOptions.config`, generator-exec.ts). */
  readonly config?: object;
  /** Threaded to `buildVocabulary` for Pass-2 bake — required when any capability
   *  declares `symbol.define`/`defineSyntax` (or a prelude). */
  readonly evalScheme: EvalSchemeInto;
  /** Per-run prelude evaluator — carries this run's `runCtx`. Required iff the tuple's
   *  C3 closure has at least one `.spec.prelude` (runtime fact of the closure). */
  readonly evalPrelude?: EvalPreludeInto;
  readonly strict?: boolean;
  readonly signal?: AbortSignal;
  readonly cache?: RunCache;
  readonly effects?: EffectLog;
  readonly reads?: ReadGuard;
  readonly strictCQSstrings?: boolean;
  /** Override CQS prior-effect log (harness spy). Default: fresh MemoryResourcePathLog. */
  readonly resourcePaths?: ResourcePathLog;
  readonly notes?: NoteSink;
  readonly display?: DisplaySink;
  /** Host wrap around membrane interactions — see RunContext.membraneClosure. */
  readonly membraneClosure?: MembraneClosure;
  /** Reuse an existing RunContext (REPL continuity). The run carries its own vocabulary, so
   *  `capabilities`/`config` are ignored on this path and no prelude re-runs. */
  readonly runCtx?: RunContext;
}

/** The `Vocabulary` a RunContext was spawned against.
 *
 *  A WeakMap rather than a `RunContext` field: `RunContext.vocabulary` is deliberately an opaque
 *  `ReadonlyMap` so the run leaf never imports the env layer (`run/CallCtx.ts`), and the full
 *  `Vocabulary` would break that opacity. Same shape as `sealedChainByVocabulary`'s own memo.
 *
 *  Absent for a RunContext minted outside this function (`CONSTANT_CTX`, the internal live-frame
 *  family) — a reusing caller falls back to assembling from its tuple. */
const vocabularyByRunCtx = new WeakMap<RunContext, Vocabulary>();

export function vocabularyOf(runCtx: RunContext): Vocabulary | undefined {
  return vocabularyByRunCtx.get(runCtx);
}

/** preludeOnly dies with the seed; `(define …)` persists; invocation survives, reference does not. */
const preludeDefinesByRunCtx = new WeakMap<RunContext, ResolvingAmbient>();

export function preludeDefinesOf(runCtx: RunContext): ResolvingAmbient | undefined {
  return preludeDefinesByRunCtx.get(runCtx);
}

export function ensurePreludeDefineFrame(runCtx: RunContext): ResolvingAmbient {
  let frame = preludeDefinesByRunCtx.get(runCtx);
  if (frame === undefined) {
    frame = ResolvingAmbient.root("run-prelude-defines");
    preludeDefinesByRunCtx.set(runCtx, frame);
  }
  return frame;
}

/** Obtain (or build) this tuple's {@link Vocabulary} and mint a fresh `RunContext`
 *  armed with it. `capabilityResources` starts empty (spawn lazily on first dispatch).
 *  `opts.runCtx` supplied ⇒ reuse verbatim: the run already carries its vocabulary, so nothing is
 *  rebuilt and no prelude re-runs. */
export async function assembleRun(opts: AssembleRunOptions): Promise<RunContext> {
  // REUSE — before any assembly. Re-deriving a vocabulary from this call's arguments in order to
  // compare it against the one the run already carries is work whose only product is the chance to
  // disagree with itself.
  if (opts.runCtx !== undefined) return opts.runCtx;

  const vocabulary = await buildVocabulary(opts.capabilities, opts.config, opts.evalScheme);

  // Mint first: prelude pass dispatches through THIS run's runCtx.
  const runCtx = new RunContext({
    strict: opts.strict,
    signal: opts.signal,
    cache: opts.cache,
    effects: opts.effects,
    reads: opts.reads,
    strictCQSstrings: opts.strictCQSstrings,
    resourcePaths: opts.resourcePaths,
    notes: opts.notes,
    display: opts.display,
    membraneClosure: opts.membraneClosure,
    capabilityConfigurations: vocabulary.configsByCapability,
    vocabulary: vocabulary.map,
    degraded: vocabulary.degraded,
  });
  vocabularyByRunCtx.set(runCtx, vocabulary);

  // The run's prelude-define frame exists for EVERY owned mint (even a prelude-less
  // tuple): mid-run `(require/extension …)` may append extension-prelude defines later,
  // and the exec entry roots the user scope here unconditionally.
  const defines = ensurePreludeDefineFrame(runCtx) as EnvWithInternals<ResolvingAmbient>;

  // Per-run prelude (module header). preludes already C3-ordered + identity-deduped.
  if (vocabulary.preludes.length > 0) {
    invariant(
      opts.evalPrelude !== undefined,
      "assembleRun: this tuple's capabilities declare a prelude — AssembleRunOptions.evalPrelude is required",
    );
    // TWO frames (ruling 2026-08-13, audit B4):
    //   SEED — null-rooted, main map bound FIRST then the preludeOnly overlay (on a
    //   cross-capability name collision preludeOnly therefore SHADOWS the main symbol
    //   DURING the prelude pass — the defined rule, pinned by P-PRELUDE-PHASE-SHADOW).
    //   The seed is discarded with the pass; preludeOnly names never reach main-phase
    //   resolution. Closures keep their captures into it — invocation survives.
    //   EVAL — a child the prelude TEXT evaluates against, so its `(define …)`s land
    //   separately from the seed; after the pass they are copied into the run's
    //   persistent define frame and become main-phase bindings.
    const preludeSeed = ResolvingAmbient.root("assemble-run-prelude-seed") as EnvWithInternals<ResolvingAmbient>;
    for (const [name, value] of vocabulary.map) preludeSeed.bind(name, value);
    for (const [name, value] of vocabulary.preludeOnly) preludeSeed.bind(name, value);
    const preludeScope = preludeSeed.child("assemble-run-prelude");
    for (const { text } of vocabulary.preludes) {
      await opts.evalPrelude(preludeScope, text, runCtx);
    }
    // Persist the pass's defines. Own-record read, sanctioned here: `list()` is the
    // frame's OWN names and the values were bound through `.bind` (already boxed) —
    // same boundary narrow vocabulary.ts documents for its own raw reads.
    for (const name of preludeScope.list()) {
      defines.bind(name, preludeScope.__env__[name]!);
    }
  }

  return runCtx;
}
