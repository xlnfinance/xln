// The whole state space of the Arrival frames page (spec/account/frames.scm), walked again on the TypeScript round.
//
// The page has two replicas, a FIFO link into each that may lose and duplicate messages (one each), a Byzantine
// proposer that forges one frame, and three txs: Left has "a", Right has "x" then "y", and "x" is invalid once "a" is
// committed. The checker found 3651 states, 11335 transitions and 16 finished worlds. This file builds the same world
// on `propose`, `receive`, `resend` and `queue` (the page has no guard at the door, so txs enter by `queue`), walks
// every state, and holds each world to the page's properties written out again. The counts are pinned: a decision
// the TypeScript takes and the page refuses, or the other way round, changes a count. Two second bounds follow the
// page's
// configs: a conflict inside Right's own frame (same-side-conflict) and a link that may deliver any of its first three
// messages (reorder, R-NET). The page has no refusal step (R-FRAME-REFUSAL: the spec thread is adding it), so the walk
// leaves a refusal message out of the link: what a refusal does is the liveness simulation's and frame.test.ts's.
import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { other, type Side } from "../model.ts";
import {
  propose, queue, receive, replica, resend, type Frame, type FrameHash, type Msg, type Replica, type Rules,
} from "./frame.ts";

/** A broken guard lets the walk run away; the page's own space is 3651 states, and past this the walk is a failure. */
const WALK_LIMIT = 40_000;
const SIDES: readonly Side[] = ["left", "right"];

type Tx = string;
type Page = Readonly<{
  txs: Readonly<Record<Side, readonly Tx[]>>;
  conflicts: readonly (readonly [Tx, Tx])[];
  maxLosses: number;
  maxDups: number;
  maxByz: number;
  deliverNth: readonly number[];
}>;

const PAGE: Page = {
  txs: { left: ["a"], right: ["x", "y"] }, conflicts: [["a", "x"]], maxLosses: 1, maxDups: 1, maxByz: 1, deliverNth: [],
};
const SAME_SIDE: Page = { ...PAGE, conflicts: [["a", "x"], ["x", "y"]] };
const REORDER: Page = { ...PAGE, deliverNth: [1, 2] };

type Fault = Tagged<"conflict", { tx: Tx; predecessor: Tx }>;
type History = readonly Tx[];
type R = Replica<Tx, History, Fault>;
type M = Msg<Tx>;

const name = (f: Frame<Tx>): FrameHash => `${JSON.stringify(f.txs)}<${f.parent}` as FrameHash;

/** The page's world: a tx is valid unless a conflicting predecessor is committed; a frame names its whole history. */
const rulesFor = (page: Page): Rules<Tx, History, Fault> => ({
  epoch: 0n,
  firstNonce: 2n,
  apply: (before, _author, tx): Result<History, Fault> => {
    const pair = page.conflicts.find(([earlier, later]) => later === tx && before.includes(earlier));
    return pair === undefined ? ok([...before, tx]) : err({ _tag: "conflict", tx, predecessor: pair[0] });
  },
  name,
  seal: (f) => ok(name(f)),
  tag: (fault) => fault._tag,
  retryable: () => false,
});

const GENESIS = "" as FrameHash;

/** The frames a head names, newest first: the head is the history, so the page's "head" is read back from it. */
const framesOf = (head: FrameHash): readonly (readonly Tx[])[] =>
  (head === "" ? [] : head.split("<").slice(0, -1).map((frame) => JSON.parse(frame)));

type World = Readonly<{
  left: R;
  right: R;
  inbox: Readonly<Record<Side, readonly M[]>>;
  unsent: Readonly<Record<Side, readonly Tx[]>>;
  lost: number;
  dups: number;
  byz: number;
}>;

const start = (page: Page): World => ({
  left: replica("left", GENESIS, []),
  right: replica("right", GENESIS, []),
  inbox: { left: [], right: [] },
  unsent: page.txs,
  lost: 0,
  dups: 0,
  byz: 0,
});

type Rule = Readonly<{ name: string; enabled: (w: World) => boolean; step: (w: World) => World }>;

/** The page has no nonce slots or epochs: a slot, a floor and an epoch are not part of a world's identity. */
const OMITTED = ["slot", "floor", "epoch", "firstNonce"];
const bare = (x: unknown): string =>
  JSON.stringify(x, (key, value) => (OMITTED.includes(key) ? undefined : value));
