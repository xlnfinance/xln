// loader-capability.test.ts — `arrivalLoaderCapability`: the module system as a declarative
// EnvCapability. Proves the postures against the sanctioned `exec`/`execState({capabilities})`
// path:
//   1. door by absence (`Contract.requiresConfig`): no `fs`/`loader` config ⇒ the vocabulary
//      builds and `require` binds a cause-carrying DoorProcedure teaching "provide `fs` or
//      `loader`" — the auto-derived door mints unconditionally (requiresConfig is read
//      mode-independently). Same for `require/extension` without a registry, naming
//      `extensionRegistry`. `require`'s gate is the DISJUNCTIVE requiresConfig form
//      (`[["fs", "loader"]]` — any-of).
//   2. an armed loader resolves data + spills `.scm` defines into the RUN env;
//   3. `require/register-extension` is the capability's `preludeOnly` symbol: callable from a
//      DEPENDENT capability's prelude during the per-run prelude pass (`env/assemble-run.ts`),
//      a plain unbound-variable error from user code.
//   4. `Vocabulary.degraded` enumerates the missing keys (design doc
//      symbol-define-static-program-validation.md §3.7).
import { describe, expect, it } from "vitest";
import { EnvCapability, exec, execState, toJS, type SchemeValue } from "@inhuman.tools/arrival";
import { AmbientRuntime, execInFrame, type EnvPack } from "@inhuman.tools/arrival/host-internals";
import invariant from "tiny-invariant";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { contentsToText, loaderFromResolver, type RunEnv } from "../loader.js";

/** Unwrap an `execState` boxed value. `exec` results are already JS — do not re-cross. */
const boxed = (v: SchemeValue): unknown => toJS(v);

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

