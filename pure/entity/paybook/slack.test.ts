// R-HOP-SLACK through whole Entities: a hub forwards a lock only if the chain's seconds leave every claim room between
// the two deadlines, read at the block the node's view stands on. Three Entities (Alice, a hub, Bob) talking until
// nothing is left to send; Bob has not answered, so a forwarded lock stays on the hub-Bob Account.
import { describe, expect, test } from "bun:test";
import { heightOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { ledgerOf } from "../../account/state.ts";
import type { Judge } from "../../account/tx.ts";
import { clockParams, type ClockParams, type Pace } from "../../account/clause/clock.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import { anchor, credit, entityOf, GOLD, judge, open, TEST_SIG } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type EntityState, type Outbound,
} from "../model.ts";

const ALICE = entityOf(1);
const HUB = entityOf(2);
const BOB = entityOf(3);
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const HASHLOCK = keccakHex(SECRET);
const AMOUNT = 10n;
const PACE: Pace = { slot: 12n, missed: 1n, pollDelay: 2n };
const UNKNOWN = undefined;
/** The tests' time map is 1000 s plus 12 s a height: height 100 is at second 2200 when no slot is missed. */
const LINE_AT_100 = 2200n;

type Net = ReadonlyMap<EntityId, EntityState>;

const clock = unwrapOr(clockParams(2n, 5n, 100n, 1n, PACE), (fault) => expect.unreachable(`refused: ${fault._tag}`));

/** The hub's judge at view 100, with the second of the block there, if it knows it. */
const judged = (seconds: bigint | undefined, params: ClockParams = clock): Judge =>
  (seconds === undefined ? { ...judge, clock: params, view: viewOf(100n) }
    : { ...judge, clock: params, view: viewOf(100n), seconds });

const deliver = (at: Judge, net: Net, to: EntityId, inputs: readonly EntityInput[]): Net => {
  const framed = entityFrame(at, anchor, net.get(to) ?? expect.unreachable("no entity"), inputs);
  const next = new Map([...net, [to, framed.state]]);
  return framed.outputs.reduce((acc: Net, out: Outbound) =>
    deliver(at, acc, out.to, [{ _tag: "peer_message", from: out.from, msg: out.msg, sig: TEST_SIG }]), next);
};

const tell = (at: Judge, net: Net, to: EntityId, ...commands: readonly Command[]): Net =>
  commands.reduce((acc, c) => deliver(at, acc, to, [c]), net);

const LINKS = [[ALICE, HUB], [HUB, ALICE], [HUB, BOB], [BOB, HUB]] as const;

const base = (at: Judge): Net => {
  const start: Net = new Map([ALICE, HUB, BOB].map((id) => [id, emptyEntity(id)]));
  const opened = LINKS.reduce((net, [self, peer]) => tell(at, net, self, open(peer)), start);
  const credited = LINKS.reduce((net, [self, peer]) => tell(at, net, self, credit(peer, 1000n)), opened);
  return tell(at, credited, HUB, { _tag: "forward", hashlock: HASHLOCK, from: ALICE, to: BOB });
};

const lockAt = (net: Net, deadline: bigint): Command => ({
  _tag: "lock", peer: HUB, token: GOLD, hold: {
    id: holdId(1n), payer: net.get(ALICE)?.accounts.get(HUB)?.side ?? expect.unreachable("no account"),
    amount: AMOUNT, hashlock: HASHLOCK, deadline: heightOf(deadline),
  },
});

const holdsBetween = (net: Net, self: EntityId, peer: EntityId) =>
  ledgerOf(net.get(self)?.accounts.get(peer)?.state ?? expect.unreachable("no account"), GOLD).holds;

/** Alice locks to the hub at `deadline`; the hub is judged at view 100 with the block at that view at `seconds`. */
const lockedWith = (seconds: bigint | undefined, deadline: bigint, params: ClockParams = clock): Net => {
  const at = judged(seconds, params);
  const net = base(at);
  return tell(at, net, ALICE, lockAt(net, deadline));
};

const INBOUND = 110n;
const ONWARD = INBOUND - (clock.reserve + clock.lag);

describe("entity/paybook the hub reads a deadline through the chain's seconds (R-HOP-SLACK)", () => {
  test("R-HOP-SLACK a lock whose claims fit is forwarded one hop sooner, as signed", () => {
    const done = lockedWith(LINE_AT_100, INBOUND);
    expect(holdsBetween(done, HUB, BOB).map((h) => h.deadline)).toEqual([heightOf(ONWARD)]);
    expect(holdsBetween(done, ALICE, HUB).map((h) => h.deadline)).toEqual([heightOf(INBOUND)]);
  });

  test("R-HOP-SLACK a missed slot shrinks the blocks left, and the forward that no longer fits is refused", () => {
    const forwarded = [0n, 1n, 2n, 3n].map((slots) =>
      holdsBetween(lockedWith(LINE_AT_100 + 12n * slots, INBOUND), HUB, BOB).length);
    expect(forwarded).toEqual([1, 1, 0, 0]);
    const refused = lockedWith(LINE_AT_100 + 24n, INBOUND);
    expect(holdsBetween(refused, ALICE, HUB)).toEqual([]);
    expect(refused.get(HUB)?.paybook.size).toBe(0);
  });

  test("R-HOP-SLACK a head second ahead of the line never lengthens a deadline: it can only refuse", () => {
    const heads = [-600n, -120n, 0n, 12n, 24n, 120n, 6000n].map((off) => LINE_AT_100 + off);
    const forwards = heads.map((seconds) => holdsBetween(lockedWith(seconds, INBOUND), HUB, BOB).length);
    expect(forwards).toEqual([1, 1, 1, 1, 0, 0, 0]);
    expect(holdsBetween(lockedWith(LINE_AT_100 + 12n, INBOUND), HUB, BOB).map((h) => h.deadline))
      .toEqual([heightOf(ONWARD)]);
  });

  test("R-HOP-SLACK a hub that does not know the second of its view forwards nothing", () => {
    expect(holdsBetween(lockedWith(UNKNOWN, INBOUND), HUB, BOB)).toEqual([]);
    expect(holdsBetween(lockedWith(UNKNOWN, INBOUND), ALICE, HUB)).toEqual([]);
  });

  test("R-HOP-SLACK a clock with no pace forwards as before, whatever second the view stands at", () => {
    const bare: ClockParams = { ...clock, pace: undefined };
    expect(holdsBetween(lockedWith(900_000n, INBOUND, bare), HUB, BOB)).toHaveLength(1);
    expect(holdsBetween(lockedWith(UNKNOWN, INBOUND, bare), HUB, BOB)).toHaveLength(1);
  });

  test("R-HOP-SLACK a lock with no room for another hop is given up whatever the seconds say", () => {
    const tight = lockedWith(LINE_AT_100, 100n + clock.reserve + clock.lag);
    expect(holdsBetween(tight, HUB, BOB)).toEqual([]);
    expect(holdsBetween(tight, ALICE, HUB)).toEqual([]);
  });
});
