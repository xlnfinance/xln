// R-HTLC-FORWARD: a hub that holds a lock for a hashlock it has an entry for locks the same amount on the next hop one
// hop sooner, passes the secret back, and gives the lock up when the next hop does. Three whole Entities (Alice, a
// hub, Bob) talking until nothing is left to send; what an Account's rules say about a lock is account/clause's.
import { describe, expect, spyOn, test } from "bun:test";
import { heightOf, secretOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId, type Hold } from "../../account/model.ts";
import { MAX_ROUTE_HOPS } from "../../account/tx.ts";
import { ledgerOf } from "../../account/state.ts";
import { jHeight } from "../../account/clause/clock.ts";
import { hopOf, lastHeard, learned, waitsOf } from "./paybook.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import { anchor, credit, entityOf, GOLD, judge, open, OPENED_WITH, TEST_SIG } from "../fixtures.ts";
import { freshChain } from "../chain.ts";
import { entityFrame } from "../frame.ts";
import {
  emptyEntity, sideOf, type Command, type Entry, type EntityId, type EntityInput, type EntityState, type Notice,
  type Outbound,
} from "../model.ts";

const ALICE = entityOf(1);
const HUB = entityOf(2);
const BOB = entityOf(3);
const CAROL = entityOf(4);
const OIL = tokenOf(2n);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const HASHLOCK = keccakHex(SECRET);
const SECOND = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const SECOND_HASHLOCK = keccakHex(SECOND);
const AMOUNT = 10n;

type Net = Readonly<{ entities: ReadonlyMap<EntityId, EntityState>; notices: readonly Notice[] }>;

const stateOf = (net: Net, id: EntityId): EntityState => net.entities.get(id) ?? expect.unreachable("no entity");

/** One input to one Entity at `view`, and then every message that leaves any Entity, one at a time, until none does. */
const deliver = (net: Net, view: bigint, to: EntityId, inputs: readonly EntityInput[]): Net => {
  const framed = entityFrame({ ...judge, view: viewOf(view) }, anchor, stateOf(net, to), inputs);
  const next: Net = {
    entities: new Map([...net.entities, [to, framed.state]]), notices: [...net.notices, ...framed.notices],
  };
  return framed.outputs.reduce((acc: Net, out: Outbound) =>
    deliver(acc, view, out.to, [{ _tag: "peer_message", from: out.from, msg: out.msg, sig: TEST_SIG }]), next);
};

const tell = (net: Net, view: bigint, to: EntityId, ...commands: readonly Command[]): Net =>
  commands.reduce((acc, c) => deliver(acc, view, to, [c]), net);

const LINKS = [
  [ALICE, HUB], [HUB, ALICE], [HUB, BOB], [BOB, HUB], [HUB, CAROL], [CAROL, HUB], [CAROL, BOB], [BOB, CAROL],
];

/** Alice, the hub, Bob and Carol, with the Accounts alice-hub, hub-bob and hub-carol open, credit both ways in all. */
const base = (bobCredit = 1000n): Net => {
  const start: Net = { entities: new Map([ALICE, HUB, BOB, CAROL].map((id) => [id, emptyEntity(id)])), notices: [] };
  const opened = LINKS.reduce((net, [self, peer]) => tell(net, 100n, self!, open(peer!)), start);
  return LINKS.reduce(
    (net, [self, peer]) => tell(net, 100n, self!, credit(peer!, self === BOB && peer === HUB ? bobCredit : 1000n)),
    opened);
};

const hold = (net: Net, id: bigint, hashlock: string, deadline: bigint): Hold => ({
  id: holdId(id), payer: stateOf(net, ALICE).accounts.get(HUB)?.side ?? expect.unreachable("no account"),
  amount: AMOUNT, hashlock, deadline: unwrapOr(jHeight(deadline), () => expect.unreachable("height")),
});

const lock = (net: Net, deadline: bigint, id = 1n, hashlock = HASHLOCK): Command =>
  ({ _tag: "lock", peer: HUB, token: GOLD, hold: hold(net, id, hashlock, deadline) });

const routedLock = (net: Net, deadline: bigint, route: readonly EntityId[]): Command =>
  ({ _tag: "lock", peer: HUB, token: GOLD, hold: hold(net, 1n, HASHLOCK, deadline), route });

const forwardAt = (net: Net, from = ALICE): Net =>
  tell(net, 100n, HUB, { _tag: "forward", hashlock: HASHLOCK, from, to: BOB });

const expectAt = (net: Net, amount = AMOUNT, token = GOLD, from = HUB): Net =>
  tell(net, 100n, BOB, { _tag: "expect", hashlock: HASHLOCK, from, token, amount, secret: SECRET });

const ledgerBetween = (net: Net, self: EntityId, peer: EntityId) =>
  ledgerOf(stateOf(net, self).accounts.get(peer)?.state ?? expect.unreachable("no account"), GOLD);

const headOf = (net: Net, self: EntityId, peer: EntityId) => stateOf(net, self).accounts.get(peer)?.head;

const sameHeads = (net: Net) =>
  headOf(net, ALICE, HUB) === headOf(net, HUB, ALICE) && headOf(net, HUB, BOB) === headOf(net, BOB, HUB);

