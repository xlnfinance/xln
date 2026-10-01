// Two Hosts over the weakest link (spec/transport/link.scm): messages are lost, repeated, reordered and misrouted, a
// stranger puts forged acks, future frames and mail for Entities nobody hosts on it, a disk write takes a while, and a
// node crashes with a write half done. After every step: no peer message halted a Host (R-X1), nothing on the link
// is an output of a row that is not durable (R-DURABLE), neither side's Account head is a frame the other side has not
// made durable (R-DURABLE: the sender never believes the peer holds more than the peer persisted), and every idle
// Host's durable rows replay to what it holds. After the random phase the adversary stops and every run must settle.
import { describe, expect, test } from "bun:test";
import { draw } from "../account/fixtures.ts";
import { GENESIS, provisionalFrameHash } from "../account/frame/account.ts";
import type { Frame, Msg } from "../account/frame/frame.ts";
import type { AccountTx } from "../account/tx.ts";
import { credit, GOLD, open, pay } from "../entity/fixtures.ts";
import { emptyEntity, type EntityId, type EntityInput, type Outbound } from "../entity/model.ts";
import type { Row } from "../runtime/model.ts";
import { setup } from "../runtime/fixtures.ts";
import { messageId } from "../runtime/tick.ts";
import { begin, persisted, receive, reopen, submit, TICK, type Tick } from "./host.ts";
import type { Effect, Host } from "./model.ts";
import { BOUNDS, entityOf, hostFor, sentIn, stamp } from "./fixtures.ts";

const NAMES = ["alice", "bob"] as const;
type Name = (typeof NAMES)[number];
const ID: Readonly<Record<Name, EntityId>> = { alice: entityOf(1), bob: entityOf(2) };
const NOBODY = entityOf(9);
const PEER: Readonly<Record<Name, Name>> = { alice: "bob", bob: "alice" };

type Node = Readonly<{ host: Host; store: readonly Row[]; writing: Row | undefined }>;
type Origin = "node" | "stranger";
type Flight = Readonly<{ id: number; origin: Origin; message: Outbound }>;
type World = Readonly<{
  nodes: Readonly<Record<Name, Node>>; link: readonly Flight[]; halts: readonly string[]; seq: number; refused: number;
}>;

/** What a shell does with the Host's effects: a planted bug replaces one of these. */
type Shell = Readonly<{ tick: Tick; onPersist: (effects: readonly Effect[]) => readonly Outbound[] }>;

const FAITHFUL: Shell = { tick: TICK, onPersist: () => [] };

const fresh = (name: Name): Node => ({ host: hostFor(ID[name]), store: [], writing: undefined });

const START: World = { nodes: { alice: fresh("alice"), bob: fresh("bob") }, link: [], halts: [], seq: 0, refused: 0 };

const withNode = (w: World, name: Name, node: Node): World => ({ ...w, nodes: { ...w.nodes, [name]: node } });

const put = (w: World, origin: Origin, messages: readonly Outbound[]): World => ({
  ...w, seq: w.seq + messages.length,
  link: [...w.link, ...messages.map((message, i): Flight => ({ id: w.seq + i, origin, message }))],
});

const halted = (w: World, tag: string): World => ({ ...w, halts: [...w.halts, tag] });

const accountOf = (w: World, name: Name) =>
  w.nodes[name].host.runtime.entities.get(ID[name])?.accounts.get(ID[PEER[name]]);

// ---- the Host's moves, through the shell

const stampFor = (w: World, name: Name) => stamp(BigInt((w.nodes[name].store.length * 37) % 101));

/** The Host begins a frame; the row goes to the disk, and for a faulty shell it also goes out. */
const start = (shell: Shell, w: World, name: Name): World => {
  const node = w.nodes[name];
  const begun = begin(node.host, stampFor(w, name), shell.tick);
  if (!begun.ok) return halted(w, begun.error._tag);
  const row = begun.value.effects.flatMap((e) => (e._tag === "persist" ? [e.row] : []))[0];
  const moved = withNode(w, name, { ...node, host: begun.value.host, writing: row ?? node.writing });
  return put(moved, "node", shell.onPersist(begun.value.effects));
};

