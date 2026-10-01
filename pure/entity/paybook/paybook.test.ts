// R-HTLC-FORWARD: a hub that holds a lock for a hashlock it has an entry for locks the same amount on the next hop one
// hop sooner, passes the secret back, and gives the lock up when the next hop does. Three whole Entities (Alice, a
// hub, Bob) talking until nothing is left to send; what an Account's rules say about a lock is account/clause's.
import { describe, expect, test } from "bun:test";
import { heightOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId, type Hold } from "../../account/model.ts";
import { MAX_ROUTE_HOPS } from "../../account/tx.ts";
import { ledgerOf } from "../../account/state.ts";
import { jHeight } from "../../account/clause/clock.ts";
import { hopOf } from "./paybook.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import { anchor, credit, entityOf, GOLD, judge, open } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type EntityState, type Notice, type Outbound,
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
    deliver(acc, view, out.to, [{ _tag: "peer_message", from: out.from, msg: out.msg }]), next);
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