describe("entity/paybook the paybook forwards a payment (R-HTLC-FORWARD)", () => {
  const routed = (): Net => expectAt(forwardAt(base()));

  test("R-HTLC-FORWARD a lock made to the hub is forwarded and resolved back to Alice", () => {
    const done = tell(routed(), 100n, ALICE, lock(routed(), 105n));
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, HUB, BOB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(-AMOUNT);
    expect(ledgerBetween(done, HUB, BOB).offdelta).toBe(-AMOUNT);
    expect(sameHeads(done)).toBe(true);
    expect([HUB, BOB].map((id) => stateOf(done, id).paybook.size)).toEqual([0, 0]);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD the next hop's lock is one hop sooner and carries the same amount and hashlock", () => {
    const waiting = tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));
    const next = ledgerBetween(waiting, HUB, BOB).holds[0];
    expect(next).toMatchObject({ amount: AMOUNT, hashlock: HASHLOCK, deadline: heightOf(105n - hopOf(judge.clock)) });
    expect(ledgerBetween(waiting, ALICE, HUB).holds[0]?.deadline).toEqual(heightOf(105n));
    expect(stateOf(waiting, HUB).paybook.get(HASHLOCK)?._tag).toBe("locked");
  });

  test("R-WATCH-STALL a hub waits on the peer it forwarded to until the inbound deadline less the lag", () => {
    const { lag } = judge.clock;
    const waiting = tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));
    expect(lastHeard(stateOf(waiting, HUB), judge.clock)).toEqual(new Map([[BOB, 105n - lag]]));
    expect(lastHeard(stateOf(forwardAt(base()), HUB), judge.clock)).toEqual(new Map());
    expect(lastHeard(stateOf(base(), HUB), judge.clock)).toEqual(new Map());
    const second = (net: Net): Net =>
      tell(net, 100n, HUB, { _tag: "forward", hashlock: SECOND_HASHLOCK, from: ALICE, to: BOB });
    const sooner = tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));
    const both = tell(second(sooner), 100n, ALICE, lock(base(), 110n, 7n, SECOND_HASHLOCK));
    expect(stateOf(both, HUB).paybook.get(SECOND_HASHLOCK)?._tag).toBe("locked");
    expect(lastHeard(stateOf(both, HUB), judge.clock)).toEqual(new Map([[BOB, 110n - lag]]));
    const later = tell(forwardAt(base()), 100n, ALICE, lock(base(), 110n));
    const either = tell(second(later), 100n, ALICE, lock(base(), 105n, 7n, SECOND_HASHLOCK));
    expect(stateOf(either, HUB).paybook.get(SECOND_HASHLOCK)?._tag).toBe("locked");
    expect(lastHeard(stateOf(either, HUB), judge.clock)).toEqual(new Map([[BOB, 110n - lag]]));
  });

  test("R-WATCH-STALL what the loop waits on the Entity for: the last heard of each peer, and who is behind", () => {
    const waiting = stateOf(tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n)), HUB);
    const behind = { ...(waiting.chain.get(ALICE) ?? freshChain), behind: 9n };
    const held = { ...waiting, chain: new Map([[ALICE, behind]]) };
    expect(waitsOf(held, judge.clock)).toEqual({
      lastHeard: new Map([[BOB, 105n - judge.clock.lag]]), behind: new Set([ALICE]), lost: new Set(),
    });
    expect(waitsOf(waiting, judge.clock).behind).toEqual(new Set());
  });

  test("R-HTLC-FORWARD a payee asked for more than the lock holds gives it up and the hub gives up Alice's", () => {
    const done = tell(expectAt(forwardAt(base()), AMOUNT + 1n), 100n, ALICE, lock(base(), 105n));
    expect(LINKS.map(([a, b]) => ledgerBetween(done, a!, b!).holds.length)).toEqual(LINKS.map(() => 0));
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(0n);
    expect(ledgerBetween(done, HUB, BOB).offdelta).toBe(0n);
    expect(sameHeads(done)).toBe(true);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
  });

  test("R-HTLC-FORWARD a lock too near its deadline for another hop is given up, not forwarded", () => {
    const done = tell(routed(), 100n, ALICE, lock(base(), 100n + hopOf(judge.clock)));
    expect(ledgerBetween(done, HUB, BOB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(0n);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD a payee that was asked for another token gives the lock up", () => {
    const done = tell(expectAt(forwardAt(base()), AMOUNT, OIL), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(0n);
    expect(stateOf(done, BOB).paybook.size).toBe(0);
  });

  test("R-HTLC-FORWARD a lock the next hop's Account refuses is told and given up upstream", () => {
    const done = tell(expectAt(forwardAt(base(5n))), 100n, ALICE, lock(base(), 105n));
    expect(done.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, HUB, BOB).holds).toEqual([]);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(sameHeads(done)).toBe(true);
  });

  /** Two payments by the same hub, to Bob and to Carol, whose first hops hold the same slot of the same token. */
  const twoNextHops = (): Net => {
    const entries = tell(base(), 100n, HUB,
      { _tag: "forward", hashlock: HASHLOCK, from: ALICE, to: BOB },
      { _tag: "forward", hashlock: SECOND_HASHLOCK, from: ALICE, to: CAROL });
    const asked = tell(entries, 100n, CAROL,
      { _tag: "expect", hashlock: SECOND_HASHLOCK, from: HUB, token: GOLD, amount: AMOUNT + 1n, secret: SECOND });
    return tell(asked, 100n, ALICE, lock(base(), 105n), lock(base(), 105n, 2n, SECOND_HASHLOCK));
  };

  test("R-HTLC-FORWARD one next hop giving its lock up fails only the payment that went to it", () => {
    const waiting = twoNextHops();
    expect(ledgerBetween(waiting, ALICE, HUB).holds.map((h) => h.hashlock)).toEqual([HASHLOCK]);
    expect(ledgerBetween(waiting, HUB, BOB).holds.length).toBe(1);
    expect(ledgerBetween(waiting, HUB, CAROL).holds).toEqual([]);
    const done = expectAt(waiting);
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect([ALICE, BOB, CAROL].map((id) => ledgerBetween(done, HUB, id).offdelta)).toEqual([-AMOUNT, -AMOUNT, 0n]);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
  });

  test("R-HTLC-FORWARD an entry forwards only a lock of the peer it names", () => {
    const done = tell(forwardAt(base(), BOB), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(done, HUB, BOB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).holds.length).toBe(1);
    expect(stateOf(done, HUB).paybook.get(HASHLOCK)?._tag).toBe("forward");
  });

  test("R-HTLC-FORWARD a second entry for one hashlock is refused and the first stands", () => {
    const again = tell(routed(), 100n, HUB, { _tag: "forward", hashlock: HASHLOCK, from: BOB, to: ALICE });
    const refused: Notice = {
      _tag: "command_refused", command: { _tag: "forward", hashlock: HASHLOCK, from: BOB, to: ALICE },
      fault: { _tag: "entry_exists", hashlock: HASHLOCK },
    };
    expect(again.notices).toEqual([refused]);
    expect(stateOf(again, HUB).paybook.get(HASHLOCK)).toEqual({ _tag: "forward", from: ALICE, to: BOB, route: [] });
  });

  test("R-HTLC-FORWARD a payment with no hop to forward to waits and moves nothing", () => {
    const done = tell(expectAt(base()), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(done, ALICE, HUB).holds.length).toBe(1);
    expect(ledgerBetween(done, HUB, BOB).holds).toEqual([]);
    expect(stateOf(done, BOB).paybook.get(HASHLOCK)?._tag).toBe("receive");
  });
  test("R-HTLC-FORWARD a lock that names its route is forwarded with no entry told to the hub", () => {
    const done = tell(expectAt(base()), 100n, ALICE, routedLock(base(), 105n, [BOB]));
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(-AMOUNT);
    expect(ledgerBetween(done, HUB, BOB).offdelta).toBe(-AMOUNT);
    expect(sameHeads(done)).toBe(true);
    expect([HUB, BOB].map((id) => stateOf(done, id).paybook.size)).toEqual([0, 0]);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD each hop of a route forwards to the next with the rest of the route", () => {
    const done = tell(expectAt(base(), AMOUNT, GOLD, CAROL), 100n, ALICE, routedLock(base(), 110n, [CAROL, BOB]));
    expect([[ALICE, HUB], [HUB, CAROL], [CAROL, BOB]].map(([a, b]) => ledgerBetween(done, a!, b!).offdelta))
      .toEqual([-AMOUNT, -AMOUNT, AMOUNT]);
    expect(LINKS.map(([a, b]) => ledgerBetween(done, a!, b!).holds.length)).toEqual(LINKS.map(() => 0));
    expect([HUB, CAROL, BOB].map((id) => stateOf(done, id).paybook.size)).toEqual([0, 0, 0]);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD a route through a peer the hub has no Account with is given up, and the lock with it", () => {
    const done = tell(expectAt(base()), 100n, ALICE, routedLock(base(), 105n, [entityOf(9)]));
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(done, ALICE, HUB).offdelta).toBe(0n);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD a route back to the peer the lock came from is given up", () => {
    const done = tell(base(), 100n, ALICE, routedLock(base(), 105n, [ALICE]));
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD an entry told to the hub stands over the route a lock names", () => {
    const done = tell(expectAt(forwardAt(base())), 100n, ALICE, routedLock(base(), 105n, [CAROL]));
    expect(ledgerBetween(done, HUB, BOB).offdelta).toBe(-AMOUNT);
    expect(ledgerBetween(done, HUB, CAROL).offdelta).toBe(0n);
    expect(ledgerBetween(done, ALICE, HUB).holds).toEqual([]);
  });

  test("R-HTLC-FORWARD a route longer than the limit makes the lock refused at the door", () => {
    const long = Array.from({ length: MAX_ROUTE_HOPS + 1 }, () => BOB);
    const refused = tell(base(), 100n, ALICE, routedLock(base(), 105n, long));
    expect(refused.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    expect(ledgerBetween(refused, ALICE, HUB).holds).toEqual([]);
    const fits = tell(base(), 100n, ALICE, routedLock(base(), 105n, long.slice(1)));
    expect(fits.notices).toEqual([]);
  });
});

