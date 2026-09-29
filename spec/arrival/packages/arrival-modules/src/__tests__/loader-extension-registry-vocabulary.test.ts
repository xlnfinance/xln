// loader-extension-registry-vocabulary.test.ts — the file-suffix → resolver-verb-name
// registry as a per-run LOADER RESOURCE on the vocabulary path (`exec`'s default for
// `{capabilities}` runs). Companion to `loader-capability.test.ts` and
// `env/__tests__/assemble-run.test.ts` (the GENERAL per-run-prelude laws) — this file
// is the REGISTRY-SPECIFIC proof:
//   - registration via prelude resolves a real `(require "x.ext")` end-to-end;
//   - PER-RUN ISOLATION: a fresh RunContext of the same tuple gets a FRESH, empty
//     registry (a run that never roots the registering capability cannot see its suffix);
//   - the diamond-DAG single-registration law (loader shared by two dependents ⇒ ONE
//     registry, no spurious conflict);
//   - the re-registration door (`ExtensionSuffixConflictError`) as its own regression
//     detector — "cannot register .yaml twice".

import { describe, expect, it } from "vitest";
import { EnvCapability, exec, execState, toJS, type SchemeValue } from "@inhuman.tools/arrival";
import { getCapabilityResources } from "@inhuman.tools/arrival/host-internals";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { contentsToText, loaderFromResolver } from "../loader.js";

const boxed = (v: SchemeValue): unknown => toJS(v);

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

/** A minimal ext-style capability — the SAME resolver shape ext-yaml/ext-toml use
 *  (rosetta over boxed contents, return IS the module value), minus a parser. */
function makeUpperExtCapability(name: string, suffix: string, resolverName: string): EnvCapability {
  return EnvCapability.define(name, {
    deps: [arrivalLoaderCapability],
    symbols: (symbol, z) => ({
      [resolverName]: symbol.rosetta`${resolverName}: uppercases module contents`(
        { input: [z.union([z.string, z.bytevector])], output: [z.string] },
        (contents) => contentsToText(contents).toUpperCase(),
      ),
    }),
    prelude: `(require/register-extension "${suffix}" "${resolverName}")`,
  });
}

describe("loader extension registry — vocabulary path (Stage B4)", () => {
  it("registers via prelude and resolves a real (require ...) end-to-end", async () => {
    const ext = makeUpperExtCapability("test/ext-upper-vocab", ".upper", "test/upper-resolve-vocab");
    const results = await exec(`(require "shout.upper")`, {
      capabilities: [ext],
      config: { loader: files({ "shout.upper": "hello" }) },
    });
    expect(results.at(-1)).toBe("HELLO");
  });

  it("PER-RUN LAW: a fresh RunContext of the SAME tuple gets a FRESH, independently-populated registry", async () => {
    const ext = makeUpperExtCapability("test/ext-upper-freshness", ".upperfresh", "test/upper-resolve-freshness");

    const runA = await execState("#t", { capabilities: [ext], config: { loader: files({}) } });
    const runB = await execState("#t", { capabilities: [ext], config: { loader: files({}) } });

    const regA = (
      getCapabilityResources(runA.runCtx, arrivalLoaderCapability) as { extensionResolvers: Map<string, string> }
    ).extensionResolvers;
    const regB = (
      getCapabilityResources(runB.runCtx, arrivalLoaderCapability) as { extensionResolvers: Map<string, string> }
    ).extensionResolvers;

    expect(regA).not.toBe(regB); // distinct Map instances, never a shared/leaked reference
    expect(regA.get(".upperfresh")).toBe("test/upper-resolve-freshness");
    expect(regB.get(".upperfresh")).toBe("test/upper-resolve-freshness"); // both populated, independently
  });

  it("ISOLATION LAW: a run that never roots the registering capability cannot see its suffix at all", async () => {
    // The decisive proof against the OLD process-global design: under that design, ANY run in
    // this process would see ".isolated" the moment `capA`'s prelude registered it anywhere —
    // the per-run resource design makes that structurally impossible.
    const capA = makeUpperExtCapability("test/ext-isolation-a", ".isolated", "test/isolation-resolve-a");
    await exec(`(require "seen.isolated")`, {
      capabilities: [capA],
      config: { loader: files({ "seen.isolated": "x" }) },
    });

    // A SEPARATE run, a capability set that never included capA (only the bare loader).
    await expect(
      exec(`(require "unseen.isolated")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "unseen.isolated": "x" }) },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });

  it("DIAMOND LAW: two capabilities sharing one ext-registering dependency yield ONE registry, no spurious conflict", async () => {
    const shared = makeUpperExtCapability("test/ext-diamond-shared", ".diamond", "test/diamond-resolve");
    const left = EnvCapability.define("test/ext-diamond-left", { deps: [shared], symbols: () => ({}) });
    const right = EnvCapability.define("test/ext-diamond-right", { deps: [shared], symbols: () => ({}) });
    const top = EnvCapability.define("test/ext-diamond-top", { deps: [left, right], symbols: () => ({}) });

    const { values, runCtx } = await execState(`(require "x.diamond")`, {
      capabilities: [top],
      config: { loader: files({ "x.diamond": "hi" }) },
    });
    expect(boxed(values.at(-1)!)).toBe("HI");

    const registry = (
      getCapabilityResources(runCtx, arrivalLoaderCapability) as { extensionResolvers: Map<string, string> }
    ).extensionResolvers;
    expect(registry.get(".diamond")).toBe("test/diamond-resolve");
    expect(registry.size).toBe(1); // shared's prelude ran exactly once — one entry, not two
  });

  it("RE-REGISTRATION DOOR: two capabilities claiming the SAME suffix with DIFFERENT resolvers doors, in ONE run", async () => {
    const capA = makeUpperExtCapability("test/ext-conflict-a", ".conflict", "test/conflict-resolve-a");
    const capB = makeUpperExtCapability("test/ext-conflict-b", ".conflict", "test/conflict-resolve-b");
    const top = EnvCapability.define("test/ext-conflict-top", { deps: [capA, capB], symbols: () => ({}) });

    // C3 apply order (deps-first) decides which of the two registers FIRST — either direction is
    // a legitimate "already handled by" door; the load-bearing fact is that ONE of them wins and
    // the OTHER doors, never silent last-write-wins.
    await expect(
      exec(`(require "x.conflict")`, { capabilities: [top], config: { loader: files({ "x.conflict": "hi" }) } }),
    ).rejects.toThrow(/already handled by "test\/conflict-resolve-(a|b)"/);
  });
});
