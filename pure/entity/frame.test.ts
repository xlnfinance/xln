import { describe, expect, test } from "bun:test";
import { emptyReplica } from "../account/frame/account.ts";
import { queue, type FrameHash, type Msg } from "../account/frame/frame.ts";
import { ledgerOf } from "../account/state.ts";
import type { AccountTx } from "../account/tx.ts";
import { anchor, credit, entityOf, GOLD, judge, open, pay, TEST_SIG } from "./fixtures.ts";
import { entityFrame } from "./frame.ts";
import { emptyEntity, entityId, sideOf, type EntityInput, type EntityState, type Outbound } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);
const DAVE = entityOf(4);

const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, anchor, state, inputs);

/** An Entity that has opened its Accounts with `peers`. */
const opened = (self: typeof ALICE, ...peers: readonly typeof ALICE[]): EntityState =>
  run(emptyEntity(self), ...peers.map(open)).state;

const aliceAndBob = opened(ALICE, BOB);
const bobAndAlice = opened(BOB, ALICE);

/** Bob has proposed `limit` of credit to Alice: the frame he sends, and Bob's own state holding it pending. */
const creditFromBob = (limit: bigint) => {
  const framed = run(bobAndAlice, credit(ALICE, limit));
  return { bob: framed.state, sent: framed.outputs };
};

const peerMessage = (from: typeof ALICE, msg: Msg<AccountTx>): EntityInput =>
  ({ _tag: "peer_message", from, msg, sig: TEST_SIG });

const toAlice = (outputs: readonly Outbound[]): EntityInput => {
  const first = outputs[0];
  return first === undefined ? expect.unreachable("nothing sent") : peerMessage(BOB, first.msg);
};

const peers = (outputs: readonly Outbound[]) => outputs.map((o) => o.to);

describe("entity ids and sides", () => {
  test("an id is 0x and 64 lowercase hex digits", () => {
    expect(entityId(ALICE).ok).toBe(true);
    expect(entityId("0x01").ok).toBe(false);
    expect(entityId(ALICE.toUpperCase()).ok).toBe(false);
  });

  test("the smaller id is the Left of the Account, on both ends", () => {
    expect(sideOf(ALICE, BOB)).toBe("left");
    expect(sideOf(BOB, ALICE)).toBe("right");
  });
});

describe("entity/frame commands", () => {
  test("opening an Account makes an empty replica on the side the ids give", () => {
    expect(aliceAndBob.accounts.get(BOB)).toEqual(emptyReplica("left"));
    expect(bobAndAlice.accounts.get(ALICE)).toEqual(emptyReplica("right"));
  });

  test("R-NOTICE an Account opened twice, with oneself, or a command to a stranger is refused with notice", () => {
    const again = run(aliceAndBob, open(BOB));
    expect(again.notices).toEqual([
      { _tag: "command_refused", command: open(BOB), fault: { _tag: "account_exists", peer: BOB } },
    ]);
    expect(again.state).toEqual(aliceAndBob);
    expect(run(aliceAndBob, open(ALICE)).notices).toEqual([
      { _tag: "command_refused", command: open(ALICE), fault: { _tag: "self_account" } },
    ]);
    expect(run(aliceAndBob, pay(CAROL, 5n)).notices).toEqual([
      { _tag: "command_refused", command: pay(CAROL, 5n), fault: { _tag: "no_account", peer: CAROL } },
    ]);
  });

  test("R-NOTICE a payment beyond the room is refused at the door with its fault, and nothing is queued", () => {
    const framed = run(aliceAndBob, pay(BOB, 5n));
    expect(framed.notices).toEqual([{
      _tag: "command_refused",
      command: pay(BOB, 5n),
      fault: { _tag: "account_refused", fault: { _tag: "insufficient_capacity", available: 0n, requested: 5n } },
    }]);
    expect(framed.outputs).toEqual([]);
    expect(framed.state).toEqual(aliceAndBob);
  });

  test("a command proposes its Account's frame on the committed head, and the Account is then pending", () => {
    const framed = run(bobAndAlice, credit(ALICE, 100n));
    expect(framed.notices).toEqual([]);
    expect(peers(framed.outputs)).toEqual([ALICE]);
    expect(framed.state.accounts.get(ALICE)?.pending?.frame.txs).toEqual([
      { _tag: "set_credit", token: GOLD, limit: 100n },
    ]);
  });
});

