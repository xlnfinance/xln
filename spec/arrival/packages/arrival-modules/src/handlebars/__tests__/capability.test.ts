// capability.test.ts — Stage B4 (docs archaeology: stage-b-runcontext-absorbs-assembly.md,
// hazards ledger): the require-extension per-type law for `.hbs`, on the DEFAULT (vocabulary)
// `exec({ capabilities })` path. Proves `arrivalHandlebarsCapability`'s prelude
// (`(require/register-extension ".hbs" ext/handlebars/resolve)`) registers into THIS run's own
// per-run registry resource (arrival/loader, Stage B4) and that a real `(require "x.hbs")`
// resolves (per the CALLABLE RULE — `kind: "eval"`, a scheme lambda) end-to-end — plus the
// re-registration door. Twin of yaml's `ext-yaml.test.ts` (that pack's data-value
// shape); `.hbs` is the CALLABLE-shape sibling.

import { describe, expect, it } from "vitest";
import { exec } from "@inhuman.tools/arrival";
import { loaderFromResolver } from "@inhuman.tools/arrival-modules";
import { EnvCapability } from "@inhuman.tools/arrival/capability";

import { arrivalHandlebarsCapability } from "../capability.js";

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalHandlebarsCapability — .hbs on the vocabulary (default) path", () => {
  it('(require "x.hbs") resolves to a CALLABLE scheme lambda (the CALLABLE RULE)', async () => {
    const results = await exec(`(define greet (require "hi.hbs")) (greet "World")`, {
      capabilities: [arrivalHandlebarsCapability],
      config: { loader: files({ "hi.hbs": "Hi {{name}}!" }) },
    });
    expect(results.at(-1)).toBe("Hi World!");
  });

  it("a SEPARATE run that never roots arrivalHandlebarsCapability cannot resolve .hbs at all (per-run isolation)", async () => {
    const { arrivalLoaderCapability } = await import("@inhuman.tools/arrival-modules");
    await expect(
      exec(`(require "unseen.hbs")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "unseen.hbs": "Hi {{name}}!" }) },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });

  it("re-registering .hbs with a DIFFERENT resolver in the SAME run doors", async () => {
    const conflicting = EnvCapability.define("test/ext-hbs-conflict", {
      deps: [arrivalHandlebarsCapability],
      symbols: (symbol, z) => ({
        "test/other-hbs-resolve": symbol.rosetta`test/other-hbs-resolve: rival .hbs handler`(
          { input: [z.union([z.string, z.bytevector])], output: [z.dynamic] },
          () => ({ rival: true }),
        ),
      }),
      prelude: `(require/register-extension ".hbs" test/other-hbs-resolve)`,
    });
    await expect(
      exec(`(require "x.hbs")`, {
        capabilities: [conflicting],
        config: { loader: files({ "x.hbs": "Hi {{name}}!" }) },
      }),
    ).rejects.toThrow(/already handled by/);
  });

  it("two RunContexts of the SAME tuple each resolve independently (per-run law)", async () => {
    const config = { loader: files({ "hi.hbs": "Hi {{name}}!" }) };
    const resultsA = await exec(`(define greet (require "hi.hbs")) (greet "A")`, {
      capabilities: [arrivalHandlebarsCapability],
      config,
    });
    const resultsB = await exec(`(define greet (require "hi.hbs")) (greet "B")`, {
      capabilities: [arrivalHandlebarsCapability],
      config,
    });
    expect(resultsA.at(-1)).toBe("Hi A!");
    expect(resultsB.at(-1)).toBe("Hi B!");
  });
});
