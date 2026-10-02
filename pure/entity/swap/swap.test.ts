// R-ENTITY-SWAP-COMMANDS: an Entity queues the Account's swap txs (offer, fill, retract, lapse) the way it queues a
// payment, and the other Entity reaches the same state by the same frames. Two whole Entities, talking until neither
// has anything left to send; what the Account's rules say about each tx is account/swap's (R-SWAP-*), not repeated.
import { describe, expect, test } from "bun:test";
import { heightOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId, type AccountState, type Leg, type Offer, type Side } from "../../account/model.ts";
import { ledgerOf } from "../../account/state.ts";
import { anchor, entityOf, GOLD, judge, open, TEST_SIG } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import { emptyEntity, type Command, type EntityInput, type EntityState, type Notice, type Outbound } from "../model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const OIL = tokenOf(2n);

type Who = "alice" | "bob";
type Pair = Readonly<{ alice: EntityState; bob: EntityState }>;

const PEER: Readonly<Record<Who, typeof ALICE>> = { alice: BOB, bob: ALICE };
const OTHER: Readonly<Record<Who, Who>> = { alice: "bob", bob: "alice" };

const runAt = (view: bigint, state: EntityState, inputs: readonly EntityInput[]) =>
  entityFrame({ ...judge, view: viewOf(view) }, anchor, state, inputs);

/** What `from` sent is what the other Entity takes in, until nothing is left to send. */
const drain = (p: Pair, view: bigint, outs: readonly Outbound[], from: Who): Pair => {
  if (outs.length === 0) return p;
  const to = OTHER[from];
  const heard = outs.map((o): EntityInput => ({ _tag: "peer_message", from: o.from, msg: o.msg, sig: TEST_SIG }));
  const framed = runAt(view, p[to], heard);
  return drain({ ...p, [to]: framed.state }, view, framed.outputs, to);
};

const say = (p: Pair, who: Who, command: Command, view = 100n): Pair => {
  const framed = runAt(view, p[who], [command]);
  return drain({ ...p, [who]: framed.state }, view, framed.outputs, who);
};

const noticesOf = (p: Pair, who: Who, command: Command, view = 100n): readonly Notice[] =>
  runAt(view, p[who], [command]).notices;

const credit = (peer: typeof ALICE, token: typeof GOLD, limit: bigint): Command =>
  ({ _tag: "set_credit", peer, token, limit });

/** Both Entities have the Account open and each extends credit in both tokens: either side may pay either token. */
const funded: Pair = (["alice", "bob"] as const).reduce<Pair>((p, who) =>
  [GOLD, OIL].reduce((q, token) => say(q, who, credit(PEER[who], token, 5_000n)), p),
(["alice", "bob"] as const).reduce<Pair>((p, who) => say(p, who, open(PEER[who])),
  { alice: emptyEntity(ALICE), bob: emptyEntity(BOB) }));

const accountOf = (p: Pair, who: Who): AccountState =>
  p[who].accounts.get(PEER[who])?.state ?? expect.unreachable("no Account");

const headOf = (p: Pair, who: Who) => p[who].accounts.get(PEER[who])?.head;

const BOTH: readonly Who[] = ["alice", "bob"];

/** What each Entity holds of the swaps, in the order alice, bob: both must say the same. */
const swapsOf = (p: Pair) => BOTH.map((who) => [accountOf(p, who).quotes, accountOf(p, who).offers]);
const offdeltasOf = (p: Pair, token: typeof GOLD) => BOTH.map((who) => ledgerOf(accountOf(p, who), token).offdelta);

const leg = (token: typeof GOLD, amount: bigint): Leg => ({ token, amount });

const offer = (peer: typeof ALICE, id: bigint, give: Leg, want: Leg, deadline = 105n): Command =>
  ({ _tag: "offer", peer, id: holdId(id), give, want, deadline: heightOf(deadline) });
const fill = (peer: typeof ALICE, id: bigint, ratio: number): Command =>
  ({ _tag: "fill", peer, id: holdId(id), ratio });
const retract = (peer: typeof ALICE, id: bigint): Command => ({ _tag: "retract", peer, id: holdId(id) });
const lapse = (peer: typeof ALICE, id: bigint): Command => ({ _tag: "lapse", peer, id: holdId(id) });

const quoteOf = (maker: Side, give: bigint, want: bigint, id = 1n): Offer => ({
  id: holdId(id), maker, give: leg(GOLD, give), want: leg(OIL, want), deadline: heightOf(105n),
});

const refused = (command: Command, fault: unknown): Notice =>
  ({ _tag: "command_refused", command, fault: { _tag: "account_refused", fault } } as Notice);

