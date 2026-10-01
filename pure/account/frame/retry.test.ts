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
import { accountRules, emptyReplica, type AccountReplica } from "./account.ts";
import { propose, queue, receive, type Msg } from "./frame.ts";

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
