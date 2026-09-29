/**
 * SRFI-151 bitwise operations — DOORED IN FULL (V ruling 2026-07-14).
 *
 * This suite pins the DOORS, not behavior: every bitwise verb — the numeric-pack
 * five (`bitwise-and`/`bitwise-ior`/`bitwise-xor`/`bitwise-not`/`arithmetic-shift`),
 * the sugarcoat aliases (`|` `&` `~` `>>` `<<`), and srfi-151's `bit-count` — must reject
 * with the dragons door, never compute. Rationale (env/srfi/srfi-151.ts header +
 * docs/design-history/arrival-one-number-rework.md): under the one-number
 * representation, exact integers are safe-range JS numbers, and JS's native bitwise
 * operators silently truncate to 32 bits — a confident-wrong-answer factory above
 * 2^31. Doors, not dragons.
 *
 * If a real bitwise demand ever lands and gets a split-limb implementation, these
 * rows flip from door-pins to behavior-pins — deliberately, in that commit.
 */
import { execOverFrame } from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { describe, expect, it } from "vitest";
import srfi151 from "../srfi-151.js";

async function mk() {
  const env = sandboxedEnv.child(`s151-${Math.random().toString(36).slice(2)}`);
  await applyCapability(env, [srfi151]);
  return (src: string) => execOverFrame(src, { env });
}

const DOOR_FORMS = [
  // numeric-pack canonical five (reachable by inheritance from the base env)
  "(bitwise-and 12 10)",
  "(bitwise-ior 12 10)",
  "(bitwise-xor 12 10)",
  "(bitwise-not 5)",
  "(arithmetic-shift 1 4)",
  // sugarcoat aliases. (`|` is doored at the BINDING too, but unreachable from the reader
  // regardless — R7RS `|…|` vertical-bar symbol syntax claims the token, so `(| 12 10)`
  // is a parse error; true before the door as well. Not row-testable.)
  "(& 12 10)",
  "(~ 5)",
  "(>> 16 4)",
  "(<< 1 4)",
  // srfi-151's own verb
  "(bit-count 7)",
] as const;

describe("bitwise family — doored in full (here lieth the dragons)", () => {
  it.each(DOOR_FORMS)("%s rejects with the dragons door", async (form) => {
    const run = await mk();
    await expect(run(form)).rejects.toThrow(/is not available[\s\S]*dragons/);
  });

  it("the door names the rework doc (the rejection teaches)", async () => {
    const run = await mk();
    await expect(run("(bit-count 7)")).rejects.toThrow(/arrival-one-number-rework/);
  });
});