/** The disk finishes the write: the row is durable, the Host is told, and what leaves goes on the link. */
const written = (shell: Shell, w: World, name: Name): World => {
  const node = w.nodes[name];
  if (node.writing === undefined) return w;
  const done = persisted(node.host, shell.tick);
  if (!done.ok) return halted(w, done.error._tag);
  const store = [...node.store, node.writing];
  const durable = withNode(w, name, { host: done.value.host, store, writing: undefined });
  return put(durable, "node", sentIn(done.value.effects));
};

/** A crash: the staged row, the half-done write and the queue are lost; the Host comes back from the durable rows. */
const crash = (shell: Shell, w: World, name: Name): World => {
  const node = w.nodes[name];
  const back = reopen(setup, [emptyEntity(ID[name])], node.store, BOUNDS, shell.tick);
  if (!back.ok) return halted(w, back.error._tag);
  const restarted = withNode(w, name, { host: back.value.host, store: node.store, writing: undefined });
  return put(restarted, "node", sentIn(back.value.effects));
};

const hear = (w: World, name: Name, flight: Flight): World => {
  const node = w.nodes[name];
  const got = receive(node.host, flight.message);
  return { ...withNode(w, name, { ...node, host: got.host }), refused: w.refused + got.notices.length };
};

const tell = (w: World, name: Name, input: EntityInput): World => {
  const node = w.nodes[name];
  return withNode(w, name, { ...node, host: submit(node.host, { to: ID[name], input }) });
}

// ---- the adversary

type Chaos = Readonly<{ shell: Shell; seed: number; run: number; checks: readonly Check[] }>;

const commandAt = (c: Chaos, w: World, step: number, name: Name): EntityInput => {
  const q = (k: number, n: number) => draw(c.seed, c.run, step, k, n);
  const peer = ID[PEER[name]];
  const kind = q(3, 100);
  if (accountOf(w, name) === undefined) return kind < 92 ? open(peer) : pay(peer, 1n);
  if (kind < 4) return open(peer);
  return kind < 22 ? credit(peer, BigInt(10 + q(4, 70))) : pay(peer, BigInt(1 + q(5, 15)));
};

const payFrame = (parent: typeof GENESIS, attempt: number): Msg<AccountTx> => {
  const frame: Frame<AccountTx> = { author: "left", parent, attempt, txs: [{ _tag: "pay", token: GOLD, amount: 1n }] };
  return { _tag: "frame", frame };
};

/** What a stranger puts on the link: a forged ack, a frame from nowhere, mail for an Entity nobody hosts. */
const forgery = (c: Chaos, step: number, name: Name): Outbound => {
  const from = ID[PEER[name]];
  const tail = draw(c.seed, c.run, step, 8, 200).toString(16).padStart(2, "0");
  const junk = `0x${"ab".repeat(31)}${tail}` as typeof GENESIS;
  switch (draw(c.seed, c.run, step, 7, 4)) {
    case 0: return { from, to: ID[name], msg: { _tag: "ack", hash: junk } };
    case 1: return { from, to: ID[name], msg: payFrame(junk, 0) };
    case 2: return { from: NOBODY, to: ID[name], msg: payFrame(GENESIS, 0) };
    default: return { from, to: NOBODY, msg: payFrame(GENESIS, 0) };
  }
};

const toward = (w: World, name: Name): readonly Flight[] => w.link.filter((f) => f.message.to === ID[name]);

const lose = (w: World, step: number, c: Chaos): World => {
  const f = w.link[draw(c.seed, c.run, step, 2, w.link.length)];
  return f === undefined ? w : { ...w, link: w.link.filter((x) => x.id !== f.id) };
};

const repeat = (w: World, step: number, c: Chaos): World => {
  const f = w.link[draw(c.seed, c.run, step, 2, w.link.length)];
  return f === undefined ? w : put(w, f.origin, [f.message]);
};

type Move = (w: World, name: Name, heard: Flight | undefined) => World;

