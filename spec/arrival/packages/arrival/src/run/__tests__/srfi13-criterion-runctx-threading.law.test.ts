/**
 * LAW W1 — an SRFI-13 criterion predicate observes the invocation's REAL RunContext,
 * not CONSTANT_CTX (the CONSTANT_CTX audit §2.4).
 *
 * W8 rewrite: bare host-fn applyCallback arm is gone — the probe is an ANativeProcedure
 * that records `callCtx.runCtx`.
 */
import { describe, expect, it } from "vitest";
import srfi13 from "../../env/srfi/srfi-13.js";
import { testCallCtx } from "../CallCtx.js";
import { RunContext, CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import type { EnvCapability } from "../../common/capability.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { schemeFalse } from "../../values/primitives/ABool.js";

/** Same extraction idiom as identity.law.test.ts's `opsOf`: pull the raw impl fn off
 *  a `symbol.native`/`symbol.rosetta` entry in the capability's inlined `symbols` —
 *  Stage A2: the CONTRACT (carrying `.impl`) rides `.contract` on the minted value now,
 *  pulled off via `harvestContracts` (the shared read-side seam). */
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    Object.entries(harvestContracts(cap.spec.symbols) as Record<string, { impl?: unknown; value?: unknown }>)
      .map(([k, v]) => [k, v.impl ?? v.value] as const)
      .filter((entry): entry is [string, (...a: any[]) => any] => typeof entry[1] === "function"),
  );
const SRFI13_OPS = opsOf(srfi13);

/** A live, real run's ctx — identity-distinct from CONSTANT_CTX. Distinguishing the two is the whole law. */
const liveCtx: RunContext = new RunContext();

/** Records the `callCtx.runCtx` an ANativeProcedure criterion observes. W8. */
function makeProbe(): { fn: ANativeProcedure; observed: RunContext[] } {
  const observed: RunContext[] = [];
  return {
    observed,
    fn: new ANativeProcedure({
      name: "probe",
      arity: { min: 0, max: null },
      contract: undefined,
      impl: (_args, callCtx) => {
        observed.push(callCtx.runCtx);
        return schemeFalse; // never matches — every char flows through the predicate once
      },
    }),
  };
}

describe("W1 srfi-13 criterion ctx threading — a user predicate observes the invocation's real ctx, not CONSTANT_CTX", () => {
  it("string-index: the criterion predicate observes liveCtx for every character probed", async () => {
    const stringIndex = SRFI13_OPS["string-index"];
    const str = new AString("abc");
    const probe = makeProbe();
    await stringIndex.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed).toHaveLength(3);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
      expect(ctx).not.toBe(CONSTANT_CTX);
    }
  });

  it("string-count: the criterion predicate observes liveCtx for every character probed", async () => {
    const stringCount = SRFI13_OPS["string-count"];
    const str = new AString("ab");
    const probe = makeProbe();
    await stringCount.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });

  it("string-trim: the criterion predicate observes liveCtx (not the default-whitespace path)", async () => {
    const stringTrim = SRFI13_OPS["string-trim"];
    const str = new AString("a");
    const probe = makeProbe();
    await stringTrim.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed.length).toBeGreaterThan(0);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });
});
