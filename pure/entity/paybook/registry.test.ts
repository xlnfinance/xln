// R-REGISTRY-AT-VIEW: the Entity accepts a lock, forwards one and co-signs an expiry on what the chain's registry
// (`hashToTimestamp`) held at the view it decides at, compared with the second the lock signs as the contract does
// (contracts/test/vm/fork-rules/h5-registry-second.test.ts pins that rule to the deployed bytecode). Whole Entities
// talking until nothing is left to send, with the readings a Host would hand each frame.
import { describe, expect, test } from "bun:test";
import { heightOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId, type Hold } from "../../account/model.ts";
import { ledgerOf } from "../../account/state.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { anchor, credit, entityOf, forwarded, GOLD, heardSigned, judge, open, TEST_SIG } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import {
  emptyEntity, heardOf, type Command, type EntityId, type EntityInput, type EntityState, type Notice, type Outbound,
  type Reading,
} from "../model.ts";
import { paid, registryOf, wantsOf } from "./registry.ts";

const ALICE = entityOf(1);
const HUB = entityOf(2);
const BOB = entityOf(3);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const HASHLOCK = keccakHex(SECRET);
const AMOUNT = 10n;
const DEADLINE = 105n;
const OIL = tokenOf(2n);

/** The second the body signs for a lock due at J height `d`, as the entity tests' terms give it. */
const signed = (d: bigint): bigint => anchor.terms.secondsOf(heightOf(d));

/** Who decides on the registry, and what it holds for each hashlock: every frame of those Entities is handed it. */
type World = Readonly<{ on: ReadonlySet<EntityId>; seconds: ReadonlyMap<string, bigint> }>;

type Net = Readonly<{ entities: ReadonlyMap<EntityId, EntityState>; notices: readonly Notice[] }>;

const stateOf = (net: Net, id: EntityId): EntityState => net.entities.get(id) ?? expect.unreachable("no entity");

const readingsOf = (world: World, id: EntityId, view: bigint): readonly Reading[] | undefined =>
  (world.on.has(id) ? [...world.seconds].map(([hashlock, seconds]) => ({ hashlock, at: view, seconds })) : undefined);

const deliver = (world: World, net: Net, view: bigint, to: EntityId, inputs: readonly EntityInput[]): Net => {
  const at = { ...judge, view: viewOf(view) };
  const framed = entityFrame(at, anchor, stateOf(net, to), inputs, readingsOf(world, to, view));
  const next: Net = {
    entities: new Map([...net.entities, [to, framed.state]]), notices: [...net.notices, ...framed.notices],
  };
  return framed.outputs.reduce((acc: Net, out: Outbound) =>
    deliver(world, acc, view, out.to, [{ ...heardOf(out), sig: TEST_SIG }]), next);
};

const tell = (world: World, net: Net, view: bigint, to: EntityId, ...commands: readonly Command[]): Net =>
  commands.reduce((acc, c) => deliver(world, acc, view, to, [c]), net);

const ALL = new Set([ALICE, HUB, BOB]);
/** No readings handed over at all: the registry gate is off for the frame. */
const GATE_OFF: readonly Reading[] | undefined = undefined;
const NONE: World = { on: ALL, seconds: new Map() };
const showing = (shown: bigint, on: ReadonlySet<EntityId> = ALL): World =>
  ({ on, seconds: new Map([[HASHLOCK, shown]]) });

const LINKS = [[ALICE, HUB], [HUB, ALICE], [HUB, BOB], [BOB, HUB]] as const;

const base = (): Net => {
  const off: World = { on: new Set(), seconds: new Map() };
  const start: Net = { entities: new Map([ALICE, HUB, BOB].map((id) => [id, emptyEntity(id)])), notices: [] };
  const opened = LINKS.reduce((net, [self, peer]) => tell(off, net, 100n, self, open(peer)), start);
  return LINKS.reduce((net, [self, peer]) => tell(off, net, 100n, self, credit(peer, 1000n)), opened);
};

