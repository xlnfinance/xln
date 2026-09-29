// vocabulary.test.ts — Stage B1: `buildVocabulary` (the Vocabulary artifact) + `assembleRun` +
// exec's `vocabularyPath` internal routing (generator-exec.ts). See
// docs/plans/stage-b-runcontext-absorbs-assembly.md for the full model this pins.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../symbol/index.js";
import * as sz from "../../common/scheme-zod/index.js";
import type { EvalSchemeInto } from "../../common/scheme-env.js";
import { buildVocabulary } from "../vocabulary.js";
import { assembleRun } from "../assemble-run.js";
import { exec, execInFrame } from "../../eval/generator-exec.js";
import { isAmbientRuntime } from "../AmbientRuntime.js";
import { toJS } from "../../membrane/rosetta.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { PurityError, SymbolKeyMismatchError } from "../../errors.js";
import { nil } from "../../values/primitives/ANil.js";
import type { DefineSymbolDef } from "../../common/symbols/_bake.js";

/** A stub `evalScheme` for fixtures with no `symbol.define`/prelude BODY evaluation — B1 never
 *  invokes it in that case (prelude text is only COLLECTED; defines are the only bake-time
 *  eval), so a real interpreter isn't needed for most of this suite. */
const noopEvalScheme: EvalSchemeInto = async () => undefined;

/** The REAL evalScheme — required whenever a fixture declares a `symbol.define`, mirroring
 *  `generator-exec.ts`'s own private `capabilityEvalScheme` (the internal bake seam). */
const realEvalScheme: EvalSchemeInto = (env, src) => {
  if (!isAmbientRuntime(env)) throw new Error("expected a concrete AmbientRuntime");
  return execInFrame(src, env);
};

describe("buildVocabulary — C3 precedence", () => {
  it("self overwrites dep on a shared name; a dep's own unique name survives", async () => {
    const dep = EnvCapability.define("test/vocab-c3-dep", {
      symbols: (symbol) => ({
        shared: symbol.value`shared: dep's value`("dep"),
        "dep-only": symbol.value`dep-only: only the dep declares this`("dep-only"),
      }),
    });
    const root = EnvCapability.define("test/vocab-c3-root", {
      deps: [dep],
      symbols: (symbol) => ({ shared: symbol.value`shared: root's value`("root") }),
    });

    const vocab = await buildVocabulary([root], undefined, noopEvalScheme);
    expect(toJS(vocab.map.get("shared") as never)).toBe("root");
    expect(toJS(vocab.map.get("dep-only") as never)).toBe("dep-only");
  });
});

