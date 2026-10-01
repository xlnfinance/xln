// The Host and the chain: a row that asks the chain for something (here Bob's reveal of a secret whose resolve Alice
// has not acked, near the clause's deadline) lets that ask leave only once the row is durable, and a J height the J
// loop hands over is a frame of its own, ahead of the queue. Bob's Runtime is the one of runtime/htlc/reveal.test.ts.
import { describe, expect, test } from "bun:test";
import { heightOf, holdOf, secretOf, viewOf } from "../account/fixtures.ts";
import { holdId } from "../account/model.ts";
import { emptyEntity, type Command } from "../entity/model.ts";
import { credit, feed, GOLD, hostOf, open, settle, start } from "../runtime/fixtures.ts";
import { begin, heard, idle, persisted, reopen, startHost, submit } from "./host.ts";
import { BOUNDS, chainIn, entityOf, inputsOf, stamp, unhalted } from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const lockIn = (id: bigint, deadline: bigint): Command =>
  ({ _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, id, deadline, 1) });

const resolveOf = (id: bigint): Command =>
  ({ _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(id), secret: secretOf(1) });

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const locked = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lockIn(1n, 115n)));

/** Bob has resolved the clause that falls due at 115, and Alice's ack has not come. */
const bob = () => startHost(hostOf(feed(locked, BOB, resolveOf(1n)), BOB), BOUNDS);

const tagsOf = (host: ReturnType<typeof bob>, height: bigint) => {
  const begun = unhalted(begin(heard(host, heightOf(height)), stamp(100n)));
  return chainIn(unhalted(persisted(begun.host)).effects).map((a) => a._tag);
};

describe("host/chain a row's asks of the chain leave with its outputs, after it is durable", () => {
  test("R-DURABLE a frame that asks the chain for a reveal sends no chain action until its row is durable", () => {
    const begun = unhalted(begin(heard(bob(), heightOf(114n)), stamp(100n)));
    expect(begun.effects.map((e) => e._tag)).toEqual(["persist"]);
    expect(chainIn(begun.effects)).toEqual([]);
    const done = unhalted(persisted(begun.host));
    expect(chainIn(done.effects).map((a) => a._tag)).toEqual(["reveal"]);
    expect(unhalted(begin(done.host, stamp(101n))).effects).toEqual([]);
  });

  test("R-DURABLE after a crash every committed chain action is asked again, once", () => {
    const host = bob();
    const begun = unhalted(begin(heard(host, heightOf(114n)), stamp(100n)));
    const wal = unhalted(persisted(begun.host)).host.runtime.wal;
    const back = unhalted(reopen(host.runtime.setup, [emptyEntity(BOB)], wal, BOUNDS));
    expect(chainIn(back.effects).map((a) => a._tag)).toEqual(["reveal"]);
  });

  test("a height far from the deadline asks nothing of the chain", () => {
    expect(tagsOf(bob(), 113n)).toEqual([]);
    expect(tagsOf(bob(), 114n)).toEqual(["reveal"]);
  });
});

describe("host/height a J height is a frame of its own, ahead of the queue; the highest stands for the rest", () => {
  const queued = submit(heard(heard(heard(bob(), heightOf(112n)), heightOf(113n)), heightOf(111n)), {
    to: BOB, input: credit(ALICE, 5n),
  });

  test("the frame takes the highest height heard, and no queued input", () => {
    const begun = unhalted(begin(queued, stamp(100n)));
    expect(begun.host.runtime.staged?.input).toMatchObject({ _tag: "j_height", height: heightOf(113n) });
    expect(begun.host.height).toBeUndefined();
    expect(begun.host.queue).toHaveLength(1);
    expect(idle(begun.host)).toBe(false);
  });

  test("after the height frame is durable the queued input takes the next frame; the height is not taken twice", () => {
    const done = unhalted(persisted(unhalted(begin(queued, stamp(100n))).host));
    const next = unhalted(begin(done.host, stamp(101n)));
    const staged = next.host.runtime.staged;
    expect(staged === undefined ? [] : inputsOf(staged.input).map((i) => i._tag)).toEqual(["set_credit"]);
    expect(next.host.queue).toEqual([]);
  });
});
