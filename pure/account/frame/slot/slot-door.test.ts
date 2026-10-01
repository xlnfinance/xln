// R-PROOF-NONCE-ABOVE-SIGNED, the door: a replica believes a slot, and a floor, only if an honest peer could have given
// it. A slot is in its author's lane, above the committed slot, and at most one lane step above what the receiver knows
// either side signed; a refusal's floor is believed on the same terms. What is not believed is answered, so the peer
// is never left waiting, and it changes nothing here: a peer cannot move a nonce toward the ceiling, nor a replica's
// view of what it has signed.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { clockParams } from "../../clause/clock.ts";
import { signing, tokenOf, viewOf } from "../../fixtures.ts";
import { emptyLedger } from "../../ledger.ts";
import type { Ledger, Side } from "../../model.ts";
import { emptyAccount, withLedger } from "../../state.ts";
import type { AccountTx } from "../../tx.ts";
import { accountRules, emptyReplica, frameName, type AccountReplica } from "../account.ts";
import {
  BAD_SLOT, MAX_ATTEMPTS, STALE_SLOT, propose, queue, receive, type Frame, type Msg,
} from "../frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rules = accountRules({ clock, view: viewOf(100n) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const frameOf = (m: Msg<AccountTx>): Frame<AccountTx> => (m._tag === "frame" ? m.frame : expect.unreachable("a frame"));
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
const refusalOf = (m: Msg<AccountTx>): Msg<AccountTx> =>
  (m._tag === "refusal" ? m : expect.unreachable("a refusal"));

/** Left proposes one payment and Right acks it: both are at slot 2 (the first frame of a fresh Account). */
const first = propose(rules, queue(funded("left"), pay(1n)));
const heard = receive(rules, funded("right"), only(first.sent));
const committed = { left: receive(rules, first.replica, only(heard.sent)).replica, right: heard.replica };
const asSlot = (m: Msg<AccountTx>, slot: number): Msg<AccountTx> => ({ _tag: "frame", frame: { ...frameOf(m), slot } });
/** Left's next frame, as Right sees it, at the slot an honest Left would take (4) and at others. */
const next = propose(rules, queue(committed.left, pay(2n)));

describe("account/frame R-PROOF-NONCE-ABOVE-SIGNED a receiver believes only a slot an honest peer could take", () => {
  test("the slot an honest peer takes is accepted: the first of Left is 2, the next 4", () => {
    expect([frameOf(only(first.sent)).slot, frameOf(only(next.sent)).slot]).toEqual([2, 4]);
    expect(receive(rules, funded("right"), only(first.sent)).outcome._tag).toBe("accepted");
    expect(receive(rules, committed.right, only(next.sent)).outcome._tag).toBe("accepted");
  });

  test("a commit leaves both highs at the committed slot: the acker signed it and the proposer was acked", () => {
    const highs = [committed.left, committed.right].map((r) => [r.used, r.signed, r.peerSigned]);
    expect(highs).toEqual([[2, 2, 2], [2, 2, 2]]);
    // and a refusal says so: Right, which acked slot 2, reports a floor of 2
    const refused = receive(rules, committed.right, asSlot(only(next.sent), 3));
    expect(refusalOf(only(refused.sent))).toMatchObject({ fault: BAD_SLOT, floor: 2 });
  });

  test("a slot in the other lane, at or below the committed one, or too far above what I know, is refused", () => {
    const bad = [
      [funded("right"), asSlot(only(first.sent), 1)], [funded("right"), asSlot(only(first.sent), 3)],
      [funded("right"), asSlot(only(first.sent), 0)], [funded("right"), asSlot(only(first.sent), 4)],
      [committed.right, asSlot(only(next.sent), 2)], [committed.right, asSlot(only(next.sent), 3)],
      [committed.right, asSlot(only(next.sent), 6)], [committed.right, asSlot(only(next.sent), 1000)],
    ] as const;
    bad.forEach(([right, msg]) => {
      const answer = receive(rules, right, msg);
      expect(answer.outcome._tag).toBe("refused_slot");
      expect(answer.replica).toEqual(right);
      expect(refusalOf(only(answer.sent))).toEqual({
        _tag: "refusal", hash: frameName(frameOf(msg)), index: 0, fault: BAD_SLOT, mark: 0, floor: right.signed,
      });
    });
  });

  test("what I know the peer signed raises how far it may go: its next slot above that is believed", () => {
    // Right knows Left signed up to slot 4 (it saw that frame and refused it), so Left's next one may be 6, not 8
    const knows = { ...funded("right"), peerSigned: 4 };
    expect(receive(rules, knows, asSlot(only(first.sent), 6)).outcome._tag).toBe("accepted");
    expect(receive(rules, knows, asSlot(only(first.sent), 8)).outcome._tag).toBe("refused_slot");
  });

  test("a frame heard at an honest slot is noted: what I propose next goes above the slot the peer signed", () => {
    const refusedFrame = asSlot(only(first.sent), 2);
    const notYet = { ...funded("right"), mempool: [pay(1n)] };
    const afterHearing = receive(accountRules({ clock, view: viewOf(100n) }, signing), notYet, refusedFrame);
    expect(afterHearing.replica.peerSigned).toBe(2);
    // Right's own frame at its next slot is above Left's (3 above 2) wherever Left's frame ended up
    const mine = propose(rules, { ...notYet, peerSigned: 2 });
    expect(frameOf(only(mine.sent)).slot).toBe(3);
  });

  test("a slot that is not a whole number is refused without a word and without a throw", () => {
    [Number.NaN, 1.5, -2, Number.POSITIVE_INFINITY, 2 ** 53, Number.MAX_SAFE_INTEGER + 2].forEach((slot) => {
      const answer = receive(rules, funded("right"), asSlot(only(first.sent), slot));
      expect([answer.outcome._tag, answer.sent, answer.replica]).toEqual(["refused_slot", [], funded("right")]);
    });
  });

  test("a slot near the ceiling is refused too: one frame cannot spend the nonce space", () => {
    const nearly = asSlot(only(first.sent), Number.MAX_SAFE_INTEGER - 1);
    const answer = receive(rules, funded("right"), nearly);
    expect([answer.outcome._tag, answer.replica.peerSigned, answer.replica.signed]).toEqual(["refused_slot", 0, 0]);
  });
});

