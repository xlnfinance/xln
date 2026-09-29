// ext-yaml.test.ts — Stage B4 (docs archaeology: stage-b-runcontext-absorbs-assembly.md,
// hazards ledger): the require-extension per-type law for `.yaml`/`.yml`, on the DEFAULT
// (vocabulary) `exec({ capabilities })` path. Proves `arrivalYamlCapability`'s prelude
// (`(require/register-extension ".yaml" yaml/parse)` / `.yml`) registers into THIS run's
// own per-run registry resource (arrival/loader, Stage B4) and that a real `(require "x.yaml")`
// resolves through it end-to-end — plus the re-registration door and the per-run freshness law.

import { describe, expect, it } from "vitest";
import { exec, execState } from "@inhuman.tools/arrival";
import { loaderFromResolver } from "@inhuman.tools/arrival-modules";
import { EnvCapability } from "@inhuman.tools/arrival/capability";

import { arrivalYamlCapability } from "../ext-yaml.js";

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalYamlCapability — .yaml/.yml on the vocabulary (default) path", () => {
  it('(require "x.yaml") resolves through THIS run\'s per-run registry, JSON-shaped', async () => {
    // `exec` already exits through `toJS` — assert the JS face directly.
    const results = await exec(`(require "personas.yaml")`, {
      capabilities: [arrivalYamlCapability],
      config: { loader: files({ "personas.yaml": "name: Ada\nage: 30\n" }) },
    });
    expect(results.at(-1)).toMatchObject({ name: "Ada", age: 30 });
  });

  it(".yml is registered alongside .yaml, same resolver", async () => {
    const results = await exec(`(require "config.yml")`, {
      capabilities: [arrivalYamlCapability],
      config: { loader: files({ "config.yml": "flag: true\n" }) },
    });
    expect(results.at(-1)).toMatchObject({ flag: true });
  });

  it("a SEPARATE run that never roots arrivalYamlCapability cannot resolve .yaml at all (per-run isolation)", async () => {
    const { arrivalLoaderCapability } = await import("@inhuman.tools/arrival-modules");
    await expect(
      exec(`(require "unseen.yaml")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "unseen.yaml": "x: 1\n" }) },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });

  it("re-registering .yaml with a DIFFERENT resolver in the SAME run doors", async () => {
    const conflicting = EnvCapability.define("test/ext-yaml-conflict", {
      deps: [arrivalYamlCapability],
      symbols: (symbol, z) => ({
        "test/other-yaml-resolve": symbol.rosetta`test/other-yaml-resolve: rival .yaml handler`(
          { input: [z.union([z.string, z.bytevector])], output: [z.dynamic] },
          () => ({ rival: true }),
        ),
      }),
      prelude: `(require/register-extension ".yaml" test/other-yaml-resolve)`,
    });
    await expect(
      exec(`(require "x.yaml")`, {
        capabilities: [conflicting],
        config: { loader: files({ "x.yaml": "a: 1\n" }) },
      }),
    ).rejects.toThrow(/already handled by/);
  });

  it("two RunContexts of the SAME tuple each get their own registry entry (per-run law)", async () => {
    const config = { loader: files({ "a.yaml": "v: 1\n" }) };
    const resultsA = await exec(`(require "a.yaml")`, { capabilities: [arrivalYamlCapability], config });
    const resultsB = await exec(`(require "a.yaml")`, { capabilities: [arrivalYamlCapability], config });
    expect(resultsA.at(-1)).toMatchObject({ v: 1 });
    expect(resultsB.at(-1)).toMatchObject({ v: 1 });
    // Distinct RunContexts (never a leaked shared registry) — the boxed-value COMPLEX tier,
    // asserted on identity alone (content is already proven via the SIMPLE tier above).
    const runA = await execState(`(require "a.yaml")`, { capabilities: [arrivalYamlCapability], config });
    const runB = await execState(`(require "a.yaml")`, { capabilities: [arrivalYamlCapability], config });
    expect(runA.runCtx).not.toBe(runB.runCtx);
  });
});
