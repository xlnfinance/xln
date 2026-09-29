/**
 * RunContext — the per-run handle, minted once per `exec()` and threaded explicitly as
 * `runCtx`. The run's identity: state CONSTANT for one run, DIFFERING between concurrent runs.
 *
 * Model: docs/execution.md §HERMETIC, §CTX-SPECIES, §CHANNELS — data-local run-state, two
 * ctx species (live-run / CONSTANT_CTX), six channels' arm-subset-wise
 * `X | undefined ⇒ facility off` (resourcePaths alone defaults ON — §CHANNELS).
 * `membraneClosure` is the observation wrap (§REACTIVITY), not a CQS channel.
 * This file is their enforcement site.
 *
 * PLACEMENT TEST for a new field: varies between concurrent runs → here; never → global
 * singleton; within one run by call depth → dynamic-extent holder. Only the first belongs.
 *
 * Parse-time source identity does NOT live here — `SourceLocation` threads as a plain
 * `loc?` argument from Parser to leaf mints, landing on the value's own `.location`.
 */

import type { RunCache } from "./run-cache.js";
import type { DisplaySink, NoteSink } from "./note-sink.js";
import type { EffectLog } from "./effect-log.js";
import type { ReadGuard } from "./read-guard.js";
import { MemoryResourcePathLog, type ResourcePathLog } from "./resource-paths.js";
import { disposeRunContext } from "./run-lifecycle.js";

/** Per-run, per-capability resource store — lazily-produced Resources bag keyed by
 *  EnvCapability object (opaque so this leaf never imports the capability layer).
 *
 *  Filled by `makeCallCtx` on first dispatch of a resource-bearing verb: WeakMap
 *  get-or-compute. Absent ⇒ call `["arrival/get-resources"]` (fed assembly config) and
 *  store. Single-dispatch makes has-then-set the semaphore; concurrent fan-out shares
 *  the stored value/promise. Pending bag replaced in-slot on settle. Disposal is the
 *  capability's job (`onRunContextDispose`), not the store's. */
export type CapabilityResourceStore = WeakMap<object, unknown>;

/** Per-run, per-capability validated configuration — capability object → assembly config.
 *  Opaque keys, same as {@link CapabilityResourceStore}.
 *
 *  FILLED ONCE, eagerly, at mint (`assembleRun` from `Vocabulary.configsByCapability`) —
 *  never grown at dispatch. ReadonlyMap (roster known and finite at mint). Reused-runCtx
 *  REPL passes carry the table their first mint built. Public exec paths are
 *  vocabulary-bearing; only CONSTANT_CTX and the internal live-frame family
 *  (`*OverFrame` / `execInFrame`, generator-exec.ts) carry no table.
 *
 *  Read by makeCallCtx: becomes `this.configuration`; same lookup feeds get-resources.
 *  Keying by the run (not value) — a symbol factory mints one value for every assembly;
 *  per-assembly config on a value-keyed map would clobber (docs/execution.md §CALLCTX). */
export type CapabilityConfigurationTable = ReadonlyMap<object, unknown>;

/**
 * Host wrap around one membrane interaction. `undefined` on the run ⇒ identity
 * (facility off). `T` may be a `Promise` — reverse-membrane wrappers are async.
 *
 * MUST be reentrant: a wrap's `work()` may itself cross (host impl `@`s a
 * borrowed object, a reverse call's body reads a member). Nesting is the law,
 * not a bug.
 *
 * Closed over by reverse-membrane wrappers at mint (`scope.runCtx`) so a late
 * JS→Scheme call after `exec` returns still sees THIS run's wrap.
 */
export type MembraneClosure = <T>(work: () => T) => T;

/** Identity when `runCtx` is missing or the wrap is unset. */
export function applyMembraneClosure<T>(runCtx: RunContext | undefined, work: () => T): T {
  const wrap = runCtx?.membraneClosure;
  return wrap === undefined ? work() : wrap(work);
}

/** Mint a fresh per-run context for one `exec()`. Single birth place.
 *  `capabilityResources` starts empty; filled lazily on first resource-bearing dispatch. */
