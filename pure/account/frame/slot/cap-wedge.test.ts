// R-NOTICE and R-SIGNED-IS-LIVE, Review B of PR 97 round 2: the cap on signed-but-unsuperseded frames
// (MAX_UNSUPERSEDED) is reached by an honest peer too, with nothing but refusals: every refused frame leaves its
// proof live and the next frame must go above it. At the cap `propose` signs nothing more, and a tx it will not take
// is refused with notice (the slot range of the live proofs), never left silent; the stall is `stalled`, for the
// Runtime to act on.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../../kernel/core/result.ts";
import { clockParams } from "../../clause/clock.ts";
import { holdOf, signing, tokenOf, viewOf } from "../../fixtures.ts";
import { emptyLedger } from "../../ledger.ts";
import type { Ledger, Side } from "../../model.ts";
import { emptyAccount, withLedger } from "../../state.ts";
import type { AccountTx } from "../../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "../account.ts";
import { MAX_UNSUPERSEDED, propose, queue, receive, stalled, type Msg } from "../frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rules = accountRules({ clock, view: viewOf(100n) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");
const lock = (id: bigint): AccountTx =>
  ({ _tag: "lock", token: GOLD, hold: holdOf("right", 5n, id, 108n, Number(id)) });

/** One round of a client that resends lock 1 which the peer already holds: refused, and the proof stays live. */
type Pair = Readonly<{ left: AccountReplica; right: AccountReplica }>;
const resent = (p: Pair): Pair => {
  const sent = propose(rules, queue(p.right, lock(1n)));
  const refused = receive(rules, p.left, only(sent.sent));
  return { left: refused.replica, right: receive(rules, sent.replica, only(refused.sent)).replica };
};

describe("account/frame R-NOTICE the cap on signed frames never leaves a tx silent", () => {
  test("an honest peer refuses MAX_UNSUPERSEDED frames for good; the next valid payment is refused with notice", () => {
    // Left holds lock 1 and refuses Right's lock 1 as it keeps coming (lock_exists): a client that does not know
    const first = propose(rules, queue(funded("right"), lock(1n)));
    const accepted = receive(rules, funded("left"), only(first.sent));
    const done = receive(rules, first.replica, only(accepted.sent)).replica;
    // Right then forgets lock 1 (a client resending it): same committed head, a state without the hold
    const forgot = { ...funded("right"), head: done.head, height: done.height, used: done.used, signed: done.signed };
    const start: Pair = { left: accepted.replica, right: { ...forgot, peerSigned: done.peerSigned, last: done.last } };
    const capped = Array.from({ length: MAX_UNSUPERSEDED }).reduce<Pair>((p) => resent(p), start);
    expect(stalled(capped.right)).toBe(true);
    const pay: AccountTx = { _tag: "pay", token: GOLD, amount: 1n };
    const next = propose(rules, queue(capped.right, pay));
    expect(next.sent).toEqual([]);
    expect(next.replica.refused.slice(capped.right.refused.length)).toEqual([
      { tx: pay, fault: { _tag: "signed_cap", first: expect.any(Number), last: expect.any(Number) } },
    ]);
    expect(next.replica.mempool).toEqual([]);
  });
});
