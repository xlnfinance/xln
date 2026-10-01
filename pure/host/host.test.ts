import { describe, expect, test } from "bun:test";
import { GENESIS } from "../account/frame/account.ts";
import type { Frame, FrameHash, Msg } from "../account/frame/frame.ts";
import type { AccountTx } from "../account/tx.ts";
import { credit, GOLD, open, pay } from "../entity/fixtures.ts";
import { emptyEntity, type EntityId, type EntityInput, type Outbound } from "../entity/model.ts";
import { err, ok } from "../kernel/core/result.ts";
import { setup } from "../runtime/fixtures.ts";
import { begin, idle, limits, persisted, receive, reopen, submit } from "./host.ts";
import type { Host, Item } from "./model.ts";
import { BOUNDS, entityOf, hostFor, hostOf, meet, sentIn, settle, stamp, tell, turn, unhalted } from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);

const peer = (from: EntityId, to: EntityId, msg: Msg<AccountTx>): Outbound => ({ from, to, msg });

const frameOf = (parent: FrameHash, txs: readonly AccountTx[]): Msg<AccountTx> => {
  const frame: Frame<AccountTx> = { author: "left", parent, attempt: 0, txs };
  return { _tag: "frame", frame };
};

const payFrame = (amount: bigint): Msg<AccountTx> => frameOf(GENESIS, [{ _tag: "pay", token: GOLD, amount }]);

const command = (to: EntityId, input: EntityInput): Item => ({ to, input });

/** Both Accounts open and Bob's credit heard; then Alice pays Bob 30, and her frame is the one message on the link. */
const aliceToBob = () => {
  const opened = settle(tell(tell(meet(ALICE, BOB), ALICE, open(BOB)), BOB, open(ALICE), credit(ALICE, 100n)));
  const paid = tell(opened, ALICE, pay(BOB, 30n));
  return { alice: hostOf(paid, ALICE), bob: hostOf(paid, BOB), sent: paid.link };
};

const filled = (host: Host, from: EntityId, n: number): Host =>
  Array.from({ length: n }).reduce<Host>((h) => receive(h, peer(from, ALICE, payFrame(1n))).host, host);

