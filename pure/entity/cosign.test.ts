// R-C2R-FOLD and R-COSIGN-FREEZE at the Entity: what the node signs about collateral, and what it stops doing after.
import { describe, expect, test } from "bun:test";
import { emptyReplica } from "../account/frame/account.ts";
import { emptyLedger } from "../account/ledger.ts";
import { tokenOf } from "../account/fixtures.ts";
import type { AccountState, Ledger, TokenId } from "../account/model.ts";
import { credit, entityOf, GOLD, judge, open, pay } from "./fixtures.ts";
import { entityFrame } from "./frame.ts";
import { emptyEntity, type CosignOp, type EntityInput, type EntityState, type JAction, type Notice } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);
const SILVER = tokenOf(2n);

const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, state, inputs);

const ledger = (offdelta: bigint): Ledger =>
  ({ ...emptyLedger, collateral: 100n, offdelta, limit: { left: 100n, right: 100n } });

/** Alice holds Accounts with Bob and Carol; the Account with Bob has these offdeltas by token (none for zero). */
const aliceWith = (offdeltas: ReadonlyMap<TokenId, bigint>): EntityState => {
  const base = run(emptyEntity(ALICE), open(BOB), open(CAROL)).state;
  const ledgers: AccountState = { ledgers: new Map([...offdeltas].map(([token, d]) => [token, ledger(d)])) };
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
    expect(run(nothingOwed, withdraw(30n)).chain).toEqual([{ _tag: "c2r", peer: BOB, token: GOLD, amount: 30n }]);
  });

  test("R-C2R-FOLD a withdrawal with an offdelta goes as a settlement that folds it, never as a C2R", () => {
    expect(run(owing, withdraw(30n)).chain).toEqual([
      { _tag: "settle", peer: BOB, token: GOLD, amount: 30n, folds: [OWED] },
    ]);
  });

  test("R-C2R-FOLD the settlement folds the offdelta of every token, not only the withdrawn one", () => {
    expect(run(owingTwo, withdraw(30n)).chain).toEqual([{
      _tag: "settle", peer: BOB, token: GOLD, amount: 30n,
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
      { _tag: "settle", peer: BOB, token: GOLD, amount: 30n, folds: [OWED] },
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
    const lapsed = run(queuedBehind.state, { _tag: "j_op_lapsed", peer: BOB });
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
