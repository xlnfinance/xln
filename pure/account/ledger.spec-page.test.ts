// The whole state space of the Arrival money page (spec/money/ledger.scm at 3010ca3), walked again on the TypeScript
// ledger.
//
// The page has a model with two reserves, credit up to 1 and two holds at most, each on one of two hashlocks (one
// open clause per hashlock, R-ONE-LOCK-PER-HASH). Its checker found 1440 states and 12918 transitions, and its five
// invariants and six step properties hold on all of them. This file rebuilds the same rules
// on `Ledger`, walks every state, and holds each world and each step to the same properties, written out again from
// the formula. The page's two counts are pinned too: a rule the TypeScript takes and the page refuses, or the other
// way round, changes a count.
import { describe, expect, test } from "bun:test";
import { unwrapOr, type Result } from "../kernel/core/result.ts";
import { lockClause } from "./clause/clause.ts";
import { clockParams, type ClockParams } from "./clause/clock.ts";
import { deposit, emptyLedger, expire, pay, resolve, setCredit, withdraw } from "./ledger.ts";
import { hashlockOf, holdOf as holdWith, secretOf } from "./fixtures.ts";
import { holdId, other, type AccountFault, type HoldId, type Ledger, type Side } from "./model.ts";

/** A broken guard lets the walk run away; the page's own space is 1440 states, and past this the walk is a failure. */
const WALK_LIMIT = 10_000;
const START_RESERVE = 2n;
const MAX_CREDIT = 1n;
const MAX_HOLDS = 2;
const SIDES: readonly Side[] = ["left", "right"];
/** The page's two hashlocks, as the secret numbers they are made from. */
const HASHES: readonly number[] = [1, 2];
/** A lock is signed at view 0 with deadline 1: the page has no clock (the clock page does). */
const params: ClockParams = unwrapOr(clockParams(0n, 0n, 1n), () => expect.unreachable("params"));

/** One token's ledger and the two reserves the chain keeps outside it. */
type World = Readonly<{ ledger: Ledger; reserve: Readonly<Record<Side, bigint>> }>;
type Verb = "pay" | "credit" | "lock" | "resolve" | "expire" | "r2c" | "c2r";
type Outcome = Result<Ledger, AccountFault>;
type Rule = Readonly<{
  verb: Verb; arg: bigint; side: Side; enabled: (w: World) => boolean; step: (w: World) => Outcome;
}>;

const start: World = { ledger: emptyLedger, reserve: { left: START_RESERVE, right: START_RESERVE } };

const total = (w: World): bigint => w.reserve.left + w.reserve.right + w.ledger.collateral;
const delta = (l: Ledger): bigint => l.ondelta + l.offdelta;
const heldBy = (l: Ledger, side: Side): bigint =>
  l.holds.filter((h) => h.payer === side).reduce((sum, h) => sum + h.amount, 0n);
const creditFor = (l: Ledger, by: Side): bigint => l.limit[other(by)];

const payerAt = (w: World, i: number): Side | undefined => w.ledger.holds[i]?.payer;

/** The slot of the i-th open hold: the page names holds by position, the ledger by slot. */
const slotAt = (w: World, i: number): HoldId => w.ledger.holds[i]?.id ?? expect.unreachable(`no hold at ${i}`);

/** The first free slot, from 1: the page has no slots, so any free one does. */
const freeSlot = (w: World): HoldId =>
  [1n, 2n].map(holdId).find((id) => !w.ledger.holds.some((h) => h.id === id)) ?? expect.unreachable("no free slot");

const rulesFor = (side: Side): readonly Rule[] => [
  ...[1n, 2n].map((arg): Rule =>
    ({ verb: "pay", arg, side, enabled: () => true, step: (w) => pay(w.ledger, side, arg) })),
  ...[0n, 1n, 2n].map((arg): Rule => ({
    verb: "credit", arg, side, enabled: (w) => arg <= MAX_CREDIT && creditFor(w.ledger, side) !== arg,
    step: (w) => setCredit(w.ledger, side, arg),
  })),
  ...HASHES.map((h): Rule => ({
    verb: "lock", arg: BigInt(h), side, enabled: (w) => w.ledger.holds.length < MAX_HOLDS,
    step: (w) => lockClause(w.ledger, params, 0n, side, holdWith(side, 1n, freeSlot(w), 1n, h)),
  })),
  ...[0, 1].flatMap((i): readonly Rule[] => [
    {
      verb: "resolve", arg: BigInt(i), side, enabled: (w) => payerAt(w, i) === side,
      step: (w) => resolve(w.ledger, slotAt(w, i)),
    },
    {
      verb: "expire", arg: BigInt(i), side, enabled: (w) => payerAt(w, i) === side,
      step: (w) => expire(w.ledger, slotAt(w, i)),
    },
  ]),
  { verb: "r2c", arg: 1n, side, enabled: (w) => w.reserve[side] >= 1n, step: (w) => deposit(w.ledger, side, 1n) },
  { verb: "c2r", arg: 1n, side, enabled: (w) => w.ledger.collateral >= 1n, step: (w) => withdraw(w.ledger, side, 1n) },
];

