// Two Hosts, each with a Runtime and a durable WAL of its own, over a link that loses, repeats and reorders, with
// random commands (open, credit, pay), random timers, random crashes (the staged row is lost, the Runtime comes back
// from its WAL alone and believes nothing was sent) and frames that carry several inputs at once. The Hosts' stamps
// jump about. After every step: the two heads lie on one chain of frames, equal heads mean equal states, RCPAN holds,
// nothing on the link is an output no WAL holds, every idle Host's WAL replays to the entities it holds, and the rows'
// stamps never go back. After the random phase the adversary stops, both Hosts open their Account if they have not,
// and every run must settle: one head, nothing pending or queued, and the money the Account ended with equal to the
// payments each Host was told were taken, less the ones it was told were refused (R-NOTICE, R-DURABLE, R-X1, R-NET).
// SEEDX picks the seed, RUNS and STEPS the size; the planted bugs at the end must each turn the explorer red.
import { describe, expect, test } from "bun:test";
import { draw } from "../account/fixtures.ts";
import { frameName } from "../account/frame/account.ts";
import type { Msg } from "../account/frame/frame.ts";
import { ledgerOf } from "../account/state.ts";
import type { AccountTx } from "../account/tx.ts";
import { GOLD, entityOf } from "../entity/fixtures.ts";
import { emptyEntity, type Command, type EntityId, type EntityInput } from "../entity/model.ts";
import type { Result } from "../kernel/core/result.ts";
import type { Halt, Input, Row, Runtime } from "./model.ts";
import { apply, commit, flush, messageId, recover, startRuntime } from "./tick.ts";
import { setup, stamp } from "./fixtures.ts";

const NAMES = ["alice", "bob"] as const;
type Name = (typeof NAMES)[number];
const ID: Readonly<Record<Name, EntityId>> = { alice: entityOf(1), bob: entityOf(2) };
const PEER: Readonly<Record<Name, Name>> = { alice: "bob", bob: "alice" };

type Source = "command" | "link" | "timer";
type Host = Readonly<{ runtime: Runtime; staged: Source | undefined; ingress: readonly number[] }>;
type Flight = Readonly<{ id: number; to: Name; msg: Msg<AccountTx> }>;
type World = Readonly<{
  hosts: Readonly<Record<Name, Host>>; net: readonly Flight[]; halts: readonly string[]; seq: number;
}>;

/** What the Runtime does for a Host: a planted bug replaces one of these. */
type Ops = Readonly<{ apply: typeof apply; commit: typeof commit; flush: typeof flush; recover: typeof recover }>;

const REAL: Ops = { apply, commit, flush, recover };

type Weather = Readonly<{ link: "reliable" | "lossy"; crashes: "never" | "sometimes" }>;

const startHost = (name: Name): Host =>
  ({ runtime: startRuntime(setup, [emptyEntity(ID[name])]), staged: undefined, ingress: [] });

const START: World = { hosts: { alice: startHost("alice"), bob: startHost("bob") }, net: [], halts: [], seq: 0 };

const withHost = (w: World, name: Name, host: Host): World => ({ ...w, hosts: { ...w.hosts, [name]: host } });

const through = <T>(w: World, r: Result<T, Halt>, next: (v: T) => World): World =>
  (r.ok ? next(r.value) : { ...w, halts: [...w.halts, r.error._tag] });

const accountOf = (w: World, name: Name) =>
  w.hosts[name].runtime.entities.get(ID[name])?.accounts.get(ID[PEER[name]]);

/** The Host's clock is not monotone: stamps jump about, and the Runtime keeps its own from going back. */
const inputOf = (w: World, name: Name, inputs: readonly EntityInput[]): Input =>
  ({ _tag: "entity", at: stamp(BigInt((w.hosts[name].runtime.wal.length * 37) % 101)), to: ID[name], inputs });

const idle = (h: Host): boolean => h.staged === undefined;

const feed = (ops: Ops, w: World, name: Name, source: Source, ingress: readonly number[], input: Input): World =>
  through(w, ops.apply(w.hosts[name].runtime, input), (runtime) =>
    withHost(w, name, { runtime, staged: source, ingress }));