/** The adversary's menu, with weights out of 100: the rest of the 100 is a step where nothing happens. */
const menu = (c: Chaos, step: number): readonly (readonly [number, Move])[] => [
  [14, (w, name) => tell(w, name, commandAt(c, w, step, name))],
  [2, (w, name) => tell(w, name, { _tag: "resend_due", peer: ID[PEER[name]] })],
  [13, (w, name, heard) => (heard === undefined ? w : hear(w, name, heard))],
  [13, (w, name) => start(c.shell, w, name)],
  [13, (w, name) => written(c.shell, w, name)],
  [3, (w, name) => crash(c.shell, w, name)],
  [6, (w) => lose(w, step, c)],
  [4, (w) => repeat(w, step, c)],
  [4, (w, name) => put(w, "stranger", [forgery(c, step, name)])],
];

const randomStep = (c: Chaos, w: World, step: number): World => {
  const name: Name = draw(c.seed, c.run, step, 0, 2) === 0 ? "alice" : "bob";
  const heard = w.link[draw(c.seed, c.run, step, 6, w.link.length)];
  const k = draw(c.seed, c.run, step, 1, 100);
  const chosen = menu(c, step).reduce<Readonly<{ upTo: number; move: Move | undefined }>>((acc, [weight, move]) => {
    const upTo = acc.upTo + weight;
    return { upTo, move: acc.move === undefined && k < upTo ? move : acc.move };
  }, { upTo: 0, move: undefined });
  return chosen.move === undefined ? w : chosen.move(w, name, heard);
};

// ---- what a world must satisfy at every step

const replacer = (_key: string, v: unknown): unknown => {
  if (typeof v === "bigint") return `${v}n`;
  return v instanceof Map ? { map: [...v] } : v;
};

const canon = (x: unknown): string => JSON.stringify(x, replacer);

const hashesOf = (msg: Msg<AccountTx>): readonly string[] =>
  (msg._tag === "frame" ? [provisionalFrameHash(msg.frame)] : []);

/** Every frame a durable row of this node holds: the ones it took in, and the ones it made. */
const framesHeld = (node: Node): ReadonlySet<string> =>
  new Set(node.store.flatMap((row) => [
    ...row.input.inputs.flatMap((i) => (i._tag === "peer_message" ? hashesOf(i.msg) : [])),
    ...row.outputs.flatMap((o) => hashesOf(o.msg)),
  ]));

const durableOutputs = (node: Node): ReadonlySet<string> =>
  new Set(node.store.flatMap((row) => row.outputs).map((o) => `${o.from} ${o.to} ${messageId(o.msg)}`));

const nameOf = (id: EntityId): Name | undefined => NAMES.find((n) => ID[n] === id);

const leaks = (w: World): readonly string[] =>
  w.link.filter((f) => f.origin === "node").flatMap((f) => {
    const sender = nameOf(f.message.from);
    const named = `${f.message.from} ${f.message.to} ${messageId(f.message.msg)}`;
    const known = sender !== undefined && durableOutputs(w.nodes[sender]).has(named);
    return known ? [] : ["an output of a row that is not durable is on the link"];
  });

/** R-DURABLE: a side's head is a frame the peer holds durably; no ack ever got ahead of the peer's disk. */
const believes = (w: World): readonly string[] =>
  NAMES.flatMap((n) => {
    const head = accountOf(w, n)?.head;
    const held = head === undefined || head === GENESIS || framesHeld(w.nodes[PEER[n]]).has(head);
    return held ? [] : [`${n} holds a head its peer has not made durable`];
  });

const replays = (shell: Shell, w: World): readonly string[] =>
  NAMES.filter((n) => w.nodes[n].host.runtime.staged === undefined).flatMap((n) => {
    const again = reopen(setup, [emptyEntity(ID[n])], w.nodes[n].store, BOUNDS, shell.tick);
    const same = again.ok && canon(again.value.host.runtime.entities) === canon(w.nodes[n].host.runtime.entities);
    return same ? [] : [`${n}'s durable rows do not replay to what it holds`];
  });

