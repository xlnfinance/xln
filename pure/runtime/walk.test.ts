// Two Runtimes, Alice's and Bob's, walked through every order their Hosts and the link between them can take, until no
// world is new. The link keeps the order of what it carries and may deliver a message twice; a Host may crash between
// any two of apply, commit and flush; a timer resends a pending frame once nothing else can move. Alice and Bob open an
// Account, Bob extends 100 of credit, and Alice pays 30 when she has seen the credit commit. In every world nothing has
// halted, nothing on the link is an output no WAL holds, a replay of each WAL makes the entities it holds, and equal
// heads mean equal states; every world nothing can leave is the finished one, and a finished world is reachable.
// The bugs planted in `Ops` and in the timer must each turn one of those red.
import { describe, expect, test } from "bun:test";
import { ledgerOf } from "../account/state.ts";
import { credit, entityOf, GOLD, open, pay } from "../entity/fixtures.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type EntityState, type Outbound,
} from "../entity/model.ts";
import type { Msg } from "../account/frame/frame.ts";
import type { AccountTx } from "../account/tx.ts";
import type { Halt, Input, Row, Runtime } from "./model.ts";
import { apply, commit, flush, messageId, recover, startRuntime } from "./tick.ts";
import { setup, stamp } from "./fixtures.ts";
import type { Result } from "../kernel/core/result.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const NAMES = ["alice", "bob"] as const;
type Name = (typeof NAMES)[number];

const ID: Readonly<Record<Name, EntityId>> = { alice: ALICE, bob: BOB };
const PEER: Readonly<Record<Name, Name>> = { alice: "bob", bob: "alice" };

/** A WAL this long is a Runtime that has looped: the walk is finite only if the timer's budget is. */
const WALK_LIMIT = 200_000;
const MAX_RESENDS = 1;

/** Hosts that make a handful of outputs and repeat them at most once each leave a link far shorter than this. */
const LINK_LIMIT = 12;

/** How much the adversary may do in one walk: crashes per Host, and repeats of a message on the link. */
type Bounds = Readonly<{ crashes: number; dups: number }>;

const CRASHING: Bounds = { crashes: 1, dups: 0 };
const REPEATING: Bounds = { crashes: 0, dups: 1 };

type Where = "script" | "link" | "timer";

/** One Host: its Runtime, how far through its script it has committed, and where its staged frame came from. */
type Host = Readonly<{
  runtime: Runtime; committed: number; staged: Where | undefined; crashes: number; resends: number;
}>;

type World = Readonly<{
  hosts: Readonly<Record<Name, Host>>;
  link: Readonly<Record<Name, readonly Msg<AccountTx>[]>>;
  dups: number;
  halts: readonly string[];
}>;

type Step = Readonly<{ command: Command; ready: (host: Host) => boolean }>;

const accountOf = (host: Host, name: Name) =>
  host.runtime.entities.get(ID[name])?.accounts.get(ID[PEER[name]]);

const sawCredit = (name: Name) => (host: Host): boolean => {
  const state = accountOf(host, name)?.state;
  return state !== undefined && ledgerOf(state, GOLD).limit.left >= 100n;
};

const always = (): boolean => ALWAYS;

const ALWAYS = true;
const SCRIPT: Readonly<Record<Name, readonly Step[]>> = {
  alice: [{ command: open(BOB), ready: always }, { command: pay(BOB, 30n), ready: sawCredit("alice") }],
  bob: [{ command: open(ALICE), ready: always }, { command: credit(ALICE, 100n), ready: always }],
};

/** The Runtime's operations, so that a planted bug can replace one. */
type Ops = Readonly<{
  apply: typeof apply;
  commit: typeof commit;
  flush: (rt: Runtime) => Readonly<{ runtime: Runtime; leaving: readonly Outbound[] }>;
  recover: typeof recover;
}>;

const REAL: Ops = { apply, commit, flush, recover };

const genesis = (name: Name): readonly EntityState[] => [emptyEntity(ID[name])];

const startHost = (name: Name): Host =>
  ({ runtime: startRuntime(setup, genesis(name)), committed: 0, staged: undefined, crashes: 0, resends: 0 });

const START: World = {
  hosts: { alice: startHost("alice"), bob: startHost("bob") }, link: { alice: [], bob: [] }, dups: 0, halts: [],
};

const withHost = (w: World, name: Name, host: Host): World => ({ ...w, hosts: { ...w.hosts, [name]: host } });

const withLink = (w: World, name: Name, msgs: readonly Msg<AccountTx>[]): World =>
  ({ ...w, link: { ...w.link, [name]: msgs } });

const halted = (w: World, halt: Halt): World => ({ ...w, halts: [...w.halts, halt._tag] });