/** The Host made its staged frame durable: what the frame took off the link is gone from it now. */
const commitHost = (ops: Ops, w: World, name: Name): World => {
  const host = w.hosts[name];
  return through(w, ops.commit(host.runtime), (runtime) => {
    const net = w.net.filter((f) => !host.ingress.includes(f.id));
    return { ...withHost(w, name, { runtime, staged: undefined, ingress: [] }), net };
  });
};

const flushHost = (ops: Ops, w: World, name: Name): World => {
  const flushed = ops.flush(w.hosts[name].runtime);
  const sent = flushed.leaving.map((o, i): Flight => ({ id: w.seq + i, to: PEER[name], msg: o.msg }));
  const host = { ...w.hosts[name], runtime: flushed.runtime };
  return { ...withHost(w, name, host), net: [...w.net, ...sent], seq: w.seq + sent.length };
};

const crashHost = (ops: Ops, w: World, name: Name): World =>
  through(w, ops.recover(setup, [emptyEntity(ID[name])], w.hosts[name].runtime.wal), (runtime) =>
    withHost(w, name, { runtime, staged: undefined, ingress: [] }));

// ---- what a world must satisfy at every step

const replacer = (_key: string, v: unknown): unknown => {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Map) return { map: [...v] };
  return v instanceof Uint8Array ? Array.from(v) : v;
};

const canon = (x: unknown): string => JSON.stringify(x, replacer);

const written = (h: Host): ReadonlySet<string> =>
  new Set(h.runtime.wal.flatMap((row: Row) => row.outputs).map((o) => messageId(o.msg)));

const leaks = (w: World): readonly string[] =>
  w.net
    .filter((f) => !written(w.hosts[PEER[f.to]]).has(messageId(f.msg)))
    .map(() => "an output no WAL holds is on the link");

const replays = (ops: Ops, w: World): readonly string[] =>
  NAMES.filter((n) => idle(w.hosts[n])).flatMap((n) => {
    const again = ops.recover(setup, [emptyEntity(ID[n])], w.hosts[n].runtime.wal);
    const same = again.ok && canon(again.value.entities) === canon(w.hosts[n].runtime.entities);
    return same ? [] : [`${n}'s WAL does not replay to the entities it holds`];
  });

const equalHeads = (w: World): readonly string[] => {
  const a = accountOf(w, "alice");
  const b = accountOf(w, "bob");
  const differ = a !== undefined && b !== undefined && a.head === b.head && canon(a.state) !== canon(b.state);
  return differ ? ["equal heads, different states"] : [];
};

const withinCredit = (w: World, name: Name): readonly string[] => {
  const state = accountOf(w, name)?.state;
  if (state === undefined) return [];
  const l = ledgerOf(state, GOLD);
  const delta = l.ondelta + l.offdelta;
  return delta >= -l.limit.left && delta <= l.collateral + l.limit.right ? [] : [`${name} is outside its credit`];
};

const stampsOf = (w: World): readonly string[] =>
  NAMES.flatMap((n) => w.hosts[n].runtime.wal.flatMap((row, i, rows) => {
    const before = rows[i - 1];
    return before !== undefined && before.stamp > row.stamp ? [`${n}'s stamp went back at row ${row.height}`] : [];
  }));

/** Every frame either WAL says it sent, by content name, with its parent head: both sides' frames are in these WALs. */
const parents = (w: World): ReadonlyMap<string, string> =>
  new Map(NAMES.flatMap((n) => w.hosts[n].runtime.wal.flatMap((row: Row) => row.outputs.flatMap((o) =>
    (o.msg._tag === "frame" ? [[frameName(o.msg.frame), o.msg.frame.parent] as const] : [])))));

type Replica = NonNullable<ReturnType<typeof accountOf>>;

/** `x` has committed one frame more than `y`: the frame `x` committed last has `y`'s head as its parent. */
const oneAhead = (up: ReadonlyMap<string, string>, x: Replica, y: Replica): boolean =>
  x.last !== undefined && up.get(x.last) === y.head;