const halts = (_shell: Shell, w: World): readonly string[] => w.halts.map((h) => `halted: ${h}`);

type Check = (shell: Shell, w: World) => readonly string[];

const EVERY: readonly Check[] = [halts, (_s, w) => leaks(w), (_s, w) => believes(w), replays];

const violations = (shell: Shell, w: World, checks: readonly Check[]): readonly string[] =>
  checks.flatMap((check) => check(shell, w));

// ---- the settle phase: the adversary stops, nothing is lost or repeated, every timer that is due fires

const finish = (shell: Shell, w: World, name: Name): World => {
  const idleNode = w.nodes[name].writing === undefined && w.nodes[name].host.runtime.staged === undefined;
  const moved = idleNode ? start(shell, w, name) : w;
  return written(shell, moved, name);
};

const take = (shell: Shell, w: World, name: Name): World => {
  const flight = toward(w, name)[0];
  if (flight === undefined) return w;
  const removed = { ...w, link: w.link.filter((f) => f.id !== flight.id) };
  return finish(shell, hear(removed, name, flight), name);
};

const everyone = (w: World, step: (acc: World, name: Name) => World): World => NAMES.reduce(step, w);

/** A message for an address nobody here holds reaches a node that is not the peer, which refuses it: it is gone. */
const withoutStrays = (w: World): World => ({ ...w, link: w.link.filter((f) => nameOf(f.message.to) !== undefined) });

const round = (shell: Shell, strayed: World): World => {
  const w = withoutStrays(strayed);
  const taken = everyone(everyone(w, (acc, n) => finish(shell, acc, n)), (acc, n) => take(shell, acc, n));
  const timers = (acc: World, n: Name) =>
    finish(shell, finish(shell, tell(acc, n, { _tag: "resend_due", peer: ID[PEER[n]] }), n), n);
  return taken.link.length > 0 ? taken : everyone(taken, timers);
};

const openAll = (shell: Shell, w: World): World =>
  everyone(w, (acc, n) => finish(shell, finish(shell, tell(acc, n, open(ID[PEER[n]])), n), n));

const quiet = (r: ReturnType<typeof accountOf>) => r !== undefined && r.pending === undefined && r.mempool.length === 0;

const settled = (w: World): boolean => {
  const [a, b] = [accountOf(w, "alice"), accountOf(w, "bob")];
  const between = NAMES.every((n) => w.nodes[n].writing === undefined && w.nodes[n].host.queue.length === 0
    && w.nodes[n].host.runtime.staged === undefined && w.nodes[n].host.runtime.sent === w.nodes[n].store.length);
  const agree = a?.head === b?.head && canon(a?.state) === canon(b?.state);
  return between && w.link.length === 0 && quiet(a) && quiet(b) && agree;
};

const settle = (shell: Shell, w: World, rounds: number): World =>
  (rounds === 0 || settled(w) ? w : settle(shell, round(shell, w), rounds - 1));

// ---- one run, and many

type Run = Readonly<{ failures: readonly string[]; settled: boolean; refused: number }>;

const runOne = (c: Chaos, steps: number): Run => {
  const walked = Array.from({ length: steps }, (_, i) => i).reduce<Readonly<{ w: World; failures: readonly string[] }>>(
    (acc, i) => {
      const next = randomStep(c, acc.w, i);
      const found = violations(c.shell, next, c.checks).map((v) => `step ${i}: ${v}`);
      return { w: next, failures: [...acc.failures, ...found] };
    }, { w: START, failures: [] });
  const recovered = everyone(walked.w, (w, n) => crash(c.shell, w, n));
  const end = settle(c.shell, openAll(c.shell, recovered), 400);
  const unsettled = settled(end) ? [] : ["did not settle"];
  const failures = [...walked.failures, ...violations(c.shell, end, c.checks), ...unsettled];
  return { failures, settled: settled(end), refused: end.refused };
};

type Verdict = Readonly<{ failures: readonly string[]; settledRuns: number; refused: number }>;

