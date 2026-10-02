// The Account's own rules over its Ledgers: what an epoch move does to them (R-LEDGER-REBASE).
import { describe, expect, test } from "bun:test";
import { holdOf, tokenOf } from "./fixtures.ts";
import { emptyLedger } from "./ledger.ts";
import type { AccountState } from "./model.ts";
import { emptyAccount, rebased } from "./state.ts";

const [ONE, TWO] = [tokenOf(1n), tokenOf(2n)];

const busy: AccountState = {
  ...emptyAccount,
  ledgers: new Map([
    [ONE, {
      ...emptyLedger, collateral: 100n, ondelta: 100n, offdelta: -40n, limit: { left: 7n, right: 9n },
      holds: [holdOf("left", 30n, 1n, 115n, 1)],
    }],
    [TWO, { ...emptyLedger, offdelta: 12n }],
  ]),
};

describe("account/state R-LEDGER-REBASE an epoch move restarts every offdelta from zero", () => {
  test("R-LEDGER-REBASE every token's offdelta is zero and everything else of the Account is as it was", () => {
    const after = rebased(busy);
    expect([...after.ledgers.values()].map((l) => l.offdelta)).toEqual([0n, 0n]);
    [ONE, TWO].forEach((token) => {
      expect(after.ledgers.get(token)).toEqual({ ...(busy.ledgers.get(token) ?? emptyLedger), offdelta: 0n });
    });
    expect([after.quotes, after.offers]).toEqual([busy.quotes, busy.offers]);
  });

  test("R-LEDGER-REBASE rebasing twice changes nothing, and an Account with no ledger has none to rebase", () => {
    expect(rebased(rebased(busy))).toEqual(rebased(busy));
    expect(rebased(emptyAccount)).toEqual(emptyAccount);
  });
});
