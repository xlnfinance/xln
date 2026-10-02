// R-C2R-FOLD and R-COSIGN-FREEZE at the Entity: what the node signs about collateral, and what it stops doing after.
import { describe, expect, test } from "bun:test";
import { emptyReplica, frameName } from "../account/frame/account.ts";
import type { Msg } from "../account/frame/frame.ts";
import type { AccountTx } from "../account/tx.ts";
import { emptyLedger, MAX_AMOUNT } from "../account/ledger.ts";
import { signing, tokenOf, viewOf } from "../account/fixtures.ts";
import type { AccountState, Ledger, TokenId } from "../account/model.ts";
import { anchor, credit, entityOf, GOLD, judge, open, pay, TEST_SIG } from "./fixtures.ts";
import { entityFrame } from "./frame.ts";
import { entityRules, type Standing } from "./rules.ts";
import { emptyEntity, type CosignOp, type EntityInput, type EntityState, type JAction, type Notice } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);
const SILVER = tokenOf(2n);
const UNFROZEN_LEFT: Standing = { self: "left", frozen: false };

const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, anchor, state, inputs);

const ledger = (offdelta: bigint): Ledger =>
  ({ ...emptyLedger, collateral: 100n, offdelta, limit: { left: 100n, right: 100n } });

/** Alice holds Accounts with Bob and Carol; the Account with Bob has these offdeltas by token (none for zero). */
const aliceWith = (offdeltas: ReadonlyMap<TokenId, bigint>): EntityState => {
  const base = run(emptyEntity(ALICE), open(BOB), open(CAROL)).state;
  const held = new Map([...offdeltas].map(([token, d]) => [token, ledger(d)]));
  const ledgers: AccountState = { ledgers: held, quotes: [], offers: [] };
  const withBob = { ...emptyReplica("left"), state: ledgers };
  return { ...base, accounts: new Map([...base.accounts, [BOB, withBob]]) };
};

const nothingOwed = aliceWith(new Map([[GOLD, 0n]]));
const owing = aliceWith(new Map([[GOLD, -10n]]));
const owingTwo = aliceWith(new Map([[SILVER, 7n], [GOLD, -10n]]));

const withdraw = (amount: bigint): EntityInput => ({ _tag: "withdraw", peer: BOB, token: GOLD, amount });
const ask = (op: CosignOp): EntityInput => ({ _tag: "cosign_ask", from: BOB, op });
const c2r: CosignOp = { _tag: "c2r", token: GOLD, amount: 30n };
const settle: CosignOp = { _tag: "settle", token: GOLD, amount: 30n };

const OWED = { token: GOLD, offdelta: -10n };

const faultsOf = (notices: readonly Notice[]) =>
  notices.map((n) => (n._tag === "command_refused" || n._tag === "cosign_refused" ? n.fault._tag : ""));

const tagsOf = (actions: readonly JAction[]) => actions.map((a) => a._tag);

describe("entity/cosign R-C2R-FOLD the shortcut is only for an Account with nothing to fold", () => {
  test("R-C2R-FOLD a withdrawal from an Account with no offdelta goes as a C2R", () => {
    const asC2r: JAction = { _tag: "c2r", peer: BOB, serial: 1n, token: GOLD, amount: 30n };
    expect(run(nothingOwed, withdraw(30n)).chain).toEqual([asC2r]);
  });

  test("R-C2R-FOLD a withdrawal with an offdelta goes as a settlement that folds it, never as a C2R", () => {
    expect(run(owing, withdraw(30n)).chain).toEqual([
      { _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 30n, folds: [OWED] },
    ]);
  });

  test("R-C2R-FOLD the settlement folds the offdelta of every token, not only the withdrawn one", () => {
    expect(run(owingTwo, withdraw(30n)).chain).toEqual([{
      _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 30n,
      folds: [{ token: GOLD, offdelta: -10n }, { token: SILVER, offdelta: 7n }],
    }]);
  });

  test("R-C2R-FOLD an offdelta in another token alone is enough: the shortcut would erase it too", () => {
    const silverOnly = aliceWith(new Map([[GOLD, 0n], [SILVER, 7n]]));
    expect(tagsOf(run(silverOnly, withdraw(30n)).chain)).toEqual(["settle"]);
  });

  test("R-C2R-FOLD a peer's ask for a C2R is refused with notice while there is an offdelta, and signs nothing", () => {
    const refused = run(owing, ask(c2r));
    expect(refused.chain).toEqual([]);
    expect(refused.notices).toEqual([
      { _tag: "cosign_refused", from: BOB, op: c2r, fault: { _tag: "unfolded_c2r", folds: [OWED] } },
    ]);
    expect(refused.state.chain.get(BOB)?.frozen).toBeUndefined();
  });

  test("R-C2R-FOLD a peer's C2R is signed with nothing to fold, a peer's settlement always", () => {
    expect(tagsOf(run(nothingOwed, ask(c2r)).chain)).toEqual(["c2r"]);
    expect(run(owing, ask(settle)).chain).toEqual([
      { _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 30n, folds: [OWED] },
    ]);
  });
});