describe("entity/paybook what the forwarder pins (R-HTLC-FORWARD)", () => {
  const routed = (): Net => expectAt(forwardAt(base()));
  const secondForward = (net: Net): Net =>
    tell(net, 100n, HUB, { _tag: "forward", hashlock: SECOND_HASHLOCK, from: ALICE, to: BOB });

  test("R-HTLC-FORWARD two payments to one next hop in one frame take two slots and both go through", () => {
    const asked = tell(secondForward(routed()), 100n, BOB,
      { _tag: "expect", hashlock: SECOND_HASHLOCK, from: HUB, token: GOLD, amount: AMOUNT, secret: SECOND });
    const done = deliver(asked, 100n, ALICE, [lock(base(), 105n), lock(base(), 105n, 2n, SECOND_HASHLOCK)]);
    expect([[ALICE, HUB], [HUB, BOB]].map(([a, b]) => ledgerBetween(done, a!, b!).offdelta)).toEqual([-20n, -20n]);
    expect(LINKS.map(([a, b]) => ledgerBetween(done, a!, b!).holds.length)).toEqual(LINKS.map(() => 0));
    expect([HUB, BOB].map((id) => stateOf(done, id).paybook.size)).toEqual([0, 0]);
    expect(done.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD with lag 1 and reserve 2 a lock due at 110 is forwarded due at 107", () => {
    expect(hopOf(judge.clock)).toBe(3n);
    const waiting = tell(forwardAt(base()), 100n, ALICE, lock(base(), 110n));
    expect(ledgerBetween(waiting, HUB, BOB).holds.map((h) => h.deadline)).toEqual([heightOf(107n)]);
  });

  test("R-HTLC-FORWARD at view 100 a lock due at 104 is forwarded due at 101 and one due at 103 is given up", () => {
    const edge = tell(forwardAt(base()), 100n, ALICE, lock(base(), 104n));
    expect(ledgerBetween(edge, HUB, BOB).holds.map((h) => h.deadline)).toEqual([heightOf(101n)]);
    expect(edge.notices).toEqual([]);
    const near = tell(forwardAt(base()), 100n, ALICE, lock(base(), 103n));
    expect(ledgerBetween(near, HUB, BOB).holds).toEqual([]);
    expect(ledgerBetween(near, ALICE, HUB).holds).toEqual([]);
    expect(near.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD a next hop that already holds a lock gets a slot above it", () => {
    const first = tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));
    const both = tell(secondForward(first), 100n, ALICE, lock(base(), 105n, 7n, SECOND_HASHLOCK));
    expect(ledgerBetween(both, HUB, BOB).holds.map((h) => h.id)).toEqual([holdId(1n), holdId(2n)]);
    expect(both.notices).toEqual([]);
  });

  test("R-HTLC-FORWARD a lock the hub itself made to the peer is not an incoming lock to forward", () => {
    const entry = tell(base(), 100n, HUB, { _tag: "forward", hashlock: HASHLOCK, from: BOB, to: CAROL });
    const side = stateOf(entry, HUB).accounts.get(BOB)?.side ?? expect.unreachable("no account");
    const own: Hold = { ...hold(entry, 1n, HASHLOCK, 105n), payer: side };
    const done = tell(entry, 100n, HUB, { _tag: "lock", peer: BOB, token: GOLD, hold: own });
    expect(ledgerBetween(done, HUB, BOB).holds.length).toBe(1);
    expect(ledgerBetween(done, HUB, CAROL).holds).toEqual([]);
    expect(stateOf(done, HUB).paybook.get(HASHLOCK)?._tag).toBe("forward");
    expect(done.notices).toEqual([]);
  });
});