const holdOf = (net: Net, deadline: bigint = DEADLINE): Hold => ({
  id: holdId(1n), payer: stateOf(net, ALICE).accounts.get(HUB)?.side ?? expect.unreachable("no account"),
  amount: AMOUNT, hashlock: HASHLOCK, deadline: heightOf(deadline),
});

const lock = (net: Net, deadline: bigint = DEADLINE): Command =>
  ({ _tag: "lock", peer: HUB, token: GOLD, hold: holdOf(net, deadline) });

const holdsBetween = (net: Net, self: EntityId, peer: EntityId): readonly Hold[] =>
  ledgerOf(stateOf(net, self).accounts.get(peer)?.state ?? expect.unreachable("no account"), GOLD).holds;

const faultOf = (net: Net): readonly string[] =>
  net.notices.flatMap((n) => (n._tag === "command_refused" && n.fault._tag === "account_refused"
    ? [n.fault.fault._tag] : []));

describe("entity/paybook the registry at the view (R-REGISTRY-AT-VIEW)", () => {
  test("R-REGISTRY-AT-VIEW a clause is paid iff a secret was shown and not after the second the lock signs", () => {
    expect(paid(0n, 2000n)).toBe(false);
    expect(paid(1n, 2000n)).toBe(true);
    expect(paid(2000n, 2000n)).toBe(true);
    expect(paid(2001n, 2000n)).toBe(false);
    expect(paid(2001n, 0n)).toBe(false);
  });

  test("R-REGISTRY-AT-VIEW only a reading taken at the frame's own view is a reading", () => {
    const readings: readonly Reading[] = [
      { hashlock: "0xa1", at: 99n, seconds: 5n }, { hashlock: "0xa2", at: 100n, seconds: 0n },
      { hashlock: "0xa3", at: 101n, seconds: 7n },
    ];
    const registry = registryOf(readings, viewOf(100n), anchor.terms.secondsOf);
    expect(registry.seconds).toEqual(new Map([["0xa2", 0n]]));
    expect(registry.secondsOf(heightOf(105n))).toBe(signed(105n));
  });

  test("R-REGISTRY-AT-VIEW a frame is handed readings for what it decides on and no others", () => {
    const net = base();
    const noted = (hashlock: string): Command => ({ _tag: "forward", hashlock, from: ALICE, to: BOB });
    const withEntry = tell(NONE, net, 100n, HUB, noted("0xf0"));
    const holder = forwarded(HUB, ALICE, BOB, 100n, DEADLINE);
    expect(wantsOf(stateOf(base(), HUB), [])).toEqual([]);
    expect(wantsOf(stateOf(withEntry, HUB), [])).toEqual(["0xf0"]);
    const at = { ...judge, view: viewOf(100n) };
    const pay: Command = { _tag: "pay", peer: HUB, token: GOLD, amount: 1n };
    const readings = readingsOf(showing(0n), ALICE, 100n);
    const sent = entityFrame(at, anchor, stateOf(base(), ALICE), [lock(base()), pay], readings);
    const frame = sent.outputs.map(heardSigned);
    expect(frame.length).toBe(1);
    expect(wantsOf(stateOf(base(), HUB), frame)).toEqual([HASHLOCK]);
    expect(wantsOf(stateOf(base(), ALICE), [lock(base()), { _tag: "pay", peer: HUB, token: GOLD, amount: 1n }]))
      .toEqual([HASHLOCK]);
    const expiry: Command = { _tag: "expire", peer: ALICE, token: GOLD, id: holdId(1n) };
    expect(wantsOf(holder, [expiry])).toEqual([HASHLOCK]);
    expect(wantsOf(holder, [{ _tag: "expire", peer: ALICE, token: GOLD, id: holdId(9n) }])).toEqual([]);
    expect(wantsOf(holder, [{ _tag: "expire", peer: ALICE, token: OIL, id: holdId(1n) }])).toEqual([]);
    expect(wantsOf(holder, [])).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW a lock is accepted when the registry shows no secret at the view", () => {
    const done = tell(showing(0n), base(), 100n, ALICE, lock(base()));
    expect(holdsBetween(done, ALICE, HUB).map((h) => h.hashlock)).toEqual([HASHLOCK]);
    expect(holdsBetween(done, HUB, ALICE).map((h) => h.hashlock)).toEqual([HASHLOCK]);
    expect(done.notices).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW a lock of a hashlock the chain pays is refused for good, at the second and not past", () => {
    const paidNow = tell(showing(signed(DEADLINE)), base(), 100n, ALICE, lock(base()));
    expect(faultOf(paidNow)).toEqual(["paid_on_chain"]);
    expect(holdsBetween(paidNow, ALICE, HUB)).toEqual([]);
    const early = tell(showing(1n), base(), 100n, ALICE, lock(base()));
    expect(faultOf(early)).toEqual(["paid_on_chain"]);
    const pastIt = tell(showing(signed(DEADLINE) + 1n), base(), 100n, ALICE, lock(base()));
    expect(faultOf(pastIt)).toEqual([]);
    expect(holdsBetween(pastIt, HUB, ALICE).map((h) => h.hashlock)).toEqual([HASHLOCK]);
  });

  test("R-REGISTRY-AT-VIEW a lock with no reading at its view is refused, and the refusal can pass", () => {
    const none = tell(NONE, base(), 100n, ALICE, lock(base()));
    expect(faultOf(none)).toEqual(["registry_unknown"]);
    expect(holdsBetween(none, ALICE, HUB)).toEqual([]);
    const other = entityFrame(
      { ...judge, view: viewOf(100n) }, anchor, stateOf(base(), ALICE), [lock(base())],
      [{ hashlock: HASHLOCK, at: 99n, seconds: 0n }],
    );
    expect(other.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    const off = entityFrame({ ...judge, view: viewOf(100n) }, anchor, stateOf(base(), ALICE), [lock(base())]);
    expect(off.notices).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW a peer's lock of a paid hashlock is refused by the receiver for good", () => {
    const world = showing(signed(DEADLINE), new Set([HUB]));
    const done = tell(world, base(), 100n, ALICE, lock(base()));
    const dropped = done.notices.flatMap((n) => (n._tag === "tx_refused" && n.refused.fault._tag === "peer_refused"
      ? [n.refused.fault.fault] : []));
    expect(dropped).toEqual(["paid_on_chain"]);
    expect([[ALICE, HUB], [HUB, ALICE]].map(([a, b]) => holdsBetween(done, a!, b!))).toEqual([[], []]);
    expect(stateOf(done, ALICE).accounts.get(HUB)?.mempool).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW a peer's lock the receiver cannot read yet comes back and the next reading takes it", () => {
    const first = tell({ on: new Set([HUB]), seconds: new Map() }, base(), 100n, ALICE, lock(base()));
    expect(first.notices.filter((n) => n._tag === "tx_refused")).toEqual([]);
    expect(holdsBetween(first, HUB, ALICE)).toEqual([]);
    expect(stateOf(first, ALICE).accounts.get(HUB)?.mempool.map((tx) => tx._tag)).toEqual(["lock"]);
    const later = deliver(showing(0n, new Set([HUB])), first, 101n, ALICE, []);
    expect(holdsBetween(later, HUB, ALICE).map((h) => h.hashlock)).toEqual([HASHLOCK]);
    expect(holdsBetween(later, ALICE, HUB).map((h) => h.hashlock)).toEqual([HASHLOCK]);
  });

  /** A lock of Alice's to the hub that stands, accepted at view 100 on a reading of none. */
  const held = (): Net => tell(showing(0n), base(), 100n, ALICE, lock(base()));
  const EXPIRABLE = DEADLINE + judge.clock.reserve + 1n;
  const expire: Command = { _tag: "expire", peer: HUB, token: GOLD, id: holdId(1n) };

  test("R-REGISTRY-AT-VIEW an expiry is refused for good when the registry pays the hold", () => {
    const paidLate = tell(showing(signed(DEADLINE)), held(), EXPIRABLE, ALICE, expire);
    expect(faultOf(paidLate)).toEqual(["revealed_on_chain"]);
    expect(holdsBetween(paidLate, ALICE, HUB).length).toBe(1);
    const onTime = tell(showing(signed(DEADLINE) + 1n), held(), EXPIRABLE, ALICE, expire);
    expect(faultOf(onTime)).toEqual([]);
    expect(holdsBetween(onTime, ALICE, HUB)).toEqual([]);
    expect(holdsBetween(onTime, HUB, ALICE)).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW an expiry queued behind a pending frame, or in a peer's frame, is wanted too", () => {
    const at = { ...judge, view: viewOf(EXPIRABLE) };
    const readings = readingsOf(showing(signed(DEADLINE) + 1n), ALICE, EXPIRABLE);
    const pay: Command = { _tag: "pay", peer: HUB, token: GOLD, amount: 1n };
    const pending = entityFrame(at, anchor, stateOf(held(), ALICE), [pay], readings);
    expect(wantsOf(pending.state, [])).toEqual([]);
    const queued = entityFrame(at, anchor, pending.state, [expire], readings);
    expect(queued.state.accounts.get(HUB)?.mempool.map((tx) => tx._tag)).toEqual(["expire"]);
    expect(wantsOf(queued.state, [])).toEqual([HASHLOCK]);
    const sent = entityFrame(at, anchor, stateOf(held(), ALICE), [expire], readings);
    expect(sent.outputs.length).toBe(1);
    expect(wantsOf(stateOf(held(), HUB), sent.outputs.map(heardSigned))).toEqual([HASHLOCK]);
  });

  test("R-REGISTRY-AT-VIEW an expiry of a hold that is not there is refused by the Account", () => {
    const none: Command = { _tag: "expire", peer: HUB, token: GOLD, id: holdId(9n) };
    const done = tell(showing(signed(DEADLINE)), held(), EXPIRABLE, ALICE, none);
    expect(done.notices.map((n) => n._tag)).toEqual(["command_refused"]);
    expect(holdsBetween(done, ALICE, HUB).length).toBe(1);
  });

  test("R-REGISTRY-AT-VIEW an expiry with no reading at its view is refused, and the refusal can pass", () => {
    const none = tell(NONE, held(), EXPIRABLE, ALICE, expire);
    expect(faultOf(none)).toEqual(["registry_unknown"]);
    expect(holdsBetween(none, ALICE, HUB).length).toBe(1);
  });

  test("R-REGISTRY-AT-VIEW a peer's expiry of a hold the chain pays is refused by the receiver, for good", () => {
    const world = showing(signed(DEADLINE), new Set([HUB]));
    const done = tell(world, held(), EXPIRABLE, ALICE, expire);
    const dropped = done.notices.flatMap((n) => (n._tag === "tx_refused" && n.refused.fault._tag === "peer_refused"
      ? [n.refused.fault.fault] : []));
    expect(dropped).toEqual(["revealed_on_chain"]);
    expect(holdsBetween(done, HUB, ALICE).length).toBe(1);
  });

  /** The hub holds Alice's lock, told nothing of where it goes; Bob is asked to resolve what comes to him. */
  const awaiting = (): Net => tell(showing(0n), base(), 100n, ALICE, lock(base()));
  const forwardCommand: Command = { _tag: "forward", hashlock: HASHLOCK, from: ALICE, to: BOB };

  test("R-REGISTRY-AT-VIEW a forward with no reading waits: no lock to the next hop, none given up", () => {
    const waiting = tell(NONE, awaiting(), 100n, HUB, forwardCommand);
    expect(stateOf(waiting, HUB).paybook.get(HASHLOCK)?._tag).toBe("forward");
    expect(holdsBetween(waiting, HUB, BOB)).toEqual([]);
    expect(holdsBetween(waiting, ALICE, HUB).length).toBe(1);
    expect(waiting.notices).toEqual([]);
    const forwarding = deliver(showing(0n), waiting, 101n, HUB, []);
    expect(stateOf(forwarding, HUB).paybook.get(HASHLOCK)?._tag).toBe("locked");
    expect(holdsBetween(forwarding, HUB, BOB).map((h) => h.hashlock)).toEqual([HASHLOCK]);
  });

  test("R-REGISTRY-AT-VIEW a forward of a paid hashlock is refused at the door, the inbound lock given up", () => {
    const waiting = tell(NONE, awaiting(), 100n, HUB, forwardCommand);
    const done = deliver(showing(signed(DEADLINE - 3n)), waiting, 101n, HUB, []);
    expect(holdsBetween(done, HUB, BOB)).toEqual([]);
    expect(holdsBetween(done, ALICE, HUB)).toEqual([]);
    expect(stateOf(done, HUB).paybook.size).toBe(0);
    expect(done.notices.flatMap((n) => (n._tag === "command_refused" ? [n.command._tag] : []))).toEqual(["lock"]);
  });

  test("R-REGISTRY-AT-VIEW a queued lock waits in its Account's queue for a reading and is not dropped", () => {
    const world = showing(0n, new Set([ALICE]));
    const at = { ...judge, view: viewOf(100n) };
    const pay: Command = { _tag: "pay", peer: HUB, token: GOLD, amount: 1n };
    const pending = entityFrame(at, anchor, stateOf(base(), ALICE), [pay], readingsOf(world, ALICE, 100n));
    expect(pending.outputs.length).toBe(1);
    const queued = entityFrame(at, anchor, pending.state, [lock(base())], readingsOf(world, ALICE, 100n));
    expect(queued.notices).toEqual([]);
    expect(queued.state.accounts.get(HUB)?.mempool.map((tx) => tx._tag)).toEqual(["lock"]);
    const hubSide = entityFrame(at, anchor, stateOf(base(), HUB), pending.outputs.map(heardSigned), GATE_OFF);
    const [ack] = hubSide.outputs;
    const unread = entityFrame(at, anchor, queued.state, ack === undefined ? [] : [heardSigned(ack)], []);
    expect(unread.notices.filter((n) => n._tag === "tx_refused")).toEqual([]);
    expect(unread.outputs).toEqual([]);
    expect(unread.state.accounts.get(HUB)?.mempool.map((tx) => tx._tag)).toEqual(["lock"]);
    const read = entityFrame(at, anchor, unread.state, [], readingsOf(world, ALICE, 100n));
    expect(read.outputs.length).toBe(1);
    expect(read.state.accounts.get(HUB)?.mempool).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW an Entity that does not decide on the registry decides as before", () => {
    const done = tell({ on: new Set(), seconds: new Map() }, base(), 100n, ALICE, lock(base()));
    expect(done.notices).toEqual([]);
    expect(holdsBetween(done, HUB, ALICE).length).toBe(1);
  });

  test("R-REGISTRY-AT-VIEW what the chain showed is kept only while a hold or an entry of the Entity names it", () => {
    const holder = forwarded(HUB, ALICE, BOB, 100n, DEADLINE);
    const shown = new Map([[HASHLOCK, 7n], ["0xdead", 3n]]);
    const frame = entityFrame({ ...judge, view: viewOf(100n) }, anchor, { ...holder, shown }, []);
    expect(frame.state.shown).toEqual(new Map([[HASHLOCK, 7n]]));
    const none = entityFrame({ ...judge, view: viewOf(100n) }, anchor, { ...emptyEntity(HUB), shown }, []);
    expect(none.state.shown.size).toBe(0);
  });
});
