// assemble-run.test.ts — Stage B2 (docs/plans/stage-b-runcontext-absorbs-assembly.md): the
// PER-RUN PRELUDE PASS on the vocabulary path. `env/vocabulary.ts`'s `buildVocabulary` only
// COLLECTS `.spec.prelude` text (C3-ordered, identity-deduped); `env/assemble-run.ts`'s
// `assembleRun` is where it now EXECUTES — once per RunContext, THIS run's runCtx threaded
// through every prelude form, so a resource-touching prelude verb spawns/reads THIS run's bag.
//
// `vocabulary.test.ts` (B1) covers `buildVocabulary` itself (C3 precedence, doors,
// preludeOnly SEPARATION, define bake, memo identity, prelude COLLECTION dedup) — this file is
// the EXECUTION-side proof: single-execution-per-run, preludeOnly overlay visibility +
// lexical-capture, prelude-define discard, and per-run effect freshness.
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../../common/scheme-env.js";
import { buildVocabulary } from "../vocabulary.js";
import { assembleRun } from "../assemble-run.js";
import { exec, execInFrame } from "../../eval/generator-exec.js";
import { isAmbientRuntime, ResolvingAmbient, type EnvWithInternals } from "../AmbientRuntime.js";
import { UnboundVariableError } from "../../errors.js";
import type { SchemeValue } from "../../values/types.js";
import { ACallable, applyCallback } from "../../values/primitives/ACallable.js";

/** The REAL evalScheme, required whenever a fixture declares a `symbol.define` — mirrors
 *  `generator-exec.ts`'s own private `capabilityEvalScheme`: the internal bake seam, never the
 *  public exec surface. */
const realEvalScheme: EvalSchemeInto = (env, src) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env);
};

/** The REAL per-run prelude evalScheme — mirrors `generator-exec.ts`'s own private
 *  `preludeEvalScheme`: threads THIS run's `runCtx` through every prelude form's dispatch. */
const realEvalPrelude: EvalPreludeInto = (env, src, runCtx) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env, runCtx);
};

describe("assembleRun — the diamond-DAG single-execution-per-run law", () => {
  // INVARIANT: a capability reachable through two DAG edges (left/right, both depending on the
  // SAME `shared`) runs `shared`'s prelude EXACTLY ONCE per RunContext — `Vocabulary.preludes`'
  // own collection dedup (B1) is what makes this fall out of a single pass, not a separate
  // execution-side dedup mechanism.
  it("a capability reachable via two DAG edges runs its prelude ONCE per run; a second run gets its own fresh count", async () => {
    const shared = EnvCapability.define("test/prelude-diamond-shared", {
      resources: (): { count: number } => ({ count: 0 }),
      prelude: "(prelude/bump!)",
      symbols: (symbol, sz) => ({
        "prelude/bump!": symbol.rosetta`prelude/bump!: bump this run's counter`(
          { input: [], output: [sz.string], preludeOnly: true },
          function () {
            this.resources.count += 1;
            return "ok";
          },
        ),
      }),
    });
    const left = EnvCapability.define("test/prelude-diamond-left", { deps: [shared], symbols: () => ({}) });
    const right = EnvCapability.define("test/prelude-diamond-right", { deps: [shared], symbols: () => ({}) });
    const top = EnvCapability.define("test/prelude-diamond-top", { deps: [left, right], symbols: () => ({}) });

    const runA = await assembleRun({
      capabilities: [top],
      evalScheme: realEvalScheme,
      evalPrelude: realEvalPrelude,
    });
    expect((runA.capabilityResources?.get(shared) as { count: number }).count).toBe(1);

    // A SECOND RunContext from the SAME tuple: the memoized Vocabulary is shared, but prelude
    // EFFECTS are per-run — a fresh resource bag, freshly bumped to 1, never accumulating across
    // runs.
    const runB = await assembleRun({
      capabilities: [top],
      evalScheme: realEvalScheme,
      evalPrelude: realEvalPrelude,
    });
    expect((runB.capabilityResources?.get(shared) as { count: number }).count).toBe(1);
    expect(runA.capabilityResources?.get(shared)).not.toBe(runB.capabilityResources?.get(shared));
  });
});

