// The identity of a chain effect (R-DURABLE): each chain action leaves with the WAL height of the row that made it and
// its place in that row, so a shell that is asked again after a crash knows it is the same action and not a second one
// (a deposit made twice). One test per kind of action, each from a real Runtime run: the row goes through the Host.
import { describe, expect, test } from "bun:test";
import { holdOf, secretOf, viewOf } from "../account/fixtures.ts";
import { holdId } from "../account/model.ts";
import { emptyEntity, type Command, type EntityId, type JAction, type JEvent } from "../entity/model.ts";
import { commit, flush, recover } from "../runtime/tick.ts";
import type { Row } from "../runtime/model.ts";
import { type Cluster, credit, feed, GOLD, hostOf, open, pay, rise, settle, start } from "../runtime/fixtures.ts";
import { begin, heard, limits, persisted, reopen, startHost, submit } from "./host.ts";
import { entityOf, stamp, unhalted } from "./fixtures.ts";
import { OPENED_WITH } from "../entity/fixtures.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import type { Effect, RowId } from "./model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const WIDE = unwrapOr(limits(10, 10), () => expect.unreachable("limits"));

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const framed = (c: Cluster, limit: bigint): Cluster => settle(feed(c, BOB, credit(ALICE, limit)));
const epochOf = (peer: EntityId, epoch: bigint, stored: bigint): JEvent => ({ _tag: "j_epoch", peer, epoch, stored });
const dispute: JEvent =
  { _tag: "j_dispute", peer: BOB, epoch: 1n, by: "right", nonce: 3n, timeout: 5n, ...OPENED_WITH };
const deposit = (amount: bigint): Command => ({ _tag: "deposit", peer: BOB, token: GOLD, amount });
const withdraw = (amount: bigint): Command => ({ _tag: "withdraw", peer: BOB, token: GOLD, amount });
const lockIn = (id: bigint, deadline: bigint): Command =>
  ({ _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, id, deadline, 1) });

const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const paid = settle(feed(credited, ALICE, pay(BOB, 10n)));
const epoch1 = framed(feed(feed(opened, ALICE, epochOf(BOB, 1n, 5n)), BOB, epochOf(ALICE, 1n, 5n)), 100n);
const locked = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lockIn(1n, 115n)));
const resolved = feed(locked, BOB, { _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(1n), secret: secretOf(1) });

type Case = Readonly<{ kind: JAction["_tag"]; owner: EntityId; run: Cluster }>;

const CASES: readonly Case[] = [
  { kind: "deposit", owner: ALICE, run: feed(framed(opened, 100n), ALICE, deposit(10n)) },
  { kind: "c2r", owner: ALICE, run: feed(credited, ALICE, withdraw(30n)) },
  { kind: "settle", owner: ALICE, run: feed(paid, ALICE, withdraw(30n)) },
  { kind: "counter", owner: ALICE, run: feed(epoch1, ALICE, dispute) },
  { kind: "reveal", owner: BOB, run: rise(resolved, BOB, 114n) },
];

const chainOf = (effects: readonly Effect[]) => effects.flatMap((e) => (e._tag === "chain" ? [e] : []));

/** The last row of the owner's WAL that asks the chain for something, and the rows before it. */
const asking = (c: Case): Readonly<{ row: Row; before: readonly Row[]; wal: readonly Row[] }> => {
  const wal = hostOf(c.run, c.owner).wal;
  const at = wal.findLastIndex((row) => row.chain.length > 0);
  return { row: wal[at] as Row, before: wal.slice(0, at), wal: wal.slice(0, at + 1) };
};

/** A Host that has everything before the row, sent, and is handed the row's input as a shell would hand it. */
const hostBefore = (c: Case, before: readonly Row[], row: Row) => {
  const back = flush(unhalted(recover(hostOf(c.run, c.owner).setup, [emptyEntity(c.owner)], before))).runtime;
  const host = startHost(back, WIDE);
  const { input } = row;
  return input._tag === "j_height"
    ? heard(host, input.height)
    : input.inputs.reduce((h, i) => submit(h, { to: input.to, input: i }), host);
};

const idOf = (row: Row, index: number): RowId => ({ height: row.height, index });

describe("host/rowid a chain effect carries the row and the place in the row it was made from", () => {
  CASES.forEach((c) => {
    const { row, before, wal } = asking(c);

    test(`R-DURABLE ${c.kind}: no chain effect before the row is durable, then it carries the row's identity`, () => {
      expect(row.chain.map((a) => a._tag)).toContain(c.kind);
      const begun = unhalted(begin(hostBefore(c, before, row), row.stamp));
      expect(begun.effects.map((e) => e._tag)).toEqual(["persist"]);
      expect(begun.host.runtime.staged).toEqual(row);
      const done = unhalted(persisted(begun.host));
      const asked = row.chain.map((action, index) => ({ _tag: "chain" as const, action, row: idOf(row, index) }));
      expect(chainOf(done.effects)).toEqual(asked);
      expect(unhalted(begin(done.host, stamp(row.stamp + 1n))).effects).toEqual([]);
    });

    test(`R-DURABLE ${c.kind}: the actions asked are the ones flush says leave, no more and no fewer`, () => {
      const begun = unhalted(begin(hostBefore(c, before, row), row.stamp));
      const done = unhalted(persisted(begun.host));
      const flushed = flush(unhalted(commit(begun.host.runtime)));
      expect(chainOf(done.effects).map((e) => e.action)).toEqual([...flushed.chain]);
    });

    test(`R-DURABLE ${c.kind}: after a crash the same row identity is asked again`, () => {
      const live = unhalted(persisted(unhalted(begin(hostBefore(c, before, row), row.stamp)).host));
      const back = unhalted(reopen(hostOf(c.run, c.owner).setup, [emptyEntity(c.owner)], wal, WIDE));
      const again = chainOf(back.effects).filter((e) => e.row.height === row.height);
      expect(again).toEqual(chainOf(live.effects));
      expect(again.length).toBeGreaterThan(0);
    });
  });

  test("two actions of one row are told apart by their place in it", () => {
    const run = feed(framed(opened, 100n), ALICE, deposit(10n), deposit(5n));
    const wal = hostOf(run, ALICE).wal;
    const row = wal[wal.length - 1] as Row;
    expect(row.chain).toHaveLength(2);
    const back = unhalted(reopen(hostOf(run, ALICE).setup, [emptyEntity(ALICE)], wal, WIDE));
    expect(chainOf(back.effects).map((e) => e.row)).toEqual([idOf(row, 0), idOf(row, 1)]);
  });
});
