/**
 * Public `exec`/`parse` entry: bridges the reader (reader/parse.ts) to the
 * generator evaluator. Every run resolves through the self-hosted `Vocabulary`
 * (env/vocabulary.ts + env/base-roster.ts). Drives each top-level form through
 * `run()`.
 */
import { AmbientRuntime, isAmbientRuntime, type EnvWithInternals } from "../env/AmbientRuntime.js";
import { buildVocabulary, type Vocabulary } from "../env/vocabulary.js";
import { assembleRun, preludeDefinesOf, vocabularyOf } from "../env/assemble-run.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import { inferenceEnv } from "../env/inference-env.js";
import run, { evaluate, expectValue, type EvalTap } from "./evaluator.js";
import { ArrivalError, AmbientShapeError, isHostRuntimeBug, OutputContractError } from "../errors.js";
import { Resolver } from "./Resolver.js";
import { Capabilities } from "./Capabilities.js";
import { LexicalScope } from "./LexicalScope.js";
import { sealResolutionChain, type CompiledResolutionChain } from "./CompiledResolutionChain.js";
import { StaticValidationError } from "../static-validation/validate-program.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto, SchemeEnv } from "../common/scheme-env.js";
import { parse as readerParse } from "../reader/parse.js";
import { parseProgram, validateAgainstResolution, type ParsedProgram } from "./exec-phases.js";
import { applyMembraneClosure, RunContext, type MembraneClosure } from "../run/RunContext.js";
import { disposeRunContext } from "../run/run-lifecycle.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import { checkReadWriteGuard, type ReadGuard } from "../run/read-guard.js";
import type { ResourcePathLog } from "../run/resource-paths.js";
// TYPE-ONLY (erased — no runtime scheme-zod edge): exec exit contract's schema type.
import type { output as ZodOutputOf, ZodType } from "../common/scheme-zod/index.js";
import type { AListAlike, SchemeValue } from "../values/types.js";
import { toJS } from "../membrane/rosetta.js";

/**
 * INTERNAL BAKE SEAM — not reachable through public ExecOptions. Evaluate parsed
 * `source` against a live `frame`: a Resolver wrapping `frame` alone composes
 * `capabilities = new Capabilities(frame)`, so defines land in `frame` and
 * builtins resolve up its OWN `__parent__` chain.
 *
 * Production seams that need a literal live-frame bake:
 *   - `buildVocabulary`'s Pass-2 `symbol.define`/`defineSyntax` evaluator
 *     (`capabilityEvalScheme` — `frame` is vocabulary.ts's null-rooted bakeEnv)
 *   - `assembleRun`'s per-run prelude pass (`preludeEvalScheme` — `frame` is
 *     assemble-run.ts's discarded preludeScope)
 *
 * `runCtx` reused when supplied (prelude pass threads its own run's handle);
 * absent (define-bake, no run) ⇒ a throwaway one is minted and disposed here.
 */
export async function execInFrame(source: string, frame: AmbientRuntime, runCtx?: RunContext): Promise<unknown[]> {
  const program = await parseProgram(source);
  const runResolver = new Resolver(frame);
  const ownRunCtx = runCtx === undefined;
  const actualRunCtx = runCtx ?? new RunContext({ strict: false });
  try {
    const results: SchemeValue[] = [];
    for (const expr of program.forms) {
      const result = expectValue(
        await run(evaluate(expr, { resolver: runResolver, strict: false, runCtx: actualRunCtx }), {}),
      );
      results.push(result);
    }
    return results.map((v) => applyMembraneClosure(actualRunCtx, () => toJS(v)));
  } finally {
    if (ownRunCtx) await disposeRunContext(actualRunCtx);
  }
}

