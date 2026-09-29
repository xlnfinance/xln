/**
 * Q17 — unit rows for `replay-memo.ts`'s LRU mechanics + composition helpers, split
 * from the LAW rows (`__tests__/doors/tier-honesty.law.test.ts`'s Q17-flipped rows,
 * `__tests__/provenance/track-cone.law.test.ts`'s R2 demand-monotonicity rows) —
 * mirrors the established split (Q8c's `wireframe-fact-wires.test.ts` is machinery,
 * the law files consume it). This file exercises `ReplayMemo`/`memoizedReplayGraphEgress`/
 * `answerQuery` directly, with SYNTHETIC `ReplayedValue`s where the point is the
 * cache mechanics (LRU eviction/recency, key discrimination) — the tier-honesty law
 * file is where a REAL γ replay (via `q16-harness.ts`'s recorded run) drives these
 * same primitives end to end.
 */
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import type { SchemeValue } from "../../values/types.js";
import { ReplayScopeError, type ReplayedValue } from "../replay.js";
import { answerQuery, memoizedReplayGraphEgress, ReplayMemo, type ReplayMemoKey } from "../replay-memo.js";
import type { PayloadEvidenceEnvelope } from "../store/tiering.js";

const stamped = (n: number, p: number): SchemeValue => z.number.encode(n).withProvenance(new Set([p]));
const replayed = (n: number, p: number): ReplayedValue => ({ boxed: stamped(n, p), value: n });

const KEY = (over: Partial<ReplayMemoKey> = {}): ReplayMemoKey => ({
  templateHash: "th-0",
  ordinalPath: [0],
  demand: "value",
  ...over,
});

describe("ReplayMemo — LRU mechanics (§4 m2: size-capped, ephemeral, never persisted)", () => {
  it("a miss returns undefined and leaves the memo untouched", () => {
    const memo = new ReplayMemo(4);
    expect(memo.get(KEY())).toBeUndefined();
    expect(memo.size).toBe(0);
  });

  it("set then get round-trips the SAME ReplayedValue", () => {
    const memo = new ReplayMemo(4);
    const v = replayed(42, 1);
    memo.set(KEY(), v);
    expect(memo.get(KEY())).toBe(v);
    expect(memo.has(KEY())).toBe(true);
  });

  it("distinct (templateHash, ordinalPath, demand) triples never collide — demand grade is PART of the key", () => {
    const memo = new ReplayMemo(4);
    const valueDemand = replayed(1, 1);
    const countDemand = replayed(2, 2);
    memo.set(KEY({ demand: "value" }), valueDemand);
    memo.set(KEY({ demand: "count" }), countDemand);
    expect(memo.get(KEY({ demand: "value" }))).toBe(valueDemand);
    expect(memo.get(KEY({ demand: "count" }))).toBe(countDemand);
    expect(memo.size).toBe(2);
  });

  it("distinct ordinalPaths under the same templateHash never collide (nested fan/loop instances)", () => {
    const memo = new ReplayMemo(4);
    const a = replayed(1, 1);
    const b = replayed(2, 2);
    memo.set(KEY({ ordinalPath: [0, 0] }), a);
    memo.set(KEY({ ordinalPath: [0, 1] }), b);
    expect(memo.get(KEY({ ordinalPath: [0, 0] }))).toBe(a);
    expect(memo.get(KEY({ ordinalPath: [0, 1] }))).toBe(b);
  });

  it("eviction removes the LEAST recently used entry once cap is exceeded", () => {
    const memo = new ReplayMemo(2);
    memo.set(KEY({ templateHash: "a" }), replayed(1, 1));
    memo.set(KEY({ templateHash: "b" }), replayed(2, 2));
    memo.set(KEY({ templateHash: "c" }), replayed(3, 3)); // evicts "a" (oldest, never touched)
    expect(memo.size).toBe(2);
    expect(memo.has(KEY({ templateHash: "a" }))).toBe(false);
    expect(memo.has(KEY({ templateHash: "b" }))).toBe(true);
    expect(memo.has(KEY({ templateHash: "c" }))).toBe(true);
  });

  it("a GET touches recency — reading an entry protects it from the next eviction", () => {
    const memo = new ReplayMemo(2);
    memo.set(KEY({ templateHash: "a" }), replayed(1, 1));
    memo.set(KEY({ templateHash: "b" }), replayed(2, 2));
    memo.get(KEY({ templateHash: "a" })); // touch "a" — now "b" is the LRU end
    memo.set(KEY({ templateHash: "c" }), replayed(3, 3)); // evicts "b", not "a"
    expect(memo.has(KEY({ templateHash: "a" }))).toBe(true);
    expect(memo.has(KEY({ templateHash: "b" }))).toBe(false);
    expect(memo.has(KEY({ templateHash: "c" }))).toBe(true);
  });

  it("re-setting an existing key refreshes both its value and its recency", () => {
    const memo = new ReplayMemo(2);
    memo.set(KEY({ templateHash: "a" }), replayed(1, 1));
    memo.set(KEY({ templateHash: "b" }), replayed(2, 2));
    memo.set(KEY({ templateHash: "a" }), replayed(99, 9)); // refresh "a" — now "b" is LRU end
    memo.set(KEY({ templateHash: "c" }), replayed(3, 3)); // evicts "b"
    expect(memo.get(KEY({ templateHash: "a" }))?.value).toBe(99);
    expect(memo.has(KEY({ templateHash: "b" }))).toBe(false);
  });

  it("a non-positive cap is rejected at construction — never a silently-unbounded memo", () => {
    expect(() => new ReplayMemo(0)).toThrow();
    expect(() => new ReplayMemo(-1)).toThrow();
  });
});

