// R-SIGNED-IS-LIVE: a proof a side has signed and sent stays enforceable against it until a frame at a higher slot
// commits, whatever the peer did with the frame. So a refusal or a yield does not make a lock void: `liveLocks` is what
// the Runtime reads to hold an upstream payer's funds. The probe is Review A's of PR 97: a hub's forwarded lock,
// refused with a fault no retry can pass, is dropped with notice while the peer still holds the proof that carries it.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { clockParams } from "../../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../../fixtures.ts";
import { emptyLedger } from "../../ledger.ts";
import { holdId, type Ledger, type Side } from "../../model.ts";
import { emptyAccount, withLedger } from "../../state.ts";
import type { AccountTx } from "../../tx.ts";
import { accountRules, emptyReplica, liveLocks, type AccountReplica } from "../account.ts";
import { MAX_UNSUPERSEDED, propose, queue, receive, stalled, type Msg } from "../frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rulesAt = (view: bigint) => accountRules({ clock, view: viewOf(view) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const lock = (id: bigint, deadline = 108n): AccountTx =>
  ({ _tag: "lock", token: GOLD, hold: holdOf("right", 5n, id, deadline, Number(id)) });
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
const slotsOf = (r: AccountReplica): readonly number[] => liveLocks(r).map((l) => l.slot);

/** Right proposes `txs`; Left, hostile or lagging, refuses with `fault` (a fault no retry can pass drops the tx). */
const refusedWith = (txs: readonly AccountTx[], fault: string) => {
  const sent = propose(rulesAt(100n), txs.reduce(queue, funded("right")));
  const frame = only(sent.sent);
  const name = frame._tag === "frame" ? rulesAt(100n).name(frame.frame) : expect.unreachable("a frame");
  const refusal: Msg<AccountTx> = { _tag: "refusal", hash: name, index: 0, fault, mark: 0, floor: 0 };
  return { sent, back: receive(rulesAt(100n), sent.replica, refusal) };
};

describe("account/frame R-SIGNED-IS-LIVE a lock in a signed proof stays live until a higher frame commits", () => {
  test("a frame in flight is live: its lock is a lock the peer may hold the proof of", () => {
    const sent = propose(rulesAt(100n), queue(funded("right"), lock(1n)));
    expect(liveLocks(sent.replica)).toEqual([{ token: GOLD, hold: holdOf("right", 5n, 1n, 108n, 1), slot: 1 }]);
  });

  test("Review A's probe: the lock is refused and dropped with notice, and is still live", () => {
    const { back } = refusedWith([lock(1n)], "too_many_holds");
    expect(back.outcome._tag).toBe("rolled_back");
    expect(back.replica.refused.map((x) => x.fault)).toEqual([{ _tag: "peer_refused", fault: "too_many_holds" }]);
    expect(back.replica.pending).toBeUndefined();
    expect(slotsOf(back.replica)).toEqual([1]);
    expect(liveLocks(back.replica).map((l) => l.hold.id)).toEqual([holdId(1n)]);
  });

  test("a retried frame adds its own live lock; the refused attempt's proof is not forgotten", () => {
    const { back } = refusedWith([lock(1n)], "not_expired");
    const again = propose(rulesAt(100n), back.replica);
    expect(slotsOf(again.replica)).toEqual([1, 3]);
  });

  test("a frame that commits above them supersedes them all, and only then is the lock released", () => {
    const { back } = refusedWith([lock(1n), pay(2n)], "too_many_holds");
    expect(slotsOf(back.replica)).toEqual([1]);
    const next = propose(rulesAt(100n), queue(back.replica, pay(1n)));
    // Left refused slot 1, so it knows Right signed it: the retry is above it, and Left acks it
    const accepted = receive(rulesAt(100n), { ...funded("left"), peerSigned: 1 }, only(next.sent));
    expect(accepted.outcome._tag).toBe("accepted");
    const done = receive(rulesAt(100n), next.replica, only(accepted.sent));
    expect(done.outcome._tag).toBe("committed_own");
    expect(liveLocks(done.replica)).toEqual([]);
    expect(done.replica.unsuperseded).toEqual([]);
  });

  test("a yield supersedes the loser's proof when the winner's frame commits above it", () => {
    const own = propose(rulesAt(100n), queue(funded("right"), lock(1n)));
    expect(slotsOf(own.replica)).toEqual([1]);
    const left = propose(rulesAt(100n), queue(funded("left"), pay(3n)));
    const yielded = receive(rulesAt(100n), own.replica, only(left.sent));
    expect(yielded.outcome._tag).toBe("accepted_over_own");
    expect(liveLocks(yielded.replica)).toEqual([]);
    expect(yielded.replica.mempool).toEqual([lock(1n)]);
  });

  test("at the cap a side signs nothing more: its txs are refused with notice, and the stall shows", () => {
    const signed = Array.from({ length: MAX_UNSUPERSEDED }, (_, i) => ({ slot: i + 1, txs: [pay(1n)] }));
    const full = { ...funded("right"), unsuperseded: signed };
    expect(stalled(full)).toBe(true);
    const blocked = propose(rulesAt(100n), queue(full, pay(1n)));
    const notice = { _tag: "signed_cap", first: 1, last: MAX_UNSUPERSEDED } as const;
    expect([blocked.sent, blocked.replica.pending, blocked.replica.mempool]).toEqual([[], undefined, []]);
    expect(blocked.replica.refused).toEqual([{ tx: pay(1n), fault: notice }]);
    expect(blocked.replica.unsuperseded).toEqual(signed);
    const room = { ...full, unsuperseded: signed.slice(1) };
    expect(stalled(room)).toBe(false);
    expect(propose(rulesAt(100n), queue(room, pay(1n))).sent).toHaveLength(1);
  });
});