export class RunContext {
  /** R7RS-strict nil-projection (`car`/`cdr` of nil throws) vs tolerant (yields nil). */
  readonly strict: boolean;
  /** Execution-budget signal — same AbortSignal the trampoline reads. */
  readonly signal: AbortSignal | undefined;
  /** Run cache; `undefined` ⇒ no interception. Armed ⇒ gates record/replay by cache class
   *  (docs/execution.md §MODE-LAW). */
  readonly cache: RunCache | undefined;
  /** Gathered-effect manifest; `undefined` ⇒ sink fires immediately. Armed ⇒ PRIME-run
   *  sink penetrations gather (docs/execution.md §BURST). */
  readonly effects: EffectLog | undefined;
  /** Read-tracking + deferral-guard; `undefined` ⇒ no tracking. Armed ⇒ eval loop wraps
   *  each top-level form and runs the read∩write guard (docs/execution.md §READ-GUARD). */
  readonly reads: ReadGuard | undefined;
  /**
   * Resource-path prior-effect set for CQS (run/resource-paths.ts).
   * Unlike cache/effects/reads (opt-in `undefined` = facility off), ordinary mints
   * always get a fresh {@link MemoryResourcePathLog} so CQS is on by default for
   * live runs. CONSTANT_CTX leaves it `undefined`. Override via ctor or
   * ExecOptions.resourcePaths (harness spy / custom log).
   */
  readonly resourcePaths: ResourcePathLog | undefined;
  /**
   * Opt-in runtime assert that every CQS path segment is a string (default false).
   * Type-level `ResourcePath` is the real law; this is for non-prod harness stress.
   * Threaded from ExecOptions.strictCQSstrings.
   */
  readonly strictCQSstrings: boolean;
  /** Model-facing note channel; `undefined` ⇒ notes dropped. */
  readonly notes: NoteSink | undefined;
  /** Display channel — MCP runner's display affordance. `undefined` ⇒ no display verb
   *  (arrival binds none). */
  readonly display: DisplaySink | undefined;
  /** Per-capability resource store. Every ordinary mint gets a fresh empty WeakMap;
   *  `undefined` ONLY for CONSTANT_CTX (`_noResourceStore`). */
  readonly capabilityResources?: CapabilityResourceStore;
  /** Per-capability configuration table — filled once at construction. `undefined` only
   *  for CONSTANT_CTX and the internal live-frame family. */
  readonly capabilityConfigurations?: CapabilityConfigurationTable;
  /** Vocabulary name→value map this run resolves through when minted via `assembleRun`.
   *  Opaque (`unknown`) so this leaf never imports the env layer. `undefined` only for
   *  CONSTANT_CTX and the internal live-frame family. */
  readonly vocabulary?: ReadonlyMap<string, unknown>;
  /** This tuple's degraded-capability list (same shape as `Vocabulary.degraded`). Opaque. */
  readonly degraded?: readonly unknown[];
  /**
   * Host wrap around every membrane interaction (borrowed-store read, host-fn
   * fire, reverse-membrane re-entry, result egress). `undefined` ⇒ identity.
   * Not a CQS channel — observation, not temporal zoning (docs/execution.md
   * §REACTIVITY). CONSTANT_CTX leaves it unset.
   */
  readonly membraneClosure: MembraneClosure | undefined;

  constructor(
    opts: {
      strict?: boolean;
      signal?: AbortSignal;
      cache?: RunCache;
      effects?: EffectLog;
      reads?: ReadGuard;
      /**
       * Override path log (harness spy). Ordinary mint: fresh MemoryResourcePathLog.
       * CONSTANT_CTX (`_noResourceStore`): undefined unless explicitly supplied.
       * Note: `?? new MemoryResourcePathLog()` — you cannot pass `undefined` to
       * disable on an ordinary mint; use CONSTANT_CTX for facility-off.
       */
      resourcePaths?: ResourcePathLog;
      /** See {@link RunContext.strictCQSstrings}. Default false. */
      strictCQSstrings?: boolean;
      notes?: NoteSink;
      display?: DisplaySink;
      /** Supply seam for configuration table — `assembleRun` is the production caller. */
      capabilityConfigurations?: CapabilityConfigurationTable;
      /** Supplied by `assembleRun` only. */
      vocabulary?: ReadonlyMap<string, unknown>;
      /** Supplied by `assembleRun` only. */
      degraded?: readonly unknown[];
      /** See {@link RunContext.membraneClosure}. */
      membraneClosure?: MembraneClosure;
    } = {},
    /** Internal: `true` for CONSTANT_CTX — no capabilityResources store. Never pass from
     *  an ordinary mint. */
    _noResourceStore = false,
  ) {
    this.strict = opts.strict ?? false;
    this.signal = opts.signal;
    this.cache = opts.cache;
    this.effects = opts.effects;
    this.reads = opts.reads;
    this.strictCQSstrings = opts.strictCQSstrings ?? false;
    this.notes = opts.notes;
    this.display = opts.display;
    this.capabilityConfigurations = opts.capabilityConfigurations;
    this.vocabulary = opts.vocabulary;
    this.degraded = opts.degraded;
    this.membraneClosure = opts.membraneClosure;
    // eslint-disable-next-line unicorn/no-negated-condition -- resource-store init is the live path; _noResourceStore is the hermetic opt-out
    if (!_noResourceStore) {
      this.capabilityResources = new WeakMap<object, unknown>();
      this.resourcePaths = opts.resourcePaths ?? new MemoryResourcePathLog();
    } else {
      this.resourcePaths = opts.resourcePaths;
    }
  }

  /** Tear down resources scoped to THIS RunContext. Delegates to {@link disposeRunContext}
   *  — same idempotent function REPL hosts and exec's owned-runCtx finally call.
   *  CONSTANT_CTX inherits it; registry-keyed dispose is a no-op when nothing registered. */
  async [Symbol.asyncDispose](): Promise<void> {
    return disposeRunContext(this);
  }
}

/**
 * Run-NEUTRAL context (docs/execution.md §CTX-SPECIES). Carried by values that outlive
 * any single run: singletons, quoted-literal AST nodes, bootstrap-time construction.
 * Frozen, strict=false, all channels undefined — a value minted here cannot
 * carry one run's state into another.
 */
export const CONSTANT_CTX: RunContext = Object.freeze(new RunContext({}, true));