describe("host", () => {
  test("R-X1 a message for an Entity this Host does not host is refused in place, and queues nothing", () => {
    const host = hostFor(ALICE);
    const { host: after, notices } = receive(host, peer(BOB, CAROL, payFrame(1n)));
    expect(notices).toEqual([{ _tag: "misrouted", to: CAROL, from: BOB }]);
    expect(after).toBe(host);
    expect(idle(after)).toBe(true);
  });

  test("R-HOST-INBOX a sender over its bound is dropped with a notice; others and the Host's own queue on", () => {
    const full = filled(hostFor(ALICE), BOB, BOUNDS.perPeer);
    expect(full.queue).toHaveLength(BOUNDS.perPeer);
    const over = receive(full, peer(BOB, ALICE, payFrame(1n)));
    expect(over.notices).toEqual([{ _tag: "queue_full", from: BOB }]);
    expect(over.host).toBe(full);
    expect(receive(full, peer(CAROL, ALICE, payFrame(1n))).notices).toEqual([]);
    expect(submit(full, command(ALICE, open(BOB))).queue).toHaveLength(BOUNDS.perPeer + 1);
  });

  test("R-HOST-INBOX a bound below one is refused when the limits are made, since such a Host could never move", () => {
    expect(limits(0, 1)).toEqual(err({ _tag: "bad_limits", perPeer: 0, perFrame: 1 }));
    expect(limits(1, 0)).toEqual(err({ _tag: "bad_limits", perPeer: 1, perFrame: 0 }));
    expect(limits(1.5, 1).ok).toBe(false);
    expect(limits(1, 1)).toEqual(ok({ perPeer: 1, perFrame: 1 }));
  });

  test("R-DURABLE a frame that has begun asks for its row to be made durable, sends nothing and holds the Host", () => {
    const queued = submit(hostFor(ALICE), command(ALICE, open(BOB)));
    const begun = unhalted(begin(queued, stamp(1n)));
    expect(begun.effects.map((e) => e._tag)).toEqual(["persist"]);
    expect(idle(begun.host)).toBe(false);
    expect(begun.host.queue).toEqual([]);
    const again = unhalted(begin(submit(begun.host, command(ALICE, open(BOB))), stamp(2n)));
    expect(again.effects).toEqual([]);
    expect(again.host.queue).toHaveLength(1);
  });

  test("R-DURABLE the outputs of a row leave only once the row is durable, once, and never an earlier row's", () => {
    const { bob, sent } = aliceToBob();
    expect(sent.map((o) => o.msg._tag)).toEqual(["frame"]);
    const heard = unhalted(begin(receive(bob, sent[0] as Outbound).host, stamp(30n)));
    expect(sentIn(heard.effects)).toEqual([]);
    const done = unhalted(persisted(heard.host));
    expect(sentIn(done.effects).map((o) => o.msg._tag)).toEqual(["ack"]);
    const next = turn(submit(done.host, command(BOB, credit(ALICE, 200n))), 40n);
    expect(next.sent.map((o) => o.msg._tag)).toEqual(["frame"]);
  });

  test("R-X1 a forged ack, a future frame and a stranger's message are rows with notices, never a halt", () => {
    const junk = `0x${"dead".repeat(16)}` as FrameHash;
    const forged: Msg<AccountTx> = { _tag: "ack", hash: GENESIS };
    const mail = [peer(ALICE, BOB, forged), peer(ALICE, BOB, frameOf(junk, [])), peer(CAROL, BOB, payFrame(1n))];
    const done = turn(mail.reduce((h, m) => receive(h, m).host, hostFor(BOB)), 5n);
    const notices = done.host.runtime.wal.flatMap((row) => row.notices.map((n) => n._tag));
    expect(notices.length).toBeGreaterThan(0);
    expect(done.sent.filter((o) => o.msg._tag === "ack")).toEqual([]);
  });

  test("a frame takes the first Entity's queued inputs in arrival order, up to its bound; the rest wait", () => {
    const items = [
      command(ALICE, open(BOB)), command(BOB, open(ALICE)),
      command(ALICE, credit(BOB, 5n)), command(ALICE, credit(BOB, 6n)),
    ];
    const begun = unhalted(begin(items.reduce(submit, hostFor(ALICE, BOB)), stamp(1n)));
    const row = begun.host.runtime.staged;
    expect(row?.input.to).toBe(ALICE);
    expect(row?.input.inputs.map((i) => i._tag)).toEqual(["open_account", "set_credit"]);
    expect(begun.host.queue.map((i) => i.to)).toEqual([BOB, ALICE]);
  });

  test("R-X1 one input queued three times is three inputs: the third stays queued", () => {
    const item = command(ALICE, open(BOB));
    const begun = unhalted(begin([item, item, item].reduce(submit, hostFor(ALICE)), stamp(1n)));
    expect(begun.host.runtime.staged?.input.inputs).toHaveLength(BOUNDS.perFrame);
    expect(begun.host.queue).toHaveLength(3 - BOUNDS.perFrame);
  });

  test("R-DURABLE after a crash the Host is the durable rows alone, and every committed output leaves again", () => {
    const { alice } = aliceToBob();
    const staged = unhalted(begin(submit(alice, command(ALICE, credit(BOB, 9n))), stamp(90n)));
    const rows = staged.host.runtime.wal;
    const back = unhalted(reopen(setup, [emptyEntity(ALICE)], rows, BOUNDS));
    expect(back.host.queue).toEqual([]);
    expect(idle(back.host)).toBe(true);
    expect(back.host.runtime.wal).toEqual(rows);
    expect(sentIn(back.effects)).toEqual(alice.runtime.wal.flatMap((row) => row.outputs));
    const held = (host: Host) => host.runtime.entities.get(ALICE)?.accounts.get(BOB);
    expect(held(back.host)).toEqual(held(alice));
  });
});