describe("account/frame R-PROOF-NONCE-ABOVE-SIGNED a proposer believes only a floor an honest peer could sign", () => {
  const pending = first.replica;
  const told = (floor: number, fault = "not_expired"): Msg<AccountTx> =>
    ({ _tag: "refusal", hash: frameName(frameOf(only(first.sent))), index: 0, fault, mark: 0, floor });

  test("a floor within reach is adopted: the retry goes above it, in Left's lane", () => {
    // Left signed slot 2; Right can have signed 1 (its own frame) or 3 at most, so a floor of 3 is believed
    const heardFloor = receive(rules, pending, told(3));
    expect([heardFloor.outcome._tag, heardFloor.replica.peerSigned]).toEqual(["rolled_back", 3]);
    const retry = propose(rules, heardFloor.replica);
    expect(frameOf(only(retry.sent)).slot).toBe(4);
  });

  test("a floor beyond reach, negative or not a whole number is not believed: the refusal is ignored", () => {
    [5, 1000, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER].forEach((floor) => {
      const answer = receive(rules, pending, told(floor));
      expect([answer.outcome._tag, answer.replica]).toEqual(["refusal_ignored", pending]);
    });
  });

  test("a stale slot costs no tx, whatever the attempt count: the frame is proposed again above the floor", () => {
    const spent = { ...pending, attempt: MAX_ATTEMPTS };
    const answer = receive(rules, spent, told(3, STALE_SLOT));
    const kept = [answer.outcome._tag, answer.replica.refused, answer.replica.mempool];
    expect(kept).toEqual(["rolled_back", [], [pay(1n)]]);
  });

  test("a commit supersedes the proofs at or below its slot and leaves any above it live (restored state)", () => {
    const held = { slot: 3, txs: [pay(5n)] };
    const above = { slot: 9, txs: [pay(6n)] };
    const restored = { ...funded("left"), unsuperseded: [held, above] };
    const sent = propose(rules, queue(restored, pay(1n)));
    expect(sent.replica.unsuperseded.map((x) => x.slot)).toEqual([3, 9, 2]);
    const acked = receive(rules, funded("right"), only(sent.sent));
    const done = receive(rules, sent.replica, only(acked.sent));
    expect([done.outcome._tag, done.replica.unsuperseded]).toEqual(["committed_own", [held, above]]);
  });
});