const RULES: readonly Rule[] = SIDES.flatMap(rulesFor);

/** A world as the page sees it: holds by payer, amount and hashlock in order, without the slots the ledger adds. */
const keyOf = (w: World): string =>
  JSON.stringify([{ ...w.ledger, holds: w.ledger.holds.map((h) => [h.payer, h.amount, h.hashlock]) }, w.reserve],
    (_, v) => (typeof v === "bigint" ? `${v}n` : v));

/** What a rule moves between the payer's reserve and the collateral: a deposit draws the reserve down. */
const reserveDraw: Readonly<Record<Verb, bigint>> =
  { pay: 0n, credit: 0n, lock: 0n, resolve: 0n, expire: 0n, r2c: 1n, c2r: -1n };

const afterStep = (w: World, rule: Rule, next: Ledger): World =>
  ({ ledger: next, reserve: { ...w.reserve, [rule.side]: w.reserve[rule.side] - reserveDraw[rule.verb] } });

type Attempt = Readonly<{ from: World; rule: Rule; outcome: Outcome }>;

const attemptsFrom = (w: World): readonly Attempt[] =>
  RULES.filter((r) => r.enabled(w)).map((rule) => ({ from: w, rule, outcome: rule.step(w) }));

type Walk = Readonly<{ worlds: ReadonlyMap<string, World>; attempts: readonly Attempt[] }>;

const walkFrom = (frontier: readonly World[], seen: ReadonlyMap<string, World>, done: readonly Attempt[]): Walk => {
  if (frontier.length === 0 || seen.size > WALK_LIMIT) return { worlds: seen, attempts: done };
  const attempts = frontier.flatMap(attemptsFrom);
  const reached = attempts.flatMap((a) => (a.outcome.ok ? [afterStep(a.from, a.rule, a.outcome.value)] : []));
  const fresh = [...new Map(reached.filter((w) => !seen.has(keyOf(w))).map((w) => [keyOf(w), w])).values()];
  const seenNow = new Map([...seen, ...fresh.map((w): [string, World] => [keyOf(w), w])]);
  return walkFrom(fresh, seenNow, [...done, ...attempts]);
};

const walked: Walk = walkFrom([start], new Map([[keyOf(start), start]]), []);

type Taken = Readonly<{ from: World; rule: Rule; before: Ledger; after: Ledger }>;
const taken: readonly Taken[] = walked.attempts.flatMap((a) =>
  (a.outcome.ok ? [{ from: a.from, rule: a.rule, before: a.from.ledger, after: a.outcome.value }] : []));

/** The holds that remain when the i-th is gone: exactly it, none other. */
const without = (l: Ledger, i: bigint): Ledger["holds"] => l.holds.filter((_, at) => BigInt(at) !== i);

const payerSign = (side: Side): bigint => (side === "left" ? -1n : 1n);

/** What each step did, from the formula and not from the ledger's helpers. One row per verb of the page. */
const stepChecks: Readonly<Record<Verb, (t: Taken) => void>> = {
  pay: ({ rule, before, after }) =>
    expect([delta(after) - delta(before), after.collateral, after.holds])
      .toEqual([payerSign(rule.side) * rule.arg, before.collateral, before.holds]),
  credit: ({ before, after }) =>
    expect([delta(after), after.collateral, after.holds]).toEqual([delta(before), before.collateral, before.holds]),
  lock: ({ rule, before, after }) => {
    expect([delta(after), after.collateral, after.holds.length, after.holds.at(-1)?.payer])
      .toEqual([delta(before), before.collateral, before.holds.length + 1, rule.side]);
    expect(after.holds.at(-1)?.hashlock).toBe(hashlockOf(secretOf(Number(rule.arg))));
  },
  resolve: ({ rule, before, after }) => {
    const named = before.holds[Number(rule.arg)] ?? expect.unreachable("resolve of a missing hold");
    expect([delta(after), after.collateral, after.holds])
      .toEqual([delta(before) + payerSign(named.payer) * named.amount, before.collateral, without(before, rule.arg)]);
  },
  expire: ({ rule, before, after }) =>
    expect([delta(after), after.collateral, after.holds])
      .toEqual([delta(before), before.collateral, without(before, rule.arg)]),
  r2c: ({ rule, before, after }) => movesCollateral(rule, before, after, 1n),
  c2r: ({ rule, before, after }) => movesCollateral(rule, before, after, -1n),
};

