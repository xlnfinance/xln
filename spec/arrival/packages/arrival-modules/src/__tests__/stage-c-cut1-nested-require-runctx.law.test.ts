/**
 * LAW — Stage C, Cut 1 (docs archaeology: stage-c-corpse-deletion.md): `execExpr` now honors a
 * passed `ExecOptions.runCtx` (reuse verbatim) instead of unconditionally minting a fresh,
 * vocabulary-less `RunContext`. `require`'s module-eval loop (loader-capability.ts) threads the
 * requiring run's LIVE `runCtx` through every `execExpr(form, …)` call it makes, so a NESTED
 * `(require …)` inside a required `.scm` module now dispatches with the SAME runCtx as its
 * parent — `this.runCtx.vocabulary` is the outer run's real vocabulary tuple, not `undefined`.
 *
 * Companion to `loader/__tests__/loader-extension-registry-vocabulary.test.ts` (Stage B4's
 * TOP-LEVEL per-run-registry proof — unaffected by this cut, since a top-level require's
 * `this.runCtx` was always the real run handle). THIS file is the ONE-LEVEL-DEEPER proof: the
 * require that dispatches from INSIDE an already-`require`d `.scm` module's own forms — the
 * exact path `loaderRegistryOf` (loader-capability.ts) used to silently fall through to the
 * process-global extension table (`loader-extensions.ts`'s `process-global extension registry`) for, even
 * under a vocabulary-path top-level run with its own per-run extension registry.
 *
 * LAW 1 (nested require resolves per-run, not historical): a vocabulary-path run requires a `.scm`
 *   module which itself `(require …)`s an extension-resolved file, registered only via THIS
 *   run's own prelude — the nested require must resolve it, and the process-global historical
 *   table must stay untouched (size 0) throughout.
 *
 * LAW 2 (cross-run isolation at the nested level): a SEPARATE run (a fresh `exec()` call, a
 *   capability set that never registered the suffix) cannot see a suffix a DIFFERENT run's
 *   nested require resolved — same per-run-bag guarantee Stage B4 established at the top level,
 *   now confirmed one require-frame deeper.
 */
import { describe, expect, it } from "vitest";

import { EnvCapability, exec } from "@inhuman.tools/arrival";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { contentsToText, loaderFromResolver } from "../loader.js";

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

/** Same resolver shape ext-yaml/ext-toml use: rosetta over boxed contents, return
 *  IS the module value. */
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

describe("LAW 1 — nested require (inside a required .scm module) resolves via the RUN's own per-run registry", () => {
  it("does not fall to a process-global extension table (Stage C Cut 3b: there is no longer one to fall to)", async () => {
    const ext = makeUpperExtCapability("test/ext-upper-nested", ".nestedupper", "test/upper-resolve-nested");

    const results = await exec(`(require "outer-nested.scm")`, {
      capabilities: [ext],
      config: {
        loader: files({
          "outer-nested.scm": `(require "inner-nested.nestedupper")`,
          "inner-nested.nestedupper": "hello from inside",
        }),
      },
    });

    // The `.scm` module's own last form is the nested require — its value is what `load`
    // discards (require's own `load` branch always returns unspecified), so the observable
    // proof is simply that resolution SUCCEEDED (pre-fix: `loaderRegistryOf` reads
    // `this.runCtx.vocabulary` off execExpr's freshly-minted, vocabulary-less RunContext for
    // the nested call ⇒ always the empty process-global table ⇒ "no-resolver" throws here instead).
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("LAW 2 — cross-run isolation holds one require-frame deeper", () => {
  it("a separate run's nested require cannot see a suffix a DIFFERENT run registered", async () => {
    const extA = makeUpperExtCapability("test/ext-upper-nested-iso-a", ".nestediso", "test/upper-resolve-nested-iso-a");

    await exec(`(require "outer-iso-a.scm")`, {
      capabilities: [extA],
      config: {
        loader: files({
          "outer-iso-a.scm": `(require "inner-iso-a.nestediso")`,
          "inner-iso-a.nestediso": "seen by run A",
        }),
      },
    });

    // Run B: a SEPARATE exec() call, a capability set that never registered `.nestediso` (only
    // the bare loader) — its nested require of the SAME suffix must fail, proving run A's
    // per-run registration never leaked (into the historical table, or anywhere run B's own bag
    // would read).
    await expect(
      exec(`(require "outer-iso-b.scm")`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          loader: files({
            "outer-iso-b.scm": `(require "unseen-iso-b.nestediso")`,
            "unseen-iso-b.nestediso": "unreachable",
          }),
        },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });
});