describe("entity/paybook what a peer's accepted frame tells the paybook (R-HTLC-FORWARD)", () => {
  const first = holdId(1n);
  const locked: Entry = { _tag: "locked", from: ALICE, to: BOB, token: GOLD, id: first };
  const resolve = { _tag: "resolve", token: GOLD, id: first, secret: SECRET } as const;

  test("R-HTLC-FORWARD a secret shown by the next hop is passed up, by any other peer it is not", () => {
    const book = new Map<string, Entry>([[HASHLOCK, locked]]);
    expect(learned(book, BOB, [resolve])).toEqual(new Map([[HASHLOCK, { _tag: "pass", from: ALICE, secret: SECRET }]]));
    expect(learned(book, CAROL, [resolve])).toEqual(book);
  });

  test("R-HTLC-FORWARD a secret shown for an entry that has locked nothing yet is not passed up", () => {
    const waiting = new Map<string, Entry>([[HASHLOCK, { _tag: "forward", from: ALICE, to: BOB, route: [] }]]);
    expect(learned(waiting, BOB, [resolve])).toEqual(waiting);
  });

  test("R-HTLC-FORWARD a cancel fails the entry of its own token and slot, not the first entry to that peer", () => {
    const oilLocked: Entry = { _tag: "locked", from: CAROL, to: BOB, token: OIL, id: first };
    const book = new Map<string, Entry>([[HASHLOCK, locked], [SECOND_HASHLOCK, oilLocked]]);
    const cancelled = learned(book, BOB, [{ _tag: "cancel", token: OIL, id: first }]);
    expect(cancelled.get(HASHLOCK)).toEqual(locked);
    expect(cancelled.get(SECOND_HASHLOCK)).toEqual({ _tag: "fail", from: CAROL });
  });
});

