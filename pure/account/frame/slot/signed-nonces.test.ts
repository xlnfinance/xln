// R-PROOF-NONCE-ABOVE-SIGNED, Review B of PR 97 (its three red tests, written against the head with slots carried in
// the frame). Every signature a node gives, as proposer or as the one who acks, is at a slot above every proof that
// node signed and the Account then left behind, and the frame that commits is above every proof either side
// abandoned: the peer disputes with the highest proof it holds, and the honest counter needs a nonce at least as high
// (at an equal nonce only Left beats Right, A12). A proof is read off the round's own messages: a frame carries its
// author's signature at its slot, and an ack carries the acker's signature on the same head.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { clockParams } from "../../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../../fixtures.ts";
import { emptyLedger } from "../../ledger.ts";
import { holdId, type Ledger, type Side } from "../../model.ts";
import { emptyAccount, withLedger } from "../../state.ts";
import type { AccountTx } from "../../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "../account.ts";
import { propose, queue, receive, type Msg } from "../frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const at = (view: bigint) => accountRules({ clock, view: viewOf(view) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 101n, 1) };
const expire: AccountTx = { _tag: "expire", token: GOLD, id: holdId(1n) };

type Signature = Readonly<{ signer: Side; slot: number; head: string }>;

/** The proof a proposer signed when it sent its pending frame. */
const proofOf = (signer: Side, proposer: AccountReplica): Signature => {
  const pending = proposer.pending ?? expect.unreachable("nothing pending");
  return { signer, slot: pending.frame.slot, head: pending.head };
};
/** The proof an acker signed: the same head at the same slot as the frame it acks. */
const ackOf = (signer: Side, slot: number, ack: Msg<AccountTx>): Signature =>
  ({ signer, slot, head: ack._tag === "ack" ? ack.hash : expect.unreachable("an ack") });

const twoOnOneNonce = (all: readonly Signature[]) =>
  all.filter((s, i) => all.some((t, j) => j < i && t.signer === s.signer && t.slot === s.slot && t.head !== s.head));
const abandonedBelow = (all: readonly Signature[], committed: Signature) =>
  all.filter((s) => s.head !== committed.head).map((s) => s.slot < committed.slot);

describe("account/frame R-PROOF-NONCE-ABOVE-SIGNED one signer, one proof per nonce, the commit above the rest", () => {
  test("simultaneous proposals: the side that yields signs the winner's frame above the one it abandons", () => {
    const g = propose(at(100n), queue(funded("left"), pay(7n)));
    const f = propose(at(100n), queue(funded("right"), pay(3n)));
    const yielded = receive(at(100n), f.replica, only(g.sent));
    expect(yielded.outcome._tag).toBe("accepted_over_own");
    const committed = proofOf("left", g.replica);
    const all = [committed, proofOf("right", f.replica), ackOf("right", committed.slot, only(yielded.sent))];
    expect(twoOnOneNonce(all)).toEqual([]);
    expect(abandonedBelow(all, committed)).toEqual([true]);
    expect(receive(at(100n), g.replica, only(yielded.sent)).outcome._tag).toBe("committed_own");
  });

  /** Left locks and Right accepts: both hold the lock at slot 2. */
  const locked = (() => {
    const l1 = propose(at(100n), queue(funded("left"), lock));
    const r1 = receive(at(100n), funded("right"), only(l1.sent));
    return { left: receive(at(100n), l1.replica, only(r1.sent)).replica, right: r1.replica };
  })();
  /** Right proposes the expiry; Left, whose view is 103, finds it not yet due and refuses. */
  const refusedRound = (right: AccountReplica, left: AccountReplica) => {
    const sent = propose(at(104n), right);
    const refused = receive(at(103n), left, only(sent.sent));
    return { sent, left: refused.replica, right: receive(at(104n), sent.replica, only(refused.sent)).replica };
  };

  test("a frame the peer refused leaves a signed proof; the peer's own frame then commits above it", () => {
    const first = refusedRound(queue(locked.right, expire), locked.left);
    const g = propose(at(103n), queue(first.left, pay(7n)));
    const accepted = receive(at(104n), first.right, only(g.sent));
    expect(accepted.outcome._tag).toBe("accepted");
    const committed = proofOf("left", g.replica);
    const all = [proofOf("right", first.sent.replica), committed, ackOf("right", committed.slot, only(accepted.sent))];
    expect(twoOnOneNonce(all)).toEqual([]);
    expect(abandonedBelow(all, committed)).toEqual([true]);
  });

  test("refused twice, Right meets Left's frame at its third attempt: nothing signed lies above the commit", () => {
    const one = refusedRound(queue(locked.right, expire), locked.left);
    const two = refusedRound(one.right, one.left);
    const three = propose(at(104n), two.right);
    const g = propose(at(103n), queue(two.left, pay(7n)));
    // Right keeps its higher frame and ignores Left's; Left, now at view 104, accepts Right's and drops its own
    expect(receive(at(104n), three.replica, only(g.sent)).outcome._tag).toBe("kept_own");
    const yielded = receive(at(104n), g.replica, only(three.sent));
    expect(yielded.outcome._tag).toBe("accepted_over_own");
    const committed = proofOf("right", three.replica);
    const all = [
      proofOf("right", one.sent.replica), proofOf("right", two.sent.replica), committed, proofOf("left", g.replica),
      ackOf("left", committed.slot, only(yielded.sent)),
    ];
    expect(twoOnOneNonce(all)).toEqual([]);
    expect(abandonedBelow(all, committed)).toEqual([true, true, true]);
    expect(receive(at(104n), three.replica, only(yielded.sent)).outcome._tag).toBe("committed_own");
  });

  test("one frame from the peer cannot spend the nonce space: an attempt is a label, never part of a nonce", () => {
    const peer = { ...queue(funded("left"), pay(1n)), attempt: Number.MAX_SAFE_INTEGER - 20 };
    const sent = propose(at(100n), peer);
    const heard = receive(at(100n), funded("right"), only(sent.sent));
    expect(heard.outcome._tag).toBe("accepted");
    const done = receive(at(100n), sent.replica, only(heard.sent));
    expect([done.replica.used, heard.replica.used]).toEqual([2, 2]);
    const next = propose(at(100n), queue(heard.replica, pay(2n)));
    expect(proofOf("right", next.replica).slot).toBe(3);
  });
});
