// capability-prelude-only-symbol.test.ts — a `preludeOnly` SymbolDef routes onto
// `Vocabulary.preludeOnly` instead of `Vocabulary.map`, using the SAME bind form (native →
// `bindTarget.set(verb, def)`; rosetta → `bindTarget.set(verb, def)`), just a different target
// map. Design doc §1.3/§4 step 3.
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`EnvCapability.apply()`
// — the bind loop this file used to unit-test (with a synthetic `ctx.preludeScope`) now lives in
// `env/vocabulary.ts`'s `processCapability`/`makeBindTarget`, which ALWAYS provides BOTH target
// maps (`mainMap`/`preludeOnlyMap`) unconditionally — there is no longer a "ctx.preludeScope
// absent" state to construct at all (that was `capability.ts`'s OWN `PackContext.preludeScope?`
// being optional; `buildVocabulary` has no such optionality). This is a STRONGER invariant than
// the retired fallback-to-runtime-env law it replaces: a preludeOnly def can ONLY ever land in
// `Vocabulary.preludeOnly`, never ambiguously in the main map. The retired "no overlay wired,
// falls back to env" row is dropped — its premise (an apply reachable outside any assembly) no
// longer exists.
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../capability.js";
import { buildVocabulary } from "../../env/vocabulary.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { symbol } from "../../symbol/index.js";
import * as z from "../scheme-zod/index.js";
import { execInFrame } from "../../eval/generator-exec.js";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

describe("buildVocabulary — routing preludeOnly symbols onto Vocabulary.preludeOnly", () => {
  it("a preludeOnly rosetta binds onto Vocabulary.preludeOnly, NOT onto Vocabulary.map", async () => {
    const def = symbol.rosetta`prelude-only/verb: only visible while a prelude evaluates`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = EnvCapability.define("test/prelude-only", { symbols: () => ({ "prelude-only/verb": def }) });
    const vocabulary = await buildVocabulary([cap], undefined, evalScheme);

    expect(vocabulary.map.has("prelude-only/verb")).toBe(false);
    const bound = vocabulary.preludeOnly.get("prelude-only/verb");
    expect(bound).toBeInstanceOf(ARosettaProcedure);
  });

  it("an ORDINARY (non-preludeOnly) rosetta binds onto Vocabulary.map as before — no regression", async () => {
    const def = symbol.rosetta`ordinary/verb: a normal runtime verb`(
      { input: [z.string], output: [z.string] },
      (s) => s,
    );
    const cap = EnvCapability.define("test/ordinary", { symbols: () => ({ "ordinary/verb": def }) });
    const vocabulary = await buildVocabulary([cap], undefined, evalScheme);

    expect(vocabulary.map.get("ordinary/verb")).toBeInstanceOf(ARosettaProcedure);
    expect(vocabulary.preludeOnly.has("ordinary/verb")).toBe(false);
  });

  it("a preludeOnly NATIVE symbol also routes onto Vocabulary.preludeOnly (kind-agnostic)", async () => {
    const def = symbol.native`prelude-only/native-verb: native prelude-only op`(
      { input: [z.string], output: [z.string], preludeOnly: true },
      (s) => s,
    );
    const cap = EnvCapability.define("test/prelude-only-native", {
      symbols: () => ({ "prelude-only/native-verb": def }),
    });
    const vocabulary = await buildVocabulary([cap], undefined, evalScheme);

    expect(vocabulary.map.has("prelude-only/native-verb")).toBe(false);
    expect(vocabulary.preludeOnly.get("prelude-only/native-verb")).toBeInstanceOf(ANativeProcedure);
  });
});