/** One unit between the payer's reserve and the collateral; a Left deposit is Left's allocation. */
const movesCollateral = (rule: Rule, before: Ledger, after: Ledger, direction: bigint): void => {
  const leftShare = rule.side === "left" ? direction : 0n;
  expect([after.collateral, delta(after), after.holds])
    .toEqual([before.collateral + direction, delta(before) + leftShare, before.holds]);
};

/** r2c is never refused on this page (its guard is the reserve, in `enabled`); the row keeps the table total. */
const refusalTag: Readonly<Record<Verb, AccountFault["_tag"]>> = {
  pay: "insufficient_capacity", credit: "credit_below_usage", lock: "insufficient_capacity",
  resolve: "no_such_hold", expire: "no_such_hold", r2c: "bad_amount", c2r: "settlement_breaks_credit",
};

/** A lock on a hashlock that is open is `lock_exists`, whatever the capacity; any other refusal is the verb's own. */
const expectedRefusal = (a: Attempt): AccountFault["_tag"] =>
  (a.rule.verb === "lock" && a.from.ledger.holds.some((h) => h.hashlock === hashlockOf(secretOf(Number(a.rule.arg))))
    ? "lock_exists"
    : refusalTag[a.rule.verb]);

describe("account/ledger against the Arrival money page", () => {
  test("the walk reaches the page's 1440 states through its 12918 transitions", () => {
    expect([walked.worlds.size, taken.length]).toEqual([1440, 12918]);
  });

  test("R-A6 credit holds in every state: RCPAN in the worst case over the open holds", () => {
    [...walked.worlds.values()].forEach(({ ledger: l }) => {
      expect(delta(l) - heldBy(l, "left")).toBeGreaterThanOrEqual(-l.limit.left);
      expect(delta(l) + heldBy(l, "right")).toBeLessThanOrEqual(l.collateral + l.limit.right);
    });
  });

  test("R-CONSERVE reserves plus collateral never change, and none goes negative", () => {
    [...walked.worlds.values()].forEach((w) => {
      expect(total(w)).toBe(2n * START_RESERVE);
      expect([w.reserve.left, w.reserve.right, w.ledger.collateral].every((n) => n >= 0n)).toBe(true);
    });
  });

  test("every open hold is within its payer's capacity", () => {
    [...walked.worlds.values()].forEach(({ ledger: l }) => {
      expect(heldBy(l, "left")).toBeLessThanOrEqual(delta(l) + l.limit.left);
      expect(heldBy(l, "right")).toBeLessThanOrEqual(l.collateral + l.limit.right - delta(l));
    });
  });

  test("each step does what its verb says and nothing else", () => {
    expect(new Set(taken.map((t) => t.rule.verb)).size).toBe(Object.keys(stepChecks).length);
    taken.forEach((t) => stepChecks[t.rule.verb](t));
  });

  test("every refused attempt names the rule that refuses it", () => {
    const refused = walked.attempts.filter((a) => !a.outcome.ok);
    expect(refused.length).toBeGreaterThan(0);
    refused.forEach((a) => expect(a.outcome.ok ? undefined : a.outcome.error._tag).toBe(expectedRefusal(a)));
  });

  test("R-ONE-LOCK-PER-HASH at most one open clause per hashlock in every state, and a second lock is refused", () => {
    [...walked.worlds.values()].forEach(({ ledger: l }) =>
      expect(new Set(l.holds.map((h) => h.hashlock)).size).toBe(l.holds.length));
    const duplicates = walked.attempts.filter((a) => expectedRefusal(a) === "lock_exists");
    expect(duplicates.length).toBeGreaterThan(0);
    duplicates.forEach((a) => expect(a.outcome.ok).toBe(false));
  });
});