describe("assembleRun — registration-conflict door as the execution-dedup detector", () => {
  // INVARIANT: a prelude that registers a key into a resource-backed registry, doors on a
  // duplicate registration WITHIN one run. A normal `assembleRun` call (single pass over the
  // already-deduped `Vocabulary.preludes`) registers exactly once — no throw. Manually
  // re-running the SAME prelude text against the SAME runCtx (simulating what an
  // execution-dedup regression would do) MUST hit the door — this is the detector the spec
  // calls for.
  it("a normal run registers once; manually re-running the prelude text against the same runCtx doors", async () => {
    const registry = EnvCapability.define("test/prelude-registry", {
      resources: (): { keys: Set<string> } => ({ keys: new Set() }),
      prelude: '(registry/register! "yaml")',
      symbols: (symbol, sz) => ({
        "registry/register!": symbol.rosetta`registry/register!: register a key; doors on a duplicate`(
          { input: [sz.string], output: [sz.string], preludeOnly: true },
          function (key: string) {
            if (this.resources.keys.has(key)) throw new Error(`cannot register ${key} twice`);
            this.resources.keys.add(key);
            return key;
          },
        ),
      }),
    });

    const runCtx = await assembleRun({
      capabilities: [registry],
      evalScheme: realEvalScheme,
      evalPrelude: realEvalPrelude,
    });
    expect((runCtx.capabilityResources?.get(registry) as { keys: Set<string> }).keys.has("yaml")).toBe(true);

    // Simulate the regression: build the SAME prelude scope shape assembleRun would (main map +
    // preludeOnly overlaid on a fresh discarded frame) and run the SAME prelude text AGAIN
    // against the SAME runCtx.
    const vocab = await buildVocabulary([registry], undefined, realEvalScheme);
    const preludeScope = ResolvingAmbient.root("test-simulated-regression") as EnvWithInternals<ResolvingAmbient>;
    for (const [name, value] of vocab.map) preludeScope.bind(name, value);
    for (const [name, value] of vocab.preludeOnly) preludeScope.bind(name, value);

    await expect(realEvalPrelude(preludeScope, vocab.preludes[0]!.text, runCtx)).rejects.toThrow(
      /cannot register yaml twice/,
    );
  });
});

describe("assembleRun — prelude `(define …)` PERSISTS into the main phase (ruling 2026-08-13)", () => {
  // A prelude define is a per-run main-phase binding (the require-extension surface).
  // The full law family lives in prelude-persistence.law.test.ts.
  it("a name a prelude `define`s IS bound from user code after assembly", async () => {
    const cap = EnvCapability.define("test/prelude-define-persists", {
      prelude: "(define leaked 42)",
      symbols: () => ({}),
    });

    const results = await exec("leaked", { capabilities: [cap] });
    expect(results[0]).toBe(42);
  });
});

