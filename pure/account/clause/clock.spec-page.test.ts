// The whole state space of the Arrival clock page (spec/account/clock.scm), walked again on the TypeScript clauses.
//
// The page has one lock of one unit, a chain that ticks to height 4, and two views of it that only catch up, each at
// most one behind. Left pays, Right is the payee. A frame carries a stamp the proposer writes as it likes. The checker
// found 2730 states, 10546 transitions and 260 finished worlds (the payee holds no secret: 173, 473, 3). This file
// rebuilds the same rules on `Ledger`, `resolveClause` and `expireClause`, walks every state, and holds each world to
// the page's four properties, written out again from the formula. Both walks' counts are pinned: a decision the
// TypeScript takes and the page refuses, or the other way round, changes a count.
//
// A stamp has nowhere to enter: no clause function takes one, so R-CLOCK (no frame refused for its age or its future
// date) holds by the types, and a signed frame's exit is the liveness check below. The pay frame commits the lock with
// the ledger's own `lock`: the page does not model the moment a lock is signed, which is N2 (clause.test.ts).
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { holdOf, secretOf } from "../fixtures.ts";
import { allocation, emptyLedger, lock, setCredit } from "../ledger.ts";
import type { AccountFault, Ledger, Side } from "../model.ts";
import { expireClause, resolveClause } from "./clause.ts";
import { clockParams, revealOnChainDue, type ClockParams } from "./clock.ts";

/** A broken guard lets the walk run away; the page's own space is 2730 states, and past this the walk is a failure. */
const WALK_LIMIT = 20_000;
const DEADLINE = 2n;
const LAG = 1n;
const RESERVE = 1n;
const MAX_JH = 4n;
const MAX_STAMP = 3n;
const SIDES: readonly Side[] = ["left", "right"];
const STAMPS: readonly bigint[] = [0n, 1n, 2n, 3n];

const params: ClockParams = unwrapOr(clockParams(LAG, RESERVE, MAX_JH), () => expect.unreachable("params"));
const secret = secretOf(1);
const theLock = holdOf("left", 1n, 1n, DEADLINE, 1);

type Kind = "pay" | "expire" | "resolve";
type Views = Readonly<Record<Side, bigint>>;
type Frame = Readonly<{ kind: "pay" | "expire"; stamp: bigint }>;
type Refusal = Readonly<{ view: bigint; stamp: bigint }>;

/** The page's world, with the ledger the committed frames built. */
type World = Readonly<{
  jh: bigint;
  view: Views;
  pending: Frame | undefined;
  committed: readonly Kind[];
  expiredViews: Views | undefined;
  revealed: boolean;
  resolvePending: bigint | undefined;
  resolveRefusals: readonly Refusal[];
  ledger: Ledger;
}>;

type Rule = Readonly<{ name: string; enabled: (w: World) => boolean; step: (w: World) => World }>;

/** Left may draw one unit of credit from Right, which is what the lock holds. */
const credited: Ledger = unwrapOr(setCredit(emptyLedger, "right", 1n), () => expect.unreachable("credit"));

const start: World = {
  jh: 0n, view: { left: 0n, right: 0n }, pending: undefined, committed: [], expiredViews: undefined, revealed: false,
  resolvePending: undefined, resolveRefusals: [], ledger: credited,
};

const committedIs = (w: World, ...kinds: readonly Kind[]): boolean =>
  w.committed.length === kinds.length && kinds.every((k, i) => w.committed[i] === k);

const settled = (w: World): boolean => committedIs(w, "pay", "expire") || committedIs(w, "pay", "resolve");

const keyOf = (w: World): string => JSON.stringify(w, (_, v) => (typeof v === "bigint" ? `${v}n` : v));

const faulted = (fault: AccountFault): never => expect.unreachable(`unexpected refusal: ${fault._tag}`);

const commit = (w: World, kind: Kind, ledger: Ledger): World =>
  ({ ...w, committed: [...w.committed, kind], ledger });

/** Who holds the secret: the page's `payee-knows-secret`, and its no-secret bound. */
type Payee = Readonly<{ knowsSecret: boolean }>;

/** The payee owes the on-chain reveal: it holds the secret, its resolve is uncommitted, its view nears the deadline. */
const payeeDuty = (payee: Payee, w: World): boolean =>
  payee.knowsSecret && committedIs(w, "pay") && !w.revealed && revealOnChainDue(params, DEADLINE, w.view.right);