/** The committed heads (of the Hosts that are between frames) are one chain: the same head, or one frame apart. */
const oneChain = (w: World): readonly string[] => {
  const a = idle(w.hosts.alice) ? accountOf(w, "alice") : undefined;
  const b = idle(w.hosts.bob) ? accountOf(w, "bob") : undefined;
  const up = parents(w);
  const forked = a !== undefined && b !== undefined && a.head !== b.head && !oneAhead(up, a, b) && !oneAhead(up, b, a);
  return forked ? ["the two sides committed different frames"] : [];
};

const violations = (ops: Ops, w: World): readonly string[] => [
  ...w.halts.map((h) => `halted: ${h}`), ...leaks(w), ...replays(ops, w), ...equalHeads(w), ...oneChain(w),
  ...stampsOf(w), ...NAMES.flatMap((n) => withinCredit(w, n)),
];

// ---- the money, from the WALs alone: a payment is taken when its command row says no refusal, refused by a notice

type Tally = Readonly<{ taken: bigint; refused: bigint }>;

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

const tally = (h: Host): Tally =>
  h.runtime.wal.reduce<Tally>((t, row) => {
    const inputs = row.input._tag === "entity" ? row.input.inputs : [];
    const asked = inputs.flatMap((i) => (i._tag === "pay" ? [i.amount] : []));
    const turnedAway = row.notices.some((n) => n._tag === "command_refused");
    const refused = row.notices.flatMap((n) =>
      (n._tag === "tx_refused" && n.refused.tx._tag === "pay" ? [n.refused.tx.amount] : []));
    return { taken: t.taken + (turnedAway ? 0n : sum(asked)), refused: t.refused + sum(refused) };
  }, { taken: 0n, refused: 0n });

const owedToLeft = (w: World): bigint => {
  const alice = tally(w.hosts.alice);
  const bob = tally(w.hosts.bob);
  return bob.taken - bob.refused - (alice.taken - alice.refused);
};

// ---- the random phase

type Chaos = Readonly<{ ops: Ops; weather: Weather; seed: number; run: number }>;

const commandAt = (c: Chaos, w: World, step: number, name: Name): Command => {
  const q = (k: number, n: number) => draw(c.seed, c.run, step, k, n);
  const peer = ID[PEER[name]];
  const kind = q(3, 100);
  if (accountOf(w, name) === undefined) {
    return kind < 92 ? { _tag: "open_account", peer } : { _tag: "pay", peer, token: GOLD, amount: 1n };
  }
  if (kind < 4) return { _tag: "open_account", peer };
  if (kind < 22) return { _tag: "set_credit", peer, token: GOLD, limit: BigInt(10 + q(4, 70)) };
  return { _tag: "pay", peer, token: GOLD, amount: BigInt(1 + q(5, 15)) };
};

/** Up to three messages for `name`, from where the link chose, and sometimes a command in the same frame. */
const linkFrame = (c: Chaos, w: World, step: number, name: Name): World => {
  const q = (k: number, n: number) => draw(c.seed, c.run, step, k, n);
  const mine = w.net.filter((f) => f.to === name);
  const taken = mine.slice(q(2, mine.length)).slice(0, 1 + q(6, 3));
  const command = q(7, 100) < 30 ? [commandAt(c, w, step, name)] : [];
  const arrivals = taken.map((f): EntityInput => ({ _tag: "peer_message", from: ID[PEER[name]], msg: f.msg }));
  const input = inputOf(w, name, [...command, ...arrivals]);
  return idle(w.hosts[name]) && taken.length > 0 ? feed(c.ops, w, name, "link", taken.map((f) => f.id), input) : w;
};

const commandInput = (c: Chaos, w: World, step: number, name: Name): Input =>
  inputOf(w, name, [commandAt(c, w, step, name)]);

const resendInput = (w: World, name: Name): Input =>
  inputOf(w, name, [{ _tag: "resend_due", peer: ID[PEER[name]] }]);

const lose = (c: Chaos, w: World, step: number): World => {
  const f = w.net[draw(c.seed, c.run, step, 2, w.net.length)];
  const free = f !== undefined && !w.hosts[f.to].ingress.includes(f.id);
  return c.weather.link === "lossy" && free ? { ...w, net: w.net.filter((x) => x.id !== f.id) } : w;
};

