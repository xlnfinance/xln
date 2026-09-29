// ext-toml.test.ts — Stage B4 (docs archaeology: stage-b-runcontext-absorbs-assembly.md,
// hazards ledger): the require-extension per-type law for `.toml`, on the DEFAULT (vocabulary)
// `exec({ capabilities })` path. Proves `arrivalTomlCapability`'s prelude
// (`(require/register-extension ".toml" toml/parse)`) registers into THIS run's own
// per-run registry resource (arrival/loader, Stage B4) and that a real `(require "x.toml")`
// resolves through it end-to-end — plus the re-registration door and the per-run freshness law.
// Twin of yaml's `ext-yaml.test.ts` — same laws, same idioms.

import { describe, expect, it } from "vitest";
import { exec, execState } from "@inhuman.tools/arrival";
import { loaderFromResolver } from "@inhuman.tools/arrival-modules";
import { EnvCapability } from "@inhuman.tools/arrival/capability";

import { arrivalTomlCapability } from "../ext-toml.js";

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalTomlCapability — .toml on the vocabulary (default) path", () => {
  it('(require "x.toml") resolves through THIS run\'s per-run registry, JSON-shaped', async () => {
    // `exec` already exits through `toJS` — assert the JS face directly.
    const results = await exec(`(require "personas.toml")`, {
      capabilities: [arrivalTomlCapability],
      config: { loader: files({ "personas.toml": 'name = "Ada"\nage = 30\n' }) },
    });
    expect(results.at(-1)).toMatchObject({ name: "Ada", age: 30 });
  });

  it("a SEPARATE run that never roots arrivalTomlCapability cannot resolve .toml at all (per-run isolation)", async () => {
    const { arrivalLoaderCapability } = await import("@inhuman.tools/arrival-modules");
    await expect(
      exec(`(require "unseen.toml")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "unseen.toml": "x = 1\n" }) },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });

  it("re-registering .toml with a DIFFERENT resolver in the SAME run doors", async () => {
    const conflicting = EnvCapability.define("test/ext-toml-conflict", {
      deps: [arrivalTomlCapability],
      symbols: (symbol, z) => ({
        "test/other-toml-resolve": symbol.rosetta`test/other-toml-resolve: rival .toml handler`(
          { input: [z.union([z.string, z.bytevector])], output: [z.dynamic] },
          () => ({ rival: true }),
        ),
      }),
      prelude: `(require/register-extension ".toml" test/other-toml-resolve)`,
    });
    await expect(
      exec(`(require "x.toml")`, {
        capabilities: [conflicting],
        config: { loader: files({ "x.toml": "a = 1\n" }) },
      }),
    ).rejects.toThrow(/already handled by/);
  });

  it("two RunContexts of the SAME tuple each get their own registry entry (per-run law)", async () => {
    const config = { loader: files({ "a.toml": "v = 1\n" }) };
    const resultsA = await exec(`(require "a.toml")`, { capabilities: [arrivalTomlCapability], config });
    const resultsB = await exec(`(require "a.toml")`, { capabilities: [arrivalTomlCapability], config });
    expect(resultsA.at(-1)).toMatchObject({ v: 1 });
    expect(resultsB.at(-1)).toMatchObject({ v: 1 });
    const runA = await execState(`(require "a.toml")`, { capabilities: [arrivalTomlCapability], config });
    const runB = await execState(`(require "a.toml")`, { capabilities: [arrivalTomlCapability], config });
    expect(runA.runCtx).not.toBe(runB.runCtx);
  });
});