describe("entity/paybook what the hub learns from a frame of its next hop (R-HTLC-FORWARD)", () => {
  /** Messages kept on the wire instead of delivered at once: a test picks which one is heard next. */
  type Wire = Readonly<{ net: Net; queue: readonly Outbound[] }>;

  const step = (wire: Wire, to: EntityId, inputs: readonly EntityInput[]): Wire => {
    const framed = entityFrame({ ...judge, view: viewOf(100n) }, anchor, stateOf(wire.net, to), inputs);
    const entities = new Map([...wire.net.entities, [to, framed.state]]);
    return {
      net: { entities, notices: [...wire.net.notices, ...framed.notices] }, queue: [...wire.queue, ...framed.outputs],
    };
  };

  const hears = (wire: Wire, out: Outbound, msg = out.msg): Wire =>
    step({ ...wire, queue: wire.queue.filter((x) => x !== out) }, out.to,
      [{ _tag: "peer_message", from: out.from, msg, sig: TEST_SIG }]);

  const wired = (wire: Wire, from: EntityId, to: EntityId, tag: Outbound["msg"]["_tag"]): Outbound =>
    wire.queue.find((x) => x.from === from && x.to === to && x.msg._tag === tag) ?? expect.unreachable("no message");

  const hear = (wire: Wire, from: EntityId, to: EntityId, tag: Outbound["msg"]["_tag"]): Wire =>
    hears(wire, wired(wire, from, to, tag));

  const drained = (wire: Wire): Wire => {
    const [next] = wire.queue;
    return next === undefined ? wire : drained(hears(wire, next));
  };

  const lockBy = (net: Net, payer: EntityId, id: bigint, hashlock: string): Command => {
    const side = stateOf(net, payer).accounts.get(HUB)?.side ?? expect.unreachable("no account");
    return { _tag: "lock", peer: HUB, token: GOLD, hold: { ...hold(net, id, hashlock, 105n), payer: side } };
  };

  const expecting = (net: Net, payee: EntityId, hashlock: string, secret: Uint8Array): Net =>
    tell(net, 100n, payee, { _tag: "expect", hashlock, from: HUB, token: GOLD, amount: AMOUNT, secret });

  const forwarded = (net: Net, hashlock: string, from: EntityId, to: EntityId): Net =>
    tell(net, 100n, HUB, { _tag: "forward", hashlock, from, to });

  test("R-HTLC-FORWARD a resolve in a frame that is refused leaves the entry locked and nothing passed up", () => {
    const entries = expecting(forwarded(base(), HASHLOCK, ALICE, BOB), BOB, HASHLOCK, SECRET);
    const sent = hear(step({ net: entries, queue: [] }, ALICE, [lock(entries, 105n)]), ALICE, HUB, "frame");
    const locked = hear(hear(sent, HUB, ALICE, "ack"), HUB, BOB, "frame");
    const frame = wired(locked, BOB, HUB, "frame");
    const forged = frame.msg._tag === "frame"
      ? { ...frame.msg, frame: { ...frame.msg.frame, txs: [...frame.msg.frame.txs, ...frame.msg.frame.txs] } }
      : expect.unreachable("not a frame");
    const forgedAck: EntityInput = { _tag: "peer_message", from: BOB, msg: forged, sig: TEST_SIG };
    const refused = step(hear(locked, BOB, HUB, "ack"), HUB, [forgedAck]);
    expect(refused.net.notices.map((n) => n._tag)).toEqual(["message_refused"]);
    expect(stateOf(refused.net, HUB).paybook.get(HASHLOCK)?._tag).toBe("locked");
    expect(ledgerBetween(refused.net, ALICE, HUB).holds.length).toBe(1);
    expect(stateOf(refused.net, HUB).accounts.get(ALICE)?.pending).toBeUndefined();
  });

  test("R-HTLC-FORWARD a resolve in a frame accepted over the hub's own pending frame is learned and passed up", () => {
    // Bob pays Alice through the hub, who is Right of Alice: its frame to Alice gives way when both propose at once.
    const asked = expecting(expecting(base(), ALICE, HASHLOCK, SECRET), ALICE, SECOND_HASHLOCK, SECOND);
    const routes = forwarded(forwarded(asked, HASHLOCK, BOB, ALICE), SECOND_HASHLOCK, BOB, ALICE);
    const bob = step(step({ net: routes, queue: [] }, BOB, [lockBy(routes, BOB, 1n, HASHLOCK)]), BOB,
      [lockBy(routes, BOB, 2n, SECOND_HASHLOCK)]);
    const second = hear(hear(hear(bob, BOB, HUB, "frame"), HUB, BOB, "ack"), BOB, HUB, "frame");
    const resolved = hear(second, HUB, ALICE, "frame");
    const alice = hear(resolved, ALICE, HUB, "ack");
    expect(stateOf(alice.net, HUB).accounts.get(ALICE)?.pending?.frame.txs.map((t) => t._tag)).toEqual(["lock"]);
    const collided = hear(alice, ALICE, HUB, "frame");
    expect(collided.net.notices).toEqual([]);
    const done = drained(collided).net;
    expect(LINKS.map(([a, b]) => ledgerBetween(done, a!, b!).holds.length)).toEqual(LINKS.map(() => 0));
    expect([[BOB, HUB], [HUB, ALICE]].map(([a, b]) => ledgerBetween(done, a!, b!).offdelta)).toEqual([20n, 20n]);
    expect([HUB, ALICE].map((id) => stateOf(done, id).paybook.size)).toEqual([0, 0]);
  });
});

