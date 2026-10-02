// The edges of what an Entity tells the chain and the order it tells it in (R-WINDOWS-NEVER-SHORTEN,
// R-NO-DEPOSIT-BEFORE-COSIGN, R-HTLC-CLOCK, R-DISPUTE-WATCH). Review B of PR 99: three mutants lived on the edges the
// slice's tests do not touch: a window of the largest uint32 refused, a deposit above the largest amount taken, and a
// counter asked ahead of a reveal.
import { describe, expect, test } from "bun:test";
import { emptyReplica } from "../../account/frame/account.ts";
import { holdOf, secretOf, viewOf } from "../../account/fixtures.ts";
import { emptyLedger, MAX_AMOUNT } from "../../account/ledger.ts";
import { holdId } from "../../account/model.ts";
import { emptyAccount, withLedger } from "../../account/state.ts";
import { withWindows, freshChain } from "../chain.ts";
import { anchor, entityOf, GOLD, judge, OPENED_WITH } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import { emptyEntity, type ChainFacts, type EntityInput, type EntityState } from "../model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const UINT32 = 2n ** 32n - 1n;

const run = (state: EntityState, view: bigint, ...inputs: readonly EntityInput[]) =>
  entityFrame({ ...judge, view: viewOf(view) }, anchor, state, inputs);

describe("entity/bounds the windows and amounts an Entity tells the chain are whole numbers that fit", () => {
  test("R-WINDOWS-NEVER-SHORTEN the largest window a uint32 holds is taken, one second more is not", () => {
    expect(withWindows(freshChain, { left: UINT32, right: UINT32 }).ok).toBe(true);
    expect(withWindows(freshChain, { left: UINT32 + 1n, right: 1n }).ok).toBe(false);
    expect(withWindows(freshChain, { left: 1n, right: UINT32 + 1n }).ok).toBe(false);
  });

  test("R-NO-DEPOSIT-BEFORE-COSIGN the largest amount is deposited, one more is refused for its size", () => {
    const account = emptyReplica("left");
    const facts = new Map([[BOB, { ...freshChain, epoch: 1n }]]);
    const held: EntityState = { ...emptyEntity(ALICE), accounts: new Map([[BOB, account]]), chain: facts };
    const deposit = (amount: bigint): EntityInput => ({ _tag: "deposit", peer: BOB, token: GOLD, amount });
    expect(run(held, 100n, deposit(MAX_AMOUNT)).chain).toMatchObject([{ _tag: "deposit", amount: MAX_AMOUNT }]);
    const over = run(held, 100n, deposit(MAX_AMOUNT + 1n));
    expect(over.chain).toEqual([]);
    expect(over.notices).toMatchObject([{ _tag: "command_refused", fault: { _tag: "account_refused" } }]);
  });
});

describe("entity/bounds what the chain is asked in one frame comes in one order", () => {
  test("R-HTLC-CLOCK R-DISPUTE-WATCH a frame that owes a reveal and a counter asks the reveal first", () => {
    const hold = holdOf("left", 30n, 1n, 115n);
    const ledger = { ...emptyLedger, holds: [hold] };
    const resolve = { _tag: "resolve", token: GOLD, id: holdId(1n), secret: secretOf(1) } as const;
    const replica = { ...emptyReplica("right"), state: withLedger(emptyAccount, GOLD, ledger), mempool: [resolve] };
    const against = { nonce: 2n, proposerIsLeft: true, bodyHash: OPENED_WITH.bodyHash, window: 500n, over: false };
    const facts: ChainFacts =
      { ...freshChain, epoch: 1n, stored: 2n, frames: 1n, against: { ...against, answer: undefined } };
    const proof = { head: replica.head, slot: 0, author: "left", sig: "0x51" } as const;
    const state: EntityState = {
      ...emptyEntity(BOB), accounts: new Map([[ALICE, replica]]), chain: new Map([[ALICE, facts]]),
      proofs: new Map([[ALICE, proof]]),
    };
    expect(run(state, 114n).chain.map((a) => a._tag)).toEqual(["reveal", "counter"]);
  });
});