describe("entity/frame arrivals", () => {
  test("a peer's frame commits and is acked; the ack commits the proposer's frame", () => {
    const { bob, sent } = creditFromBob(100n);
    const arrived = run(aliceAndBob, toAlice(sent));
    expect(peers(arrived.outputs)).toEqual([BOB]);
    expect(ledgerOf(arrived.state.accounts.get(BOB)?.state ?? expect.unreachable("no account"), GOLD).limit.left)
      .toBe(100n);
    const acked = run(bob, peerMessage(ALICE, arrived.outputs[0]?.msg ?? expect.unreachable("no ack")));
    expect(acked.state.accounts.get(ALICE)?.pending).toBeUndefined();
    expect(acked.state.accounts.get(ALICE)?.head).toBe(arrived.state.accounts.get(BOB)?.head);
  });

  test("R-X1 a message from a stranger is refused with notice and changes nothing", () => {
    const { sent } = creditFromBob(100n);
    const framed = run(emptyEntity(ALICE), toAlice(sent));
    expect(framed.notices).toEqual([{ _tag: "unknown_peer", from: BOB }]);
    expect(framed.outputs).toEqual([]);
    expect(framed.state).toEqual(emptyEntity(ALICE));
  });

  test("a frame that is not the next one is refused with notice and answered with nothing", () => {
    const { sent } = creditFromBob(100n);
    const framed = run(aliceAndBob, toAlice(sent), toAlice(sent));
    expect(framed.notices).toEqual([]);
    const elsewhere = `0x${"ab".repeat(32)}` as FrameHash;
    const txs: readonly AccountTx[] = [{ _tag: "set_credit", token: GOLD, limit: 1n }];
    const frame = { author: "right", parent: elsewhere, attempt: 0, slot: 1, epoch: 0n, firstNonce: 2n, txs } as const;
    const behind = run(framed.state, peerMessage(BOB, { _tag: "frame", frame }));
    expect(behind.notices.map((n) => n._tag)).toEqual(["message_refused"]);
    expect(behind.outputs).toEqual([]);
  });
});