describe("entity/cosign R-COSIGN-FREEZE after a signature the Account proposes nothing until it lands", () => {
  const frozen = run(owing, withdraw(30n)).state;
  const queuedBehind = run(frozen, pay(BOB, 1n));

  test("R-COSIGN-FREEZE a tx queued after the signature waits: no frame goes to the peer", () => {
    expect(queuedBehind.outputs).toEqual([]);
    expect(queuedBehind.state.accounts.get(BOB)?.mempool).toHaveLength(1);
  });

  test("R-COSIGN-FREEZE a signature given to a peer's ask freezes the Account just as the node's own does", () => {
    const asked = run(owing, ask(settle)).state;
    expect(run(asked, pay(BOB, 1n)).outputs).toEqual([]);
    expect(asked.chain.get(BOB)?.frozen).toBe(true);
  });

  test("R-COSIGN-FREEZE without a signature the same tx is proposed at once", () => {
    expect(run(owing, pay(BOB, 1n)).outputs).toHaveLength(1);
  });

  test("R-COSIGN-FREEZE only the Account the signature is about stops: the others still propose", () => {
    const both = run(frozen, pay(BOB, 1n), credit(CAROL, 50n));
    expect(both.outputs.map((o) => o.to)).toEqual([CAROL]);
  });

  test("R-COSIGN-FREEZE the chain moving the epoch on, landed or superseded, ends it and the queue goes out", () => {
    const landed = run(queuedBehind.state, { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 4n });
    expect(landed.state.chain.get(BOB)?.frozen).toBe(false);
    expect(landed.outputs.map((o) => o.to)).toEqual([BOB]);
  });

  test("R-COSIGN-FREEZE a report of an epoch already known, or about another Account, does not end it", () => {
    const again = run(queuedBehind.state, { _tag: "j_epoch", peer: BOB, epoch: 0n, stored: 0n });
    expect(again.state.chain.get(BOB)?.frozen).toBe(true);
    expect(again.outputs).toEqual([]);
    const other = run(queuedBehind.state, { _tag: "j_epoch", peer: CAROL, epoch: 1n, stored: 4n });
    expect(other.state.chain.get(BOB)?.frozen).toBe(true);
  });

  test("R-COSIGN-FREEZE an operation that can no longer land ends it too, or the Account would wait for ever", () => {
    const lapsed = run(queuedBehind.state, { _tag: "j_op_lapsed", peer: BOB, serial: 1n });
    expect(lapsed.state.chain.get(BOB)?.frozen).toBe(false);
    expect(lapsed.outputs.map((o) => o.to)).toEqual([BOB]);
  });

  test("R-COSIGN-FREEZE a second signature while one waits is refused with notice, whoever asks", () => {
    const second = run(frozen, withdraw(5n), ask(settle));
    expect(second.chain).toEqual([]);
    expect(second.notices.map((n) => n._tag)).toEqual(["cosign_refused", "command_refused"]);
    const faults = faultsOf(second.notices);
    expect(faults).toEqual(["already_cosigned", "already_cosigned"]);
  });

  test("R-COSIGN-FREEZE the peer's settlement and our withdrawal in one frame: the peer's wins, either order", () => {
    const theirs: CosignOp = { _tag: "settle", token: GOLD, amount: 20n };
    const signed: readonly JAction[] = [
      { _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 20n, folds: [OWED] },
    ];
    const raced = [[ask(theirs), withdraw(30n)], [withdraw(30n), ask(theirs)]].map((inputs) => run(owing, ...inputs));
    expect(raced.map((r) => r.chain)).toEqual([signed, signed]);
    expect(raced.map((r) => faultsOf(r.notices))).toEqual([["already_cosigned"], ["already_cosigned"]]);
    expect(raced.map((r) => r.state.chain.get(BOB)?.frozen)).toEqual([true, true]);
  });

  test("R-COSIGN-FREEZE nothing is signed over a frame still in flight: its ack may move the offdelta", () => {
    const inFlight = run(owing, pay(BOB, 1n));
    const refused = run(inFlight.state, withdraw(30n), ask(c2r));
    expect(refused.chain).toEqual([]);
    const faults = faultsOf(refused.notices);
    expect(faults).toEqual(["frame_in_flight", "frame_in_flight"]);
  });

  test("a withdrawal of nothing, or of more than a uint256, or to a stranger, signs nothing", () => {
    expect(run(owing, withdraw(0n), withdraw(2n ** 256n)).chain).toEqual([]);
    const stranger = run(owing, { _tag: "withdraw", peer: entityOf(9), token: GOLD, amount: 1n });
    expect(stranger.chain).toEqual([]);
    expect(stranger.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    const strangerAsk = run(owing, { _tag: "cosign_ask", from: entityOf(9), op: settle });
    expect(strangerAsk.notices.map((n) => n._tag)).toEqual(["unknown_peer"]);
  });
});

describe("entity/cosign R-COSIGN-FREEZE the other way: the peer's frames are refused while it is out", () => {
  const frozen = run(owing, withdraw(30n)).state;
  const bob = run(emptyEntity(BOB), open(ALICE)).state;
  const sent = run(bob, credit(ALICE, 50n));
  const frame = sent.outputs[0]?.msg ?? expect.unreachable("Bob proposed nothing");
  const fromBob: EntityInput = { _tag: "peer_message", from: BOB, msg: frame, sig: TEST_SIG };
  const hashOf = frame._tag === "frame" ? frameName(frame.frame) : expect.unreachable("no frame");

  test("R-COSIGN-FREEZE a peer's frame is refused with the frozen fault, naming the frame and its first tx", () => {
    const refused = run(frozen, fromBob);
    const refusal: Msg<AccountTx> = { _tag: "refusal", hash: hashOf, index: 0, fault: "frozen", mark: 0, floor: 0 };
    expect(refused.outputs.map((o) => o.msg)).toEqual([refusal]);
    expect(refused.state.accounts.get(BOB)?.head).toBe(frozen.accounts.get(BOB)?.head);
    expect(refused.notices.map((n) => n._tag)).toEqual(["message_refused"]);
  });

  test("R-COSIGN-FREEZE the same frame on an Account that is not frozen is taken and acked", () => {
    const taken = run(owing, fromBob);
    expect(taken.outputs.map((o) => o.msg._tag)).toEqual(["ack"]);
    expect(taken.state.accounts.get(BOB)?.head).not.toBe(owing.accounts.get(BOB)?.head);
  });

  test("R-COSIGN-FREEZE the refusal can pass: Bob takes the frame back, keeps its tx, drops nothing", () => {
    const refused = run(frozen, fromBob).outputs[0]?.msg ?? expect.unreachable("no refusal");
    const back = run(sent.state, { _tag: "peer_message", from: ALICE, msg: refused, sig: TEST_SIG });
    const account = back.state.accounts.get(ALICE);
    expect(account?.pending).toBeUndefined();
    expect(account?.mempool).toHaveLength(1);
    expect(back.notices.map((n) => n._tag)).toEqual([]);
  });

  test("R-COSIGN-FREEZE after a lapse Bob's retry at the next attempt commits, the refused frame stays refused", () => {
    const refused = run(frozen, fromBob).outputs[0]?.msg ?? expect.unreachable("no refusal");
    const rolled = run(sent.state, { _tag: "peer_message", from: ALICE, msg: refused, sig: TEST_SIG }).state;
    const later = entityFrame({ ...judge, view: viewOf(101n) }, anchor, rolled, []);
    const retry = later.outputs[0]?.msg ?? expect.unreachable("Bob did not retry");
    const lapsed = run(run(frozen, fromBob).state, { _tag: "j_op_lapsed", peer: BOB, serial: 1n });
    const again = run(lapsed.state, { _tag: "peer_message", from: BOB, msg: retry, sig: TEST_SIG });
    expect(again.outputs.map((o) => o.msg._tag)).toEqual(["ack"]);
    const repeat = run(lapsed.state, fromBob);
    expect(repeat.outputs.map((o) => o.msg._tag)).toEqual(["refusal"]);
  });

  test("R-COSIGN-FREEZE a refusal that is not about the freeze is no more retryable than before", () => {
    const rules = entityRules(judge, signing, UNFROZEN_LEFT);
    expect(rules.retryable("frozen")).toBe(true);
    expect(rules.retryable("not_expired")).toBe(true);
    expect(rules.retryable("insufficient_capacity")).toBe(false);
  });
});

describe("entity/cosign R-COSIGN-FREEZE a lapse names its operation: only the one out ends the freeze", () => {
  const lapse = (serial: bigint): EntityInput => ({ _tag: "j_op_lapsed", peer: BOB, serial });
  const factsOf = (s: EntityState) => s.chain.get(BOB);
  const first = run(owing, withdraw(30n));
  const thawed = run(first.state, lapse(1n)).state;
  const second = run(thawed, withdraw(20n));
  const bob = run(emptyEntity(BOB), open(ALICE), credit(ALICE, 50n));
  const frame = bob.outputs[0]?.msg ?? expect.unreachable("Bob proposed nothing");
  const fromBob: EntityInput = { _tag: "peer_message", from: BOB, msg: frame, sig: TEST_SIG };

  test("R-COSIGN-FREEZE each operation of an Account has its own serial, counting from one", () => {
    expect(first.chain.map((a) => (a._tag === "settle" ? a.serial : undefined))).toEqual([1n]);
    expect(second.chain.map((a) => (a._tag === "settle" ? a.serial : undefined))).toEqual([2n]);
  });

  test("R-COSIGN-FREEZE a repeated lapse of the first operation thaws nothing while the second is out", () => {
    const repeated = run(second.state, lapse(1n)).state;
    expect(factsOf(repeated)?.frozen).toBe(true);
    const heard = run(repeated, fromBob);
    expect(heard.outputs.map((o) => o.msg._tag)).toEqual(["refusal"]);
  });

  test("R-COSIGN-FREEZE a report naming an operation never signed changes nothing, the right one thaws", () => {
    expect(factsOf(run(second.state, lapse(3n)).state)).toEqual(factsOf(second.state));
    expect(factsOf(run(second.state, lapse(2n)).state)?.frozen).toBe(false);
  });

  test("R-COSIGN-FREEZE the serial goes on when the epoch moves: the next operation is not the first again", () => {
    const landed = run(second.state, { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 5n }).state;
    expect(factsOf(landed)?.frozen).toBe(false);
    expect(factsOf(landed)?.cosigned).toBe(2n);
    const third = run(landed, withdraw(10n));
    expect(third.chain.map((a) => (a._tag === "settle" ? a.serial : undefined))).toEqual([3n]);
    expect(factsOf(run(third.state, lapse(2n)).state)?.frozen).toBe(true);
  });
});

describe("entity/cosign review A: the edges of the signature, and what a dispute does to the freeze", () => {
  const signed = (amount: bigint): JAction =>
    ({ _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount, folds: [OWED] });
  const disputed = (by: "left" | "right"): EntityInput =>
    ({ _tag: "j_dispute", peer: BOB, epoch: 0n, by, timeout: 5n });
  const factsOf = (s: EntityState) => s.chain.get(BOB);

  test("R-COSIGN-FREEZE a tx queued in the same frame does not stop the signature, which holds it back", () => {
    const raced = run(owing, pay(BOB, 1n), withdraw(30n));
    expect(raced.chain).toEqual([signed(30n)]);
    expect(raced.outputs).toEqual([]);
    expect(raced.state.accounts.get(BOB)?.mempool).toHaveLength(1);
  });

  test("a withdrawal of 1 and of the largest amount are signed, one above it is refused", () => {
    expect(run(owing, withdraw(1n)).chain).toEqual([signed(1n)]);
    expect(run(owing, withdraw(MAX_AMOUNT)).chain).toEqual([signed(MAX_AMOUNT)]);
    const over = run(owing, withdraw(MAX_AMOUNT + 1n));
    expect(over.chain).toEqual([]);
    expect(faultsOf(over.notices)).toEqual(["account_refused"]);
  });

  test("R-COSIGN-FREEZE a dispute on the chain, opened by either side or over, does not end the freeze", () => {
    const out = run(owing, withdraw(30n)).state;
    expect(factsOf(run(out, disputed("right")).state)?.frozen).toBe(true);
    expect(factsOf(run(out, disputed("left")).state)?.frozen).toBe(true);
    const over = run(run(out, disputed("right")).state, { _tag: "j_dispute_over", peer: BOB }).state;
    expect(factsOf(over)?.frozen).toBe(true);
  });
});