const repeat = (c: Chaos, w: World, step: number): World => {
  const f = w.net[draw(c.seed, c.run, step, 2, w.net.length)];
  const again = f === undefined ? [] : [{ ...f, id: w.seq }];
  return c.weather.link === "lossy" ? { ...w, net: [...w.net, ...again], seq: w.seq + again.length } : w;
};

const randomStep = (c: Chaos, w: World, step: number): World => {
  const name: Name = draw(c.seed, c.run, step, 0, 2) === 0 ? "alice" : "bob";
  const h = w.hosts[name];
  const k = draw(c.seed, c.run, step, 1, 100);
  switch (true) {
    case k < 18: return idle(h) ? feed(c.ops, w, name, "command", [], commandInput(c, w, step, name)) : w;
    case k < 40: return linkFrame(c, w, step, name);
    case k < 60: return idle(h) ? w : commitHost(c.ops, w, name);
    case k < 74: return flushHost(c.ops, w, name);
    case k < 80: return c.weather.crashes === "sometimes" ? crashHost(c.ops, w, name) : w;
    case k < 86: return lose(c, w, step);
    case k < 91: return repeat(c, w, step);
    default: return idle(h) ? feed(c.ops, w, name, "timer", [], resendInput(w, name)) : w;
  }
};

// ---- the settle phase: nothing is lost or repeated any more, and every timer that is due fires

const finishHost = (ops: Ops, w: World, name: Name): World =>
  flushHost(ops, idle(w.hosts[name]) ? w : commitHost(ops, w, name), name);

const take = (ops: Ops, w: World, name: Name): World => {
  const flight = w.net.find((f) => f.to === name);
  if (flight === undefined) return w;
  const arrival: EntityInput = { _tag: "peer_message", from: ID[PEER[name]], msg: flight.msg };
  return commitHost(ops, feed(ops, w, name, "link", [flight.id], inputOf(w, name, [arrival])), name);
};

const round = (ops: Ops, w: World): World => {
  const finished = NAMES.reduce((acc, n) => finishHost(ops, acc, n), w);
  const taken = NAMES.reduce((acc, n) => flushHost(ops, take(ops, acc, n), n), finished);
  return taken.net.length > 0
    ? taken
    : NAMES.reduce((acc, n) => finishHost(ops, feed(ops, acc, n, "timer", [], resendInput(acc, n)), n), taken);
};

const openAll = (ops: Ops, w: World): World =>
  NAMES.reduce((acc, n) => {
    const open: Command = { _tag: "open_account", peer: ID[PEER[n]] };
    const fed = feed(ops, finishHost(ops, acc, n), n, "command", [], inputOf(acc, n, [open]));
    return finishHost(ops, commitHost(ops, fed, n), n);
  }, w);

const settled = (w: World): boolean => {
  const a = accountOf(w, "alice");
  const b = accountOf(w, "bob");
  const between = NAMES.every((n) => idle(w.hosts[n]) && w.hosts[n].runtime.sent === w.hosts[n].runtime.wal.length);
  const agree = a !== undefined && b !== undefined && a.head === b.head && canon(a.state) === canon(b.state);
  const quiet = (r: typeof a) => r?.pending === undefined && r?.mempool.length === 0;
  const empty = quiet(a) && quiet(b);
  return between && w.net.length === 0 && agree && empty;
};

const settle = (ops: Ops, w: World, rounds: number): World =>
  (rounds === 0 || settled(w) ? w : settle(ops, round(ops, w), rounds - 1));

// ---- one run, and many

type Run = Readonly<{ failures: readonly string[]; settled: boolean; frames: number }>;

const moneyFailures = (w: World): readonly string[] => {
  const a = accountOf(w, "alice");
  const l = a === undefined ? undefined : ledgerOf(a.state, GOLD);
  const owed = owedToLeft(w);
  const says = `the payments taken less refused say ${owed}`;
  return l === undefined || l.offdelta === owed ? [] : [`offdelta ${l.offdelta}, ${says}`];
};