describe("entity/paybook the hub learns a secret the Account in dispute cannot carry (R-DISPUTE-FREEZE)", () => {
  const chainOpened = (peer: EntityId, nonce: bigint): EntityInput =>
    ({ _tag: "j_dispute", peer, epoch: 0n, by: sideOf(BOB, HUB), nonce, timeout: 500n, ...OPENED_WITH });

  /** Only the hub has heard of a dispute on hub-bob that Bob started: Bob has not yet. */
  const hubHeard = (net: Net): Net => deliver(net, 100n, HUB, [chainOpened(BOB, 3n)]);

  /** Bob asked for the dispute and the chain opened it: Bob and the hub are both frozen on hub-bob. */
  const bobDisputed = (net: Net): Net => {
    const asked = tell(net, 100n, BOB, { _tag: "dispute", peer: HUB });
    const nonce = stateOf(asked, BOB).chain.get(HUB)?.starting?.start.nonce ?? expect.unreachable("no start asked");
    return [HUB, BOB].reduce((acc, id) => deliver(acc, 100n, id, [chainOpened(id === HUB ? BOB : HUB, nonce)]), asked);
  };

  /** The chain showed a secret and the hub heard it. */
  const showing = (net: Net, secret: Uint8Array): Net =>
    deliver(net, 100n, HUB, [{ _tag: "j_secret", secret, at: 100n }]);

  /** Alice's lock reaches Bob through the hub before Bob has said what he will answer. */
  const forwarded = (): Net => tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));

  const upstream = (net: Net) => [ledgerBetween(net, ALICE, HUB).offdelta, ledgerBetween(net, ALICE, HUB).holds.length];

  test("R-DISPUTE-FREEZE a secret Bob shows on the chain is passed up: the hub claims Alice's lock", () => {
    const frozen = expectAt(bobDisputed(forwarded()));
    expect(upstream(frozen)).toEqual([0n, 1]);
    const shown = showing(frozen, SECRET);
    expect(upstream(shown)).toEqual([-AMOUNT, 0]);
    expect(stateOf(shown, HUB).paybook.size).toBe(0);
  });

  test("R-REVEAL-DIRECT a secret shown with no dispute at all is passed up: the hub claims the lock", () => {
    const shown = showing(forwarded(), SECRET);
    expect(upstream(shown)).toEqual([-AMOUNT, 0]);
    expect(stateOf(shown, HUB).shown.get(HASHLOCK)).toBe(100n);
    expect(ledgerBetween(shown, HUB, BOB).holds.length).toBe(1);
  });

  test("R-DISPUTE-FREEZE a resolve the hub refuses as frozen still gives it the secret to pass up", () => {
    const refused = expectAt(hubHeard(forwarded()));
    expect(upstream(refused)).toEqual([-AMOUNT, 0]);
    expect(ledgerBetween(refused, HUB, BOB).holds.length).toBe(1);
  });

  test("R-DISPUTE-FREEZE a secret nobody forwarded a lock under, or a wrong one, changes nothing", () => {
    const frozen = expectAt(bobDisputed(forwarded()));
    const other = showing(frozen, SECOND);
    const wrong = showing(frozen, new Uint8Array(32));
    [other, wrong].forEach((net) => {
      expect(upstream(net)).toEqual([0n, 1]);
      expect(stateOf(net, HUB).paybook.get(HASHLOCK)?._tag).toBe("locked");
    });
  });

  test("R-DISPUTE-FREEZE a lock forwarded into an Account in dispute is refused and given up upstream", () => {
    const refused = tell(hubHeard(forwardAt(base())), 100n, ALICE, lock(base(), 105n));
    const faults = refused.notices.flatMap((n) => (n._tag === "command_refused" ? [n.fault._tag] : []));
    expect(faults).toEqual(["account_disputed"]);
    expect(upstream(refused)).toEqual([0n, 0]);
    expect(ledgerBetween(refused, HUB, BOB).holds).toEqual([]);
    expect(stateOf(refused, HUB).paybook.size).toBe(0);
  });

  const blind = (net: Net): Net => deliver(net, 100n, HUB, [{ _tag: "j_blind", boot: false }]);

  test("R-WATCH-CALLDATA a blind Entity forwards no lock: the lock that came to it is given up upstream", () => {
    const refused = tell(blind(forwardAt(base())), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(refused, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(refused, HUB, BOB).holds).toEqual([]);
    expect(stateOf(refused, HUB).paybook.size).toBe(0);
  });

  test("R-WATCH-CALLDATA blind is told to the owner once, and a lock forwarded before it stands", () => {
    const waiting = tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));
    const told = blind(blind(waiting));
    expect(told.notices.filter((n) => n._tag === "chain_blind")).toHaveLength(1);
    expect(stateOf(told, HUB).blind).toBe(true);
    expect(ledgerBetween(told, HUB, BOB).holds).toHaveLength(1);
  });

  test("R-WATCH-CALLDATA an Entity told its provider traces again forwards as before", () => {
    const over = deliver(blind(forwardAt(base())), 100n, HUB, [{ _tag: "j_blind_over" }]);
    expect(stateOf(over, HUB).blind).toBe(false);
    const waiting = tell(over, 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(waiting, HUB, BOB).holds).toHaveLength(1);
  });

  const behindOn = (net: Net, peer: EntityId): Net => deliver(net, 100n, HUB, [{ _tag: "j_behind", peer, from: 2n }]);
  const expiring = (net: Net) => tell(net, 200n, ALICE, { _tag: "expire", peer: HUB, token: GOLD, id: holdId(1n) });
  const locked = (): Net => tell(forwardAt(base()), 100n, ALICE, lock(base(), 105n));

  test("R-WATCH-STALL a hub forwards no lock to a peer whose events the Host still owes it", () => {
    const refused = tell(behindOn(forwardAt(base()), BOB), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(refused, ALICE, HUB).holds).toEqual([]);
    expect(ledgerBetween(refused, HUB, BOB).holds).toEqual([]);
    const other = tell(behindOn(forwardAt(base()), CAROL), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(other, HUB, BOB).holds).toHaveLength(1);
  });

  test("R-WATCH-STALL an expiry of the lock a hub forwarded to a peer it is behind on is not co-signed", () => {
    expect(ledgerBetween(expiring(locked()), ALICE, HUB).holds).toEqual([]);
    const held = expiring(behindOn(locked(), BOB));
    expect(ledgerBetween(held, ALICE, HUB).holds).toHaveLength(1);
    const lifted = expiring(deliver(behindOn(locked(), BOB), 100n, HUB, [{ _tag: "j_behind_over", peer: BOB }]));
    expect(ledgerBetween(lifted, ALICE, HUB).holds).toEqual([]);
    const unrelated = expiring(behindOn(locked(), CAROL));
    expect(ledgerBetween(unrelated, ALICE, HUB).holds).toEqual([]);
  });

  const lostOn = (net: Net, peer: EntityId): Net =>
    deliver(net, 100n, HUB, [{ _tag: "j_account_lost", peer, from: 2n }]);

  test("R-WATCH-WINDOW a hub forwards no lock to a peer it cannot read, and expires none forwarded to it", () => {
    const refused = tell(lostOn(forwardAt(base()), BOB), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(refused, HUB, BOB).holds).toEqual([]);
    const held = expiring(lostOn(locked(), BOB));
    expect(ledgerBetween(held, ALICE, HUB).holds).toHaveLength(1);
    const freed = expiring(deliver(lostOn(locked(), BOB), 100n, HUB, [{ _tag: "j_behind_over", peer: BOB }]));
    expect(ledgerBetween(freed, ALICE, HUB).holds).toHaveLength(1);
    const waits = waitsOf(stateOf(lostOn(locked(), BOB), HUB), judge.clock);
    expect(waits.lost).toEqual(new Set([BOB]));
    expect(waits.behind).toEqual(new Set());
  });

  test("R-REVEAL-BACKSTOP an Entity co-signs no expiry of a hold whose secret the chain showed by its deadline", () => {
    const plain = (): Net => tell(base(), 100n, ALICE, lock(base(), 105n));
    expect(ledgerBetween(expiring(plain()), ALICE, HUB).holds).toEqual([]);
    const shown = expiring(showing(plain(), SECRET));
    expect(ledgerBetween(shown, ALICE, HUB).holds).toHaveLength(1);
    const other = expiring(showing(plain(), SECOND));
    expect(ledgerBetween(other, ALICE, HUB).holds).toEqual([]);
  });

  const showingAt = (net: Net, secret: Uint8Array, at: bigint): Net =>
    deliver(net, 100n, HUB, [{ _tag: "j_secret", secret, at }]);

  test("R-REVEAL-BACKSTOP the Entity keeps the lowest height a secret was shown at, in any hearing order", () => {
    const heard = (...heights: readonly bigint[]) =>
      stateOf(heights.reduce((net, at) => showingAt(net, SECRET, at), forwarded()), HUB).shown;
    expect(heard(9n, 5n, 7n)).toEqual(new Map([[HASHLOCK, 5n]]));
    expect(heard(5n, 9n)).toEqual(new Map([[HASHLOCK, 5n]]));
  });

  test("R-REVEAL-BACKSTOP a secret no hold or entry of the Entity names is not kept, however many show", () => {
    const flood = Array.from({ length: 300 }, (_, i) => secretOf(i + 10));
    const flooded = flood.reduce((net, secret) => showingAt(net, secret, 100n), forwarded());
    expect(stateOf(flooded, HUB).shown.size).toBe(0);
    const held = showingAt(tell(base(), 100n, ALICE, lock(base(), 105n)), SECRET, 100n);
    expect(stateOf(held, HUB).shown).toEqual(new Map([[HASHLOCK, 100n]]));
    const entry = showingAt(forwardAt(base()), SECRET, 100n);
    expect(stateOf(entry, HUB).shown).toEqual(new Map([[HASHLOCK, 100n]]));
  });

  test("R-REVEAL-BACKSTOP a secret heard again once its hold exists is kept, whatever was heard before it", () => {
    const early = showingAt(base(), SECRET, 99n);
    const later = showingAt(tell(early, 100n, ALICE, lock(base(), 105n)), SECRET, 101n);
    expect(stateOf(later, HUB).shown).toEqual(new Map([[HASHLOCK, 101n]]));
    const both = showingAt(showingAt(tell(base(), 100n, ALICE, lock(base(), 105n)), SECRET, 101n), SECRET, 100n);
    expect(stateOf(both, HUB).shown).toEqual(new Map([[HASHLOCK, 100n]]));
  });

  test("R-REVEAL-BACKSTOP a frame of foreign secrets builds its unchanged named set once", () => {
    const hub = stateOf(forwarded(), HUB);
    const values = spyOn(hub.accounts, "values");
    const inputs: EntityInput[] = Array.from({ length: 300 }, (_, i) =>
      ({ _tag: "j_secret", secret: secretOf(i + 10), at: 100n }));
    const frame = entityFrame(judge, anchor, hub, inputs);
    const calls = values.mock.calls.length;
    values.mockRestore();
    expect(frame.state.shown.size).toBe(0);
    expect(calls).toBe(1);
  });

  test("R-REVEAL-BACKSTOP a peer lock between two reveals invalidates the frame's named set", () => {
    const net = base();
    const sent = entityFrame(judge, anchor, stateOf(net, ALICE), [lock(net, 105n)]).outputs[0];
    if (sent === undefined) return expect.unreachable("no lock frame");
    const inputs: EntityInput[] = [
      { _tag: "j_secret", secret: SECRET, at: 99n },
      { _tag: "peer_message", from: sent.from, msg: sent.msg, sig: TEST_SIG },
      { _tag: "j_secret", secret: SECRET, at: 101n },
    ];
    expect(entityFrame(judge, anchor, stateOf(net, HUB), inputs).state.shown).toEqual(new Map([[HASHLOCK, 101n]]));
  });

  test("R-REVEAL-BACKSTOP a hold in a proposed frame or a queued lock is named too", () => {
    const hub = stateOf(base(), HUB);
    const alice = hub.accounts.get(ALICE) ?? expect.unreachable("no account");
    const locked = stateOf(tell(base(), 100n, ALICE, lock(base(), 105n)), HUB).accounts.get(ALICE)?.state;
    const after = locked ?? expect.unreachable("no account");
    const hold = ledgerOf(after, GOLD).holds[0] ?? expect.unreachable("no hold");
    const heard = (replica: typeof alice) =>
      entityFrame(judge, anchor, { ...hub, accounts: new Map([...hub.accounts, [ALICE, replica]]) },
        [{ _tag: "j_secret", secret: SECRET, at: 100n }]).state.shown;
    const frame = { author: alice.side, parent: alice.head, attempt: 0, slot: 1, epoch: 0n, firstNonce: 1n, txs: [] };
    expect(heard(alice)).toEqual(new Map());
    expect(heard({ ...alice, pending: { frame, after, head: alice.head } }))
      .toEqual(new Map([[HASHLOCK, 100n]]));
    // A queued lock behind a frame still in flight stays queued through the frame, so it is still named at its end.
    const waiting = { frame, after: alice.state, head: alice.head };
    const queued = { ...alice, pending: waiting, mempool: [{ _tag: "lock", token: GOLD, hold }] } as const;
    expect(heard(queued)).toEqual(new Map([[HASHLOCK, 100n]]));
  });

  test("R-WATCH-CALLDATA a blind Entity co-signs no expiry of any hold", () => {
    const held = expiring(blind(locked()));
    expect(ledgerBetween(held, ALICE, HUB).holds).toHaveLength(1);
    const lifted = expiring(deliver(blind(locked()), 100n, HUB, [{ _tag: "j_blind_over" }]));
    expect(ledgerBetween(lifted, ALICE, HUB).holds).toEqual([]);
  });
});

