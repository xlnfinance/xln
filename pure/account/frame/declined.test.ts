// R-FRAME-REFUSAL, Review A of PR 85: a frame a replica refused stays refused for as long as its head lasts, whatever
// else happened since. The proposer drops the refused tx on the refusal, so a late copy of the frame that is accepted
// would put that tx in one history and not in the other. Two ways to lose the memory are pinned here: a refusal that
// ends one of my own pending frames must not clear what I refused, and every refused frame is kept, not the first only.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { holdOf, secretOf, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import { holdId, type Ledger, type Side } from "../model.ts";
import { emptyAccount, withLedger } from "../state.ts";
import type { AccountTx } from "../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "./account.ts";
import { propose, queue, receive, type Msg } from "./frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const at = (view: bigint) => accountRules({ clock, view: viewOf(view) });
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");

const lock = (id: bigint, deadline: bigint): AccountTx =>
  ({ _tag: "lock", token: GOLD, hold: holdOf("left", 5n, id, deadline, Number(id)) });
const expire: AccountTx = { _tag: "expire", token: GOLD, id: holdId(1n) };
const resolve: AccountTx = { _tag: "resolve", token: GOLD, id: holdId(2n), secret: secretOf(2) };

/** Both replicas have committed Left's locks of slot 1 (deadline 101) and slot 2 (deadline 104), at view 100. */
const locked = [lock(1n, 101n), lock(2n, 104n)].reduce((both, tx) => {
  const proposed = propose(at(100n), queue(both.left, tx));
  const accepted = receive(at(100n), both.right, only(proposed.sent));
  return { left: receive(at(100n), proposed.replica, only(accepted.sent)).replica, right: accepted.replica };
}, { left: funded("left"), right: funded("right") });

describe("account/frame R-FRAME-REFUSAL a refused frame stays refused on its head", () => {
  test("a refusal that ends my own pending frame does not clear what I refused: a late copy is refused again", () => {
    const leftG = propose(at(105n), queue(locked.left, expire));      // Left, view 105: the expiry is due
    const rightF = propose(at(103n), queue(locked.right, resolve));   // Right, view 103: the resolve is still live
    const rightRefusesG = receive(at(103n), rightF.replica, only(leftG.sent)); // Right's view: too early to expire
    const leftRollsBack = receive(at(105n), leftG.replica, only(rightRefusesG.sent));
    const leftRefusesF = receive(at(105n), leftRollsBack.replica, only(rightF.sent)); // Left's view: past the deadline
    const rightRollsBack = receive(at(103n), rightRefusesG.replica, only(leftRefusesF.sent));
    const outcomes = [rightRefusesG, leftRollsBack, leftRefusesF, rightRollsBack].map((heard) => heard.outcome._tag);
    expect(outcomes).toEqual(["refused_invalid", "rolled_back", "refused_invalid", "rolled_back"]);
    // Left dropped the expiry; at view 105 Right would apply a late copy of G, so only the memory refuses it
    expect(receive(at(105n), rightRollsBack.replica, only(leftG.sent)).outcome._tag).toBe("refused_invalid");
  });

  test("two different frames refused on one head are both kept: a late copy of the second is refused", () => {
    const first = propose(at(105n), queue(locked.left, expire));
    const refusedFirst = receive(at(103n), locked.right, only(first.sent));
    const back = receive(at(105n), first.replica, only(refusedFirst.sent));
    const pay: AccountTx = { _tag: "pay", token: GOLD, amount: 1n };
    const second = propose(at(105n), queue(queue(back.replica, expire), pay));
    const refusedSecond = receive(at(103n), refusedFirst.replica, only(second.sent));
    expect(refusedSecond.outcome._tag).toBe("refused_invalid");
    expect(receive(at(105n), refusedSecond.replica, only(second.sent)).outcome._tag).toBe("refused_invalid");
  });
});