const runOne = (c: Chaos, steps: number): Run => {
  const steps0 = Array.from({ length: steps }, (_, i) => i);
  const walked = steps0.reduce<Readonly<{ w: World; failures: readonly string[] }>>((acc, i) => {
    const next = randomStep(c, acc.w, i);
    return { w: next, failures: [...acc.failures, ...violations(c.ops, next).map((v) => `step ${i}: ${v}`)] };
  }, { w: START, failures: [] });
  const clean = NAMES.reduce((w, n) => (idle(w.hosts[n]) ? w : crashHost(c.ops, w, n)), walked.w);
  const end = settle(c.ops, openAll(c.ops, clean), 400);
  const unsettled = settled(end) ? [] : ["did not settle"];
  const money = settled(end) ? moneyFailures(end) : [];
  const failures = [...walked.failures, ...violations(c.ops, end), ...unsettled, ...money];
  const outputs = NAMES.flatMap((n) => end.hosts[n].runtime.wal.flatMap((row) => row.outputs));
  const acks = outputs.filter((o) => o.msg._tag === "ack");
  return { failures, settled: settled(end), frames: acks.length };
};

type Verdict = Readonly<{ failures: readonly string[]; settledRuns: number; frames: number }>;

const explore = (ops: Ops, weather: Weather, seed: number, runs: number): Verdict => {
  const each = Array.from({ length: runs }, (_, run) => runOne({ ops, weather, seed, run }, STEPS));
  return {
    failures: [...new Set(each.flatMap((r, run) => r.failures.slice(0, 2).map((f) => `run ${run}: ${f}`)))].slice(0, 8),
    settledRuns: each.filter((r) => r.settled).length,
    frames: each.reduce((n, r) => n + r.frames, 0),
  };
};

const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 7;
const RUNS = process.env["RUNS"] ? Number(process.env["RUNS"]) : 60;
const STEPS = process.env["STEPS"] ? Number(process.env["STEPS"]) : 220;

const RELIABLE: Weather = { link: "reliable", crashes: "never" };
const CRASHING: Weather = { link: "reliable", crashes: "sometimes" };
const STORMY: Weather = { link: "lossy", crashes: "sometimes" };

/** A run of the explorer is seconds of CPU; Bun's 5 s default would make a slow machine the cause of a red gate. */
const BUDGET_MS = 120_000;

describe("runtime/chaos two Hosts over a link that loses, repeats and reorders, with crashes", () => {
  test("R-NET R-DURABLE a reliable link: every run settles and the money matches the notices", () => {
    const v = explore(REAL, RELIABLE, SEED, RUNS);
    expect(v.failures).toEqual([]);
    expect(v.settledRuns).toBe(RUNS);
  }, BUDGET_MS);

  test("R-DURABLE R-X1 crashes at any step: every run settles and the money matches the notices", () => {
    const v = explore(REAL, CRASHING, SEED, RUNS);
    expect(v.failures).toEqual([]);
    expect(v.settledRuns).toBe(RUNS);
  }, BUDGET_MS);

  test("R-NET R-DURABLE a link that loses, repeats and reorders, and crashes: every run settles, on one chain", () => {
    const v = explore(REAL, STORMY, SEED, RUNS);
    expect(v.failures).toEqual([]);
    expect(v.settledRuns).toBe(RUNS);
    expect(v.frames).toBeGreaterThan(RUNS * 4);
  }, BUDGET_MS);

  test("R-DURABLE planted bug: a flush that lets a staged frame's outputs leave is a leak", () => {
    const leaking: Ops = { ...REAL, flush: (rt) => {
      const flushed = flush(rt);
      return { ...flushed, leaving: [...flushed.leaving, ...(rt.staged?.outputs ?? [])] };
    } };
    expect(explore(leaking, CRASHING, SEED, RUNS).failures.join("\n")).toContain("an output no WAL holds");
  }, BUDGET_MS);

  test("R-X1 planted bug: a recovery that forgets the last row does not replay to what the Runtime holds", () => {
    const forgetful: Ops = { ...REAL, recover: (s, g, wal) => recover(s, g, wal.slice(0, -1)) };
    expect(explore(forgetful, CRASHING, SEED, RUNS).failures.join("\n")).toContain("does not replay");
  }, BUDGET_MS);
});