describe("entity/frame phases", () => {
  test("R-E1 a command sees what the arrivals of its own frame did, wherever the arrival sits among the inputs", () => {
    const { sent } = creditFromBob(100n);
    const arrival = toAlice(sent);
    const payment = pay(BOB, 30n);
    const arrivalFirst = run(aliceAndBob, arrival, payment);
    const arrivalLast = run(aliceAndBob, payment, arrival);
    expect(arrivalFirst.notices).toEqual([]);
    expect(arrivalLast).toEqual(arrivalFirst);
    expect(arrivalFirst.state.accounts.get(BOB)?.pending?.frame.txs).toEqual([
      { _tag: "pay", token: GOLD, amount: 30n },
    ]);
  });

  test("R-E1 the ack of an arrival goes out ahead of the frame the commands propose", () => {
    const { sent } = creditFromBob(100n);
    const framed = run(aliceAndBob, pay(BOB, 30n), toAlice(sent));
    expect(framed.outputs.map((o) => o.msg._tag)).toEqual(["ack", "frame"]);
  });

  test("R-E4 Accounts propose in the order a command first touched them, then the rest by id", () => {
    const state = opened(ALICE, BOB, CAROL, DAVE);
    const waiting = state.accounts.get(CAROL) ?? expect.unreachable("no account");
    const withQueued: EntityState = {
      ...state,
      accounts: new Map([...state.accounts, [CAROL, queue(waiting, { _tag: "set_credit", token: GOLD, limit: 7n })]]),
    };
    const framed = run(withQueued, credit(DAVE, 1n), credit(BOB, 2n), credit(DAVE, 3n));
    expect(peers(framed.outputs)).toEqual([DAVE, BOB, CAROL]);
  });

  test("R-E4 an Account touched twice proposes once, with both txs in one frame", () => {
    const framed = run(opened(ALICE, BOB), credit(BOB, 1n), credit(BOB, 2n));
    expect(framed.outputs).toHaveLength(1);
    expect(framed.state.accounts.get(BOB)?.pending?.frame.txs).toHaveLength(2);
  });

  test("R-NOTICE a queued tx the Account refuses at propose is told to the Entity, and the Account forgets it", () => {
    const state = aliceAndBob;
    const account = state.accounts.get(BOB) ?? expect.unreachable("no account");
    const overdraft: AccountTx = { _tag: "pay", token: GOLD, amount: 5n };
    const stale = { ...state, accounts: new Map([[BOB, queue(account, overdraft)]]) };
    const framed = run(stale);
    expect(framed.notices).toEqual([{
      _tag: "tx_refused",
      peer: BOB,
      refused: { tx: overdraft, fault: { _tag: "insufficient_capacity", available: 0n, requested: 5n } },
    }]);
    expect(framed.state.accounts.get(BOB)?.refused).toEqual([]);
    expect(framed.state.accounts.get(BOB)?.mempool).toEqual([]);
  });

  test("a hook sends the pending frame again, and sends nothing for an Account with none or a stranger", () => {
    const { bob, sent } = creditFromBob(100n);
    const again = run(bob, { _tag: "resend_due", peer: ALICE });
    expect(again.outputs).toEqual(sent);
    expect(run(bobAndAlice, { _tag: "resend_due", peer: ALICE }).outputs).toEqual([]);
    expect(run(bob, { _tag: "resend_due", peer: CAROL }).outputs).toEqual([]);
  });
});

