import { describe, expect, test } from "bun:test";
import { signing, viewOf } from "../../account/fixtures.ts";
import { holdOf, secretOf } from "../../account/fixtures.ts";
import { emptyLedger } from "../../account/ledger.ts";
import { holdId, type AccountState, type Side } from "../../account/model.ts";
import type { AccountTx } from "../../account/tx.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { GOLD, judge } from "../fixtures.ts";
import { entityRules } from "../rules.ts";

const DEADLINE = 105n;
const LATE = { ...judge, view: viewOf(DEADLINE + 3n) };
const HASHLOCK = keccakHex(secretOf(1));

/** An Account whose one clause, in slot 1, is locked by Left on the secret number 1 and due at the deadline. */
const clausing: AccountState = {
  ledgers: new Map([[GOLD, {
    ...emptyLedger, collateral: 100n, limit: { left: 100n, right: 100n },
    holds: [holdOf("left", 5n, 1n, DEADLINE, 1)],
  }]]),
  quotes: [], offers: [],
};
const expire: AccountTx = { _tag: "expire", token: GOLD, id: holdId(1n) };

const applied = (shown: ReadonlyMap<string, bigint>, author: Side) =>
  entityRules(LATE, signing, { self: "left", frozen: false, unruled: new Set(), blind: false, shown })
    .apply(clausing, author, expire);

describe("entity/rules R-REVEAL-BACKSTOP the chain's paid clause is not expired", () => {
  const refused = { ok: false as const, error: { _tag: "revealed_on_chain" as const } };

  test("R-REVEAL-BACKSTOP an expiry is refused for a hold whose secret was shown at or before its deadline", () => {
    expect(["left", "right"].map((author) => applied(new Map([[HASHLOCK, DEADLINE]]), author as Side)))
      .toEqual([refused, refused]);
    expect(["left", "right"].map((author) => applied(new Map([[HASHLOCK, 1n]]), author as Side)))
      .toEqual([refused, refused]);
  });

  test("R-REVEAL-BACKSTOP a secret shown after the deadline pays nothing: the expiry stands", () => {
    expect(applied(new Map([[HASHLOCK, DEADLINE + 1n]]), "right").ok).toBe(true);
  });

  test("R-REVEAL-BACKSTOP the expiry of a hold nobody showed the secret of, or of another hashlock's, stands", () => {
    expect(applied(new Map(), "right").ok).toBe(true);
    expect(applied(new Map([[keccakHex(secretOf(2)), 1n]]), "right").ok).toBe(true);
  });

  test("R-REVEAL-BACKSTOP the refusal is for good: no wait lifts it, so the payee's way is a dispute", () => {
    const rules = entityRules(LATE, signing, {
      self: "left", frozen: false, unruled: new Set(), blind: false, shown: new Map(),
    });
    expect(rules.retryable("revealed_on_chain")).toBe(false);
  });
});
