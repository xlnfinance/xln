// binding-symbol-define-migration.test.ts — pack law rows for scheme/r7rs/binding
// after the multi-return ban-with-door cut.
//
// This pack is doors-only: set! + values/call-with-values/let-values/let*-values/
// define-values. No prelude, no defineSyntax macros, no live multi-return.
// Mirrors control-symbol-define-migration's doors-only posture.
import { describe, expect, it } from "vitest";
import bindingPack from "../binding.js";
import { exec, execInFrame } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);
import type { AEntity } from "../../../common/symbols/_bake.js";
import { PurityError } from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(bindingPack.spec.symbols);

const DOOR_NAMES = ["set!", "values", "call-with-values", "let-values", "let*-values", "define-values"] as const;

const door = async (src: string): Promise<{ purity: boolean; message: string }> => {
  try {
    await exec(src);
  } catch (e) {
    const direct = e instanceof PurityError;
    const viaCause = (e as { cause?: unknown })?.cause instanceof PurityError;
    return { purity: direct || viaCause, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected a purity door for: ${src}`);
};

describe("ROW 1 — structural: doors-only, no prelude, multi-return surface totalized", () => {
  it("the capability declares no prelude field", () => {
    expect(bindingPack.spec.prelude).toBeUndefined();
  });

  it("every symbol is kind door; define-values is present (was silent backlog)", () => {
    expect(Object.keys(symbols).sort()).toEqual([...DOOR_NAMES].sort());
    for (const name of DOOR_NAMES) {
      expect(symbols[name]?.kind).toBe("door");
    }
  });
});

describe("ROW 2 — bake / cause: the vocabulary builds; assembled env binds DoorProcedure", () => {
  it("a bare vocabulary build does not throw", async () => {
    await expect(buildVocabulary([bindingPack], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("every door name binds as DoorProcedure in the base env", async () => {
    const env = await freshEnv();
    for (const name of DOOR_NAMES) {
      expect(env.get(name)).toBeInstanceOf(DoorProcedure);
    }
  });
});

describe("ROW 3 — firing doors throws PurityError (multi-return + set!)", () => {
  // Call shapes use self-evaluating operands so unbound free vars in former
  // macro formals cannot throw before DoorProcedure fires.
  it.each([
    ["set!", "(set! 1 2)"],
    ["values", "(values 1 2)"],
    ["call-with-values", "(call-with-values (lambda () 1) list)"],
    ["let-values", "(let-values 1 2)"],
    ["let*-values", "(let*-values 1 2)"],
    ["define-values", "(define-values 1 2)"],
  ] as const)("%s → purity door", async (_name, src) => {
    const { purity, message } = await door(src);
    expect(purity).toBe(true);
    expect(message.length).toBeGreaterThan(0);
  });
});
