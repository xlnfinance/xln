// Mid-run `(require/extension …)` prelude-define persistence (audit B4).
// Companion to arrival's `env/__tests__/prelude-persistence.law.test.ts` (capability
// preludes). This file is the require/extension half: a pack's prelude defines
// land in the run's persistent define frame; the seed (`require/register-extension`)
// does not.

import { describe, expect, it } from "vitest";
import invariant from "tiny-invariant";
import { exec } from "@inhuman.tools/arrival";
import { AmbientRuntime, execInFrame, type EnvPack } from "@inhuman.tools/arrival/host-internals";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { loaderFromResolver, type RunEnv } from "../loader.js";

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("prelude-define persistence — mid-run require/extension (audit B4)", () => {
  it("P-EXT-PRELUDE-DEFINE — an extension pack's prelude define is callable after (require/extension …)", async () => {
    const pack: EnvPack<RunEnv> = {
      name: "ext/definer",
      apply: async (_env, ctx) => {
        invariant(ctx.preludeEvalScope !== undefined, "test pack: preludeEvalScope expected");
        invariant(ctx.preludeEvalScope instanceof AmbientRuntime, "test pack: concrete frame expected");
        await execInFrame(`(define (ext-helper) "from-ext")`, ctx.preludeEvalScope);
      },
    };
    const results = await exec(`(require/extension :definer) (ext-helper)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({}), extensionRegistry: new Map([["definer", pack]]) },
    });
    expect(results.at(-1)).toBe("from-ext");
  });

  it("N-EXT-PRELUDE-SEED — the mid-run prelude seed (require/register-extension) never rides along into the main phase", async () => {
    const pack: EnvPack<RunEnv> = {
      name: "ext/quiet",
      apply: async () => {},
    };
    await expect(
      exec(`(require/extension :quiet) (require/register-extension ".x" "nope")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({}), extensionRegistry: new Map([["quiet", pack]]) },
      }),
    ).rejects.toThrow(/Unbound variable/);
  });
});
