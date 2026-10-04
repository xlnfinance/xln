// The Host and the chain: a row that asks the chain for something (here Bob's reveal of a secret whose resolve Alice
// has not acked, near the clause's deadline) lets that ask leave only once the row is durable, and a J height the J
// loop hands over is a frame of its own, ahead of the queue. Bob's Runtime is the one of runtime/htlc/reveal.test.ts.
import { describe, expect, test } from "bun:test";
import { heightOf, holdOf, secretOf, viewOf } from "../account/fixtures.ts";
import { holdId } from "../account/model.ts";
import { emptyEntity, type Command } from "../entity/model.ts";
import { credit, feed, GOLD, hostOf, open, settle, start } from "../runtime/fixtures.ts";
import { begin, heard, idle, persisted, reopen, startHost, submit, upcoming } from "./host.ts";
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

  test("R-REGISTRY-AT-VIEW a waiting height is the frame to come, at that height, for every Entity", () => {
    expect(upcoming(queued)).toEqual({ view: viewOf(113n), to: undefined, inputs: [] });
    expect(upcoming(unhalted(begin(queued, stamp(100n))).host)).toBeUndefined();
  });

  test("after the height frame is durable the queued input takes the next frame; the height is not taken twice", () => {
    const done = unhalted(persisted(unhalted(begin(queued, stamp(100n))).host));
    const next = unhalted(begin(done.host, stamp(101n)));
    const staged = next.host.runtime.staged;
    expect(staged === undefined ? [] : inputsOf(staged.input).map((i) => i._tag)).toEqual(["set_credit"]);
    expect(next.host.queue).toEqual([]);
  });

  test("R-HOP-SLACK the second of a height's block waits with it, and the highest height's stands for the rest", () => {
    const host = bob();
    const waiting = heard(heard(host, heightOf(host.runtime.view + 2n), 500n), heightOf(host.runtime.view + 1n), 400n);
    expect(waiting).toMatchObject({ height: heightOf(host.runtime.view + 2n), seconds: 500n });
    expect(heard(waiting, heightOf(host.runtime.view + 3n), 600n)).toMatchObject({ seconds: 600n });
    const staged = unhalted(begin(waiting, stamp(100n))).host;
    expect(staged).toMatchObject({ height: undefined, seconds: undefined });
    expect(unhalted(begin(waiting, stamp(100n))).host.runtime.staged?.input).toMatchObject({ seconds: 500n });
  });

  test("a height that does not rise above the Runtime's view is not kept: no frame and no row", () => {
    const host = bob();
    const view = host.runtime.view;
    expect(heard(host, heightOf(view))).toBe(host);
    expect(heard(host, heightOf(view - 1n))).toBe(host);
    const waiting = heard(host, heightOf(view + 2n));
    expect(heard(waiting, heightOf(view + 2n))).toBe(waiting);
    expect(heard(waiting, heightOf(view + 1n))).toBe(waiting);
  });

  test("a quiet chain that announces its height at every poll never starves the queue", () => {
    const host = submit(bob(), { to: BOB, input: credit(ALICE, 5n) });
    const polled = Array.from({ length: 20 }).reduce<typeof host>((h) => heard(h, heightOf(host.runtime.view)), host);
    const staged = unhalted(begin(polled, stamp(100n))).host.runtime.staged;
    expect(staged?.input._tag).toBe("entity");
  });

  test("a height heard while a frame is staged waits for the next frame, which carries the later stamp", () => {
    const staged = unhalted(begin(submit(bob(), { to: BOB, input: credit(ALICE, 5n) }), stamp(100n)));
    const waiting = heard(staged.host, heightOf(staged.host.runtime.view + 3n));
    expect(unhalted(begin(waiting, stamp(101n))).effects).toEqual([]);
    const next = unhalted(begin(unhalted(persisted(waiting)).host, stamp(102n))).host.runtime.staged;
    expect(next).toMatchObject({ stamp: stamp(102n), input: { _tag: "j_height" } });
  });

  test("a waiting height is lost in a crash: the Host that comes back holds none", () => {
    const host = bob();
    const waiting = heard(host, heightOf(host.runtime.view + 4n));
    const back = unhalted(reopen(host.runtime.setup, [emptyEntity(BOB)], host.runtime.wal, BOUNDS));
    expect(waiting.height).toBeDefined();
    expect(back.host.height).toBeUndefined();
  });
});