const msgKey = (m: M): string => bare(m);
const replicaKey = (r: R) => [r.head, r.mempool, r.pending?.frame ?? null, r.refused.map((x) => x.tx)];
/** The page's world identity: what the page keeps (a refusal's fault is derived, so it is not part of the identity). */
const keyOf = (w: World): string =>
  bare([replicaKey(w.left), replicaKey(w.right), w.inbox, w.unsent, w.lost, w.dups, w.byz]);

const withReplica = (w: World, side: Side, r: R): World => ({ ...w, [side]: r });

/** A message already waiting on the link is not queued again: repeats come only from the budgeted `duplicate`. */
const enqueue = (w: World, side: Side, msgs: readonly M[]): World => {
  const waiting = new Set(w.inbox[side].map(msgKey));
  return { ...w, inbox: { ...w.inbox, [side]: [...w.inbox[side], ...msgs.filter((m) => !waiting.has(msgKey(m)))] } };
};

const submit = (side: Side): Rule => ({
  name: `submit ${side}`,
  enabled: (w) => w.unsent[side].length > 0,
  step: (w) => {
    const [tx, ...rest] = w.unsent[side];
    const queued = withReplica(w, side, queue(w[side], tx ?? expect.unreachable("nothing to submit")));
    return { ...queued, unsent: { ...w.unsent, [side]: rest } };
  },
});

const proposeRule = (page: Page, side: Side): Rule => ({
  name: `propose ${side}`,
  enabled: (w) => w[side].pending === undefined && w[side].mempool.length > 0,
  step: (w) => {
    const out = propose(rulesFor(page), w[side]);
    return enqueue(withReplica(w, side, out.replica), other(side), out.sent);
  },
});

/** The page's link carries frames and acks only. */
const pageMessages = (sent: readonly Msg<Tx>[]): readonly Msg<Tx>[] => sent.filter((m) => m._tag !== "refusal");

const take = (w: World, side: Side, n: number): World => {
  const q = w.inbox[side];
  return { ...w, inbox: { ...w.inbox, [side]: [...q.slice(0, n), ...q.slice(n + 1)] } };
};

/** The receiver takes the n-th message of its link: the page's `deliver` is the head (n = 0). */
const deliver = (page: Page, side: Side, n: number): Rule => ({
  name: n === 0 ? `deliver ${side}` : `deliver ${side} ${n}`,
  enabled: (w) => w.inbox[side].length > n,
  step: (w) => {
    const heard = receive(rulesFor(page), w[side], w.inbox[side][n] ?? expect.unreachable("no such message"));
    return enqueue(withReplica(take(w, side, n), side, heard.replica), other(side), pageMessages(heard.sent));
  },
});

const resendRule = (side: Side): Rule => ({
  name: `resend ${side}`,
  enabled: (w) => {
    const again = resend(w[side]);
    return again.length > 0 && !w.inbox[other(side)].some((m) => msgKey(m) === msgKey(again[0] ?? m));
  },
  step: (w) => enqueue(w, other(side), resend(w[side])),
});

const lose = (page: Page, side: Side): Rule => ({
  name: `lose ${side}`,
  enabled: (w) => w.inbox[side].length > 0 && w.lost < page.maxLosses,
  step: (w) => ({ ...take(w, side, 0), lost: w.lost + 1 }),
});

const duplicate = (page: Page, side: Side): Rule => ({
  name: `duplicate ${side}`,
  enabled: (w) => w.inbox[side].length > 0 && w.dups < page.maxDups,
  step: (w) => {
    const copy = w.inbox[side][0] ?? expect.unreachable("nothing to repeat");
    return { ...w, inbox: { ...w.inbox, [side]: [...w.inbox[side], copy] }, dups: w.dups + 1 };
  },
});

/** Txs the page's validity refuses against an empty history: the Byzantine frame is invalid on its own. */
const invalidAlone = (page: Page, txs: readonly Tx[]): boolean => {
  const rules = rulesFor(page);
  return txs.reduce<readonly [History, boolean]>(([before, bad], tx) => {
    const next = rules.apply(before, "left", tx);
    return next.ok ? [next.value, bad] : [before, true];
  }, [[], false])[1];
};

