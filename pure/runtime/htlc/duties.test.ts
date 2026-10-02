// Review A of PR 96: the reveal duty with more than one Account, more than one hold and more than one Entity in a
// Runtime, and a replay that has to see every field of a chain action. Bob is the payee throughout: Alice and Carol
// lock for him until height 115 (LAG 1, so a reveal is due at his view 114) and his resolves are never acked.
import { TEST_SIG } from "../../entity/fixtures.ts";
import { describe, expect, test } from "bun:test";
import { hashlockOf, holdOf, secretOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type JAction, type Outbound,
} from "../../entity/model.ts";
import type { Runtime } from "../model.ts";
import { recover, startRuntime } from "../tick.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, heightAt, hostOf, inputFor, open, rise, setup, settle, tick,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);
const DEADLINE = 115n;

const lock = (peer: EntityId, payer: "left" | "right", slot: bigint): Command =>
  ({ _tag: "lock", peer, token: GOLD, hold: holdOf(payer, 30n, slot, DEADLINE, Number(slot)) });

const resolve = (peer: EntityId, slot: bigint): Command =>
  ({ _tag: "resolve", peer, token: GOLD, id: holdId(slot), secret: secretOf(Number(slot)) });

const reveal = (peer: EntityId, slot: bigint): JAction => {
  const secret = secretOf(Number(slot));
  return { _tag: "reveal", peer, token: GOLD, id: holdId(slot), hashlock: hashlockOf(secret), secret };
};

const hosting = (...ids: readonly EntityId[]): Runtime =>
  startRuntime({ ...setup, view: viewOf(110n) }, ids.map(emptyEntity));

const hostsOf = (...ids: readonly EntityId[]): Cluster =>
  ({ hosts: new Map(ids.map((id) => [id, hosting(id)])), inflight: [], chain: [], clock: 1n });

const openAll = (c: Cluster, pairs: readonly (readonly [EntityId, EntityId])[]): Cluster =>
  pairs.reduce((acc, [from, to]) => settle(feed(acc, from, open(to))), c);

describe("runtime/duties review A: Bob owes the chain a reveal for every unacked resolve", () => {
  // Alice, Bob and Carol, each a Host of its own. Alice (Left of Bob) and Carol (Right of Bob) lock for Bob.
  const world = (): Cluster => {
    const opened = openAll(hostsOf(ALICE, BOB, CAROL), [[ALICE, BOB], [BOB, ALICE], [BOB, CAROL], [CAROL, BOB]]);
    const credited = settle(feed(feed(opened, BOB, credit(ALICE, 100n)), BOB, credit(CAROL, 100n)));
    const alices = feed(credited, ALICE, lock(BOB, "left", 1n), lock(BOB, "left", 2n));
    return settle(feed(alices, CAROL, lock(BOB, "right", 3n)));
  };

  test("R-HTLC-CLOCK each Account of the Entity is watched, and the actions follow the peers' ids", () => {
    const resolved = feed(feed(world(), BOB, resolve(ALICE, 1n)), BOB, resolve(CAROL, 3n));
    expect(rise(resolved, BOB, 114n).chain).toEqual([reveal(ALICE, 1n), reveal(CAROL, 3n)]);
  });

  test("R-HTLC-CLOCK the reveal names the hold of the resolve's slot, not another hold of the Account", () => {
    const resolved = feed(world(), BOB, resolve(ALICE, 2n));
    expect(rise(resolved, BOB, 114n).chain).toEqual([reveal(ALICE, 2n)]);
  });
});

describe("runtime/duties review A: a Runtime that hosts two payees asks for both in one height's row", () => {
  type Pair = Readonly<{ alice: Runtime; both: Runtime; inflight: readonly Outbound[]; at: bigint }>;

  const send = (p: Pair, to: EntityId, ...inputs: readonly EntityInput[]): Pair => {
    const mine = to === ALICE;
    const ticked = tick(mine ? p.alice : p.both, inputFor(to, p.at, ...inputs));
    const next = { ...p, inflight: [...p.inflight, ...ticked.leaving], at: p.at + 1n };
    return mine ? { ...next, alice: ticked.runtime } : { ...next, both: ticked.runtime };
  };

  const deliverAll = (p: Pair): Pair => {
    const [next, ...rest] = p.inflight;
    if (next === undefined) return p;
    const heard: EntityInput = { _tag: "peer_message", from: next.from, msg: next.msg, sig: TEST_SIG };
    return deliverAll(send({ ...p, inflight: rest }, next.to, heard));
  };

  test("R-HTLC-CLOCK both payees of one Runtime are asked in the one row of the height, by ids", () => {
    const start: Pair = { alice: hosting(ALICE), both: hosting(BOB, CAROL), inflight: [], at: 1n };
    const opened = ([[ALICE, BOB], [ALICE, CAROL], [BOB, ALICE], [CAROL, ALICE]] as const)
      .reduce((p, [from, to]) => deliverAll(send(p, from, open(to))), start);
    const credited = deliverAll(send(send(opened, BOB, credit(ALICE, 100n)), CAROL, credit(ALICE, 100n)));
    const locked = deliverAll(send(send(credited, ALICE, lock(BOB, "left", 1n)), ALICE, lock(CAROL, "left", 2n)));
    const resolved = send(send(locked, BOB, resolve(ALICE, 1n)), CAROL, resolve(ALICE, 2n));
    const risen = tick(resolved.both, heightAt(resolved.at, 114n));
    expect(risen.chain).toEqual([reveal(ALICE, 1n), reveal(ALICE, 2n)]);
  });
});

describe("runtime/duties review A: a replay sees every field of a chain action", () => {
  const unacked = (): Cluster => {
    const opened = openAll(hostsOf(ALICE, BOB), [[ALICE, BOB], [BOB, ALICE]]);
    const locked = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lock(BOB, "left", 1n)));
    return rise(feed(locked, BOB, resolve(ALICE, 1n)), BOB, 114n);
  };

  type Reveal = Extract<JAction, { _tag: "reveal" }>;
  const forged: readonly (readonly [string, Partial<Reveal>])[] = [
    ["peer", { peer: CAROL }],
    ["token", { token: tokenOf(2n) }],
    ["slot", { id: holdId(9n) }],
    ["hashlock", { hashlock: "0x00" }],
  ];

  test.each(forged)("R-DURABLE a WAL whose reveal names another %s does not replay", (_field, change) => {
    const bob = hostOf(unacked(), BOB);
    const last = bob.wal.at(-1) ?? expect.unreachable("no row");
    const action = last.chain[0] ?? expect.unreachable("no action");
    const row = { ...last, chain: [{ ...action, ...change } as JAction] };
    expect(recover(bob.setup, [emptyEntity(BOB)], [...bob.wal.slice(0, -1), row])).toEqual({
      ok: false, error: { _tag: "replay_diverged", height: last.height },
    });
  });
});