describe("entity/swap R-ENTITY-SWAP-COMMANDS the swap txs are queued like a payment and both Entities agree", () => {
  const quote = say(funded, "alice", offer(BOB, 1n, leg(GOLD, 1000n), leg(OIL, 333n)));

  test("an offer, a first fill that accepts it and a retract take both Entities through the same states", () => {
    const q = quoteOf("left", 1000n, 333n);
    expect(swapsOf(quote)).toEqual([[[q], []], [[q], []]]);
    expect(headOf(quote, "alice")).toBe(headOf(quote, "bob"));
    const taken = say(quote, "bob", fill(ALICE, 1n, 10_000));
    const rest = quoteOf("left", 848n, 283n);
    expect(swapsOf(taken)).toEqual([[[], [rest]], [[], [rest]]]);
    expect([offdeltasOf(taken, GOLD), offdeltasOf(taken, OIL)]).toEqual([[-152n, -152n], [50n, 50n]]);
    expect(headOf(taken, "alice")).toBe(headOf(taken, "bob"));
    const gone = say(taken, "alice", retract(BOB, 1n));
    expect(swapsOf(gone)).toEqual([[[], []], [[], []]]);
    expect(offdeltasOf(gone, GOLD)).toEqual([-152n, -152n]);
    expect(headOf(gone, "alice")).toBe(headOf(gone, "bob"));
  });

  test("a node's offer is always its own: Bob's is a quote of the Right side, on both Entities", () => {
    const bobs = say(funded, "bob", offer(ALICE, 7n, leg(OIL, 50n), leg(GOLD, 70n)));
    expect(BOTH.map((who) => accountOf(bobs, who).quotes.map((o) => [o.id, o.maker])))
      .toEqual([[[holdId(7n), "right"]], [[holdId(7n), "right"]]]);
    expect(headOf(bobs, "alice")).toBe(headOf(bobs, "bob"));
  });

  test("a lapse is a frame like another: once the offer is past due either Entity may ask, and both drop it", () => {
    const lapsed = say(quote, "bob", lapse(ALICE, 1n), 109n);
    expect(swapsOf(lapsed)).toEqual([[[], []], [[], []]]);
    expect(BOTH.map((who) => ledgerOf(accountOf(lapsed, who), GOLD).reserved))
      .toEqual([{ left: 0n, right: 0n }, { left: 0n, right: 0n }]);
    expect(headOf(lapsed, "alice")).toBe(headOf(lapsed, "bob"));
  });

  test("R-NOTICE each refusal reaches the owner as command_refused with the Account's fault, queuing nothing", () => {
    const cases: readonly (readonly [Who, Command, unknown])[] = [
      ["alice", fill(BOB, 1n, 10_000), { _tag: "not_taker" }],
      ["bob", retract(ALICE, 1n), { _tag: "not_maker" }],
      ["bob", fill(ALICE, 2n, 10_000), { _tag: "no_such_offer", id: holdId(2n) }],
      ["bob", fill(ALICE, 1n, 0), { _tag: "bad_ratio", ratio: 0 }],
      ["bob", lapse(ALICE, 1n), { _tag: "not_expired", deadline: 105n, earliest: 108n }],
      ["alice", offer(BOB, 1n, leg(GOLD, 1n), leg(OIL, 1n)), { _tag: "offer_exists", id: holdId(1n) }],
      ["alice", offer(BOB, 2n, leg(GOLD, 1n), leg(GOLD, 1n)), { _tag: "same_token", token: GOLD }],
    ];
    cases.forEach(([who, command, fault]) => {
      const framed = runAt(100n, quote[who], [command]);
      expect(framed.notices).toEqual([refused(command, fault)]);
      expect(framed.outputs).toEqual([]);
      expect(framed.state).toEqual(quote[who]);
    });
  });

  test("R-SWAP-CONSENT the cap of four quotes and the taker's room are refused at the door of the one who asks", () => {
    const four = [2n, 3n, 4n].reduce((p, id) => say(p, "alice", offer(BOB, id, leg(GOLD, 1n), leg(OIL, 1n))), quote);
    expect(noticesOf(four, "alice", offer(BOB, 5n, leg(GOLD, 1n), leg(OIL, 1n))))
      .toEqual([refused(offer(BOB, 5n, leg(GOLD, 1n), leg(OIL, 1n)), { _tag: "too_many_quotes", max: 4 })]);
    const wide = say(funded, "alice", offer(BOB, 1n, leg(GOLD, 10n), leg(OIL, 6_000n)));
    const command = fill(ALICE, 1n, 30_000);
    expect(noticesOf(wide, "bob", command)).toEqual([
      refused(command, { _tag: "insufficient_capacity", available: 5_000n, requested: 6_000n }),
    ]);
  });

  test("a command for a peer with no Account is no_account, as for any Account command", () => {
    const command = fill(entityOf(9), 1n, 10_000);
    expect(noticesOf(funded, "alice", command))
      .toEqual([{ _tag: "command_refused", command, fault: { _tag: "no_account", peer: entityOf(9) } }]);
  });
});
