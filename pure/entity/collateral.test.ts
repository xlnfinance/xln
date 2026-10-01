import { describe, expect, test } from "bun:test";
import type { Msg } from "../account/frame/frame.ts";
import { ledgerOf } from "../account/state.ts";
import type { AccountTx } from "../account/tx.ts";
import { tokenOf } from "../account/fixtures.ts";
import { anchor, credit, entityOf, GOLD, judge, open, pay } from "./fixtures.ts";
import { entityFrame } from "./frame.ts";
import { emptyEntity, type EntityInput, type EntityState, type JEvent } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);

const run = (state: EntityState, ...inputs: readonly EntityInput[]) => entityFrame(judge, anchor, state, inputs);

const opened = (self: typeof ALICE, peer: typeof ALICE): EntityState => run(emptyEntity(self), open(peer)).state;

const held = (collateral: bigint, ondelta: bigint, peer = BOB, token = GOLD): JEvent =>
  ({ _tag: "j_collateral", peer, token, collateral, ondelta });

const ledgerFor = (state: EntityState, peer: typeof ALICE) => {
  const account = state.accounts.get(peer);
  return account === undefined ? undefined : ledgerOf(account.state, GOLD);
};

const heard = (from: typeof ALICE, msg: Msg<AccountTx>): EntityInput => ({ _tag: "peer_message", from, msg });

describe("entity/frame what the chain holds for an Account (R-J-COLLATERAL)", () => {
  const alice = opened(ALICE, BOB);

  test("R-J-COLLATERAL the chain's collateral and ondelta are set as they stand; a repeat changes nothing", () => {
    const first = run(alice, held(100n, 100n));
    expect(ledgerFor(first.state, BOB)).toMatchObject({ collateral: 100n, ondelta: 100n, offdelta: 0n });
    expect(run(first.state, held(100n, 100n)).state).toEqual(first.state);
    const lower = run(first.state, held(90n, -5n));
    expect(ledgerFor(lower.state, BOB)).toMatchObject({ collateral: 90n, ondelta: -5n });
    expect(first.notices).toEqual([]);
  });

  test("R-J-COLLATERAL one token's snapshot leaves the other tokens and the off-chain fields as they were", () => {
    const credited = run(alice, credit(BOB, 7n)).state;
    const settled = run(credited, held(50n, 50n));
    expect(ledgerFor(settled.state, BOB)).toMatchObject({ limit: { left: 0n, right: 0n }, offdelta: 0n });
    const other = run(settled.state, held(9n, 0n, BOB, GOLD));
    expect(ledgerFor(other.state, BOB)?.collateral).toBe(9n);
    const elsewhere = run(alice, held(5n, 5n, BOB, tokenOf(2n)));
    expect(ledgerFor(elsewhere.state, BOB)).toEqual(ledgerFor(alice, BOB));
  });

  test("R-J-COLLATERAL an Account the Entity does not hold is told and ignored", () => {
    const stranger = run(alice, held(10n, 10n, CAROL));
    expect(stranger.notices).toEqual([{ _tag: "unknown_peer", from: CAROL }]);
    expect(stranger.state).toEqual(alice);
  });

  test("R-J-COLLATERAL what the chain holds is what a payment may spend: Left pays from its deposit", () => {
    const before = run(alice, pay(BOB, 40n));
    expect(before.outputs).toEqual([]);
    expect(before.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    const after = run(run(alice, held(100n, 100n)).state, pay(BOB, 40n));
    expect(after.notices).toEqual([]);
    expect(after.outputs.map((o) => o.to)).toEqual([BOB]);
  });

  test("R-J-COLLATERAL a frame in flight when the chain is heard commits with the chain's amounts", () => {
    const proposed = run(alice, credit(BOB, 5n));
    const midway = run(proposed.state, held(100n, 100n));
    const pending = midway.state.accounts.get(BOB)?.pending;
    expect(pending === undefined ? undefined : ledgerOf(pending.after, GOLD).collateral).toBe(100n);
    const sent = proposed.outputs[0];
    const bob = run(opened(BOB, ALICE), heard(ALICE, sent === undefined ? expect.unreachable("sent") : sent.msg));
    const ack = bob.outputs[0];
    const done = run(midway.state, heard(BOB, ack === undefined ? expect.unreachable("ack") : ack.msg));
    expect(done.state.accounts.get(BOB)?.pending).toBeUndefined();
    expect(ledgerFor(done.state, BOB))
      .toMatchObject({ collateral: 100n, ondelta: 100n, limit: { left: 0n, right: 5n } });
  });
});
