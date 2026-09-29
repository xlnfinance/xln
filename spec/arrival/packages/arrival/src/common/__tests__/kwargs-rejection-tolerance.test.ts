// kwargs-rejection-tolerance — B5 (benchmark-defect-register.md): the third option for an
// unknown kwarg key, split BEFORE throwing:
//   - NEAR a declared param (a typo, e.g. :pageSze vs :pageSize) → keep the hard door,
//     now with a did-you-mean suffix (load-bearing constraint #7: the typo door must
//     survive kwargs tolerance).
//   - FAR from every declared param (e.g. :limit on a tool with no limit param) → drop it,
//     let the call proceed, and note what was dropped via `drainDroppedKwargNotes` — never
//     silently, never stderr.
//
// A REQUIRED-key-missing rejection is a DIFFERENT zod issue code (`invalid_type`, not
// `unrecognized_keys`) and must render byte-identically to before this change.

import { describe, expect, it } from "vitest";
import * as z from "../scheme-zod/index.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { decodeKwargsStrict, drainDroppedKwargNotes, KwargsRejectionError } from "../kwargs-rejection.js";

const str = (s: string) => new AString(s);
const num = (n: number) => new AExact(n);

describe("decodeKwargsStrict — far-unknown-key tolerance (B5)", () => {
  it("a FAR unknown key (:limit, no near declared param) is dropped — the call SUCCEEDS", () => {
    const decoded = decodeKwargsStrict("search", { query: z.string }, { query: str("x"), limit: num(10) }) as {
      query: string;
    };
    expect(decoded.query).toBe("x");
  });

  it("the dropped key is NOTED, discoverable via drainDroppedKwargNotes on the returned object", () => {
    const decoded = decodeKwargsStrict("search", { query: z.string }, { query: str("x"), limit: num(10) });
    const notes = drainDroppedKwargNotes(decoded);
    expect(notes).toBeDefined();
    expect(notes!.some((n) => n.includes(":limit") && n.includes("not a parameter"))).toBe(true);
  });

  it("notes drain ONCE — a second drain on the same object returns undefined (consumed)", () => {
    const decoded = decodeKwargsStrict("search", { query: z.string }, { query: str("x"), limit: num(10) });
    expect(drainDroppedKwargNotes(decoded)).toBeDefined();
    expect(drainDroppedKwargNotes(decoded)).toBeUndefined();
  });

  it(":response-size (a manifold envelope arg, not a tool param) gets the envelope-routing note, not the generic one", () => {
    const decoded = decodeKwargsStrict("search", { query: z.string }, { query: str("x"), "response-size": num(500) });
    const notes = drainDroppedKwargNotes(decoded)!;
    expect(notes.some((n) => n.includes("response-size") && /envelope|REPL tool itself/.test(n))).toBe(true);
  });

  it("a NEAR unknown key (:pageSze vs declared :pageSize) still HARD-REJECTS with a did-you-mean suggestion", () => {
    let caught: unknown;
    try {
      decodeKwargsStrict(
        "search",
        { query: z.string, pageSize: z.number.optional() },
        { query: str("x"), pageSze: num(5) },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KwargsRejectionError);
    expect((caught as Error).message).toMatch(/:pageSze — unknown key \(did you mean :pageSize\?\)/);
  });

  it("a mix of one near + one far unknown key still hard-rejects (near wins — the typo door survives tolerance)", () => {
    let caught: unknown;
    try {
      decodeKwargsStrict(
        "search",
        { query: z.string, pageSize: z.number.optional() },
        { query: str("x"), pageSze: num(5), limit: num(10) },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KwargsRejectionError);
    expect((caught as Error).message).toMatch(/:pageSze/);
    expect((caught as Error).message).toMatch(/:limit/);
  });

  it("a required-key-missing rejection is UNCHANGED — invalid_type, not unrecognized_keys, never dropped/noted", () => {
    let caught: unknown;
    try {
      decodeKwargsStrict("search", { query: z.string }, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KwargsRejectionError);
    expect((caught as Error).message).toBe("search: arguments rejected — 1 problem(s):\n  :query — missing (required)");
  });

  it("a far-unknown key ALONGSIDE a missing-required key still hard-rejects (only a PURE far-unknown set is tolerated)", () => {
    let caught: unknown;
    try {
      decodeKwargsStrict("search", { query: z.string }, { limit: num(10) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KwargsRejectionError);
    expect((caught as Error).message).toMatch(/:query — missing \(required\)/);
    expect((caught as Error).message).toMatch(/:limit — unknown key/);
  });
});