const explore = (shell: Shell, checks: readonly Check[], runs: number, steps: number): Verdict => {
  const each = Array.from({ length: runs }, (_, run) => runOne({ shell, checks, seed: SEED, run }, steps));
  return {
    failures: [...new Set(each.flatMap((r, run) => r.failures.slice(0, 2).map((f) => `run ${run}: ${f}`)))].slice(0, 8),
    settledRuns: each.filter((r) => r.settled).length,
    refused: each.reduce((n, r) => n + r.refused, 0),
  };
};

const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 7;
const RUNS = process.env["RUNS"] ? Number(process.env["RUNS"]) : 40;
const STEPS = process.env["STEPS"] ? Number(process.env["STEPS"]) : 200;

/** A run of the explorer is seconds of CPU; Bun's 5 s default would make a slow machine the cause of a red gate. */
const BUDGET_MS = 120_000;

/** Both Accounts open and Bob's credit heard; Alice's payment frame is on the link, her Host at rest. */
const paying = (shell: Shell): World => {
  const opened = settle(shell, everyone(START, (w, n) => tell(w, n, open(ID[PEER[n]]))), 40);
  const credited = settle(shell, tell(opened, "bob", credit(ID.alice, 100n)), 40);
  return finish(shell, tell(credited, "alice", pay(ID.bob, 30n)), "alice");
};

/** Bob hears the frame and stages its row, not yet durable; what his shell sent then reaches Alice, who takes it. */
const afterAck = (shell: Shell): World => {
  const w = paying(shell);
  const frame = toward(w, "bob").find((f) => f.message.msg._tag === "frame" && f.message.msg.frame.txs.length > 0);
  const heard = frame === undefined ? w : hear(w, "bob", frame);
  const staged = start(shell, heard, "bob");
  const ack = toward(staged, "alice").find((f) => f.message.msg._tag === "ack");
  return ack === undefined ? staged : start(shell, hear(staged, "alice", ack), "alice");
};

describe("host/link two Hosts over a link that loses, repeats, misroutes and has strangers, with crashes", () => {
  test("R-DURABLE R-X1 every run settles; at every step nothing halted and nothing left ahead of its disk", () => {
    const v = explore(FAITHFUL, EVERY, RUNS, STEPS);
    expect(v.failures).toEqual([]);
    expect(v.settledRuns).toBe(RUNS);
    expect(v.refused).toBeGreaterThan(0);
  }, BUDGET_MS);

  test("R-DURABLE planted bug: a shell that sends a row's outputs when it asks for the write, not after", () => {
    const eager: Shell = {
      tick: TICK,
      onPersist: (effects) => effects.flatMap((e) => (e._tag === "persist" ? e.row.outputs : [])),
    };
    expect(explore(eager, [(_s, w) => leaks(w)], RUNS, STEPS).failures.join("\n")).toContain("not durable");
  }, BUDGET_MS);

  test("R-DURABLE the sender never believes the peer holds more than the peer made durable", () => {
    expect(believes(afterAck(FAITHFUL))).toEqual([]);
    expect(afterAck(FAITHFUL).link.filter((f) => f.message.msg._tag === "ack")).toEqual([]);
  });

  test("R-DURABLE planted bug: an ack that leaves with the write request gives Alice a head Bob lacks", () => {
    const eager: Shell = {
      tick: TICK,
      onPersist: (effects) =>
        effects.flatMap((e) => (e._tag === "persist" ? e.row.outputs.filter((o) => o.msg._tag === "ack") : [])),
    };
    expect(believes(afterAck(eager))).toEqual(["alice holds a head its peer has not made durable"]);
  });

  test("R-X1 planted bug: a recovery that forgets the last row does not replay to what the Host holds", () => {
    const recover: Tick["recover"] = (s, g, wal) => TICK.recover(s, g, wal.slice(0, -1));
    const forgetful: Shell = { ...FAITHFUL, tick: { ...TICK, recover } };
    expect(explore(forgetful, [replays], RUNS, STEPS).failures.join("\n")).toContain("do not replay");
  }, BUDGET_MS);
});
