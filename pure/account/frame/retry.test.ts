// R-FRAME-REFUSAL, Review A of PR 85: which refusals are tried again. A fault is retryable only when it can pass with
// the peer's view of the chain: an expiry it finds not yet due, a lock whose deadline it finds too far ahead. Every
// other fault drops the tx, with notice. Pinned here so a tag cannot slip into or out of the list unseen.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import { type Ledger, type Side } from "../model.ts";
import { emptyAccount, openHolds, withLedger } from "../state.ts";
import type { AccountTx } from "../tx.ts";
import { accountRules, emptyReplica, frameName, type AccountReplica } from "./account.ts";
import { MAX_ATTEMPTS, propose, queue, receive, resend, type Msg } from "./frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const at = (view: bigint) => accountRules({ clock, view: viewOf(view) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");

describe("account/frame R-FRAME-REFUSAL which faults are tried again", () => {
  test("only the faults a lagging view of the chain causes are retryable", () => {
    const retryable = ["not_expired", "deadline_too_far"];
    const permanent = [
      "deadline_past", "past_deadline", "bad_amount", "insufficient_capacity", "wrong_secret", "bad_secret",
      "not_payee", "not_own_funds", "lock_exists", "no_such_lock", "too_many_holds", "credit_below_usage",
    ];
    expect(retryable.map(at(100n).retryable)).toEqual([true, true]);
    expect(permanent.filter(at(100n).retryable)).toEqual([]);
  });

  test("a lock whose deadline is too far for the peer's lagging view is retried and commits", () => {
    // Left's view 102 admits a deadline up to 102 + 10 + 2 = 114; Right's view 100 admits up to 112
    const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 114n, 1) };
    const proposed = propose(at(102n), queue(funded("left"), lock));
    const refused = receive(at(100n), funded("right"), only(proposed.sent));
    expect(refused.outcome._tag).toBe("refused_invalid");
    const back = receive(at(102n), proposed.replica, only(refused.sent));
    expect(back.replica.refused).toEqual([]);
    const again = propose(at(102n), back.replica);
    const accepted = receive(at(102n), refused.replica, only(again.sent));
    expect(accepted.outcome._tag).toBe("accepted");
    expect(openHolds(accepted.replica.state)).toHaveLength(1);
  });
});

describe("account/frame R-FRAME-EPOCH a frame is judged only under its own epoch and first nonce", () => {
  const under = (epoch: bigint, firstNonce = signing.firstNonce) =>
    accountRules({ clock, view: viewOf(100n) }, { ...signing, ondeltaEpoch: epoch, firstNonce });
  const pay: AccountTx = { _tag: "pay", token: GOLD, amount: 5n };
  const proposed = propose(under(2n), queue(funded("left"), pay));
  const refused = receive(under(1n), funded("right"), only(proposed.sent));
  const parked = receive(under(2n), proposed.replica, only(refused.sent));

  test("the frame carries the epoch and the first nonce its proposer signs under, and its name says so", () => {
    const frame = only(proposed.sent);
    expect(frame._tag === "frame" && [frame.frame.epoch, frame.frame.firstNonce]).toEqual([2n, signing.firstNonce]);
    const named = (epoch: bigint, firstNonce: bigint) => frameName({
      author: "left", parent: proposed.replica.head, attempt: 0, slot: 2, epoch, firstNonce, txs: [pay],
    });
    expect(named(2n, 2n)).not.toBe(named(3n, 2n));
    expect(named(2n, 2n)).not.toBe(named(2n, 3n));
  });

  test("a receiver in another epoch refuses it unjudged, keeps its head and notes the slot", () => {
    expect(refused.outcome._tag).toBe("refused_epoch");
    expect(only(refused.sent)).toMatchObject({ _tag: "refusal", fault: "wrong_epoch", floor: 0 });
    expect([refused.replica.head, refused.replica.height, refused.replica.declined])
      .toEqual([funded("right").head, 0, undefined]);
    expect(refused.replica.peerSigned).toBe(2);
  });

  test("the same epoch with another first nonce is refused the same way, not acked at another head", () => {
    const other = receive(under(2n, signing.firstNonce + 1n), funded("right"), only(proposed.sent));
    expect([other.outcome._tag, only(other.sent)]).toMatchObject(["refused_epoch", { fault: "wrong_epoch" }]);
    expect([other.replica.head, other.replica.height]).toEqual([funded("right").head, 0]);
  });

  test("the proposer parks the frame: pending, its tx kept as is, past MAX_ATTEMPTS too", () => {
    expect(parked.outcome._tag).toBe("parked");
    const worn = receive(under(2n), { ...proposed.replica, attempt: MAX_ATTEMPTS + 3 }, only(refused.sent));
    [parked, worn].forEach((back) => {
      expect([back.replica.pending, back.replica.mempool, back.replica.refused])
        .toEqual([proposed.replica.pending, [], []]);
      expect(back.sent).toEqual([]);
    });
  });

  test("a peer that always answers wrong_epoch costs the proposer one signed proof, not one for every try", () => {
    const refusal = only(refused.sent);
    const tried = Array.from({ length: 200 }, (_, i) => i).reduce((r) => receive(under(2n), r, refusal).replica,
      proposed.replica);
    expect([tried.unsuperseded.length, tried.signed, tried.pending]).toEqual([1, 2, proposed.replica.pending]);
    expect(resend(tried)).toEqual(resend(proposed.replica));
    const queued = propose(under(2n), queue(tried, pay));
    expect([queued.sent, queued.replica.mempool, queued.replica.unsuperseded.length]).toEqual([[], [pay], 1]);
  });

  test("once the receiver signs under the frame's epoch, the same bytes sent again commit with one head", () => {
    const again = resend(parked.replica);
    expect(again).toEqual([only(proposed.sent)]);
    const accepted = receive(under(2n), refused.replica, only(again));
    expect(accepted.outcome._tag).toBe("accepted");
    const acked = receive(under(2n), parked.replica, only(accepted.sent));
    expect([acked.outcome._tag, acked.replica.head === accepted.replica.head]).toEqual(["committed_own", true]);
  });

  test("a proposer whose own view moved since it sealed takes the frame back and seals it anew", () => {
    const back = receive(under(3n), proposed.replica, only(refused.sent));
    expect(back.outcome._tag).toBe("rolled_back");
    expect([back.replica.pending, back.replica.mempool, back.replica.refused]).toEqual([undefined, [pay], []]);
    const again = propose(under(3n), back.replica);
    expect(only(again.sent)).toMatchObject({ _tag: "frame", frame: { epoch: 3n, txs: [pay] } });
  });
});
