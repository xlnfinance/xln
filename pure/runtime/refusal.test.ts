// What a peer that cannot be followed does to a Runtime and what the Runtime says back (R-X1, R-NOTICE,
// R-FRAME-REFUSAL), and the order a Runtime keeps (R-DURABLE rows leave in row order, R-CLOCK a stamp never goes back).
// Review B of PR 93: the two ends of the refusal path were not reached by the slice's tests, and mutants that silenced
// them, reversed the flush or dropped the stamp of a refused row lived.
import { describe, expect, test } from "bun:test";
import { emptyReplica, GENESIS } from "../account/frame/account.ts";
import type { Frame, Msg } from "../account/frame/frame.ts";
import { emptyLedger } from "../account/ledger.ts";
import { emptyAccount, withLedger } from "../account/state.ts";
import type { AccountTx } from "../account/tx.ts";
import { entityFrame } from "../entity/frame.ts";
import { emptyEntity, type EntityId, type EntityInput, type EntityState } from "../entity/model.ts";
import { anchor, credit, entityOf, GOLD, judge, open, pay } from "../entity/fixtures.ts";
import { inputFor, setup, stamp, started, tick } from "./fixtures.ts";
import { flush, recover, startRuntime } from "./tick.ts";
import type { Row } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const payFrame = (author: "left" | "right", amount: bigint): Msg<AccountTx> => {
  const slot = author === "left" ? 2 : 1;
  const frame: Frame<AccountTx> = {
    author, parent: GENESIS, attempt: 0, slot, epoch: 0n, firstNonce: 2n, txs: [{ _tag: "pay", token: GOLD, amount }],
  };
  return { _tag: "frame", frame };
};

const fromPeer = (from: EntityId, msg: Msg<AccountTx> | undefined): EntityInput =>
  ({ _tag: "peer_message", from, msg: msg ?? payFrame("left", 0n) });

/** An Entity whose Account with `peer` is open and holds `limit` of credit extended to its Left. */
const holdingCredit = (self: EntityId, peer: EntityId, side: "left" | "right", limit: bigint): EntityState => {
  const state = withLedger(emptyAccount, GOLD, { ...emptyLedger, limit: { left: limit, right: 0n } });
  return { ...emptyEntity(self), accounts: new Map([[peer, { ...emptyReplica(side), state }]]) };
};

const opened = (self: EntityId, peer: EntityId) => tick(started(self), inputFor(self, 1n, open(peer)));

const tagsOf = (outputs: readonly { msg: Msg<AccountTx> }[]) => outputs.map((o) => o.msg._tag);

describe("runtime/refusal a frame the Runtime cannot apply or does not own is refused in place", () => {
  test("R-X1 R-NOTICE a frame that does not apply is refused to its sender, naming its first bad tx", () => {
    const bob = opened(BOB, ALICE).runtime;
    const heard = tick(bob, inputFor(BOB, 2n, fromPeer(ALICE, payFrame("left", 30n))));
    const row = heard.runtime.wal[1];
    expect(row?.notices.map((n) => n._tag)).toEqual(["message_refused"]);
    expect(row?.notices[0]).toMatchObject({ from: ALICE, outcome: { _tag: "refused_invalid" } });
    expect(heard.leaving).toHaveLength(1);
    expect(heard.leaving[0]?.msg).toMatchObject({ _tag: "refusal", index: 0, fault: "insufficient_capacity", mark: 0 });
    expect(heard.runtime.entities.get(BOB)?.accounts.get(ALICE)?.head).toBe(GENESIS);
  });

  test("R-X1 R-NOTICE a frame written by the receiver's own side is refused with notice, and not answered", () => {
    const bob = opened(BOB, ALICE).runtime;
    const heard = tick(bob, inputFor(BOB, 2n, fromPeer(ALICE, payFrame("right", 30n))));
    const notice = heard.runtime.wal[1]?.notices[0];
    expect(notice).toMatchObject({ _tag: "message_refused", outcome: { _tag: "refused_own" } });
    expect(heard.leaving).toEqual([]);
  });

  test("R-FRAME-REFUSAL a payment the peer cannot apply is dropped with notice to its payer, no wedge", () => {
    // Alice believes Bob extended her 100 of credit; Bob's own Account says he did not: a peer that diverged.
    const alice = startRuntime(setup, [holdingCredit(ALICE, BOB, "left", 100n)]);
    const bob = startRuntime(setup, [holdingCredit(BOB, ALICE, "right", 0n)]);
    const paid = tick(alice, inputFor(ALICE, 1n, pay(BOB, 30n)));
    expect(tagsOf(paid.leaving)).toEqual(["frame"]);
    const refused = tick(bob, inputFor(BOB, 1n, fromPeer(ALICE, paid.leaving[0]?.msg)));
    expect(tagsOf(refused.leaving)).toEqual(["refusal"]);
    const refusal = fromPeer(BOB, refused.leaving[0]?.msg);
    const told = tick(paid.runtime, inputFor(ALICE, 2n, refusal));
    const account = told.runtime.entities.get(ALICE)?.accounts.get(BOB);
    expect([account?.pending, account?.mempool, account?.attempt]).toEqual([undefined, [], 1]);
    expect(told.leaving).toEqual([]);
    expect(told.runtime.wal[1]?.notices).toMatchObject([
      { _tag: "tx_refused", peer: BOB, refused: { tx: { _tag: "pay", amount: 30n }, fault: { _tag: "peer_refused" } } },
    ]);
    const again = tick(told.runtime, inputFor(ALICE, 3n, refusal));
    expect(again.runtime.wal[2]?.notices).toEqual([]);
  });
});