/** The result of an operation, or the world with the Halt it hit: a walk with a halt in it is red. */
const through = <T>(w: World, r: Result<T, Halt>, next: (value: T) => World): World =>
  (r.ok ? next(r.value) : halted(w, r.error));

type Kind = "progress" | "adversary" | "timer";
type Rule = Readonly<{ name: string; kind: Kind; enabled: (w: World) => boolean; step: (w: World) => World }>;

const idle = (h: Host): boolean => h.staged === undefined;

/** The Host's input to `name`'s Runtime: its frame number is the stamp, so a world needs no clock of its own. */
const inputOf = (w: World, name: Name, inputs: readonly EntityInput[]): Input =>
  ({ at: stamp(BigInt(w.hosts[name].runtime.wal.length) + 1n), to: ID[name], inputs });

const fromPeer = (name: Name, msg: Msg<AccountTx>): EntityInput =>
  ({ _tag: "peer_message", from: ID[PEER[name]], msg });

const feed = (ops: Ops, w: World, name: Name, where: Where, input: Input): World =>
  through(w, ops.apply(w.hosts[name].runtime, input), (runtime) =>
    withHost(w, name, { ...w.hosts[name], runtime, staged: where }));

/** The next step of `name`'s script, as a list: empty once the script is done. */
const dueStep = (w: World, name: Name): readonly Step[] => SCRIPT[name].slice(w.hosts[name].committed).slice(0, 1);

const feedScript = (ops: Ops, name: Name): Rule => ({
  name: `${name} takes its next command`,
  kind: "progress",
  enabled: (w) => idle(w.hosts[name]) && dueStep(w, name).some((step) => step.ready(w.hosts[name])),
  step: (w) => feed(ops, w, name, "script", inputOf(w, name, dueStep(w, name).map((step) => step.command))),
});

const feedLink = (ops: Ops, name: Name): Rule => ({
  name: `${name} takes the next message off the link`,
  kind: "progress",
  enabled: (w) => idle(w.hosts[name]) && w.link[name].length > 0,
  step: (w) => feed(ops, w, name, "link", inputOf(w, name, w.link[name].slice(0, 1).map((msg) => fromPeer(name, msg)))),
});

/** The Host has made the staged frame durable; the input it came from is consumed only now. */
const commitRule = (ops: Ops, name: Name): Rule => ({
  name: `${name} commits its staged frame`,
  kind: "progress",
  enabled: (w) => !idle(w.hosts[name]),
  step: (w) => {
    const host = w.hosts[name];
    return through(w, ops.commit(host.runtime), (runtime) => {
      const committed = host.committed + (host.staged === "script" ? 1 : 0);
      const link = host.staged === "link" ? w.link[name].slice(1) : w.link[name];
      return withLink(withHost(w, name, { ...host, runtime, staged: undefined, committed }), name, link);
    });
  },
});

const flushRule = (ops: Ops, name: Name): Rule => ({
  name: `${name} flushes`,
  kind: "progress",
  enabled: (w) => !idle(w.hosts[name]) || w.hosts[name].runtime.sent < w.hosts[name].runtime.wal.length,
  step: (w) => {
    const flushed = ops.flush(w.hosts[name].runtime);
    const to = PEER[name];
    const sent = flushed.leaving.map((o) => o.msg);
    return withLink(withHost(w, name, { ...w.hosts[name], runtime: flushed.runtime }), to, [...w.link[to], ...sent]);
  },
});

const crashRule = (ops: Ops, bounds: Bounds, name: Name): Rule => ({
  name: `${name} crashes and recovers`,
  kind: "adversary",
  enabled: (w) => w.hosts[name].crashes < bounds.crashes,
  step: (w) => {
    const host = w.hosts[name];
    return through(w, ops.recover(setup, genesis(name), host.runtime.wal), (runtime) =>
      withHost(w, name, { ...host, runtime, staged: undefined, crashes: host.crashes + 1 }));
  },
});

const duplicateRule = (bounds: Bounds, name: Name): Rule => ({
  name: `the link to ${name} repeats its first message`,
  kind: "adversary",
  enabled: (w) => w.dups < bounds.dups && w.link[name].length > 0,
  step: (w) => ({ ...withLink(w, name, [...w.link[name].slice(0, 1), ...w.link[name]]), dups: w.dups + 1 }),
});

const pendingTo = (host: Host, name: Name): boolean => accountOf(host, name)?.pending !== undefined;

/** The timer of a pending frame: it runs out only when nothing else can move, and only while nothing is in flight. */
const resendRule = (ops: Ops, name: Name): Rule => ({
  name: `${name}'s timer resends its pending frame`,
  kind: "timer",
  enabled: (w) => idle(w.hosts[name]) && pendingTo(w.hosts[name], name) && w.link[PEER[name]].length === 0 &&
    w.hosts[name].resends < MAX_RESENDS,
  step: (w) => {
    const due: EntityInput = { _tag: "resend_due", peer: ID[PEER[name]] };
    const fed = feed(ops, w, name, "timer", inputOf(w, name, [due]));
    return withHost(fed, name, { ...fed.hosts[name], resends: w.hosts[name].resends + 1 });
  },
});