describe("entity/paybook a finalize held back for its secrets ends the Account late (R-WATCH-STALL)", () => {
  const FINAL = `0x${"05".repeat(32)}`;
  const hear = (net: Net, ...inputs: readonly EntityInput[]): Net => deliver(net, 100n, HUB, inputs);
  const moved: EntityInput = { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 5n, finalBodyHash: FINAL };
  const late: EntityInput = { _tag: "j_dispute_over", peer: BOB, late: true };

  /** Two locks of Alice's, one hash each, forwarded to Bob: the shorter at 105, the longer at 110. */
  const twoLocks = (): Net => {
    const entries = tell(base(), 100n, HUB,
      { _tag: "forward", hashlock: HASHLOCK, from: ALICE, to: BOB },
      { _tag: "forward", hashlock: SECOND_HASHLOCK, from: ALICE, to: BOB });
    return tell(entries, 100n, ALICE, lock(base(), 105n), lock(base(), 110n, 7n, SECOND_HASHLOCK));
  };
  const upstream = (net: Net) => [ledgerBetween(net, ALICE, HUB).offdelta, ledgerBetween(net, ALICE, HUB).holds.length];

  test("R-WATCH-STALL the epoch told ahead of the finalize dissolves nothing: both locks stay locked", () => {
    const heard = hear(twoLocks(), moved);
    expect(stateOf(heard, HUB).chain.get(BOB)).toMatchObject({ epoch: 1n });
    const entries = [HASHLOCK, SECOND_HASHLOCK].map((h) => stateOf(heard, HUB).paybook.get(h)?._tag);
    expect(entries).toEqual(["locked", "locked"]);
    expect(upstream(heard)).toEqual([0n, 2]);
  });

  test("R-WATCH-STALL of two locks on one Account the secret of the longer is claimed, the end fails the other", () => {
    const heard = hear(twoLocks(), moved, { _tag: "j_secret", secret: SECOND, at: 100n });
    expect(upstream(heard)).toEqual([-AMOUNT, 1]);
    const over = hear(heard, late);
    expect(upstream(over)).toEqual([-AMOUNT, 0]);
    expect(ledgerBetween(over, HUB, BOB).holds).toEqual([]);
    expect(stateOf(over, HUB).paybook.size).toBe(0);
  });

  test("R-WATCH-STALL the late end of the dispute with no secret fails every lock forwarded to the peer", () => {
    const over = hear(twoLocks(), moved, late);
    expect(upstream(over)).toEqual([0n, 0]);
    expect(stateOf(over, HUB).paybook.size).toBe(0);
  });

  test("R-WATCH-STALL two finalizes wait for the earlier secret before canceling unpaid upstream locks", () => {
    const behind: EntityInput = { _tag: "j_behind", peer: BOB, from: 90n };
    const second: EntityInput = { _tag: "j_epoch", peer: BOB, epoch: 2n, stored: 7n, finalBodyHash: FINAL };
    const waiting = hear(twoLocks(), behind, moved, second);
    expect(upstream(waiting)).toEqual([0n, 2]);
    const done = hear(waiting, { _tag: "j_secret", secret: SECOND, at: 100n }, late, late,
      { _tag: "j_behind_over", peer: BOB });
    expect(upstream(done)).toEqual([-AMOUNT, 0]);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(stateOf(done, HUB).chain.get(BOB)?.epoch).toBe(2n);
  });
});