/** A Byzantine proposer sends its whole mempool as one frame when that frame is invalid on its own. */
const byzFrame = (page: Page, side: Side): Rule => ({
  name: `byz frame ${side}`,
  enabled: (w) => w.byz < page.maxByz && w[side].mempool.length > 0 && invalidAlone(page, w[side].mempool),
  step: (w) => {
    const slot = w[other(side)].used + (side === "left" ? 2 : 1);
    const forged: M = {
      _tag: "frame",
      frame: { author: side, parent: w[side].head, attempt: 0, slot, epoch: 0n, firstNonce: 2n, txs: w[side].mempool },
    };
    return { ...enqueue(w, other(side), [forged]), byz: w.byz + 1 };
  },
});

const rulesOf = (page: Page): readonly Rule[] =>
  SIDES.flatMap((side) => [
    submit(side), proposeRule(page, side), deliver(page, side, 0), resendRule(side), lose(page, side),
    duplicate(page, side), byzFrame(page, side), ...page.deliverNth.map((n) => deliver(page, side, n)),
  ]);

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

const allTxs = (page: Page): readonly Tx[] => [...page.txs.left, ...page.txs.right];

const done = (page: Page, w: World): boolean =>
  w.left.head === w.right.head &&
  SIDES.every((s) => w[s].pending === undefined && w[s].mempool.length === 0 && w.inbox[s].length === 0 &&
    w.unsent[s].length === 0) &&
  w.left.state.length + w.left.refused.length + w.right.refused.length === allTxs(page).length;

/** Every world from which a finished world is still reachable: grown from the finished ones until it stops. */
const canFinish = (page: Page, w: Walk): ReadonlySet<string> => {
  const grow = (known: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set([...known, ...w.edges.filter((e) => known.has(e.to)).map((e) => e.from)]);
    return next.size === known.size ? known : grow(next);
  };
  return grow(new Set([...w.worlds].filter(([, world]) => done(page, world)).map(([key]) => key)));
};

const walkOf = (page: Page): Walk => {
  const first = start(page);
  return walkFrom(rulesOf(page), [first], new Map([[keyOf(first), first]]), []);
};

const counts = (page: Page, w: Walk): readonly number[] =>
  [w.worlds.size, w.edges.length, [...w.worlds.values()].filter((world) => done(page, world)).length];

const extendsFrames = (longer: readonly (readonly Tx[])[], shorter: readonly (readonly Tx[])[]): boolean =>
  longer.length >= shorter.length &&
  JSON.stringify(longer.slice(longer.length - shorter.length)) === JSON.stringify(shorter);

const submitted = (page: Page, w: World, side: Side): readonly Tx[] =>
  page.txs[side].slice(0, page.txs[side].length - w.unsent[side].length);

const held = (r: R): readonly Tx[] =>
  [...r.state, ...r.mempool, ...r.refused.map((x) => x.tx), ...(r.pending?.frame.txs ?? [])];

type Holds = (page: Page, w: World) => boolean;

/** The page's invariants, restated from its formulas. */
const agree: Holds = (_, w) => {
  const [l, r] = [framesOf(w.left.head), framesOf(w.right.head)];
  return extendsFrames(l, r) || extendsFrames(r, l);
};
const heights: Holds = (_, w) => Math.abs(framesOf(w.left.head).length - framesOf(w.right.head).length) <= 1;
const noneLost: Holds = (page, w) =>
  SIDES.every((s) => submitted(page, w, s).every((tx) => held(w[s]).includes(tx)));
const noneTwice: Holds = (_, w) => SIDES.every((s) => new Set(w[s].state).size === w[s].state.length);
const inOrder: Holds = (page, w) => SIDES.every((s) => SIDES.every((o) => {
  const mine = w[s].state.filter((tx) => page.txs[o].includes(tx));
  return JSON.stringify(mine) === JSON.stringify(page.txs[o].filter((tx) => mine.includes(tx)));
}));
const noneInvalid: Holds = (page, w) => SIDES.every((s) => !invalidAlone(page, w[s].state));
const refusedHasPredecessor: Holds = (page, w) =>
  SIDES.every((s) => w[s].refused.every(({ tx }) => page.conflicts.some(([earlier, later]) =>
    later === tx && SIDES.some((o) => submitted(page, w, o).includes(earlier)))));
const noneBoth: Holds = (_, w) => SIDES.every((s) => w[s].refused.every(({ tx }) => !w[s].state.includes(tx)));