describe("memoizedReplayGraphEgress — tier composition over a caller-supplied γ call", () => {
  it("a MISS runs the replay callback exactly once and tags the result `replayed`", async () => {
    const memo = new ReplayMemo(8);
    let calls = 0;
    const result = await memoizedReplayGraphEgress(memo, KEY(), async () => {
      calls++;
      return replayed(6, 1);
    });
    expect(result.tier).toBe("replayed");
    expect(result.value).toBe(6);
    expect(calls).toBe(1);
  });

  it("a HIT never re-invokes the replay callback and tags the result `replayed-cached`", async () => {
    const memo = new ReplayMemo(8);
    let calls = 0;
    const replay = async (): Promise<ReplayedValue> => {
      calls++;
      return replayed(6, 1);
    };
    const first = await memoizedReplayGraphEgress(memo, KEY(), replay);
    const second = await memoizedReplayGraphEgress(memo, KEY(), replay);
    expect(first.tier).toBe("replayed");
    expect(second.tier).toBe("replayed-cached");
    expect(second.value).toBe(first.value);
    expect(calls).toBe(1); // the SECOND call's replay callback never ran
  });
});

describe("answerQuery — the FULL envelope (replay/replayed-cached arms here, Q14's recorded/stub arms on scope refusal)", () => {
  const unreachableFallback = (): Promise<PayloadEvidenceEnvelope> => {
    throw new Error("unreachable — replay must have succeeded for this row");
  };

  it("a successful replay answers `replayed` and populates the memo", async () => {
    const memo = new ReplayMemo(8);
    const answer = await answerQuery({
      memo,
      key: KEY(),
      replay: async () => replayed(10, 5),
      fallback: unreachableFallback,
    });
    expect(answer.tier).toBe("replayed");
    expect(answer.value).toBe(10);
    expect(answer.stampIds).toEqual([5]);
    expect(memo.has(KEY())).toBe(true);
  });

  it("a memo hit answers `replayed-cached` WITHOUT calling replay again", async () => {
    const memo = new ReplayMemo(8);
    memo.set(KEY(), replayed(10, 5));
    let replayCalls = 0;
    const answer = await answerQuery({
      memo,
      key: KEY(),
      replay: async () => {
        replayCalls++;
        return replayed(999, 999); // would be WRONG if ever consulted
      },
      fallback: unreachableFallback,
    });
    expect(answer.tier).toBe("replayed-cached");
    expect(answer.value).toBe(10);
    expect(replayCalls).toBe(0);
  });

  it("a `ReplayScopeError` from `replay` falls through to the Q14 `fallback` arm", async () => {
    const memo = new ReplayMemo(8);
    const answer = await answerQuery({
      memo,
      key: KEY(),
      replay: async () => {
        throw new ReplayScopeError("fan", "some-span", "out of this driver's claimed scope");
      },
      fallback: async () => ({
        tier: "recorded",
        storageTier: "do",
        value: "fallback-value",
        stampIds: [7],
        retention: "standard",
      }),
    });
    expect(answer.tier).toBe("recorded");
    expect(answer.value).toBe("fallback-value");
    expect(answer.stampIds).toEqual([7]);
    // a scope refusal never populates the memo — nothing was actually replayed.
    expect(memo.has(KEY())).toBe(false);
  });

  it("a NON-scope error from `replay` propagates uncaught — never silently degraded to a fallback answer", async () => {
    const memo = new ReplayMemo(8);
    await expect(
      answerQuery({
        memo,
        key: KEY(),
        replay: async () => {
          throw new Error("a genuine bug, not a scope refusal");
        },
        fallback: unreachableFallback,
      }),
    ).rejects.toThrow("a genuine bug, not a scope refusal");
  });
});