const tickChain = (payee: Payee): Rule => ({
  name: "chain height ticks",
  enabled: (w) => w.jh < MAX_JH && !payeeDuty(payee, w) && SIDES.every((s) => w.jh + 1n - w.view[s] <= LAG),
  step: (w) => ({ ...w, jh: w.jh + 1n }),
});

const viewTick = (side: Side): Rule => ({
  name: `${side} view catches up`,
  enabled: (w) => w.view[side] < w.jh,
  step: (w) => ({ ...w, view: { ...w.view, [side]: w.view[side] + 1n } }),
});

const payeeReveals = (payee: Payee): Rule => ({
  name: "payee reveals the secret on-chain",
  enabled: (w) => payeeDuty(payee, w),
  step: (w) => ({ ...w, revealed: true }),
});

const proposeResolve = (payee: Payee, stamp: bigint): Rule => ({
  name: `Right proposes a resolve stamped ${stamp}`,
  enabled: (w) => payee.knowsSecret && committedIs(w, "pay") && w.resolvePending === undefined,
  step: (w) => ({ ...w, resolvePending: stamp }),
});

const proposeFrame = (kind: Frame["kind"], stamp: bigint): Rule => ({
  name: `Left proposes ${kind} stamped ${stamp}`,
  enabled: (w) => w.pending === undefined && (kind === "pay" ? w.committed.length === 0 : committedIs(w, "pay")),
  step: (w) => ({ ...w, pending: { kind, stamp } }),
});

/** Left decides Right's resolve on its own view: refused only by the clause's deadline, and only on that. */
const deliverResolve: Rule = {
  name: "Left decides the resolve",
  enabled: (w) => w.resolvePending !== undefined,
  step: (w) => {
    const stamp = w.resolvePending ?? expect.unreachable("no resolve in flight");
    const cleared: World = { ...w, resolvePending: undefined };
    const decided = resolveClause(w.ledger, w.view.left, "right", theLock.id, secret);
    if (decided.ok) return commit(cleared, "resolve", decided.value);
    if (decided.error._tag === "no_such_lock") return cleared;
    if (decided.error._tag !== "past_deadline") return faulted(decided.error);
    const refusal: Refusal = { view: w.view.left, stamp };
    const seen = w.resolveRefusals.some((r) => r.view === refusal.view && r.stamp === refusal.stamp);
    return { ...cleared, resolveRefusals: seen ? w.resolveRefusals : [...w.resolveRefusals, refusal] };
  },
};

/** Right decides the pending frame on its content and its own view: the stamp is not an input. */
const deliver = (payee: Payee): Rule => ({
  name: "Right decides the pending frame",
  enabled: (w) => w.pending !== undefined,
  step: (w) => {
    const frame = w.pending ?? expect.unreachable("no frame in flight");
    const cleared: World = { ...w, pending: undefined };
    if (frame.kind === "pay") return commit(cleared, "pay", unwrapOr(lock(w.ledger, theLock), faulted));
    const expired = expireClause(w.ledger, params, w.view.right, theLock.id);
    if (expired.ok && !payeeDuty(payee, w)) {
      return { ...commit(cleared, "expire", expired.value), expiredViews: { ...w.view } };
    }
    return cleared;
  },
});

const rulesFor = (payee: Payee): readonly Rule[] => [
  tickChain(payee), ...SIDES.map(viewTick), payeeReveals(payee), deliver(payee), deliverResolve,
  ...STAMPS.flatMap((s) => [proposeFrame("pay", s), proposeFrame("expire", s)]),
  proposeResolve(payee, 0n), proposeResolve(payee, MAX_STAMP),
];

type Edge = Readonly<{ from: string; to: string; rule: string }>;
type Walk = Readonly<{ worlds: ReadonlyMap<string, World>; edges: readonly Edge[] }>;

const walkFrom = (
  rules: readonly Rule[], frontier: readonly World[], seen: ReadonlyMap<string, World>, edges: readonly Edge[],
): Walk => {
  if (frontier.length === 0 || seen.size > WALK_LIMIT) return { worlds: seen, edges };
  const moves = frontier.flatMap((w) =>
    rules.filter((r) => r.enabled(w)).map((r) => ({ rule: r.name, from: keyOf(w), next: r.step(w) })));
  const unseen = moves.filter((m) => !seen.has(keyOf(m.next)));
  const fresh = [...new Map(unseen.map((m) => [keyOf(m.next), m.next])).values()];
  const seenNow = new Map([...seen, ...fresh.map((w): [string, World] => [keyOf(w), w])]);
  const taken = moves.map((m): Edge => ({ from: m.from, to: keyOf(m.next), rule: m.rule }));
  return walkFrom(rules, fresh, seenNow, [...edges, ...taken]);
};

