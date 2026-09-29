/**
 * Sandbox surface for host-language vs R7RS-eval names.
 *
 * R7RS `eval` / `load` are **doors** (implement-or-door): bound `DoorProcedure`s
 * that fire `PurityError` on apply — never silently unbound.
 *
 * Non-R7RS host-language verbs (set-obj! / set-special! / new / instanceof)
 * remain genuinely unbound — the host-language sweep deleted them at the source.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { inferenceEnv } from "../../env/inference-env.js";
import { ensureInferenceEnvPopulated, exec } from "../../eval/generator-exec.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { PurityError } from "../../errors.js";

/** R7RS §6.12 / §6.14 names that policy requires as doors (not Unbound). */
const R7RS_SANDBOX_DOORS = ["eval", "load"] as const;

/** Host-language verbs the sweep deleted — must stay non-existent. */
const HOST_LANGUAGE_VERBS = ["set-obj!", "set-special!", "new", "instanceof"] as const;

beforeAll(async () => {
  await import("../../index.js");
  await ensureInferenceEnvPopulated();
});

describe("R7RS eval/load are doors (not unbound)", () => {
  it.each(R7RS_SANDBOX_DOORS)("%s is bound as DoorProcedure in the inference env", (name) => {
    const value = inferenceEnv.get(name, { throwError: false });
    expect(value, `'${name}' must be bound as a door`).toBeInstanceOf(DoorProcedure);
  });

  it.each(R7RS_SANDBOX_DOORS)("%s appears in the env surface", (name) => {
    const names = new Set(Object.keys(inferenceEnv.__env__));
    expect(names.has(name), `'${name}' must appear in the surface`).toBe(true);
  });

  it.each([
    ["eval", "(eval)"],
    ["load", "(load)"],
  ] as const)("%s fires PurityError on apply", async (_name, src) => {
    try {
      await exec(src);
      throw new Error(`expected purity door for: ${src}`);
    } catch (e) {
      const purity = e instanceof PurityError || (e as { cause?: unknown })?.cause instanceof PurityError;
      expect(purity).toBe(true);
    }
  });
});

describe("non-R7RS host-language verbs remain non-existent", () => {
  it.each(HOST_LANGUAGE_VERBS)("%s is genuinely Unbound in the inference env", (verb) => {
    const value = inferenceEnv.get(verb, { throwError: false });
    expect(value, `'${verb}' must NOT be bound`).toBeUndefined();
  });

  it("no host-language verb appears in the env's own surface", () => {
    const names = new Set(Object.keys(inferenceEnv.__env__));
    for (const verb of HOST_LANGUAGE_VERBS) {
      expect(names.has(verb), `'${verb}' must not appear in the surface`).toBe(false);
    }
  });
});
