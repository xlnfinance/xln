// The lane batches the rewrite's retained outbox rows the way og's dispatch does (core/runtime/delivery/dispatch.ts
// batchOutputsByTarget): rows of one lane (Runtime, Entity, signer, source frame) that carry txs and nothing else join
// into the first row's slot. No og on the other side here: these are the two lane-key conditions and the tx-only filter
// that no scenario exercises, so they are pinned on their own (review of #55, mutants b and e).
import { describe, expect, test } from "bun:test";
import { batchedByLane } from "./lane.ts";
import { haltDeparture } from "./departures.ts";
import type { Runtime } from "../xln.ts";

type Row = Parameters<typeof batchedByLane>[0][number];
const RUNTIME = "0x" + "a1".repeat(20);
const OTHER_RUNTIME = "0x" + "b2".repeat(20);
const ENTITY = "0x" + "00".repeat(31) + "01";
const row = (over: Record<string, unknown>): Row =>
  ({ runtimeId: RUNTIME, entityId: ENTITY, signerId: "0x" + "c3".repeat(20), sourceRuntimeFrame: { height: 4, timestamp: 1000 }, entityTxs: [], ...over }) as unknown as Row;
const txs = (row_: Row): readonly unknown[] => row_["entityTxs"] as readonly unknown[];

describe("lane batching: the lane key names the source frame", () => {
  test("two rows of one source frame join, txs in order", () => {
    const out = batchedByLane([row({ entityTxs: ["a"] }), row({ entityTxs: ["b"] })]);
    expect(out.length).toBe(1);
    expect(txs(out[0]!)).toEqual(["a", "b"]);
  });

  test("two source frames of one Account at consecutive heights stay two rows", () => {
    const out = batchedByLane([
      row({ sourceRuntimeFrame: { height: 4, timestamp: 1000 }, entityTxs: ["a"] }),
      row({ sourceRuntimeFrame: { height: 5, timestamp: 1000 }, entityTxs: ["b"] }),
    ]);
    expect(out.map(txs)).toEqual([["a"], ["b"]]);
  });

  test("the same height at another timestamp is another frame", () => {
    const out = batchedByLane([
      row({ sourceRuntimeFrame: { height: 4, timestamp: 1000 }, entityTxs: ["a"] }),
      row({ sourceRuntimeFrame: { height: 4, timestamp: 2000 }, entityTxs: ["b"] }),
    ]);
    expect(out.map(txs)).toEqual([["a"], ["b"]]);
  });

  test("another Runtime, Entity or signer is another lane", () => {
    const out = batchedByLane([
      row({ entityTxs: ["a"] }),
      row({ runtimeId: OTHER_RUNTIME, entityTxs: ["b"] }),
      row({ entityId: "0x" + "00".repeat(31) + "02", entityTxs: ["c"] }),
      row({ signerId: "0x" + "d4".repeat(20), entityTxs: ["d"] }),
    ]);
    expect(out.map(txs)).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });
});

describe("lane batching: a row carrying a consensus payload never batches", () => {
  const payloads: readonly (readonly [string, unknown])[] = [
    ["proposedFrame", { height: 9 }],
    ["hashPrecommits", new Map([["k", "v"]])],
    ["leaderTimeoutVote", { round: 1 }],
    ["jPrefixAttestations", new Map([["k", "v"]])],
  ];
  test.each(payloads)("%s keeps its own row, the tx rows around it join", (key, payload) => {
    const out = batchedByLane([
      row({ entityTxs: ["a"] }),
      row({ entityTxs: ["x"], [key]: payload }),
      row({ entityTxs: ["b"] }),
    ]);
    expect(out.map(txs)).toEqual([["a", "b"], ["x"]]);
  });

  test("a row without txs is not tx-only either", () => {
    const out = batchedByLane([row({ entityTxs: [] }), row({ entityTxs: ["a"] })]);
    expect(out.length).toBe(2);
  });
});

describe("loneCrossJLeg: the rewrite must hold the leg og dropped, for the Runtime og named", () => {
  const halt = (runtimeId: string): string => `CROSS_J_INCOMPLETE_COHORT_DROPPED:${runtimeId}`;
  const leg = (runtimeId: string, accountTxType: string): Record<string, unknown> => ({
    runtimeId,
    entityTxs: [{ data: { proposal: { frame: { accountTxs: [{ type: accountTxType }] } } } }],
  });
  const after = (outputs: readonly Record<string, unknown>[]): Runtime => ({ pendingNetworkOutputs: outputs }) as unknown as Runtime;
  const departure = haltDeparture(halt(RUNTIME))!;

  test("a cross_pull_lock leg for the halted Runtime is the departure", () => {
    expect(departure.instead(after([leg(RUNTIME, "cross_pull_lock")]), halt(RUNTIME))).toBeNull();
  });

  test("the Runtime id compares without case", () => {
    expect(departure.instead(after([leg(RUNTIME.toUpperCase().replace("0X", "0x"), "cross_pull_lock")]), halt(RUNTIME))).toBeNull();
  });

  test("a cross_pull_lock leg for another Runtime does not excuse the halt", () => {
    expect(departure.instead(after([leg(OTHER_RUNTIME, "cross_pull_lock")]), halt(RUNTIME))).not.toBeNull();
  });

  test("another Account tx for the halted Runtime does not either", () => {
    expect(departure.instead(after([leg(RUNTIME, "direct_payment")]), halt(RUNTIME))).not.toBeNull();
  });

  test("an empty retained outbox does not", () => {
    expect(departure.instead(after([]), halt(RUNTIME))).not.toBeNull();
  });
});