const walk = (payee: Payee): Walk => walkFrom(rulesFor(payee), [start], new Map([[keyOf(start), start]]), []);

/** Every world from which a finished world is still reachable: grown from the finished ones until it stops. */
const canFinish = (w: Walk): ReadonlySet<string> => {
  const grow = (known: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set([...known, ...w.edges.filter((e) => known.has(e.to)).map((e) => e.from)]);
    return next.size === known.size ? known : grow(next);
  };
  return grow(new Set([...w.worlds].filter(([, world]) => settled(world)).map(([key]) => key)));
};

const withSecret = walk({ knowsSecret: true });
const withoutSecret = walk({ knowsSecret: false });
const ruleNames = rulesFor({ knowsSecret: true }).map((r) => r.name);

const counts = (w: Walk): readonly number[] =>
  [w.worlds.size, w.edges.length, [...w.worlds.values()].filter(settled).length];

/** What the committed frames must have built: the page keeps only the frames, the ledger is what they did. */
const ledgerFor = (w: World): Ledger => {
  if (committedIs(w, "pay")) return { ...credited, holds: [theLock] };
  if (committedIs(w, "pay", "expire")) return credited;
  if (committedIs(w, "pay", "resolve")) return { ...credited, offdelta: -1n };
  return credited;
};

describe("account/clause against the Arrival clock page", () => {
  test("the walk reaches the page's 2730 states through its 10546 transitions, 260 of them finished", () => {
    expect(counts(withSecret)).toEqual([2730, 10546, 260]);
  });

  test("the payee that holds no secret reaches the page's 173 states through 473 transitions, 3 finished", () => {
    expect(counts(withoutSecret)).toEqual([173, 473, 3]);
  });

  test("every move of the page is taken in the walk where the payee holds the secret", () => {
    expect(new Set(withSecret.edges.map((e) => e.rule))).toEqual(new Set(ruleNames));
  });

  test("the walk finishes in both ways, and a resolve is refused somewhere", () => {
    const worlds = [...withSecret.worlds.values()];
    expect(worlds.some((w) => committedIs(w, "pay", "expire"))).toBe(true);
    expect(worlds.some((w) => committedIs(w, "pay", "resolve"))).toBe(true);
    expect(worlds.some((w) => w.resolveRefusals.length > 0)).toBe(true);
  });

  test("R-CLOCK a signed frame has an exit: from every world a finished world is still reachable", () => {
    [withSecret, withoutSecret].forEach((w) => expect(canFinish(w).size).toBe(w.worlds.size));
  });

  test("R-HTLC-CLOCK b an expiry commits only when both parties' views are strictly past the deadline", () => {
    [...withSecret.worlds.values()].forEach((w) => {
      if (w.expiredViews !== undefined) {
        expect(w.expiredViews.left).toBeGreaterThan(DEADLINE);
        expect(w.expiredViews.right).toBeGreaterThan(DEADLINE);
      }
    });
  });

  test("R-HTLC-CLOCK a a resolve is refused only when the payer's own view is past the deadline", () => {
    [...withSecret.worlds.values()].forEach((w) =>
      w.resolveRefusals.forEach((r) => expect(r.view).toBeGreaterThan(DEADLINE)));
  });

  test("R-HTLC-CLOCK c a payee that holds the secret has revealed it on chain before an expiry commits", () => {
    [...withSecret.worlds.values()].forEach((w) => {
      if (w.expiredViews !== undefined) expect(w.revealed).toBe(true);
    });
  });

  test("the ledger is what the committed frames built: one hold while open, none after, paid only on a resolve", () => {
    [withSecret, withoutSecret].forEach((walked) =>
      [...walked.worlds.values()].forEach((w) => {
        expect(w.ledger).toEqual(ledgerFor(w));
        expect(allocation(w.ledger)).toBe(committedIs(w, "pay", "resolve") ? -1n : 0n);
      }));
  });

  test("the views never pass the chain and never trail it by more than LAG", () => {
    [...withSecret.worlds.values()].forEach((w) => SIDES.forEach((s) => {
      expect(w.view[s]).toBeLessThanOrEqual(w.jh);
      expect(w.view[s]).toBeGreaterThanOrEqual(w.jh - LAG);
    }));
  });
});