describe("buildVocabulary — requiresConfig doors + degraded surfacing", () => {
  function fixtureCapability(name: string): EnvCapability<any, any> {
    return EnvCapability.define(name, {
      configuration: {
        fs: z
          .custom<{
            readFile: (p: string) => Promise<string>;
          }>(
            (v): v is { readFile: (p: string) => Promise<string> } =>
              v !== null && typeof v === "object" && typeof (v as { readFile?: unknown }).readFile === "function",
            "fs must expose readFile(path)",
          )
          .optional(),
      },
      symbols: (symbol) => ({
        "fixture/verb": symbol.native`fixture/verb: reads via the fs`(
          { input: [], output: [sz.schemeValue], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });
  }

  // INVARIANT: an absent optional-enabling key mints a DoorProcedure carrying the SAME
  // degradation cause `lower()`'s bind arm produces, and the tuple's degraded list surfaces it.
  it("mints a DoorProcedure for a missing requiresConfig key; degraded surfaces it", async () => {
    const cap = fixtureCapability("test/vocab-door-missing");
    const vocab = await buildVocabulary([cap], {}, noopEvalScheme);
    const bound = vocab.map.get("fixture/verb");
    expect(bound).toBeInstanceOf(DoorProcedure);
    expect((bound as DoorProcedure).door.cause?.owner).toBe("test/vocab-door-missing");
    expect(vocab.degraded).toEqual([
      { capability: "test/vocab-door-missing", needs: [{ kind: "configuration", key: "fs" }] },
    ]);
  });

  it("a satisfied config binds the real verb; nothing degraded", async () => {
    const cap = fixtureCapability("test/vocab-door-satisfied");
    const vocab = await buildVocabulary([cap], { fs: { readFile: async () => "" } }, noopEvalScheme);
    expect(vocab.map.get("fixture/verb")).not.toBeInstanceOf(DoorProcedure);
    expect(vocab.degraded).toEqual([]);
  });
});

describe("buildVocabulary — preludeOnly separation", () => {
  it("routes a preludeOnly rosetta onto `preludeOnly`, not `map`", async () => {
    const cap = EnvCapability.define("test/vocab-prelude-only", {
      symbols: (symbol, z) => ({
        "prelude-only/verb": symbol.rosetta`prelude-only/verb: assembly-time-only`(
          { input: [z.string], output: [z.string], preludeOnly: true },
          (s: string) => s,
        ),
        "ordinary/verb": symbol.rosetta`ordinary/verb: a normal runtime verb`(
          { input: [z.string], output: [z.string] },
          (s: string) => s,
        ),
      }),
    });
    const vocab = await buildVocabulary([cap], undefined, noopEvalScheme);
    expect(vocab.map.has("prelude-only/verb")).toBe(false);
    expect(vocab.preludeOnly.has("prelude-only/verb")).toBe(true);
    expect(vocab.map.has("ordinary/verb")).toBe(true);
    expect(vocab.preludeOnly.has("ordinary/verb")).toBe(false);
  });
});

describe("buildVocabulary — key===name violation", () => {
  // INVARIANT: a record key that disagrees with the minted def's own declared name throws
  // SymbolKeyMismatchError — the same guard `EnvCapability.lower().apply()` enforces.
  it("throws SymbolKeyMismatchError when the record key disagrees with the def's own name", async () => {
    const cap = EnvCapability.define("test/vocab-key-mismatch", {
      symbols: (symbol, z) => ({
        // Declared under "right-name" but placed under a DIFFERENT record key.
        "wrong-key": symbol.native`right-name: doc`({ input: [], output: [z.schemeValue] }, () => nil),
      }),
    });
    await expect(buildVocabulary([cap], undefined, noopEvalScheme)).rejects.toBeInstanceOf(SymbolKeyMismatchError);
  });
});

describe("buildVocabulary — define bake products", () => {
  it("bakes a symbol.define into a bound ANativeProcedure carrying its own contract", async () => {
    const cap = EnvCapability.define("test/vocab-define-bake", {
      // `(lambda (x) x)` — its only "free" reference is `x`, bound by the lambda's own
      // formal, so this needs no `deps` edge at all (a real capability's arithmetic/list
      // define would declare one, per define-bake.ts's FV-locality law).
      symbols: (symbol, z) => ({
        identity: symbol.define`identity: the identity function`(
          { input: [z.number], output: [z.number] },
          "(lambda (x) x)",
        ),
      }),
    });
    const vocab = await buildVocabulary([cap], undefined, realEvalScheme);
    const bound = vocab.map.get("identity");
    expect(bound).toBeInstanceOf(ANativeProcedure);
    expect(((bound as ANativeProcedure).contract as DefineSymbolDef).kind).toBe("define");
  });
});

describe("buildVocabulary — memo identity", () => {
  it("same tuple → same Vocabulary object (reference identity)", async () => {
    const cap = EnvCapability.define("test/vocab-memo-same", { symbols: () => ({}) });
    const v1 = await buildVocabulary([cap], undefined, noopEvalScheme);
    const v2 = await buildVocabulary([cap], undefined, noopEvalScheme);
    expect(v1).toBe(v2);
  });

  // INVARIANT: a config object that is merely DEEP-EQUAL (not reference-equal) builds an
  // unshared second Vocabulary — memo key is config OBJECT IDENTITY (the documented default).
  it("a different (deep-equal) config object builds a DIFFERENT Vocabulary object", async () => {
    const cap = EnvCapability.define("test/vocab-memo-config", {
      configuration: { k: z.string() },
      symbols: () => ({}),
    });
    const cfgA = { k: "a" };
    const cfgB = { k: "a" }; // deep-equal, NOT reference-equal
    const vA = await buildVocabulary([cap], cfgA, noopEvalScheme);
    const vB = await buildVocabulary([cap], cfgB, noopEvalScheme);
    expect(vA).not.toBe(vB);
  });
});

describe("buildVocabulary — the diamond-DAG single-execution law (prelude collection)", () => {
  // INVARIANT: a capability reachable through two DAG edges contributes its prelude text ONCE
  // to `Vocabulary.preludes` (execution dedup is B2's; this pins the COLLECTION dedup now).
  it("a capability reachable via two DAG edges appears exactly once in `preludes`", async () => {
    const shared = EnvCapability.define("test/vocab-diamond-shared", {
      prelude: "(define %%vocab-diamond-shared-marker%% 1)",
      symbols: () => ({}),
    });
    const left = EnvCapability.define("test/vocab-diamond-left", { deps: [shared], symbols: () => ({}) });
    const right = EnvCapability.define("test/vocab-diamond-right", { deps: [shared], symbols: () => ({}) });
    const top = EnvCapability.define("test/vocab-diamond-top", { deps: [left, right], symbols: () => ({}) });

    const vocab = await buildVocabulary([top], undefined, noopEvalScheme);
    const sharedEntries = vocab.preludes.filter((p) => p.capability === shared);
    expect(sharedEntries).toHaveLength(1);
  });
});

// `{ fn }` capabilities are rejected at the type level (`SymbolDeclaration`); the pin
// lives in `common/__tests__/capability.test-d.ts`.

describe("assembleRun", () => {
  it("attaches vocabulary/degraded and builds a correct capabilityConfigurations table", async () => {
    const cap = EnvCapability.define("test/vocab-assemble-run", {
      configuration: { greeting: z.string() },
      symbols: (symbol, sz) => ({
        greet: symbol.rosetta`greet: this.configuration-reading`(
          { input: [sz.string], output: [sz.string] },
          function (s: string) {
            return `${this.configuration.greeting} ${s}`;
          },
        ),
      }),
    });
    const runCtx = await assembleRun({ capabilities: [cap], config: { greeting: "hi" }, evalScheme: noopEvalScheme });
    expect(runCtx.vocabulary).toBeDefined();
    expect(runCtx.vocabulary?.has("greet")).toBe(true);
    expect(runCtx.degraded).toEqual([]);
    expect(runCtx.capabilityConfigurations?.get(cap)).toEqual({ greeting: "hi" });
  });
});

describe("exec — vocabularyPath end-to-end integration", () => {
  // INVARIANT (full integration): a capability verb reads `this.configuration` through a REAL
  // evaluator dispatch, resolved entirely through the vocabulary-backed chain; a requiresConfig
  // door fires (PurityError) when its config key is absent — the SAME degradation contract the
  // ambient path enforces, now proven end-to-end over the routed path.
  it("routes exec(code, { capabilities, config }) through the Vocabulary", async () => {
    const cap = EnvCapability.define("test/vocab-exec-route", {
      configuration: {
        greeting: z.string(),
        fs: z.custom<{ readFile: (p: string) => Promise<string> }>().optional(),
      },
      symbols: (symbol, sz) => ({
        greet: symbol.rosetta`greet: reads this.configuration`(
          { input: [sz.string], output: [sz.string] },
          function (s: string) {
            return `${this.configuration.greeting} ${s}`;
          },
        ),
        "fixture/verb": symbol.native`fixture/verb: gated on fs`(
          { input: [], output: [sz.schemeValue], requiresConfig: ["fs"] },
          () => nil,
        ),
      }),
    });

    const [out] = await exec('(greet "world")', {
      capabilities: [cap],
      config: { greeting: "hi" },
    });
    expect(out).toBe("hi world");

    await expect(exec("(fixture/verb)", { capabilities: [cap], config: { greeting: "hi" } })).rejects.toBeInstanceOf(
      PurityError,
    );
  });
});
