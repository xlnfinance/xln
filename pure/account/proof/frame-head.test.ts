// R-FRAME-HASH-SIGNED and R-PROOF-NONCE on the frame round: the head a frame gives once it commits is the digest its
// signers sign, the ack carries it, and a frame signs at a nonce slot above every slot spent (two slots an attempt,
// Left's the higher), so no two frames share a nonce. The content name stays what refusals and repeats are matched by.
import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import type { AccountFault, Ledger, Side } from "../model.ts";
import { emptyAccount, withLedger } from "../state.ts";
import type { AccountTx } from "../tx.ts";
import { accountRules, emptyReplica, frameName, type AccountReplica } from "../frame/account.ts";
import {
  propose, queue, receive, submit, type FrameHash, type Msg, type Rules,
} from "../frame/frame.ts";
import { frameDigest, type SigningContext } from "./signing.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rulesIn = (c: SigningContext) => accountRules({ clock, view: viewOf(100n) }, c);
const rules = rulesIn(signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });
const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 105n, 1) };
const digestOf = (c: SigningContext, height: number, author: Side, r: AccountReplica): FrameHash =>
  unwrapOr(frameDigest(c, height, author, r.state), (e) => expect.unreachable(JSON.stringify(e))) as FrameHash;

/** Left proposes `tx`, Right accepts it, Left commits on the ack. */
type R = Rules<AccountTx, AccountReplica["state"], AccountFault>;
const round = (r: R, left: AccountReplica, right: AccountReplica, tx: AccountTx) => {
  const sent = propose(r, queue(left, tx));
  const heard = receive(r, right, only(sent.sent));
  const done = receive(r, sent.replica, only(heard.sent));
  return { sent, heard, done };
};

describe("account/proof R-FRAME-HASH-SIGNED the head a frame gives is the digest its signers sign", () => {
  const first = round(rules, funded("left"), funded("right"), lock);

  test("both replicas hold the digest of the state the frame made, by its author, at its slot", () => {
    // Left's first frame is slot 2: the slot below it is Right's at the same attempt
    const head = digestOf(signing, 2, "left", first.done.replica);
    expect([first.done.outcome, first.heard.outcome]).toEqual([{ _tag: "committed_own" }, { _tag: "accepted" }]);
    expect([first.done.replica.head, first.heard.replica.head]).toEqual([head, head]);
    expect([first.done.replica.height, first.heard.replica.height]).toEqual([1, 1]);
    expect([first.done.replica.used, first.heard.replica.used]).toEqual([2, 2]);
    expect(first.sent.replica.pending?.head).toBe(head);
  });

  test("the ack carries the head, not the content name, and an ack that names the content is ignored", () => {
    const frame = only(first.sent.sent);
    const name = frame._tag === "frame" ? frameName(frame.frame) : expect.unreachable("a frame");
    expect(only(first.heard.sent)).toEqual({ _tag: "ack", hash: first.heard.replica.head });
    expect(name).not.toBe(first.heard.replica.head);
    const wrong = receive(rules, first.sent.replica, { _tag: "ack", hash: name });
    expect(wrong.outcome).toEqual({ _tag: "ack_ignored" });
    expect(wrong.replica).toEqual(first.sent.replica);
  });

  test("a repeat of the frame just committed is answered with the ack of its head", () => {
    const repeat = receive(rules, first.heard.replica, only(first.sent.sent));
    expect(repeat.outcome).toEqual({ _tag: "re_acked" });
    expect(repeat.sent).toEqual([{ _tag: "ack", hash: first.heard.replica.head }]);
    expect(repeat.replica).toEqual(first.heard.replica);
  });

  test("R-PROOF-NONCE a frame signs above every slot spent: Left's next is slot 4, no other slot is its digest", () => {
    const second = round(rules, first.done.replica, first.heard.replica, pay(1n));
    const next = { ...signing, firstNonce: signing.firstNonce + 1n };
    expect([second.done.replica.height, second.done.replica.used]).toEqual([2, 4]);
    expect(second.done.replica.head).toBe(digestOf(signing, 4, "left", second.done.replica));
    expect(second.done.replica.head).toBe(digestOf(next, 3, "left", second.done.replica));
    const head = second.done.replica.head;
    expect([1, 2, 3, 5].map((slot) => digestOf(signing, slot, "left", second.done.replica) === head))
      .toEqual([false, false, false, false]);
  });

  test("the author is bound: Right's frame on the same state signs another digest than Left's would", () => {
    const right = round(rules, funded("right"), funded("left"), pay(1n));
    expect(right.heard.replica.head).toBe(digestOf(signing, 1, "right", right.heard.replica));
    expect(right.heard.replica.head).not.toBe(digestOf(signing, 2, "left", right.heard.replica));
  });
});

