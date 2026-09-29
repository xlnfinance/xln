// scheme/r7rs/syntax — library/inclusion/feature-expand doors (M4 silent → door).
import { describe, expect, it } from "vitest";
import syntaxPack from "../syntax.js";
import { exec } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { PurityError } from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(syntaxPack.spec.symbols);

const SYNTAX_DOOR_NAMES = ["include", "include-ci", "cond-expand", "define-library", "import", "syntax-error"] as const;

const door = async (src: string) => {
  try {
    await exec(src);
  } catch (e) {
    const purity = e instanceof PurityError || (e as { cause?: unknown })?.cause instanceof PurityError;
    return { purity, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected purity door for: ${src}`);
};

describe("scheme/r7rs/syntax — M4 library/inclusion doors", () => {
  it("each M4 name is kind door", () => {
    for (const name of SYNTAX_DOOR_NAMES) {
      expect(symbols[name]?.kind).toBe("door");
      expect((symbols[name] as { reason: string }).reason.length).toBeGreaterThan(20);
    }
  });

  it("base env binds each as DoorProcedure", async () => {
    const env = await freshEnv();
    for (const name of SYNTAX_DOOR_NAMES) {
      expect(env.get(name)).toBeInstanceOf(DoorProcedure);
    }
  });

  it.each(SYNTAX_DOOR_NAMES.map((n) => [n, `(${n})`] as const))("%s → PurityError with Why", async (_n, src) => {
    const { purity, message } = await door(src);
    expect(purity).toBe(true);
    expect(message.length).toBeGreaterThan(20);
  });
});
