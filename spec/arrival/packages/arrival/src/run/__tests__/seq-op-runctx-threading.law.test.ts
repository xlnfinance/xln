/**
 * LAW W1 — the seq-op terms (`map`/`filter`/`reduce`, both APair and AVector) thread the
 * invocation's REAL RunContext into their callback, not CONSTANT_CTX
 * (the CONSTANT_CTX audit §2.5, the wave-0
 * confessions: APair.ts ×3 + AVector.ts ×3 carried an explicit `runCtx ?? CONSTANT_CTX`
 * literal pending this wave, §4 Wave 1).
 *
 * W8 rewrite: bare host-fn applyCallback arm is gone — the probe is an ANativeProcedure
 * that records `callCtx.runCtx` (the CallCtx threaded through the apply term).
 */
import { describe, expect, it } from "vitest";
import { APair } from "../../values/primitives/APair.js";
import { AVector } from "../../values/primitives/AVector.js";
import { nil } from "../../values/primitives/ANil.js";
import { AExact } from "../../values/primitives/AExact.js";
import { RunContext, CONSTANT_CTX } from "../../run/RunContext.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import type { SchemeValue } from "../../values/types.js";

/** A live, real run's ctx — identity-distinct from CONSTANT_CTX. Distinguishing the two is the whole law. */
const liveCtx: RunContext = new RunContext();

/** Records the `callCtx.runCtx` an ANativeProcedure callback observes. W8. */
function makeProbe(): { fn: ANativeProcedure; observed: RunContext[] } {
  const observed: RunContext[] = [];
  return {
    observed,
    fn: new ANativeProcedure({
      name: "probe",
      arity: { min: 0, max: null },
      contract: undefined,
      impl: (args, callCtx) => {
        observed.push(callCtx.runCtx);
        return args[0] as SchemeValue;
      },
    }),
  };
}

const one = new AExact(1);
const two = new AExact(2);

describe("W1 seq-op ctx threading — APair map/filter/reduce thread the invocation's real ctx into their callback", () => {
  it("map: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(one, new APair(two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/map"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
      expect(ctx).not.toBe(CONSTANT_CTX);
    }
  });

  it("filter: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(one, new APair(two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/filter"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });

  it("reduce: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(one, new APair(two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/reduce"](probe.fn, 0, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });
});

describe("W1 seq-op ctx threading — AVector map/filter/reduce thread the invocation's real ctx into their callback", () => {
  // Loose mode (no `strict`): AVector's map/filter/reduce strict-gate BEFORE reaching the
  // callback ("R7RS map/filter/reduce operate on lists; a vector is not a list") — the
  // confession this test regresses against is only reachable in loose mode. `liveCtx` above
  // is already loose (`RunContext`'s `strict` defaults to `false`).
  it("map: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector([one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/map"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });

  it("filter: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector([one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/filter"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });

  it("reduce: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector([one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/reduce"](probe.fn, new AExact(0), liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });
});
