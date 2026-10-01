// R-FRAME-REFUSAL, Review A of PR 85 (round 3): the proposer's attempt and its retry budget are its own count. The
// receiver's mark only raises the next attempt, so a refusal that carries a lower mark neither lowers it nor buys
// retries.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import { type Ledger, type Side } from "../model.ts";
import { emptyAccount, withLedger } from "../state.ts";
import type { AccountTx } from "../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "./account.ts";
import { MAX_ATTEMPTS, propose, queue, receive, type Msg } from "./frame.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const rules = accountRules({ clock, view: viewOf(100n) }, signing);
const GOLD = tokenOf(1n);
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };
const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: withLedger(emptyAccount, GOLD, FUNDED) });
const pay: AccountTx = { _tag: "pay", token: GOLD, amount: 1n };

/** A proposer that has counted `attempt` refusals has a frame pending; it hears a retryable refusal carrying `mark`. */
const refusedAt = (attempt: number, mark: number) => {
  const proposed = propose(rules, queue({ ...funded("left"), attempt }, pay));
  const frame = proposed.replica.pending?.frame ?? expect.unreachable("nothing pending");
  const hash = rules.name(frame);
  const refusal: Msg<AccountTx> = { _tag: "refusal", hash, index: 0, fault: "not_expired", mark, floor: 0 };
  return receive(rules, proposed.replica, refusal).replica;
};

describe("account/frame R-FRAME-REFUSAL the proposer's count is its own", () => {
  test("a mark below my own attempt does not lower it", () => {
    const back = refusedAt(5, 0);
    expect([back.attempt, back.mempool, back.refused]).toEqual([6, [pay], []]);
  });

  test("a retryable fault past my own budget is dropped, whatever mark the refusal carries", () => {
    const back = refusedAt(MAX_ATTEMPTS, 0);
    expect([back.attempt, back.mempool, back.refused.map((x) => x.fault)]).toEqual([
      MAX_ATTEMPTS + 1, [], [{ _tag: "peer_refused", fault: "not_expired" }],
    ]);
  });
});