// Build-time evalScheme — injected into buildVocabulary's Pass-2 define bake.
// Shared across every run of a given tuple; no runCtx to carry.
const capabilityEvalScheme: EvalSchemeInto = (env, source) => {
  if (!isAmbientRuntime(env))
    throw new AmbientShapeError("capability define-bake", "expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};

// Per-run prelude evalScheme — carries THIS run's runCtx so a resource-touching
// prelude verb spawns/reads THIS run's bag.
const preludeEvalScheme: EvalPreludeInto = (env, source, runCtx) => {
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("prelude evalScheme", "expected a concrete AmbientRuntime");
  return execInFrame(source, env, runCtx);
};

export interface ExecOptions {
  /** Run's MODEL-FACING NOTE CHANNEL (run/note-sink.ts). Rides onto
   *  RunContext.notes. A caller that RENDERS an observation (MCP runner) mints
   *  one and drains it after the call; everyone else omits it. */
  notes?: NoteSink;
  /** DISPLAY channel — where the MCP runner's `display` affordance records what
   *  a model asked to see. Arrival binds no display verb; this is the seam a
   *  HOST uses to offer one without the language acquiring an IO surface. */
  display?: DisplaySink;
  /**
   * EnvCapability packs assembled onto the self-hosted base (BASE_ROSTER,
   * folded in automatically). A bare `exec(code)` is the degenerate case
   * (`capabilities` empty — closure is just BASE_ROSTER).
   */
  capabilities?: readonly EnvCapability[];
  /**
   * SHARED CONFIG BAG for `capabilities` (inert without them). ONE object
   * handed to buildVocabulary, which threads it to every capability: each
   * validates its OWN slice against its configuration zod schemas. Reference-
   * shared, never cloned: the SAME raw object reaches a capability's root AND
   * dep appearances, so the closure-walk's identity dedup matches by IDENTITY
   * instead of tripping VocabularyCapabilityConflictError.
   */
  config?: object;
  /**
   * Lexical root the run's top-level defines land in. Pass a persistent
   * {@link LexicalScope} across calls for REPL-style multi-step accumulation;
   * default is a fresh isolated root (LexicalScope.fresh()). Builtins still
   * resolve through the capability base.
   */
  scope?: LexicalScope;
  /**
   * REUSE an existing RunContext (REPL continuity) instead of minting a fresh
   * one. CALLER-owned: exec will NOT dispose it. A bare exec's self-minted
   * RunContext is disposed at this call's end. Also honored by {@link execExpr}.
   */
  runCtx?: RunContext;
  /**
   * Pre-parsed program — skip the reader (parse-once-run-many,
   * {@link parseProgram}). When set, the `code` argument is ignored. The
   * program's READER strictness is its own stamped identity
   * (ParsedProgram.strict); ExecOptions.strict keeps governing the RUN mode.
   */
  program?: ParsedProgram;
  /**
   * MODULE-EVAL RESOLVER PASSTHROUGH — consumed by {@link execExpr} only;
   * exec/execState ignore it. Evaluate through an EXISTING composed Resolver
   * instead of building one from the default base. THE seam `(require …)` uses:
   * a required module's forms must resolve through the SAME scope+capability
   * composition as the requiring program. Obtained via `this.resolver` at the
   * require apply (`runResolverOf`).
   */
  resolver?: Resolver;
  tap?: EvalTap;
  /** Predicate to suppress tap firing for specific nodes (atoms always skipped).
   *  Piped to EvalContext.nodeFilter (evaluator.ts) — domain is full AListAlike. */
  nodeFilter?: (node: AListAlike) => boolean;
  /**
   * Execution-budget signal. When aborted, the trampoline throws at the next
   * iteration boundary. See EvalContext.signal (evaluator.ts) — the 5ms
   * event-loop yield does NOT bound CPU, so `(define (loop) (loop))` needs an
   * external bound for sandbox use.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget (ms). INTERNAL bound: trampoline throws
   * ArrivalError(/budget/) once budgetMs elapses, checked at the same iteration
   * boundary that yields to the event loop. Composable with signal — whichever
   * fires first wins.
   */
  budgetMs?: number;
  /**
   * THE RUN CACHE (run/run-cache.ts). When set, rides onto RunContext.cache and
   * every baked rosetta penetration is intercepted per the mode law
   * (docs/execution.md §MODE-LAW). Unset ⇒ no interception. Session identity
   * (epoch/roster/configDigest) is the session layer's concern, checked BEFORE
   * a cache is handed to a run.
   */
  cache?: RunCache;
  /**
   * THE EFFECT LOG (run/effect-log.ts). When set, rides onto RunContext.effects,
   * arming the burst gather (docs/execution.md §BURST). A SIBLING of cache, not
   * a field on it. Unset ⇒ sink fires immediately. Draining the log is HOST
   * territory; this option only wires the gather.
   */
  effects?: EffectLog;
  /**
   * THE READ GUARD (run/read-guard.ts). When set, rides onto RunContext.reads,
   * arming the read-tracking region + read∩write deferral guard
   * (docs/execution.md §READ-GUARD). Unset ⇒ no tracking. A reads with no
   * writeSetOf armed never crashes — the guard degrades to a no-op.
   */
  reads?: ReadGuard;
  /**
   * Opt-in runtime assert that every CQS path segment is a string (default false).
   * Type-level `ResourcePath` is the law; use this in non-prod harnesses to catch
   * producers that smuggle non-strings past TS. Rides onto RunContext.strictCQSstrings.
   */
  strictCQSstrings?: boolean;
  /**
   * Override the per-run resource-path prior-effect log (run/resource-paths.ts).
   * Default: fresh MemoryResourcePathLog on ordinary mint. Harness spies inject here
   * (same channel as cache/effects/reads). CONSTANT_CTX stays facility-off.
   */
  resourcePaths?: ResourcePathLog;
  /**
   * Host wrap around every membrane interaction (docs/execution.md §REACTIVITY).
   * Rides onto RunContext.membraneClosure. Unset ⇒ identity. Reentrant — a wrap's
   * `work()` may itself cross. Reverse-membrane wrappers close over this run's
   * wrap at mint, so a late JS→Scheme call after exec returns still sees it.
   */
  membraneClosure?: MembraneClosure;
  /**
   * THE EXIT CONTRACT. When supplied, the LAST form's result is validated
   * against this schema at the exit boundary — AFTER toJS unwrap, so the schema
   * describes the plain-JS value exec hands back. A mismatch throws a teaching
   * door naming expected vs got — the outbound twin of define/overridable's
   * validation. Parse RESULT replaces the last element (transforms apply),
   * driving the static return type. Consumed by exec only — execState/execExpr
   * hand back boxed values and perform no exit validation.
   */
  output?: ZodType;
  /**
   * Interpreter-level NIL-TOLERANCE mode. When true, projection ops
   * (car/cdr and friends) applied to null/nil THROW instead of resolving
   * tolerantly to nil. Default false is TOLERANT. Threaded through
   * EvalContext.strict; inference-plane car/cdr (env/fl-interop.ts) read it off
   * ctx.runCtx.strict. A wrong-TYPE arg throws in BOTH modes — tolerance is
   * scoped to absence.
   */
  strict?: boolean;
  /**
   * THE STATIC VALIDATION PASS. `"on"` runs validateProgram over the parsed
   * forms against the sealed chain + session scope after parse, before the
   * first form evaluates; error-tier diagnostics throw ONE StaticValidationError
   * carrying the COMPLETE list. Also opts this run's capability lowering into
   * degradation: "doors".
   *
   * DEFAULT `"off"` (opt-in). exec is the low-level primitive the door/purity/
   * typo LAW suites use to exercise RUNTIME behavior; a global default flip
   * turns law assertions into parse-phase throws. Production entry points
   * (DiscoveryTool.call, runProgram) opt IN by passing `"on"`.
   */
  staticValidation?: "on" | "off";
}

/**
 * COMPLEX tier — "run, get reusable state": boxed, provenance-bearing results
 * PLUS the session handles a caller needs to continue or introspect. Not a
 * membrane crossing — hands boxed state to JS-side tooling (law tests, REPL,
 * arrival-chain). exec (SIMPLE tier) delegates here and unwraps.
 */
export interface ExecState {
  /** Boxed, provenance-bearing results — one per top-level form. */
  readonly values: readonly SchemeValue[];
  /**
   * The run's lexical accumulation handle — the SAME type ExecOptions.scope
   * accepts. When the caller passed scope, this IS that object; when not, it
   * wraps the run's lexicalRoot so a follow-up execState continues the session.
   */
  readonly scope: LexicalScope;
  readonly runCtx: RunContext;
}

/**
 * SHARED SEALED CHAIN, memoized ONCE per {@link Vocabulary} OBJECT (WeakMap so
 * it's GC'd with the tuple's own memo entry). Base symbols are ordinary members
 * of the tuple's map (BASE_ROSTER folded in by execStateViaVocabulary), so this
 * bind loop is costly — amortize across every run sharing the tuple.
 *
 * `chainFrame` is NULL-ROOTED — the ambient species ("I exist before program
 * start and I'm static," never attributed to any run). Exists only to satisfy
 * sealResolutionChain's frame-shaped input; once sealed, `chain` is the only
 * artifact that matters.
 *
 * Per-run cost: obtain the run's OWN lexical scope and wrap this SHARED
 * `{ chainFrame, chain }` in a fresh Capabilities — Resolver composes
 * `scope.lookup ?? capabilities.lookup` as two genuinely separate fields, so
 * nothing a run does ever writes into chainFrame.
 */
const sealedChainByVocabulary = new WeakMap<
  Vocabulary,
  { readonly chainFrame: AmbientRuntime; readonly chain: CompiledResolutionChain }
>();
function sealedVocabularyChain(vocabulary: Vocabulary): {
  readonly chainFrame: AmbientRuntime;
  readonly chain: CompiledResolutionChain;
} {
  let sealed = sealedChainByVocabulary.get(vocabulary);
  if (sealed === undefined) {
    const chainFrame = AmbientRuntime.root("exec-vocabulary") as EnvWithInternals;
    for (const [name, value] of vocabulary.map) chainFrame.bind(name, value);
    const chain = sealResolutionChain(chainFrame);
    sealed = Object.freeze({ chainFrame, chain });
    sealedChainByVocabulary.set(vocabulary, sealed);
  }
  return sealed;
}

/**
 * Fresh per-call lexical scope rooted at the run's prelude-define frame:
 * session → prelude defines → capabilities. Prelude `(define …)` is a main-phase
 * binding; preludeOnly seeds stay unresolvable. A run minted outside assembleRun
 * has no define frame — plain fresh root.
 */
function runRootedScope(runCtx: RunContext): LexicalScope {
  const defines = preludeDefinesOf(runCtx);
  return defines === undefined ? LexicalScope.fresh() : LexicalScope.for(defines.child("session"));
}

/**
 * Parse and execute Scheme code — COMPLEX tier (see {@link ExecState}). EVERY
 * run resolves through the self-hosted, memoized Vocabulary:
 *
 *   1. THE FOLD — `effectiveCapabilities = [...capabilities, ...BASE_ROSTER]`:
 *      caller capabilities FIRST, base stdlib LAST. With no deps edge between
 *      an unrelated user capability and a base pack, C3's root-list tie-break
 *      decides who's bound FIRST. Base LAST ⇒ LOWEST precedence ⇒ processed
 *      FIRST (bindings exist before any user define-bake); user FIRST ⇒ HIGHEST
 *      precedence ⇒ WIN a same-name conflict against a base pack.
 *      See base-roster.ts for the full ordering argument.
 *   2. buildVocabulary — C3 walk, doors, config validation, define-bake (ONCE
 *      per tuple, memoized by closure identity).
 *   3. sealedVocabularyChain — shared, memoized `{ chainFrame, chain }` for this
 *      tuple.
 *   3.5. STATIC VALIDATION (staticValidation: "on") — validateAgainstResolution
 *      BEFORE assembleRun, so an error throws with ZERO prelude effects fired.
 *   4. assembleRun — mints RunContext (or REUSES ExecOptions.runCtx) AND runs
 *      the PER-RUN PRELUDE PASS against it (fresh mint only).
 *   5. Capabilities (wrapping the shared chain) → Resolver → per-form loop.
 *
 * ISOLATION: top-level defines land in scope's env when the caller passes one
 * (REPL continuity), else a FRESH per-call null-rooted scope. Two bare execs do
 * not share top-level defines. Cross-call continuity requires explicit scope
 * (or runCtx reuse).
 *
 * SymbolDeclaration rejects bare `{ fn }` records at the type level — they cannot
 * reach this function.
 */
export async function execState(code: string | SchemeValue, options: ExecOptions = {}): Promise<ExecState> {
  const {
    capabilities,
    config,
    scope,
    runCtx: passedRunCtx,
    program: passedProgram,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    cache,
    effects,
    reads,
    strictCQSstrings,
    resourcePaths,
    notes,
    display,
    membraneClosure,
    strict,
    staticValidation,
  } = options;

  const program = passedProgram ?? (await parseProgram(code, { strict }));

  // THE FOLD — see this function's doc for the ordering rationale. Skipped entirely on the reuse
  // path: a run carries the vocabulary it was spawned against, so re-folding a tuple to rebuild
  // one is redundant. `capabilities`/`config` are SPAWN inputs; a call that already holds a run
  // needs neither.
  const effectiveCapabilities = [...(capabilities ?? []), ...BASE_ROSTER];

  const vocabulary =
    (passedRunCtx === undefined ? undefined : vocabularyOf(passedRunCtx)) ??
    (await buildVocabulary(effectiveCapabilities, config, capabilityEvalScheme));
  const { chainFrame, chain } = sealedVocabularyChain(vocabulary);

  // STATIC VALIDATION — AFTER the chain seals, BEFORE assembleRun's prelude pass.
  // Validation is deliberately BLIND to prelude defines (they are dynamic — a prelude
  // is arbitrary scheme, ruling 2026-08-13): it sees the caller's scope, or an empty
  // fresh one, exactly what is statically knowable pre-run.
  if (staticValidation === "on") {
    const diagnostics = validateAgainstResolution(program, chain, vocabulary.degraded, scope ?? LexicalScope.fresh());
    if (diagnostics.some((d) => d.severity === "error")) throw new StaticValidationError(diagnostics);
  }

  // assembleRun is THE ONE place preludes run — mints RunContext THEN runs the
  // per-run prelude. runCtx: passedRunCtx — REUSE when supplied (tuple-identity
  // invariant; skips re-preluding on a match — see assemble-run.ts).
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx = await assembleRun({
    capabilities: effectiveCapabilities,
    config,
    evalScheme: capabilityEvalScheme,
    evalPrelude: preludeEvalScheme,
    runCtx: passedRunCtx,
    strict,
    signal,
    cache,
    effects,
    reads,
    strictCQSstrings,
    resourcePaths,
    notes,
    display,
    membraneClosure,
  });

  // Fresh scope per call unless the caller opts into continuity. Fresh root is
  // prelude-define-framed; seeds stay out of the walk.
  const lexicalScope = scope ?? runRootedScope(runCtx);
  const runResolver = new Resolver(lexicalScope.env, new Capabilities(chainFrame, chain));

  try {
    const results: SchemeValue[] = [];
    const forms = program.forms;
    const start = budgetMs === undefined ? 0 : performance.now();
    for (const expr of forms) {
      const remaining = budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      let result: SchemeValue;
      const runForm = () =>
        run(
          evaluate(expr, {
            resolver: runResolver,
            tap,
            nodeFilter,
            signal,
            strict: strict ?? false,
            runCtx,
          }),
          { signal, budgetMs: remaining },
        );
      try {
        result = expectValue(await (runCtx.reads ? runCtx.reads.tracker.region(runForm) : runForm()));
      } catch (error) {
        if (error instanceof ArrivalError && error.cause instanceof TypeError && !isHostRuntimeBug(error.cause))
          throw error.cause;
        throw error;
      }
      results.push(result);

      if (runCtx.reads !== undefined && runCtx.effects !== undefined && runCtx.cache?.mode !== "replay") {
        checkReadWriteGuard(runCtx.effects.entries, runCtx.reads.tracker.log, runCtx.reads.writeSetOf);
      }
    }
    return { values: results, scope: runResolver.scope, runCtx };
  } finally {
    // Only THIS call's own (freshly-minted) RunContext is disposed here.
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

/** Short, safe rendering of an arrived value for the exit-contract door's "got …"
 *  clause — same rendering define/overridable's door uses. */
function describeExitValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Short human phrase for the declared output schema, for the door's "expected …"
 *  clause. zod 4's public `.def.type` names the schema's kind; anything
 *  unreadable falls back to a generic phrase. */
function describeExitSchema(schema: ZodType): string {
  const type = (schema as { def?: { type?: string } }).def?.type;
  return typeof type === "string" ? `a value matching the declared ${type} contract` : "the declared output contract";
}

/**
 * SIMPLE tier — THE default exec surface, "run, get JS". Delegates to
 * {@link execState} and fully unwraps each result through {@link toJS} — a true
 * membrane crossing. Outside this function only plain-JS-observable values
 * exist. Callers that need boxed values, the lexical scope, or the run context
 * use {@link execState} directly.
 *
 * RETURN SHAPE: a generic per-form tuple. Caller may assert
 * `const [, users] = await exec<[void, User[]]>(…)` — zero runtime change.
 * When ExecOptions.output is supplied WITHOUT an explicit tuple, the schema's
 * output face drives the LAST element's static type.
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns one plain-JS value per top-level expression
 *
 * @example
 * ```typescript
 * const [result] = await exec("(+ 1 2 3)");  // result = 6
 * const results = await exec("(define x 10) (+ x 5)");  // [undefined, 15]
 * const [, sum] = await exec<[void, number]>("(define x 10) (+ x 5)");
 * const results = await exec("(+ 1 2)", { output: z.number() });  // last: number
 * ```
 */
export async function exec<O extends ZodType>(
  code: string | SchemeValue,
  options: ExecOptions & { output: O },
): Promise<[...unknown[], ZodOutputOf<O>]>;
export async function exec<T extends readonly unknown[] = unknown[]>(
  code: string | SchemeValue,
  options?: ExecOptions,
): Promise<T>;
export async function exec(code: string | SchemeValue, options: ExecOptions = {}): Promise<readonly unknown[]> {
  const state = await execState(code, options);
  const values = state.values.map((v) => applyMembraneClosure(state.runCtx, () => toJS(v)));
  const contract = options.output;
  if (contract !== undefined) {
    // THE EXIT DOOR — outbound twin of define/overridable's validation.
    if (values.length === 0) {
      throw new OutputContractError(describeExitSchema(contract), "no-forms");
    }
    const last = values.length - 1;
    const outcome = contract.safeParse(values[last]);
    if (!outcome.success) {
      const issues = outcome.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      throw new OutputContractError(describeExitSchema(contract), describeExitValue(values[last]), issues);
    }
    values[last] = outcome.data; // parse result — transforms apply
  }
  return values;
}

/**
 * Parse Scheme code without evaluating (delegates to reader/parse.ts).
 * `source` (filename / module path) is stamped onto every produced location,
 * so frames built from these forms read as `file:line` — used by `(require …)`.
 * Pure reader-leaf call — no env consulted.
 */
export async function parse(code: string, source?: string): Promise<SchemeValue[]> {
  return readerParse(code, source);
}

/**
 * Execute a single pre-parsed expression. COMPLEX tier — internal form-at-a-time
 * entry (require, prelude eval); returns one boxed SchemeValue, never unwrapped.
 *
 * `ExecOptions.runCtx` CONTRACT: supplied ⇒ evaluate WITHIN that run — its
 * vocabulary/degraded/capabilityConfigurations, meter, strict, signal, per-run
 * extension registry — reused verbatim, never re-minted, left for the CALLER to
 * dispose. Absent ⇒ standalone throwaway run.
 *
 * Standalone default is VOCABULARY-BEARING: with no resolver and no runCtx, this
 * mints the degenerate BASE_ROSTER tuple (same memoized Vocabulary a bare
 * execState shares) via assembleRun, so the standalone run carries a real
 * vocabulary.
 *
 * require's module-eval loop threads the requiring run's LIVE runCtx so a nested
 * `(require …)` inside a .scm module resolves through the SAME run as its parent.
 */
export async function execExpr(
  expr: SchemeValue,
  {
    resolver,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    cache,
    effects,
    reads,
    strictCQSstrings,
    resourcePaths,
    membraneClosure,
    runCtx: passedRunCtx,
  }: ExecOptions = {},
): Promise<SchemeValue> {
  const runCtxOwned = passedRunCtx === undefined;
  // STANDALONE DEFAULT — degenerate BASE_ROSTER tuple. A passed-resolver caller
  // threads its OWN runCtx alongside it on every sanctioned path, so this only
  // mints fresh when BOTH are absent.
  const runCtx =
    passedRunCtx ??
    (await assembleRun({
      capabilities: BASE_ROSTER,
      evalScheme: capabilityEvalScheme,
      evalPrelude: preludeEvalScheme,
      signal,
      cache,
      effects,
      reads,
      strictCQSstrings,
      resourcePaths,
      membraneClosure,
    }));
  let runResolver = resolver;
  if (runResolver === undefined) {
    const vocabulary = await buildVocabulary(BASE_ROSTER, undefined, capabilityEvalScheme);
    const { chainFrame, chain } = sealedVocabularyChain(vocabulary);
    runResolver = new Resolver(runRootedScope(runCtx).env, new Capabilities(chainFrame, chain));
  }
  // Run axis is SOURCE OF TRUTH once a runCtx exists (mirrors evaluator.ts
  // lambda runner — bodyCtx.signal = callCtx.runCtx.signal).
  const runSignal = runCtx.signal;

  try {
    // Top-level form evaluates to a value, never a bare expander — seal it.
    const value = expectValue(
      await run(
        evaluate(expr, {
          resolver: runResolver,
          tap,
          nodeFilter,
          signal: runSignal,
          runCtx,
        }),
        { signal: runSignal, budgetMs },
      ),
    );
    return value;
  } catch (error) {
    if (error instanceof ArrivalError && error.cause instanceof TypeError) throw error.cause;
    throw error;
  } finally {
    // A passed-in runCtx is CALLER-owned — only a runCtx THIS call minted is torn down.
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

// ── INTERNAL LIVE-FRAME SEAM ────────────────────────────────────────────────
// NOT part of public ExecOptions, NOT barrel-exported. For test harnesses that
// mint their OWN live AmbientRuntime frame, bind bespoke rosettas/resolvers by
// hand, and evaluate directly against that frame — rather than declaring an
// EnvCapability and going through { capabilities }. Production code
// (execState/exec/execExpr above) never uses this seam.
//
// ExecOptionsOverFrame is ExecOptions plus a REQUIRED env — never optional, so
// a caller reaching this seam is always explicit about it.

export type ExecOptionsOverFrame = ExecOptions & { readonly env: SchemeEnv };

/**
 * Lazily bind the full self-hosted BASE_ROSTER vocabulary flatly onto
 * {@link inferenceEnv}, once (memoized). Idempotent-cheap to call unconditionally
 * (every *OverFrame entry does): a frame unrelated to inferenceEnv is unaffected.
 */
let _inferenceEnvPopulated: Promise<void> | undefined;
export function ensureInferenceEnvPopulated(): Promise<void> {
  return (_inferenceEnvPopulated ??= (async () => {
    const vocabulary = await buildVocabulary(BASE_ROSTER, undefined, capabilityEvalScheme);
    const env = inferenceEnv as EnvWithInternals<typeof inferenceEnv>;
    for (const [name, value] of vocabulary.map) env.bind(name, value);
  })());
}

/**
 * COMPLEX tier over a caller-held live frame. env's `__parent__` chain resolves
 * builtins (glass Resolver(env) composition); scope/runCtx reuse are honored
 * exactly like the vocabulary path's execState.
 */
export async function execStateOverFrame(
  code: string | SchemeValue,
  options: ExecOptionsOverFrame,
): Promise<ExecState> {
  const {
    env,
    scope,
    runCtx: passedRunCtx,
    program: passedProgram,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    cache,
    effects,
    reads,
    strictCQSstrings,
    resourcePaths,
    notes,
    display,
    membraneClosure,
    strict,
  } = options;
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("execStateOverFrame", "expected a concrete AmbientRuntime");
  await ensureInferenceEnvPopulated();

  const program = passedProgram ?? (await parseProgram(code, { strict }));
  // eslint-disable-next-line unicorn/no-negated-condition -- provided scope is the live arm; a fresh Resolver(env) is the default
  const runResolver = scope !== undefined ? new Resolver(scope.env) : new Resolver(env);
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx =
    passedRunCtx ??
    new RunContext({
      strict: strict ?? false,
      signal,
      cache,
      effects,
      reads,
      strictCQSstrings,
      resourcePaths,
      notes,
      display,
      membraneClosure,
    });

  try {
    const results: SchemeValue[] = [];
    const forms = program.forms;
    const start = budgetMs === undefined ? 0 : performance.now();
    for (const expr of forms) {
      const remaining = budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      let result: SchemeValue;
      const runForm = () =>
        run(
          evaluate(expr, {
            resolver: runResolver,
            tap,
            nodeFilter,
            signal,
            strict: strict ?? false,
            runCtx,
          }),
          { signal, budgetMs: remaining },
        );
      try {
        result = expectValue(await (runCtx.reads ? runCtx.reads.tracker.region(runForm) : runForm()));
      } catch (error) {
        if (error instanceof ArrivalError && error.cause instanceof TypeError && !isHostRuntimeBug(error.cause))
          throw error.cause;
        throw error;
      }
      results.push(result);

      if (runCtx.reads !== undefined && runCtx.effects !== undefined && runCtx.cache?.mode !== "replay") {
        checkReadWriteGuard(runCtx.effects.entries, runCtx.reads.tracker.log, runCtx.reads.writeSetOf);
      }
    }
    return { values: results, scope: runResolver.scope, runCtx };
  } finally {
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

/** SIMPLE tier over a caller-held live frame. Delegates to
 *  {@link execStateOverFrame} and unwraps through {@link toJS}. */
export async function execOverFrame(
  code: string | SchemeValue,
  options: ExecOptionsOverFrame,
): Promise<readonly unknown[]> {
  const state = await execStateOverFrame(code, options);
  return state.values.map((v) => applyMembraneClosure(state.runCtx, () => toJS(v)));
}

/** Single-form COMPLEX tier over a caller-held live frame — mirrors execExpr,
 *  minus the standalone-default machinery (caller always holds a real frame). */
export async function execExprOverFrame(
  expr: SchemeValue,
  {
    env,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    cache,
    effects,
    reads,
    strictCQSstrings,
    resourcePaths,
    membraneClosure,
    runCtx: passedRunCtx,
  }: ExecOptionsOverFrame,
): Promise<SchemeValue> {
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("execExprOverFrame", "expected a concrete AmbientRuntime");
  await ensureInferenceEnvPopulated();
  const runResolver = new Resolver(env);
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx =
    passedRunCtx ??
    new RunContext({
      signal,
      cache,
      effects,
      reads,
      strictCQSstrings,
      resourcePaths,
      membraneClosure,
    });
  const runSignal = runCtx.signal;
  try {
    const value = expectValue(
      await run(evaluate(expr, { resolver: runResolver, tap, nodeFilter, signal: runSignal, runCtx }), {
        signal: runSignal,
        budgetMs,
      }),
    );
    return value;
  } catch (error) {
    if (error instanceof ArrivalError && error.cause instanceof TypeError) throw error.cause;
    throw error;
  } finally {
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}