describe("account/proof R-FRAME-HASH-SIGNED a state with no proof body is refused before anyone signs it", () => {
  const stateless = { ...signing, terms: { ...signing.terms, secondsOf: () => 0n } };
  const refused: AccountFault = { _tag: "unsignable", fault: "deadline_not_positive" };

  test("a tx that would leave one is refused at admission, and a peer that cannot sign it refuses the frame", () => {
    const admitted = submit(rulesIn(stateless), funded("left"), lock);
    expect(admitted).toEqual({ ok: false, error: refused });
    const sent = propose(rules, queue(funded("left"), lock));
    const heard = receive(rulesIn(stateless), funded("right"), only(sent.sent));
    expect(heard.outcome).toEqual({ _tag: "refused_invalid", fault: refused });
    expect(heard.replica.height).toBe(0);
  });

  test("a frame whose digest cannot be made is refused with notice by its proposer, and by its receiver", () => {
    const unsealable: AccountFault = { _tag: "unsignable", fault: "height_not_signed" };
    const failing: R = { ...rules, seal: () => err(unsealable) };
    const proposed = propose(failing, queue(funded("left"), pay(1n)));
    expect([proposed.sent, proposed.replica.pending]).toEqual([[], undefined]);
    expect(proposed.replica.refused).toEqual([{ tx: pay(1n), fault: unsealable }]);
    const sent = propose(rules, queue(funded("left"), pay(1n)));
    const heard = receive(failing, funded("right"), only(sent.sent));
    expect(heard.outcome).toEqual({ _tag: "refused_invalid", fault: unsealable });
    expect([only(heard.sent)]).toMatchObject([{ _tag: "refusal", index: 0, fault: "unsignable" }]);
  });
});

describe("account/proof R-RETRY-NEW-NONCE a retried frame is signed at a nonce no earlier attempt used", () => {
  const at = (view: bigint) => accountRules({ clock, view: viewOf(view) }, signing);
  // Left's view 102 admits a deadline up to 114; Right's view 100 admits up to 112: Right refuses the first attempt
  const far: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 114n, 1) };
  const first = propose(at(102n), queue(funded("left"), far));
  const refused = receive(at(100n), funded("right"), only(first.sent));
  const back = receive(at(102n), first.replica, only(refused.sent));
  const again = propose(at(102n), back.replica);
  const accepted = receive(at(102n), refused.replica, only(again.sent));
  const done = receive(at(102n), again.replica, only(accepted.sent));

  test("R-RETRY-NEW-NONCE the retry is signed two slots above the refused attempt, at another digest", () => {
    expect(refused.outcome._tag).toBe("refused_invalid");
    expect(first.replica.pending?.head).toBe(digestOf(signing, 2, "left", done.replica));
    expect(again.replica.pending?.head).toBe(digestOf(signing, 4, "left", done.replica));
    expect(again.replica.pending?.head).not.toBe(first.replica.pending?.head);
  });

  test("both replicas commit the retry at that slot and spend it, and the refused attempt with it", () => {
    const head = again.replica.pending?.head ?? expect.unreachable("pending");
    expect([accepted.replica.head, done.replica.head]).toEqual([head, head]);
    expect([accepted.replica.height, accepted.replica.used]).toEqual([1, 4]);
    expect([done.replica.height, done.replica.used]).toEqual([1, 4]);
  });

  test("the next frame signs above every slot spent, whatever its own attempt", () => {
    const next = round(at(102n), done.replica, accepted.replica, pay(1n));
    expect(next.done.replica.head).toBe(digestOf(signing, 6, "left", next.done.replica));
    expect(next.heard.replica.head).toBe(next.done.replica.head);
    expect([next.done.replica.height, next.done.replica.used]).toEqual([2, 6]);
  });

  test("a nonce the contract would refuse is not signed: no digest at the ceiling, a refusal with notice", () => {
    const nearly = { ...signing, firstNonce: BigInt(Number.MAX_SAFE_INTEGER) - 2n };
    expect([1, 2].map((slot) => frameDigest(nearly, slot, "left", funded("left").state).ok)).toEqual([true, true]);
    expect(frameDigest(nearly, 3, "left", funded("left").state)).toEqual({
      ok: false, error: { _tag: "height_not_signed", height: 3 },
    });
  });
});
