// EnvCapability — config validation, the one piece of `lower()`'s behavior with a direct
// vocabulary-path successor.
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`LoweredPack`
// entirely, and with them this file's OWN pre-cut coverage:
//   - the forbidden `{ fn }`-record arm (capability.ts's `isSymbolSpec`/`bindRosetta` bind path) —
//     DIED with the arm itself (dropped from `SymbolDeclaration`, see capability.ts's own doc);
//     McpEnvCapability's downstream authoring shape is the postponed MCP rework's territory now,
//     not arrival-internal test coverage.
//   - the PER-AMBIENT `cells`/`ResourceCell` pre-spawn + `windDown()`/`resume()` lifecycle this
//     suite pinned via `net.lower({...}).apply(env, ...)` — that was `lower()`'s OWN ambient-
//     scoped resource middleware (the base ctor's `activation.resources`, a DIFFERENT mechanism
//     from the surviving PER-RUNCONTEXT resource store, `["arrival/get-resources"]`, covered by
//     `run-scoped-resources.test.ts` instead). No vocabulary-path equivalent exists — the
//     ambient-scoped cell middleware was retired along with the `{fn}` arm that was its only
//     consumer (`common/capability.ts`'s own `lower()` doc, pre-cut).
//   - the "method-less prelude capability needs evalScheme, else throws PreludeArmingError" law —
//     `buildVocabulary(capabilities, config, evalScheme)`'s `evalScheme` parameter is REQUIRED at
//     the TYPE level (not optional), so a caller literally cannot omit it and reach a runtime
//     throw the way `lower({})` (an all-optional `opts` bag) could — TypeScript itself is now the
//     enforcement, not a runtime door.
//
// What survives: config validation. `EnvCapability.define`'s `configuration` schema is parsed
// exactly the same way (`z.object(spec.configuration).parse(config)`) whether the bind loop lives
// in `lower()` (pre-cut) or `env/vocabulary.ts`'s `processCapability` (post-cut) — re-authored
// here against `buildVocabulary` directly.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { buildVocabulary } from "../../env/vocabulary.js";
import { execInFrame } from "../../eval/generator-exec.js";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

describe("EnvCapability — config validation (the vocabulary-build path)", () => {
  it("validates config through zod when the vocabulary builds — bad enum rejects", async () => {
    const cap = EnvCapability.define("test/config-validation", {
      configuration: { context: z.enum(["browser", "node", "bun"]), retries: z.number().default(3) },
      symbols: () => ({}),
    });
    await expect(buildVocabulary([cap], { context: "deno" }, evalScheme)).rejects.toThrow();
  });

  it("a satisfied config bakes cleanly; defaults are applied", async () => {
    const cap = EnvCapability.define("test/config-defaults", {
      configuration: { context: z.enum(["browser", "node", "bun"]), retries: z.number().default(3) },
      symbols: () => ({}),
    });
    const vocabulary = await buildVocabulary([cap], { context: "node" }, evalScheme);
    expect(vocabulary.configsByCapability.get(cap)).toEqual({ context: "node", retries: 3 });
  });
});