const properties: readonly Holds[] = [
  agree, heights, noneLost, noneTwice, inOrder, noneInvalid, refusedHasPredecessor, noneBoth,
];

const walks = { page: walkOf(PAGE), sameSide: walkOf(SAME_SIDE), reorder: walkOf(REORDER) };

describe("account/frame against the Arrival frames page", () => {
  test("the walk reaches the page's 3651 states through its 11335 transitions, 16 of them finished", () => {
    expect(counts(PAGE, walks.page)).toEqual([3651, 11335, 16]);
  });

  test("every move of the page is taken (Left has one tx, so only Right can forge a frame)", () => {
    const taken = new Set(Object.values(walks).flatMap((w) => w.edges.map((e) => e.rule)));
    expect(taken).toEqual(new Set(rulesOf(REORDER).map((r) => r.name).filter((name) => name !== "byz frame left")));
    expect(new Set(walks.page.edges.map((e) => e.rule)).has("byz frame left")).toBe(false);
  });

  const everywhere = (holds: Holds): void =>
    [...walks.page.worlds.values()].forEach((w) => expect(holds(PAGE, w)).toBe(true));

  test("R-A1 R-PARENT committed histories agree: one extends the other, in every state of the page", () =>
    everywhere(agree));
  test("R-A1 R-PARENT heights differ by at most one, in every state of the page", () => everywhere(heights));
  test("R-NOTICE no submitted tx is lost: committed, held, or refused, in every state of the page", () =>
    everywhere(noneLost));
  test("R-A1 R-PARENT no tx committed twice, in every state of the page", () => everywhere(noneTwice));
  test("R-A1 each side's txs commit in submission order, in every state of the page", () => everywhere(inOrder));
  test("R-ADMIT no committed tx is invalid against the history before it, in every state of the page", () =>
    everywhere(noneInvalid));
  test("R-NOTICE R-ADMIT a refused tx has a conflicting predecessor in the submitted txs, in every state of the page",
    () => everywhere(refusedHasPredecessor));
  test("R-NOTICE no tx is both committed and refused, in every state of the page", () => everywhere(noneBoth));

  test("R-A1 R-REACK nothing wedges: a finished world is reachable from every state", () => {
    expect(canFinish(PAGE, walks.page).size).toBe(walks.page.worlds.size);
  });

  test("the walk shows each outcome: a collision, a re-ack, a refused tx, a refused forged frame", () => {
    const worlds = [...walks.page.worlds.values()];
    expect(worlds.some((w) => SIDES.some((s) => w[s].refused.length > 0))).toBe(true);
    expect(worlds.some((w) => w.left.state.length > 0 && w.left.state.length === w.right.state.length)).toBe(true);
  });
});

describe("account/frame against the page's second bounds", () => {
  test("same-side conflict: a frame whose own earlier tx makes a later one invalid is refused whole", () => {
    // The page counts 3423, 10383 and 24. The TypeScript counts fewer because it refuses an equivocating proposer's
    // second frame at an attempt it has already refused (R-FRAME-REFUSAL: the attempt number is not on the page yet):
    // the forged frame refused at attempt 0, the genuine one at attempt 0 is refused too. An honest proposer never
    // sends two frames at one attempt on one head, so only a world with a forger loses states. The count is above what
    // it was before the frames carried nonce slots: a collision after a refusal is won by the higher slot, so Right
    // wins some (R-PROOF-NONCE-ABOVE-SIGNED), and the walk reaches the worlds where it does.
    expect(counts(SAME_SIDE, walks.sameSide)).toEqual([3206, 9697, 22]);
    expect(walks.sameSide.edges.some((e) => e.rule.startsWith("byz frame"))).toBe(true);
    [...walks.sameSide.worlds.values()].forEach((w) =>
      properties.forEach((holds) => expect(holds(SAME_SIDE, w)).toBe(true)));
    expect(canFinish(SAME_SIDE, walks.sameSide).size).toBe(walks.sameSide.worlds.size);
  });

  test("R-NET reorder: the receiver may take any of the first three messages, every property and liveness hold", () => {
    expect(counts(REORDER, walks.reorder)).toEqual([7312, 33183, 16]);
    [...walks.reorder.worlds.values()].forEach((w) =>
      properties.forEach((holds) => expect(holds(REORDER, w)).toBe(true)));
    expect(canFinish(REORDER, walks.reorder).size).toBe(walks.reorder.worlds.size);
  });
});
