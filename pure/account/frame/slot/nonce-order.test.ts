// R-PROOF-NONCE-ABOVE-SIGNED (Review A of PR 97: its red test is the first of the first describe, rewritten for the
// rule that makes it pass: the frame with the higher slot wins a collision, so the loser's proof is the one below).
// A proof a side signed and the peer holds, for a frame that did not commit, must not outrank the committed head by
// the contract's order (nonce, then a Left proof over a Right proof at one nonce: Account.sol, processCounterDisputes),
// else the peer starts a dispute with it and erases the frames that committed above or beside it.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { clockParams } from "../../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../../fixtures.ts";
import { emptyLedger } from "../../ledger.ts";
import { other, type AccountState, type Ledger, type Side } from "../../model.ts";
import { emptyAccount, withLedger } from "../../state.ts";
import type { AccountTx } from "../../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "../account.ts";
import { propose, queue, receive, type Msg } from "../frame.ts";
import { frameDigest } from "../../proof/signing.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rulesAt = (view: bigint) => accountRules({ clock, view: viewOf(view) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
// a lock whose deadline the author's view admits and the other side, a block behind, finds too far ahead (retryable)
const farLock = (side: Side): AccountTx => ({ _tag: "lock", token: GOLD, hold: holdOf(side, 5n, 1n, 114n, 1) });

type Proof = Readonly<{ author: Side; nonce: number }>;

/** The nonce a proof is signed at: the slot whose digest is the head (the first slot is 1). */
const proofOf = (author: Side, after: AccountState, head: string): Proof => ({
  author,
  nonce: Array.from({ length: 12 }, (_, i) => i + 1).find((slot) => {
    const digest = frameDigest(signing, slot, author, after);
    return digest.ok && digest.value === head;
  }) ?? -1,
});
const proposed = (r: AccountReplica): Proof => {
  const p = r.pending ?? expect.unreachable("nothing pending");
  return proofOf(r.side, p.after, p.head);
};

/** Account.sol: a higher nonce wins, and at one nonce only a Left proof replaces a Right one. */
const outranks = (a: Proof, b: Proof): boolean =>
  a.nonce > b.nonce || (a.nonce === b.nonce && a.author === "left" && b.author === "right");

describe("account/frame R-PROOF-NONCE-ABOVE-SIGNED no signed proof outlives a collision above the commit", () => {
  test("Right's retry meets Left's first frame: the higher slot keeps its frame, the other is below it", () => {
    const first = propose(rulesAt(102n), queue(funded("right"), farLock("right")));
    const refusedByLeft = receive(rulesAt(100n), funded("left"), only(first.sent));
    const rolled = receive(rulesAt(102n), first.replica, only(refusedByLeft.sent));
    const retry = propose(rulesAt(102n), rolled.replica);
    const own = propose(rulesAt(100n), queue(refusedByLeft.replica, pay(7n)));
    const kept = receive(rulesAt(102n), retry.replica, only(own.sent));
    expect(kept.outcome._tag).toBe("kept_own");
    const yielded = receive(rulesAt(102n), own.replica, only(retry.sent));
    expect(yielded.outcome._tag).toBe("accepted_over_own");
    expect(receive(rulesAt(102n), retry.replica, only(yielded.sent)).outcome._tag).toBe("committed_own");
    const committed = proposed(retry.replica);
    const stale = [proposed(first.replica), proposed(own.replica)];
    expect(stale.map((p) => outranks(committed, p))).toEqual([true, true]);
  });

  test("Right refuses Left's first attempt and proposes its own frame above it: it commits over Left's proof", () => {
    const first = propose(rulesAt(102n), queue(funded("left"), farLock("left")));
    const refusedByRight = receive(rulesAt(100n), funded("right"), only(first.sent));
    const rolled = receive(rulesAt(102n), first.replica, only(refusedByRight.sent));
    const own = propose(rulesAt(100n), queue(refusedByRight.replica, pay(9n)));
    const accepted = receive(rulesAt(102n), rolled.replica, only(own.sent));
    expect(accepted.outcome._tag).toBe("accepted");
    const committed = proposed(own.replica);
    expect(outranks(committed, proposed(first.replica))).toBe(true);
  });
});

describe("account/frame R-PROOF-NONCE-ABOVE-SIGNED every proof has a slot of its own, above all signed", () => {
  type Round = Readonly<{ mine: AccountReplica; peer: AccountReplica; slots: readonly number[] }>;
  /** `author`'s lock is refused by the peer over and over (its view is a block behind): the slot of each retry. */
  const slotsOf = (author: Side): readonly number[] =>
    Array.from({ length: 6 }).reduce<Round>(
      (acc) => {
        const sent = propose(rulesAt(102n), acc.mine);
        const refused = receive(rulesAt(100n), acc.peer, only(sent.sent));
        return {
          mine: receive(rulesAt(102n), sent.replica, only(refused.sent)).replica, peer: refused.replica,
          slots: [...acc.slots, proposed(sent.replica).nonce],
        };
      }, { mine: queue(funded(author), farLock(author)), peer: funded(other(author)), slots: [] }).slots;

  test("a retry climbs two slots: Left's are the even numbers from 2, Right's the odd ones from 1, none shared", () => {
    expect([slotsOf("left"), slotsOf("right")]).toEqual([[2, 4, 6, 8, 10, 12], [1, 3, 5, 7, 9, 11]]);
  });

  test("a replica refuses a frame that would commit below a proof it signed, naming the floor that clears it", () => {
    // Right's lock is refused at attempts 0 and 1 (slots 1 and 3) and rolled back: Right has signed up to slot 3
    const lockRound = (right: AccountReplica) => {
      const sent = propose(rulesAt(102n), right);
      const refused = receive(rulesAt(100n), funded("left"), only(sent.sent));
      return receive(rulesAt(102n), sent.replica, only(refused.sent));
    };
    const twice = lockRound(lockRound(queue(funded("right"), farLock("right"))).replica);
    expect([twice.outcome._tag, twice.replica.attempt, twice.replica.signed]).toEqual(["rolled_back", 2, 3]);
    // Left's frame at attempt 0 is slot 2, below it: refused as stale, mark 0, and costs Left nothing
    const left = propose(rulesAt(100n), queue(funded("left"), pay(3n)));
    const stale = receive(rulesAt(102n), twice.replica, only(left.sent));
    const answer = { _tag: "refusal", mark: 0, floor: 3 };
    expect([stale.outcome._tag, only(stale.sent)]).toMatchObject(["refused_stale", answer]);
    const back = receive(rulesAt(100n), left.replica, only(stale.sent));
    expect([back.outcome._tag, back.replica.attempt, back.replica.mempool]).toEqual(["rolled_back", 1, [pay(3n)]]);
    // Left goes above that floor: slot 4, above Right's 3. Right accepts it and Left commits on the ack
    const again = propose(rulesAt(100n), back.replica);
    const accepted = receive(rulesAt(102n), twice.replica, only(again.sent));
    expect(accepted.outcome._tag).toBe("accepted");
    expect(receive(rulesAt(100n), again.replica, only(accepted.sent)).outcome._tag).toBe("committed_own");
  });
});