describe("assembleRun — preludeOnly overlay: invisible from user code, visible from prelude, captured lexically", () => {
  // INVARIANT (three-in-one, per the spec's own grouping): (a) a preludeOnly symbol is unbound
  // from user code (the vocabulary-path resolution chain never carries `preludeOnly`); (b) it IS
  // visible from the prelude's own text (the prelude scope overlays it); (c) a CLOSURE the
  // prelude mints over a preludeOnly symbol keeps working when called LATER from user code — pure
  // lexical capture, not a temporal gate. The bridge from prelude to user code is a SANCTIONED
  // channel (a resource), never a leaked `define`: a preludeOnly registration verb stashes the
  // prelude-minted closure into this run's resource bag; a PUBLIC verb retrieves + applies it.
  it("(a) unbound from user code directly", async () => {
    const cap = EnvCapability.define("test/prelude-only-invisible", {
      symbols: (symbol, sz) => ({
        "prelude-only/secret": symbol.rosetta`prelude-only/secret: assembly-time-only`(
          { input: [], output: [sz.string], preludeOnly: true },
          () => "SECRET",
        ),
      }),
    });
    await expect(exec("(prelude-only/secret)", { capabilities: [cap] })).rejects.toBeInstanceOf(UnboundVariableError);
  });

  it("(b)+(c) visible from the prelude; a prelude-minted closure over it keeps working from user code", async () => {
    // `store-closure!`/`run-stored-closure` are NATIVE (not rosetta, not `symbol.define`):
    //  - not ROSETTA — a `sz.procedure()`-decoded wrapper is REGION-BOUND (invocable only while
    //    the exporting call is still running, per docs/membrane.md §REGION), the wrong tool for a
    //    value meant to survive PAST its minting call and be applied by a LATER, unrelated
    //    dispatch; the stored value here is the RAW scheme ALambda, never crossing the membrane.
    //  - not `symbol.define` — a baked define's BODY evaluates against its DEFINITION-TIME
    //    `ctx.runCtx` (captured once, at vocabulary-build time, shared across every run of this
    //    tuple), never the CALL-TIME runCtx (define-bake.ts's own documented limitation) — so a
    //    resource read from INSIDE a baked define body would see the WRONG run. `run-stored
    //    -closure` is a plain native impl instead: `applyCallback(stored, [], this)` applies the
    //    stored ALambda using THIS dispatch's own CallCtx (this run's real runCtx), the same seam
    //    every HOF (`map`/`filter`/`fold`) uses to invoke a callback it was handed.
    const cap = EnvCapability.define("test/prelude-only-closure-capture", {
      resources: (): { closure?: ACallable } => ({ closure: undefined }),
      // Minted DURING the prelude pass: a lambda closing over `prelude-only/secret` (visible only
      // here), immediately stashed into this run's resource bag via the preludeOnly registration
      // verb `store-closure!` — the sanctioned channel, never a leaked `define`.
      prelude: "(store-closure! (lambda () (prelude-only/secret)))",
      symbols: (symbol, sz) => ({
        "prelude-only/secret": symbol.rosetta`prelude-only/secret: visible only while a prelude evaluates`(
          { input: [], output: [sz.string], preludeOnly: true },
          () => "SECRET-42",
        ),
        "store-closure!":
          symbol.native`store-closure!: stash a prelude-minted closure (raw scheme value) into this run's resources`(
            { input: [sz.lambda], output: [sz.lambda], preludeOnly: true },
            function (closure) {
              this.resources.closure = closure;
              return closure;
            },
          ),
        "run-stored-closure":
          symbol.native`run-stored-closure: apply the resource-stashed closure through THIS dispatch's own runCtx`(
            { input: [], output: [sz.schemeValue] },
            function () {
              const stored = this.resources.closure;
              if (stored === undefined) throw new Error("no closure stored");
              return applyCallback(stored, [], this) as SchemeValue;
            },
          ),
      }),
    });

    // `run-stored-closure` is an ORDINARY (non-preludeOnly) verb — resolvable from user code —
    // yet its stored closure still resolves `prelude-only/secret`, a name user code itself
    // cannot see directly (proven by the sibling test above): pure lexical capture.
    const [out] = await exec("(run-stored-closure)", { capabilities: [cap] });
    expect(out).toBe("SECRET-42");
  });
});

describe("assembleRun — per-run effect freshness", () => {
  it("two assembleRun calls from one tuple get independent resource state", async () => {
    const cap = EnvCapability.define("test/prelude-freshness", {
      resources: (): { count: number } => ({ count: 0 }),
      prelude: "(prelude/bump!)",
      symbols: (symbol, sz) => ({
        "prelude/bump!": symbol.rosetta`prelude/bump!: bump this run's counter`(
          { input: [], output: [sz.string], preludeOnly: true },
          function () {
            this.resources.count += 1;
            return "ok";
          },
        ),
      }),
    });

    const runA = await assembleRun({ capabilities: [cap], evalScheme: realEvalScheme, evalPrelude: realEvalPrelude });
    const runB = await assembleRun({ capabilities: [cap], evalScheme: realEvalScheme, evalPrelude: realEvalPrelude });
    const bagA = runA.capabilityResources?.get(cap) as { count: number };
    const bagB = runB.capabilityResources?.get(cap) as { count: number };
    expect(bagA.count).toBe(1);
    expect(bagB.count).toBe(1);
    expect(bagA).not.toBe(bagB);
  });
});

describe("assembleRun — evalPrelude required iff the tuple's closure declares a prelude", () => {
  it("omitting evalPrelude is safe when no capability in the closure declares a prelude", async () => {
    const cap = EnvCapability.define("test/prelude-none", { symbols: () => ({}) });
    const runCtx = await assembleRun({ capabilities: [cap], evalScheme: realEvalScheme });
    expect(runCtx.vocabulary).toBeDefined();
  });

  it("a tuple WITH a prelude but no evalPrelude supplied throws", async () => {
    const cap = EnvCapability.define("test/prelude-missing-evalPrelude", {
      prelude: "(define x 1)",
      symbols: () => ({}),
    });
    await expect(assembleRun({ capabilities: [cap], evalScheme: realEvalScheme })).rejects.toThrow(/evalPrelude/);
  });
});