describe("arrivalLoaderCapability — the declarative module system", () => {
  it("door by absence: a config-less run succeeds and `require` binds the fs-or-loader door", async () => {
    await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.toThrow(
      /require @ arrival\/loader is not available.*requires configuration `fs` or `loader` — provide one of them/s,
    );
  });

  it("door by absence: no extensionRegistry ⇒ `require/extension` binds a door naming it", async () => {
    await expect(
      exec(`(require/extension :sql)`, { capabilities: [arrivalLoaderCapability], config: { loader: files({}) } }),
    ).rejects.toThrow(
      /require\/extension @ arrival\/loader is not available.*requires configuration `extensionRegistry`/s,
    );
  });

  it("an armed loader resolves a data module (raw scheme args + no return marshal)", async () => {
    const results = await exec(`(define cfg (require "cfg.json")) (assoc "irrelevant" (list)) cfg`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "cfg.json": `{"name":"world"}` }) },
    });
    const cfg = results.at(-1) as Record<string, unknown>;
    expect(cfg).toMatchObject({ name: "world" });
  });

  it("JSONC (.json with // comments + trailing commas) resolves like strict JSON", async () => {
    const src = `{
      // provider roster
      "name": "world",
      "tags": ["a", "b",],
    }`;
    const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "cfg.json": src }) },
    });
    const cfg = results.at(-1) as Record<string, unknown>;
    expect(cfg).toMatchObject({ name: "world", tags: ["a", "b"] });
  });

  it("a .scm require spills its defines into the RUN env (the ctx-read frame)", async () => {
    const results = await exec(`(require "lib.scm") (+ lib-answer 1)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({ "lib.scm": `(define lib-answer 41)` }) },
    });
    expect(Number(results.at(-1))).toBe(42);
  });

  it("require/register-extension: callable from a DEPENDENT capability's prelude via the per-run prelude pass; unbound from user code", async () => {
    // An ext-style capability: a rosetta resolver (boxed contents in, module value
    // out) + a prelude that registers the suffix by name.
    const extCap = EnvCapability.define("test/ext-upper", {
      symbols: (symbol, z) => ({
        "test/upper-resolve": symbol.rosetta`test/upper-resolve: uppercases module contents`(
          { input: [z.union([z.string, z.bytevector])], output: [z.string] },
          (contents) => contentsToText(contents).toUpperCase(),
        ),
      }),
      prelude: `(require/register-extension ".upper" "test/upper-resolve")`,
    });
    // Tuple identity is config-object-IDENTITY-keyed (`buildVocabulary`'s memo) — reuse the SAME
    // config (and capabilities array) across both calls so the reused `runCtx` matches this
    // tuple, not a distinct one.
    const capabilities = [extCap, arrivalLoaderCapability];
    const config = { loader: files({ "shout.upper": "hello" }) };
    const state = await execState(`(require "shout.upper")`, { capabilities, config });
    // The prelude registration took: a `.upper` require resolves through the by-name registry.
    expect(boxed(state.values.at(-1)!)).toBe("HELLO");
    // And the verb itself is assembly-time-only. Reuse the SAME runCtx (REPL continuity) so the
    // prelude pass does not re-fire.
    await expect(
      exec(`(require/register-extension ".x" "nope")`, { capabilities, config, runCtx: state.runCtx }),
    ).rejects.toThrow(/Unbound variable/);
  });

  it("(require/extension :name) applies a registry pack onto the live env, idempotently", async () => {
    let applies = 0;
    const registry = new Map([
      [
        "greeter",
        {
          name: "ext/greeter",
          apply: async (_env: RunEnv, ctx) => {
            applies += 1;
            invariant(ctx.preludeEvalScope !== undefined, "registry pack: preludeEvalScope expected");
            invariant(ctx.preludeEvalScope instanceof AmbientRuntime, "registry pack expects a real env");
            await execInFrame(`(define (greeting-of) "hi")`, ctx.preludeEvalScope);
          },
        } satisfies EnvPack<RunEnv>,
      ],
    ]);
    const results = await exec(`(require/extension :greeter) (require/extension :greeter) (greeting-of)`, {
      capabilities: [arrivalLoaderCapability],
      config: { loader: files({}), extensionRegistry: registry },
    });
    expect(results.at(-1)).toBe("hi");
    expect(applies).toBe(1);
  });

  describe("door-set degradation — the auto-derived requiresConfig doors, mode-independent (D2)", () => {
    it("an armed loader is NOT degraded — `require` binds for real", async () => {
      const results = await exec(`(require "cfg.json")`, {
        capabilities: [arrivalLoaderCapability],
        config: { loader: files({ "cfg.json": `{"name":"world"}` }) },
      });
      const cfg = results.at(-1) as Record<string, unknown>;
      expect(cfg).toMatchObject({ name: "world" });
    });

    it("the door mints unconditionally — requiresConfig is mode-independent", async () => {
      await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.toThrow(
        /is not available/,
      );
      await expect(exec(`(require "x.json")`, { capabilities: [arrivalLoaderCapability] })).rejects.not.toThrow(
        /Unbound variable|PurityError/,
      );
    });
  });

  describe("a required .scm module composes with base builtins", () => {
    // A required module's forms must resolve through the run's COMPOSED resolver
    // (`this.resolver` → `execExpr({ resolver })`), not a bare frame rebuild —
    // else module code can't see base builtins (`string-append` unbound).
    it("a required .scm module sees base builtins (string-append) and spills its defines", async () => {
      const table: Record<string, string> = {
        "lib.scm": `(define (greet name) (string-append "hello " name))`,
      };
      const results = await exec(`(require "lib.scm") (greet "world")`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: {
            readFile: (p: string) => {
              const hit = table[p];
              if (hit === undefined) throw new Error(`no such file: ${p}`);
              return hit;
            },
          },
          dirname: "",
        },
      });
      expect(results.at(-1)).toBe("hello world");
    });

    it("a required data module resolves too (fs IS the intent to support require)", async () => {
      const table: Record<string, string> = { "cfg.json": `{"name":"world"}` };
      const results = await exec(`(define cfg (require "cfg.json")) cfg`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          fs: { readFile: (p: string) => table[p] ?? "" },
          dirname: "",
        },
      });
      expect(results.at(-1)).toMatchObject({ name: "world" });
    });
  });
});