describe("runtime/tick the order a Runtime keeps", () => {
  test("R-DURABLE the outputs of committed rows leave in row order, and a row's own outputs in their order", () => {
    // Bob's third row hears Alice's frame and proposes his own again: its ack goes out, then his frame.
    const alice = tick(started(ALICE), inputFor(ALICE, 1n, open(BOB), credit(BOB, 50n)));
    const bobOpened = opened(BOB, ALICE);
    const bobProposed = tick(bobOpened.runtime, inputFor(BOB, 2n, credit(ALICE, 100n)));
    const heard = tick(bobProposed.runtime, inputFor(BOB, 3n, fromPeer(ALICE, alice.leaving[0]?.msg)));
    expect(tagsOf(heard.leaving)).toEqual(["ack", "frame"]);
    const crashed = { ...heard.runtime, sent: 0 };
    expect(tagsOf(flush(crashed).leaving)).toEqual(["frame", "ack", "frame"]);
  });

  test("R-CLOCK an input refused for an unknown Entity still moves the stamp: a later row never goes back", () => {
    const bob = opened(BOB, ALICE).runtime;
    const stray = tick(bob, inputFor(entityOf(9), 500n, open(ALICE)));
    const later = tick(stray.runtime, inputFor(BOB, 10n, credit(ALICE, 1n)));
    expect(later.runtime.wal.map((row) => row.stamp)).toEqual([stamp(1n), stamp(500n), stamp(500n)]);
  });

  test("R-NOTICE the txs an Account refused are told in the order it refused them, and it forgets them", () => {
    const refused = (amount: bigint) =>
      ({ tx: { _tag: "pay", token: GOLD, amount }, fault: { _tag: "bad_amount", amount } }) as const;
    const holding: EntityState = {
      ...emptyEntity(ALICE),
      accounts: new Map([[BOB, { ...emptyReplica("left"), refused: [refused(1n), refused(2n)] }]]),
    };
    const told = entityFrame(judge, anchor, holding, []);
    const amounts = told.notices.flatMap((n) =>
      (n._tag === "tx_refused" && n.refused.tx._tag === "pay" ? [n.refused.tx.amount] : []));
    expect(amounts).toEqual([1n, 2n]);
    expect(told.state.accounts.get(BOB)?.refused).toEqual([]);
  });
});

/** The WAL with the first output of row `at` made into another message of the same kind. */
const tamperedFirstOutput = (rows: readonly Row[], at: number, change: (msg: Msg<AccountTx>) => Msg<AccountTx>) =>
  rows.map((row, i) => {
    const outputs = row.outputs.map((o, j) => (j === 0 ? { ...o, msg: change(o.msg) } : o));
    return i === at ? { ...row, outputs } : row;
  });

describe("runtime/replay a replay that makes another output than the WAL holds has diverged", () => {
  const alice = startRuntime(setup, [holdingCredit(ALICE, BOB, "left", 100n)]);
  const aliceRow = tick(alice, inputFor(ALICE, 1n, pay(BOB, 30n))).runtime.wal;
  const bobCredited = [holdingCredit(BOB, ALICE, "right", 100n)];
  const aliceFrame = fromPeer(ALICE, aliceRow[0]?.outputs[0]?.msg);
  const bobHears = tick(startRuntime(setup, bobCredited), inputFor(BOB, 1n, aliceFrame));
  const bobDiverged = [holdingCredit(BOB, ALICE, "right", 0n)];
  const bobRefuses = tick(startRuntime(setup, bobDiverged), inputFor(BOB, 1n, aliceFrame));
  const diverges = (genesis: readonly EntityState[], rows: readonly Row[]) =>
    expect(recover(setup, genesis, rows)).toEqual({ ok: false, error: { _tag: "replay_diverged", height: 1n } });

  test("R-DURABLE the untouched WALs replay", () => {
    expect(recover(setup, [holdingCredit(ALICE, BOB, "left", 100n)], aliceRow).ok).toBe(true);
    expect(recover(setup, bobCredited, bobHears.runtime.wal).ok).toBe(true);
    expect(recover(setup, bobDiverged, bobRefuses.runtime.wal).ok).toBe(true);
  });

  test("R-DURABLE a frame with the same parent and other txs is another output", () => {
    const txs: readonly AccountTx[] = [{ _tag: "pay", token: GOLD, amount: 31n }];
    const other = (msg: Msg<AccountTx>): Msg<AccountTx> =>
      (msg._tag === "frame" ? { ...msg, frame: { ...msg.frame, txs } } : msg);
    diverges([holdingCredit(ALICE, BOB, "left", 100n)], tamperedFirstOutput(aliceRow, 0, other));
  });

  test("R-DURABLE an ack of another frame is another output", () => {
    const other = (msg: Msg<AccountTx>): Msg<AccountTx> => (msg._tag === "ack" ? { ...msg, hash: GENESIS } : msg);
    diverges(bobCredited, tamperedFirstOutput(bobHears.runtime.wal, 0, other));
  });

  test("R-DURABLE a refusal naming another tx is another output, and so is one carrying another mark", () => {
    const index = (msg: Msg<AccountTx>): Msg<AccountTx> =>
      (msg._tag === "refusal" ? { ...msg, index: msg.index + 1 } : msg);
    const mark = (msg: Msg<AccountTx>): Msg<AccountTx> =>
      (msg._tag === "refusal" ? { ...msg, mark: msg.mark + 1 } : msg);
    diverges(bobDiverged, tamperedFirstOutput(bobRefuses.runtime.wal, 0, index));
    diverges(bobDiverged, tamperedFirstOutput(bobRefuses.runtime.wal, 0, mark));
  });
});