type Options = Readonly<{ ops: Ops; bounds: Bounds; timers: boolean }>;

const rulesOf = ({ ops, bounds, timers }: Options): readonly Rule[] =>
  NAMES.flatMap((name) => [
    feedScript(ops, name), feedLink(ops, name), commitRule(ops, name), flushRule(ops, name),
    crashRule(ops, bounds, name), duplicateRule(bounds, name), ...(timers ? [resendRule(ops, name)] : []),
  ]);

/** The moves a world has: progress and adversary moves always, a timer only when no progress move is left. */
const enabledIn = (rules: readonly Rule[], w: World): readonly Rule[] => {
  const live = rules.filter((r) => r.enabled(w));
  const progress = live.some((r) => r.kind === "progress");
  return live.filter((r) => r.kind !== "timer" || !progress);
};

const atRest = (rules: readonly Rule[], w: World): boolean =>
  enabledIn(rules, w).every((r) => r.kind === "adversary");

// ---- what a world is, written out so that two worlds are equal when their keys are

const plain = (_key: string, v: unknown): unknown => {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Map) return { map: [...v] };
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
};

const canon = (x: unknown): string => JSON.stringify(x, plain);

// ---- the properties

const outputKeys = (h: Host): ReadonlySet<string> =>
  new Set(h.runtime.wal.flatMap((row: Row) => row.outputs).map((o) => messageId(o.msg)));

/** A message on the link into `to` was written by its peer, and must be an output of a row its peer's WAL holds. */
const leaked = (w: World): readonly string[] =>
  NAMES.flatMap((to) => {
    const written = outputKeys(w.hosts[PEER[to]]);
    return w.link[to].filter((m) => !written.has(messageId(m))).map(() => `${to}'s link holds an output no WAL has`);
  });

const unrecovered = (ops: Ops, w: World): readonly string[] =>
  NAMES.filter((n) => idle(w.hosts[n])).flatMap((n) => {
    const again = ops.recover(setup, genesis(n), w.hosts[n].runtime.wal);
    return again.ok && canon(again.value.entities) === canon(w.hosts[n].runtime.entities)
      ? []
      : [`${n}'s WAL does not replay to the entities it holds`];
  });

const inOrder = (row: Row, i: number, rows: readonly Row[]): boolean => {
  const before = rows[i - 1];
  return row.height === BigInt(i) + 1n && (before === undefined || before.stamp <= row.stamp);
};

const walRows = (h: Host): readonly string[] =>
  h.runtime.wal.filter((row, i, rows) => !inOrder(row, i, rows)).map(() => "WAL out of order");

const equalHeadsMeanEqualStates = (w: World): readonly string[] => {
  const a = accountOf(w.hosts.alice, "alice");
  const b = accountOf(w.hosts.bob, "bob");
  return a !== undefined && b !== undefined && a.head === b.head && canon(a.state) !== canon(b.state)
    ? ["equal heads, different states"]
    : [];
};

/** RCPAN with no open hold: Left's allocation stays in [-limit.left, collateral + limit.right] (spec money/ledger). */
const withinCredit = (name: Name, w: World): readonly string[] => {
  const state = accountOf(w.hosts[name], name)?.state;
  const l = state === undefined ? undefined : ledgerOf(state, GOLD);
  const delta = l === undefined ? 0n : l.ondelta + l.offdelta;
  const inside = l === undefined || (delta >= -l.limit.left && delta <= l.collateral + l.limit.right);
  return inside ? [] : [`${name}'s Account is outside its credit`];
};

const flooded = (w: World): readonly string[] =>
  NAMES.filter((to) => w.link[to].length > LINK_LIMIT).map((to) => `the link to ${to} grows without bound`);

const violations = (ops: Ops, w: World): readonly string[] => [
  ...w.halts.map((h) => `halted: ${h}`),
  ...leaked(w),
  ...flooded(w),
  ...unrecovered(ops, w),
  ...NAMES.flatMap((n) => walRows(w.hosts[n])),
  ...equalHeadsMeanEqualStates(w),
  ...NAMES.flatMap((n) => withinCredit(n, w)),
];

const finished = (w: World): boolean => {
  const a = accountOf(w.hosts.alice, "alice");
  const b = accountOf(w.hosts.bob, "bob");
  const settled = NAMES.every((n) => {
    const h = w.hosts[n];
    return idle(h) && h.committed === SCRIPT[n].length && h.runtime.sent === h.runtime.wal.length &&
      w.link[n].length === 0 && accountOf(h, n)?.pending === undefined && accountOf(h, n)?.mempool.length === 0;
  });
  const ledger = a === undefined ? undefined : ledgerOf(a.state, GOLD);
  return settled && a !== undefined && b !== undefined && a.head === b.head && canon(a.state) === canon(b.state) &&
    ledger?.offdelta === -30n && ledger.limit.left === 100n;
};

