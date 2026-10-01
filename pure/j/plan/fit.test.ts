// R-J3: a group that no single batch could carry is refused when its last op is queued, never sealed.
import { describe, expect, test } from "bun:test";
import { MAX_ENCODED_BYTES } from "../op/limits.ts";
import {
  ME, LEFT_PEER, RIGHT_PEER, bigStart, deposit, finalize, fundSpread, reserveToReserve, reveal, start,
} from "../fixtures.ts";
import type { JOp } from "../op/ops.ts";
import { encodedBytes, fitFault, fitPrefix } from "./fit.ts";

const orZero = (size: ReturnType<typeof encodedBytes>): number => (size.ok ? size.value : 0);

describe("R-J3 the encoded size of a group is judged when an op is queued", () => {
  test("two starts of 140 KiB are one group of 280 KiB: over the limit", () => {
    const draft = [bigStart(LEFT_PEER, 1n, 140), bigStart(RIGHT_PEER, 1n, 140)];
    const fault = fitFault(ME, draft);
    expect(fault._tag === "some" && fault.value._tag).toBe("group_too_large");
    expect(fault._tag === "some" && fault.value._tag === "group_too_large" && fault.value.max).toBe(MAX_ENCODED_BYTES);
  });
  test("one start of 140 KiB is a group that fits", () => {
    expect(fitFault(ME, [bigStart(LEFT_PEER, 1n, 140)])._tag).toBe("none");
  });
  test("a group is judged on its own bytes: big ops in other groups do not add up", () => {
    const draft = [bigStart(LEFT_PEER, 1n, 140), finalize(LEFT_PEER), deposit(1n), reserveToReserve(1n)];
    expect(fitFault(ME, draft)._tag).toBe("none");
  });
  test("one op alone above the limit is refused", () => {
    expect(fitFault(ME, [bigStart(LEFT_PEER, 1n, 260)])._tag).toBe("some");
  });
  test("the largest whole KiB that fits passes and one KiB more is refused", () => {
    const sized = (kib: number): number => orZero(encodedBytes([bigStart(LEFT_PEER, 1n, kib)]));
    const base = sized(100);
    const slack = MAX_ENCODED_BYTES - base;
    expect(slack).toBeGreaterThan(0);
    expect(sized(100 + Math.floor(slack / 1024))).toBeLessThanOrEqual(MAX_ENCODED_BYTES);
    expect(fitFault(ME, [bigStart(LEFT_PEER, 1n, 100 + Math.floor(slack / 1024))])._tag).toBe("none");
    expect(fitFault(ME, [bigStart(LEFT_PEER, 1n, 100 + Math.floor(slack / 1024) + 1)])._tag).toBe("some");
  });
  test("an op the ABI cannot encode is a fault of its own, not a size", () => {
    const broken = reveal(1);
    const bad = broken._tag === "reveal_secret" ? { ...broken, reveal: { ...broken.reveal, secret: "0x12" } } : broken;
    const fault = fitFault(ME, [bad]);
    expect(fault._tag === "some" && fault.value._tag).toBe("unencodable");
  });
  test("a reveal rides with starts in one group, so it is counted with them", () => {
    expect(encodedBytes([start(LEFT_PEER, 1n), reveal(1)]).ok).toBe(true);
  });
});

describe("R-J3 the counts are judged per group, and the draft by the most one batch carries", () => {
  test("two finalizes pass: each is a group of its own", () => {
    expect(fitFault(ME, [finalize(LEFT_PEER, 1n), finalize(RIGHT_PEER, 1n)])._tag).toBe("none");
  });
  test("nine starts fail: they are one group and a batch carries eight", () => {
    const starts = Array.from({ length: 9 }, (_, i) => start(LEFT_PEER, BigInt(i + 1)));
    const fault = fitFault(ME, starts);
    expect(fault._tag === "some" && fault.value._tag).toBe("too_many_of_kind");
  });
  test("a draft of more than fifty ops fails whatever its groups", () => {
    const fifty = Array.from({ length: 51 }, (_, i) => deposit(BigInt(i + 1)));
    const fault = fitFault(ME, fifty);
    expect(fault._tag === "some" && fault.value._tag).toBe("too_many_ops");
  });
});

describe("R-J3 fitPrefix: the longest front of a group that is one batch", () => {
  const funding = (): JOp => fundSpread(64);
  test("four fundings of 64 pairs are 256 pairs: three go, the fourth waits", () => {
    expect(fitPrefix([funding(), funding(), funding(), funding()]).length).toBe(3);
  });
  test("a group that fits goes whole, and an empty group stays empty", () => {
    expect(fitPrefix([funding(), funding()]).length).toBe(2);
    expect(fitPrefix([]).length).toBe(0);
  });
});
