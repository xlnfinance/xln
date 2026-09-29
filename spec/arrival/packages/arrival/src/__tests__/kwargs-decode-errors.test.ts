// kwargs-decode-errors — pins the kwargs zod-decode humanizer's frozen shape (coordinates
// with arrival-manifold docs/args-error-reporting-v2.md §2.5 — those strings must change
// only together with the manifold's own re-freeze; do not edit one side alone).
//
// A rejected kwargs decode (rosetta.ts's `z.decode(kwargsSchema, collectKwargsObject(args))`)
// humanizes to the frozen shape design doc §2.5 defines:
//
//   <name>: arguments rejected — <n> problem(s):
//     :<path> — <humanized issue>
//
// so the localized args-misuse door (mcp-substrate) can parse `:<path> —` off the FIRST
// line with no heuristics (the own-decode clue family, design doc §2.5).
//
// Harness: mirrors common/__tests__/kwargs-runtime.test.ts's UNIT plane — a `symbol.rosetta`
// kwargs contract exercised directly via `fire(def, testCallCtx(), ...pluck pairs...)`,
// no evaluator round trip needed to reach the decode chokepoint.

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { symbol } from "../symbol/index.js";
import { testCallCtx } from "../run/CallCtx.js";
import * as z from "../common/scheme-zod/index.js";

/** Build a keyword `ASymbol` exactly as evaluating `:key` now does (self-evaluating —
 *  keyword-tagless-apply.md) — the SAME helper kwargs-runtime.test.ts's UNIT plane uses. */
function pluck(key: string): unknown {
  return new ASymbol(`:${key}`);
}

function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("kwargs decode rejection — humanized frozen shape (docs/args-error-reporting-v2.md §2.5)", () => {
  // R1: a single value-mismatch issue (a scalar sent where the kwargs field declares an
  // object) humanizes to the frozen head + one per-issue line, instead of a raw ZodError
  // issues dump.
  it(
    "R1 — a single-issue kwargs rejection humanizes to '<name>: arguments rejected — 1 problem(s):' " +
      "+ one ':<param> — expected <type>, got <type>: <preview>' line (today: raw ZodError dump — the " +
      "known regression fixed by the rosetta.ts kwargs-decode humanizer, design doc §2.5)",
    async () => {
      const def = symbol.rosetta`greet: kwargs greeting`(
        { input: [], inputRest: { query: z.object({ term: z.string.optional() }) }, output: [z.string] },
        (args) => JSON.stringify(args.query),
      );
      let caught: unknown;
      try {
        await fire(def, testCallCtx(), pluck("query"), new AString("King Saud University"));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        'greet: arguments rejected — 1 problem(s):\n  :query — expected object, got string: "King Saud University"',
      );
    },
  );

  // R2: THE SILENT-STRIP PROBE. `z.object`'s default mode STRIPS unknown keys rather than
  // rejecting them — a misspelled OPTIONAL key would otherwise vanish with NO rejection at
  // all, a silent failure worse than any error. The kwargs decode is strict (`z.strictObject`,
  // design doc §2.5) precisely to close this: this row pins that a misspelled kwarg key is
  // REJECTED, never silently dropped.
  it(
    "R2 — THE SILENT-STRIP PROBE: a misspelled OPTIONAL kwarg key (:pagesize vs declared :pageSize) is " +
      "REJECTED, never silently dropped (strict decode closes z.object's default silent-strip mode, " +
      "design doc §2.5)",
    async () => {
      const def = symbol.rosetta`search: kwargs search`(
        { input: [], inputRest: { query: z.string, pageSize: z.number.optional() }, output: [z.string] },
        (args) => `${args.query}:${args.pageSize}`,
      );
      await expect(
        fire(
          def,
          testCallCtx(),
          pluck("query"),
          new AString("King Saud University"),
          pluck("pagesize"),
          new AString("50"),
        ),
      ).rejects.toThrow();
    },
  );

  // R3: multi-issue rejection counts every problem and lists each on its own line, in
  // schema declaration order (verified against zod 4.3.6 directly: `z.decode` on a
  // multi-required-field object returns issues in shape-declaration order, not sent-arg
  // order) — a model reading a truncated observation should see the FIRST-declared miss
  // first, matching the signature it was just shown.
  it(
    "R3 — a two-issue kwargs rejection counts BOTH problems and lists each on its own line, in schema " +
      "declaration order (query before pageSize) — today: raw ZodError dump, no stable count/order contract",
    async () => {
      const def = symbol.rosetta`search: kwargs search two-required`(
        { input: [], inputRest: { query: z.string, pageSize: z.number }, output: [z.string] },
        (args) => `${args.query}:${args.pageSize}`,
      );
      let caught: unknown;
      try {
        await fire(def, testCallCtx());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "search: arguments rejected — 2 problem(s):\n  :query — missing (required)\n  :pageSize — missing (required)",
      );
    },
  );
});