// ---- the walk

const NOT_FINISHED = "at rest and not finished";
type Found = Readonly<{ text: string; world: World }>;
type Walk = Readonly<{ worlds: number; atRest: number; finished: number; found: readonly Found[] }>;

type Frontier = Readonly<{ ops: Ops; rules: readonly Rule[]; worlds: readonly World[]; seen: ReadonlySet<string> }>;

/** A walk ends when no world is new, past its limit, or at the first violation (a planted bug needs no more). */
const walkFrom = ({ ops, rules, worlds: frontier, seen }: Frontier, acc: Walk): Walk => {
  if (frontier.length === 0 || seen.size > WALK_LIMIT || acc.found.length > 0) return { ...acc, worlds: seen.size };
  const next = frontier.filter((w) => w.halts.length === 0).flatMap((w) => enabledIn(rules, w).map((r) => r.step(w)));
  const fresh = [...new Map(next.map((w) => [canon(w), w] as const).filter(([k]) => !seen.has(k))).values()];
  const resting = frontier.filter((w) => atRest(rules, w));
  const bad = fresh.flatMap((w) => violations(ops, w).map((text): Found => ({ text, world: w })));
  const stuck = resting.filter((w) => !finished(w)).map((world): Found => ({ text: NOT_FINISHED, world }));
  const grown: Walk = {
    ...acc,
    atRest: acc.atRest + resting.length,
    finished: acc.finished + resting.filter(finished).length,
    found: [...acc.found, ...bad, ...stuck],
  };
  return walkFrom({ ops, rules, worlds: fresh, seen: new Set([...seen, ...fresh.map(canon)]) }, grown);
};

const walk = (options: Options): Walk => {
  const first: Frontier = { ops: options.ops, rules: rulesOf(options), worlds: [START], seen: new Set([canon(START)]) };
  return walkFrom(first, { worlds: 0, atRest: 0, finished: 0, found: [] });
};

const texts = (w: Walk): readonly string[] => [...new Set(w.found.map((f) => f.text))];

const REAL_OPTIONS: Options = { ops: REAL, bounds: CRASHING, timers: true };

describe("runtime/walk Alice and Bob open an Account and Alice pays", () => {
  const crashing = walk(REAL_OPTIONS);
  const repeating = walk({ ...REAL_OPTIONS, bounds: REPEATING });

  test("R-DURABLE R-X1 in every world: no halt, no leak, every WAL replays, equal heads mean equal states", () => {
    expect(texts(crashing)).toEqual([]);
    expect(texts(repeating)).toEqual([]);
  });

  test("R-DURABLE every world nothing can move in is the finished one, and a finished world is reached", () => {
    [crashing, repeating].forEach((w) => {
      expect(w.atRest).toBeGreaterThan(0);
      expect(w.finished).toBe(w.atRest);
    });
  });

  test("R-DURABLE the walk is not trivial: it covers crashes, repeats and resends, and ends before its limit", () => {
    expect(crashing.worlds).toBeGreaterThan(5000);
    expect(repeating.worlds).toBeGreaterThan(500);
    expect(Math.max(crashing.worlds, repeating.worlds)).toBeLessThan(WALK_LIMIT);
  });

  test("R-DURABLE planted bug: a flush that lets a staged frame's outputs leave is caught", () => {
    const leak: Ops = { ...REAL, flush: (rt) => {
      const flushed = flush(rt);
      return { ...flushed, leaving: [...flushed.leaving, ...(rt.staged?.outputs ?? [])] };
    } };
    expect(texts(walk({ ...REAL_OPTIONS, ops: leak }))).toContain("alice's link holds an output no WAL has");
  });

  test("R-DURABLE planted bug: a flush that never marks its rows sent repeats them without end", () => {
    const repeating: Ops = { ...REAL, flush: (rt) => ({ ...flush(rt), runtime: rt }) };
    expect(texts(walk({ ...REAL_OPTIONS, ops: repeating })).join()).toContain("grows without bound");
  });

  test("R-DURABLE planted bug: a recovery that forgets the last row is caught", () => {
    const forgetful: Ops = { ...REAL, recover: (s, g, wal) => recover(s, g, wal.slice(0, -1)) };
    const found = texts(walk({ ...REAL_OPTIONS, ops: forgetful }));
    expect(found).toContain("alice's WAL does not replay to the entities it holds");
  });

  test("R-NET planted bug: with no timer, a frame refused before its peer opened wedges", () => {
    expect(texts(walk({ ...REAL_OPTIONS, timers: false }))).toContain(NOT_FINISHED);
  });
});