describe("entity/frame review A: order inside a phase, and what the owner is told", () => {
  const aliceWithBobAndCarol = (): EntityState => {
    const state = opened(ALICE, BOB, CAROL);
    const queued = (peer: typeof ALICE, limit: bigint) =>
      queue(state.accounts.get(peer) ?? expect.unreachable("no account"), { _tag: "set_credit", token: GOLD, limit });
    return { ...state, accounts: new Map([[BOB, queued(BOB, 1n)], [CAROL, queued(CAROL, 2n)]]) };
  };

  const framesFromBob = () => {
    const first = creditFromBob(100n);
    const toAliceFirst = run(aliceAndBob, toAlice(first.sent));
    const acked = run(first.bob, peerMessage(ALICE, toAliceFirst.outputs[0]?.msg ?? expect.unreachable("no ack")));
    const second = run(acked.state, credit(ALICE, 200n));
    return { first: toAlice(first.sent), second: toAlice(second.outputs) };
  };

  test("R-E1 a hook sees the Accounts after the arrivals of its frame: an ack in it takes the resend away", () => {
    const { bob, sent } = creditFromBob(100n);
    const alice = run(aliceAndBob, toAlice(sent));
    const ack = peerMessage(ALICE, alice.outputs[0]?.msg ?? expect.unreachable("no ack"));
    const together = run(bob, { _tag: "resend_due", peer: ALICE }, ack);
    expect(together.outputs).toEqual([]);
    expect(together.state.accounts.get(ALICE)?.pending).toBeUndefined();
  });

  test("R-E1 arrivals fold in the order they came: two frames of one peer in one input both commit", () => {
    const { first, second } = framesFromBob();
    const framed = run(aliceAndBob, first, second);
    expect(framed.notices).toEqual([]);
    expect(framed.outputs.map((o) => o.msg._tag)).toEqual(["ack", "ack"]);
    expect(ledgerOf(framed.state.accounts.get(BOB)?.state ?? expect.unreachable("no account"), GOLD).limit.left)
      .toBe(200n);
  });

  test("R-E1 commands fold in the order they came: the last credit set is the one that stands", () => {
    const framed = run(opened(ALICE, BOB), credit(BOB, 100n), credit(BOB, 200n));
    expect(framed.state.accounts.get(BOB)?.pending?.frame.txs).toEqual([
      { _tag: "set_credit", token: GOLD, limit: 100n }, { _tag: "set_credit", token: GOLD, limit: 200n },
    ]);
  });

  test("R-E4 a command the door refused does not claim a place: Accounts propose by id", () => {
    const framed = run(aliceWithBobAndCarol(), pay(CAROL, 5n));
    expect(framed.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    expect(peers(framed.outputs)).toEqual([BOB, CAROL]);
  });

  test("R-E4 the Accounts no command touched propose by ascending id, after the touched ones", () => {
    const state = opened(ALICE, BOB, CAROL, DAVE);
    const waiting = (peer: typeof ALICE, limit: bigint) =>
      queue(state.accounts.get(peer) ?? expect.unreachable("no account"), { _tag: "set_credit", token: GOLD, limit });
    const queuedAll: EntityState = {
      ...state, accounts: new Map([[BOB, waiting(BOB, 1n)], [CAROL, waiting(CAROL, 2n)], [DAVE, waiting(DAVE, 3n)]]),
    };
    expect(peers(run(queuedAll, credit(DAVE, 9n)).outputs)).toEqual([DAVE, BOB, CAROL]);
  });

  type Side = "left" | "right";
  const frameOf = (author: Side, parent: FrameHash, attempt: number, txs: readonly AccountTx[]): EntityInput =>
    peerMessage(BOB, {
      _tag: "frame",
      frame: { author, parent, attempt, slot: author === "left" ? 2 : 1, epoch: 0n, firstNonce: 2n, txs },
    });

  test("R-NOTICE every refusal of a peer's message reaches the owner with its peer and its outcome", () => {
    const head = aliceAndBob.accounts.get(BOB)?.head ?? expect.unreachable("no account");
    const overdraft: AccountTx = { _tag: "pay", token: GOLD, amount: 5n };
    const heardWith = (input: EntityInput) => run(aliceAndBob, input).notices;
    expect(heardWith(frameOf("right", head, 0, []))).toEqual([
      { _tag: "message_refused", from: BOB, outcome: { _tag: "refused_empty" } },
    ]);
    expect(heardWith(frameOf("left", head, 0, [overdraft]))).toEqual([
      { _tag: "message_refused", from: BOB, outcome: { _tag: "refused_own" } },
    ]);
    expect(heardWith(frameOf("right", head, -1, [overdraft]))).toEqual([
      { _tag: "message_refused", from: BOB, outcome: { _tag: "refused_attempt" } },
    ]);
    expect(heardWith(frameOf("right", head, 0, [overdraft]))).toEqual([{
      _tag: "message_refused",
      from: BOB,
      outcome: { _tag: "refused_invalid", fault: { _tag: "insufficient_capacity", available: 0n, requested: 5n } },
    }]);
  });

  test("R-NOTICE every tx an Account refused is told, and so is every Account's", () => {
    const state = aliceWithBobAndCarol();
    const overdraft = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
    const bob = queue(queue(state.accounts.get(BOB) ?? expect.unreachable("no account"), overdraft(5n)), overdraft(6n));
    const carol = queue(state.accounts.get(CAROL) ?? expect.unreachable("no account"), overdraft(7n));
    const framed = run({ ...state, accounts: new Map([[BOB, bob], [CAROL, carol]]) });
    const told = framed.notices.map((n) => (n._tag === "tx_refused" ? [n.peer, n.refused.tx._tag] : [n._tag]));
    expect(told).toEqual([[BOB, "pay"], [BOB, "pay"], [CAROL, "pay"]]);
    expect([...framed.state.accounts.values()].map((a) => a.refused)).toEqual([[], []]);
  });

  test("an id is exactly 0x and 64 lowercase hex digits: nothing before, nothing after", () => {
    expect(entityId(`${ALICE}00`).ok).toBe(false);
    expect(entityId(`00${ALICE}`).ok).toBe(false);
    expect(entityId(` ${ALICE}`).ok).toBe(false);
  });
});
