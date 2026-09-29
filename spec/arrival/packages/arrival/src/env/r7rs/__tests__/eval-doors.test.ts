// scheme/r7rs/eval — §6.12 doors (sandbox + environment reification).
import { describe, expect, it } from "vitest";
import evalPack, { EVAL_DOOR_NAMES } from "../eval.js";
import { exec } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { PurityError } from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(evalPack.spec.symbols);

const door = async (src: string) => {
  try {
    await exec(src);
  } catch (e) {
    const purity = e instanceof PurityError || (e as { cause?: unknown })?.cause instanceof PurityError;
    return { purity, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected purity door for: ${src}`);
};

describe("scheme/r7rs/eval — §6.12 doors", () => {
  it("exports exactly the five §6.12 names as kind door", () => {
    expect(Object.keys(symbols).sort()).toEqual([...EVAL_DOOR_NAMES].sort());
    for (const name of EVAL_DOOR_NAMES) expect(symbols[name]?.kind).toBe("door");
  });

  it("base env binds each as DoorProcedure with scheme/r7rs/eval owner", async () => {
    const env = await freshEnv();
    for (const name of EVAL_DOOR_NAMES) {
      const bound = env.get(name);
      expect(bound).toBeInstanceOf(DoorProcedure);
      expect((bound as DoorProcedure).door.cause?.owner).toBe("scheme/r7rs/eval");
      expect((bound as DoorProcedure).door.cause?.needs).toEqual([]);
    }
  });

  it.each([
    ["eval", "(eval)"],
    ["environment", "(environment)"],
    ["null-environment", "(null-environment)"],
    ["scheme-report-environment", "(scheme-report-environment)"],
    ["interaction-environment", "(interaction-environment)"],
  ] as const)("%s → PurityError with Why", async (_n, src) => {
    const { purity, message } = await door(src);
    expect(purity).toBe(true);
    expect(message).toMatch(/omitted from arrival by design|sandbox|reification|construction-site lineage/);
  });
});
