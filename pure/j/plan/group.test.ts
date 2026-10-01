// R-SPLIT, J6, R-COSIGN: which ops of a draft may travel in one batch.
import { describe, expect, test } from "bun:test";
import { groupsOf } from "./group.ts";
import { accountsOf, classOf, isCosigned, type JOp } from "../op/ops.ts";
import {
  ME, LEFT_PEER, RIGHT_PEER, TOKEN, pick, counter, deposit, finalize, fund, reserveToExternal, reserveToReserve, reveal,
  settle, start, withdraw,
} from "../fixtures.ts";

const tags = (group: readonly JOp[]): readonly string[] => group.map((op) => op._tag);

const mixed: readonly JOp[] = [
  reserveToReserve(4n), deposit(10n), settle(LEFT_PEER, -2n), start(LEFT_PEER), finalize(RIGHT_PEER), reveal(1),
  withdraw(RIGHT_PEER, 3n), deposit(20n), fund(LEFT_PEER, 5n), counter(RIGHT_PEER), reserveToExternal(1n),
];

describe("R-SPLIT dispute, reveal and deposit ops never share a batch with payment, settlement or reserve ops", () => {
  test("every group is all hard or all soft", () => {
    groupsOf(ME, mixed).forEach((group) => {
      const classes = new Set(group.map(classOf));
      expect(classes.size).toBe(1);
    });
  });
  test("a draft of one hard and one soft op offers two groups, not one", () => {
    expect(groupsOf(ME, [reserveToReserve(1n), start(LEFT_PEER)]).map(tags))
      .toEqual([["dispute_start"], ["reserve_to_reserve"]]);
  });
  test("every op of the draft is in some group, and none in two", () => {
    const groups = groupsOf(ME, mixed);
    const used = groups.flat();
    mixed.forEach((op) => expect(used.filter((u) => u === op).length).toBe(1));
  });
});

describe("J6 a deposit leg travels alone", () => {
  test("each deposit is a group of its own, among payments and disputes", () => {
    const groups = groupsOf(ME, mixed).filter((g) => g.some((op) => op._tag === "deposit"));
    expect(groups.map(tags)).toEqual([["deposit"], ["deposit"]]);
  });
});

describe("a finalize travels alone: its own batch, because an open HTLC deadline reverts the whole batch", () => {
  test("each finalize is a group of its own and no dispute op rides with it", () => {
    const groups = groupsOf(ME, [start(LEFT_PEER), finalize(LEFT_PEER), finalize(RIGHT_PEER), counter(LEFT_PEER)]);
    expect(groups.map(tags))
      .toEqual([["dispute_start", "dispute_counter"], ["dispute_finalize"], ["dispute_finalize"]]);
  });
});

describe("R-COSIGN a batch with a co-signed op carries ops of that one Account only", () => {
  const draft: readonly JOp[] = [
    settle(LEFT_PEER, -2n), withdraw(LEFT_PEER, 3n), settle(RIGHT_PEER, 1n), fund(LEFT_PEER, 5n),
    fund(RIGHT_PEER, 5n), reserveToReserve(1n),
  ];
  const groups = groupsOf(ME, draft);

  test("one group per co-signed Account, with that Account's co-signed ops and its funding", () => {
    expect(groups.slice(0, 2).map(tags)).toEqual([
      ["settle", "collateral_to_reserve", "reserve_to_collateral"], ["settle", "reserve_to_collateral"],
    ]);
    expect(groups[0]).toEqual(pick(draft, 0, 1, 3));
    expect(groups[1]).toEqual(pick(draft, 2, 4));
  });
  test("a reserve transfer touches no Account and is in no co-signed group", () => {
    expect(groups.slice(0, 2).flat().some((op) => op._tag === "reserve_to_reserve")).toBe(false);
  });
  test("a funding that names two counterparties is not in the group of either", () => {
    const pairs = [{ entity: LEFT_PEER, amount: 1n }, { entity: RIGHT_PEER, amount: 1n }];
    const two: JOp = { _tag: "reserve_to_collateral", funding: { tokenId: TOKEN, receivingEntity: ME, pairs } };
    expect(groupsOf(ME, [settle(LEFT_PEER, -1n), two]).slice(0, 1).map(tags)).toEqual([["settle"]]);
  });
  test("no group carries a co-signed op together with an op of another Account or of none", () => {
    const cosignedGroups = groups.filter((g) => g.some(isCosigned));
    expect(cosignedGroups.length).toBe(2);
    cosignedGroups.forEach((g) => {
      expect(g.every((op) => accountsOf(ME, op).length > 0)).toBe(true);
      expect(new Set(g.flatMap((op) => accountsOf(ME, op))).size).toBe(1);
    });
  });
});

describe("the groups come most urgent first", () => {
  test("reveals, starts and counters, then finalizes, then deposits, then co-signed, then the rest", () => {
    expect(groupsOf(ME, mixed).map(tags)).toEqual([
      ["dispute_start", "reveal_secret", "dispute_counter"],
      ["dispute_finalize"],
      ["deposit"], ["deposit"],
      ["settle", "reserve_to_collateral"],
      ["collateral_to_reserve"],
      ["reserve_to_reserve", "reserve_to_external"],
    ]);
  });
  test("an empty draft has no group", () => expect(groupsOf(ME, [])).toEqual([]));
});
