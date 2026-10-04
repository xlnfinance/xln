// Two Hosts, each with a Runtime and a durable WAL of its own, over a link that loses, repeats and reorders, with
// random commands (open, credit, pay, and in the chain weather withdraw), random timers, random crashes (the staged
// row is lost, the Runtime comes back
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
import type { FrameHash, Msg } from "../account/frame/frame.ts";
import { ledgerOf } from "../account/state.ts";
import type { AccountTx } from "../account/tx.ts";
import { GOLD, TEST_SIG, entityOf } from "../entity/fixtures.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type EntityState, type JAction,
} from "../entity/model.ts";
import { mapSet } from "../kernel/core/collections.ts";
import type { Result } from "../kernel/core/result.ts";
import type { Halt, Input, Row, Runtime } from "./model.ts";
import { apply, commit, flush, messageId, recover, startRuntime } from "./tick.ts";
import { heightAt, setup, stamp } from "./fixtures.ts";

const NAMES = ["alice", "bob"] as const;
type Name = (typeof NAMES)[number];
const ID: Readonly<Record<Name, EntityId>> = { alice: entityOf(1), bob: entityOf(2) };
const PEER: Readonly<Record<Name, Name>> = { alice: "bob", bob: "alice" };

type Source = "command" | "link" | "timer" | "chain";
type Host = Readonly<{ runtime: Runtime; staged: Source | undefined; ingress: readonly number[] }>;
type Flight = Readonly<{ id: number; to: Name; msg: Msg<AccountTx> }>;
type World = Readonly<{
  hosts: Readonly<Record<Name, Host>>; net: readonly Flight[]; halts: readonly string[]; seq: number;
}>;

/** What the Runtime does for a Host: a planted bug replaces one of these. */
type Ops = Readonly<{ apply: typeof apply; commit: typeof commit; flush: typeof flush; recover: typeof recover }>;

const REAL: Ops = { apply, commit, flush, recover };

type Weather = Readonly<{
  link: "reliable" | "lossy"; crashes: "never" | "sometimes"; chain: "idle" | "collateral";
}>;

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
const parents = (w: World): ReadonlyMap<string, FrameHash> =>
  new Map(NAMES.flatMap((n) => w.hosts[n].runtime.wal.flatMap((row: Row) => row.outputs.flatMap((o) =>
    (o.msg._tag === "frame" ? [[frameName(o.msg.frame), o.msg.frame.parent] as const] : [])))));

type Replica = NonNullable<ReturnType<typeof accountOf>>;

/** `x` has committed one frame more than `y`: the frame `x` committed last has `y`'s head as its parent. */
const oneAhead = (up: ReadonlyMap<string, FrameHash>, x: Replica, y: Replica): boolean =>
  x.last !== undefined && up.get(x.last) === y.head;

/** The committed heads (of the Hosts that are between frames) are one chain: the same head, or one frame apart. */
const oneChain = (w: World): readonly string[] => {
  const a = idle(w.hosts.alice) ? accountOf(w, "alice") : undefined;
  const b = idle(w.hosts.bob) ? accountOf(w, "bob") : undefined;
  const up = parents(w);
  const forked = a !== undefined && b !== undefined && a.head !== b.head && !oneAhead(up, a, b) && !oneAhead(up, b, a);
  return forked ? ["the two sides committed different frames"] : [];
};

// ---- the chain: a signed operation waits for the chain, and the Account holds still until it lands (R-COSIGN-FREEZE)

type Signed = Extract<JAction, { _tag: "c2r" | "settle" }>;

const signing = (row: Row): readonly Signed[] =>
  row.chain.filter((a): a is Signed => a._tag === "settle" || a._tag === "c2r");

const landing = (row: Row): boolean =>
  row.input._tag === "entity" && row.input.inputs.some((i) => i._tag === "j_epoch" || i._tag === "j_op_lapsed");

/** What this Host co-signed and has not seen land or lapse: its newest signing row, when no landing came after it. */
const outstanding = (h: Host): Signed | undefined => {
  const rows = h.runtime.wal;
  const signed = rows.findLastIndex((row) => signing(row).length > 0);
  return signed > rows.findLastIndex(landing) ? signing(rows[signed] ?? expect.unreachable("no row"))[0] : undefined;
};

/** A Host that signed and waits commits no frame of the Account and proposes none: its head does not move. */
const holdsStill = (before: World, after: World): readonly string[] =>
  NAMES.flatMap((n) => {
    const waiting = outstanding(before.hosts[n]) !== undefined && outstanding(after.hosts[n]) !== undefined;
    const headMoved = accountOf(before, n)?.head !== accountOf(after, n)?.head;
    const moved = headMoved || accountOf(after, n)?.pending !== undefined;
    return waiting && moved ? [`${n} signed an operation and its Account moved before the chain did`] : [];
  });

/**
 * What a step signed must match the Account at the moment it signed, which the freeze keeps until the step is over
 * (R-C2R-FOLD): a C2R only over no offdelta, a settlement folding exactly the offdelta there is.
 */
const folding = (before: World, after: World): readonly string[] =>
  NAMES.flatMap((n) => {
    const fresh = after.hosts[n].runtime.wal.slice(before.hosts[n].runtime.wal.length).flatMap(signing);
    const state = accountOf(after, n)?.state;
    const owed = state === undefined ? 0n : ledgerOf(state, GOLD).offdelta;
    return fresh.flatMap((s) => {
      if (s._tag === "c2r") return owed === 0n ? [] : [`${n} signed a C2R over an offdelta of ${owed}`];
      const folded = s.folds.map((f) => f.offdelta);
      const right = owed === 0n ? folded.length === 0 : folded.length === 1 && folded[0] === owed;
      return right ? [] : [`${n} signed a settlement folding [${folded}] over an offdelta of ${owed}`];
    });
  });

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
  if (kind >= 75 && c.weather.chain === "collateral") {
    return { _tag: "withdraw", peer, token: GOLD, amount: BigInt(1 + q(5, 5)) };
  }
  return { _tag: "pay", peer, token: GOLD, amount: BigInt(1 + q(5, 15)) };
};

const factsOf = (w: World, name: Name) => w.hosts[name].runtime.entities.get(ID[name])?.chain.get(ID[PEER[name]]);

const told = (ops: Ops, w: World, name: Name, input: EntityInput): World =>
  commitHost(ops, feed(ops, w, name, "chain", [], inputOf(w, name, [input])), name);

/** Every event of the chain is a new height of J for both Hosts: when an Account that was refused tries again. */
const risen = (ops: Ops, w: World): World =>
  NAMES.reduce((acc, n) => {
    const at = BigInt((acc.hosts[n].runtime.wal.length * 37) % 101);
    const fed = through(acc, ops.apply(acc.hosts[n].runtime, heightAt(at, BigInt(acc.hosts[n].runtime.view) + 1n)),
      (runtime) => withHost(acc, n, { ...acc.hosts[n], runtime, staged: "chain" }));
    return commitHost(ops, fed, n);
  }, w);

/** The Host whose signed operation the chain answers: the newest serial, when both signed and neither landed. */
const signerOf = (w: World): Name | undefined => {
  const serialOf = (n: Name): bigint => outstanding(w.hosts[n])?.serial ?? -1n;
  const [first, ...rest] = NAMES.filter((n) => outstanding(w.hosts[n]) !== undefined);
  return first === undefined ? undefined : rest.reduce((best, n) => (serialOf(n) > serialOf(best) ? n : best), first);
};

/** The chain moves the epoch on for both Hosts, which have to be between frames: whatever was signed has landed. */
const landed = (ops: Ops, w: World): World => {
  const epoch = 1n + NAMES.reduce((e, n) => (e > (factsOf(w, n)?.epoch ?? 0n) ? e : (factsOf(w, n)?.epoch ?? 0n)), 0n);
  const event = (n: Name): EntityInput => ({ _tag: "j_epoch", peer: ID[PEER[n]], epoch, stored: epoch * 10n });
  // The chain holds one value for both Hosts: what the signer folded, read off its own ledger (it was frozen from the
  // signature on, so its offdelta is the signed fold). The other Host may hold a frame the link has not delivered yet,
  // so its own ledger says nothing about it. A landing is asked for only when something was signed.
  const signer = signerOf(w) ?? expect.unreachable("a landing with nothing signed");
  const signed = accountOf(w, signer) ?? expect.unreachable("a signer with no Account");
  const folded = (acc: World, n: Name): World => {
    const l = ledgerOf(signed.state, GOLD);
    const ondelta = l.ondelta + l.offdelta;
    const fold: EntityInput =
      { _tag: "j_collateral", peer: ID[PEER[n]], token: GOLD, collateral: l.collateral, ondelta };
    return told(ops, acc, n, fold);
  };
  return risen(ops, NAMES.reduce((acc, n) => folded(told(ops, acc, n, event(n)), n), w));
};

/** The Host of `signer` asks the other for the same signature, as its transport would. */
const asked = (ops: Ops, w: World, signer: Name, op: Signed): World => {
  const asking = { _tag: op._tag, token: op.token, amount: op.amount };
  const ask: EntityInput = { _tag: "cosign_ask", from: ID[signer], op: asking };
  return idle(w.hosts[PEER[signer]]) ? told(ops, w, PEER[signer], ask) : w;
};

/** The chain tells a Host something: the operation lands on both, lapses for its signer, or is asked of the other. */
const chainStep = (c: Chaos, w: World, step: number): World => {
  const signer = signerOf(w);
  const op = signer === undefined ? undefined : outstanding(w.hosts[signer]);
  if (signer === undefined || op === undefined) return w;
  const lapse: EntityInput = { _tag: "j_op_lapsed", peer: ID[PEER[signer]], serial: op.serial };
  switch (draw(c.seed, c.run, step, 9, 6)) {
    case 0: return NAMES.every((n) => idle(w.hosts[n])) ? landed(c.ops, w) : w;
    case 1: return NAMES.every((n) => idle(w.hosts[n])) ? risen(c.ops, told(c.ops, w, signer, lapse)) : w;
    default: return asked(c.ops, w, signer, op);
  }
};

/** Up to three messages for `name`, from where the link chose, and sometimes a command in the same frame. */
const linkFrame = (c: Chaos, w: World, step: number, name: Name): World => {
  const q = (k: number, n: number) => draw(c.seed, c.run, step, k, n);
  const mine = w.net.filter((f) => f.to === name);
  const taken = mine.slice(q(2, mine.length)).slice(0, 1 + q(6, 3));
  const command = q(7, 100) < 30 ? [commandAt(c, w, step, name)] : [];
  const arrivals = taken.map((f): EntityInput =>
    ({ _tag: "peer_message", from: ID[PEER[name]], msg: f.msg, sig: TEST_SIG }));
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

/** A timer, or in the chain weather sometimes the chain instead. */
const ticks = (c: Chaos, w: World, step: number, name: Name): World => {
  if (c.weather.chain === "collateral" && draw(c.seed, c.run, step, 8, 100) < 30) return chainStep(c, w, step);
  return idle(w.hosts[name]) ? feed(c.ops, w, name, "timer", [], resendInput(w, name)) : w;
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
    default: return ticks(c, w, step, name);
  }
};

// ---- the settle phase: nothing is lost or repeated any more, and every timer that is due fires

const finishHost = (ops: Ops, w: World, name: Name): World =>
  flushHost(ops, idle(w.hosts[name]) ? w : commitHost(ops, w, name), name);

const take = (ops: Ops, w: World, name: Name): World => {
  const flight = w.net.find((f) => f.to === name);
  if (flight === undefined) return w;
  const arrival: EntityInput = { _tag: "peer_message", from: ID[PEER[name]], msg: flight.msg, sig: TEST_SIG };
  return commitHost(ops, feed(ops, w, name, "link", [flight.id], inputOf(w, name, [arrival])), name);
};

const round = (ops: Ops, w: World): World => {
  const finished = NAMES.reduce((acc, n) => finishHost(ops, acc, n), w);
  const taken = NAMES.reduce((acc, n) => flushHost(ops, take(ops, acc, n), n), finished);
  return taken.net.length > 0
    ? taken
    : NAMES.reduce((acc, n) => finishHost(ops, feed(ops, acc, n, "timer", [], resendInput(acc, n)), n), taken);
};

const finishAll = (ops: Ops, w: World): World => NAMES.reduce((acc, n) => finishHost(ops, acc, n), w);

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

/** With a chain in the weather, J goes on: each round of the settle phase is a new height too, as blocks are. */
const settle = (c: Chaos, w: World, rounds: number): World => {
  if (rounds === 0 || settled(w)) return w;
  const next = round(c.ops, w);
  const ticking = c.weather.chain === "collateral" && !settled(next);
  return settle(c, ticking ? finishAll(c.ops, risen(c.ops, next)) : next, rounds - 1);
};

// ---- one run, and many

type Run = Readonly<{ failures: readonly string[]; settled: boolean; frames: number }>;

const moneyFailures = (w: World): readonly string[] => {
  const a = accountOf(w, "alice");
  const l = a === undefined ? undefined : ledgerOf(a.state, GOLD);
  const owed = owedToLeft(w);
  const says = `the payments taken less refused say ${owed}`;
  return l === undefined || l.ondelta + l.offdelta === owed ? [] : [`delta ${l.ondelta + l.offdelta}, ${says}`];
};

/** Every second run of the chain weather starts with an offdelta: the Accounts open, Bob lends, Alice pays him 7. */
const primed = (c: Chaos): World => {
  const say = (w: World, n: Name, command: Command): World => {
    const fed = feed(c.ops, finishHost(c.ops, w, n), n, "command", [], inputOf(w, n, [command]));
    return finishHost(c.ops, commitHost(c.ops, fed, n), n);
  };
  const lend: Command = { _tag: "set_credit", peer: ID.alice, token: GOLD, limit: 50n };
  const pays: Command = { _tag: "pay", peer: ID.bob, token: GOLD, amount: 7n };
  const opened = settle(c, openAll(c.ops, START), 50);
  return settle(c, say(settle(c, say(opened, "bob", lend), 50), "alice", pays), 50);
};

const runOne = (c: Chaos, steps: number): Run => {
  const steps0 = Array.from({ length: steps }, (_, i) => i);
  const walked = steps0.reduce<Readonly<{ w: World; failures: readonly string[] }>>((acc, i) => {
    const next = randomStep(c, acc.w, i);
    const broken = [...holdsStill(acc.w, next), ...folding(acc.w, next), ...violations(c.ops, next)];
    return { w: next, failures: [...acc.failures, ...broken.map((v) => `step ${i}: ${v}`)] };
  }, { w: c.weather.chain === "collateral" && c.run % 2 === 1 ? primed(c) : START, failures: [] });
  const clean = NAMES.reduce((w, n) => (idle(w.hosts[n]) ? w : crashHost(c.ops, w, n)), walked.w);
  const open = openAll(c.ops, clean);
  const end = settle(c, NAMES.some((n) => outstanding(open.hosts[n]) !== undefined) ? landed(c.ops, open) : open, 400);
  const unsettled = settled(end) ? [] : ["did not settle"];
  const money = settled(end) ? moneyFailures(end) : [];
  const failures = [...walked.failures, ...violations(c.ops, end), ...unsettled, ...money];
  const outputs = NAMES.flatMap((n) => end.hosts[n].runtime.wal.flatMap((row) => row.outputs));
  const acks = outputs.filter((o) => o.msg._tag === "ack");
  return { failures, settled: settled(end), frames: acks.length };
};

/** One of each kind of failure a run had (a kind is the failure without its step), so one noisy kind hides no other. */
const kinds = (failures: readonly string[]): readonly string[] =>
  [...new Map(failures.map((f) => [f.replace(/^step \d+: /, ""), f])).values()].slice(0, 4);

type Verdict = Readonly<{ failures: readonly string[]; settledRuns: number; frames: number }>;

const explore = (ops: Ops, weather: Weather, seed: number, runs: number): Verdict => {
  const each = Array.from({ length: runs }, (_, run) => runOne({ ops, weather, seed, run }, STEPS));
  return {
    failures: [...new Set(each.flatMap((r, run) => kinds(r.failures).map((f) => `run ${run}: ${f}`)))].slice(0, 16),
    settledRuns: each.filter((r) => r.settled).length,
    frames: each.reduce((n, r) => n + r.frames, 0),
  };
};

const SEED = process.env["SEEDX"] ? Number(process.env["SEEDX"]) : 7;
const RUNS = process.env["RUNS"] ? Number(process.env["RUNS"]) : 60;
const STEPS = process.env["STEPS"] ? Number(process.env["STEPS"]) : 220;

const RELIABLE: Weather = { link: "reliable", crashes: "never", chain: "idle" };
const CRASHING: Weather = { link: "reliable", crashes: "sometimes", chain: "idle" };
const STORMY: Weather = { link: "lossy", crashes: "sometimes", chain: "idle" };
const WITHDRAWING: Weather = { link: "lossy", crashes: "sometimes", chain: "collateral" };

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

  test("R-NET planted fork: two Hosts that committed different frames are red; one frame apart is not", () => {
    const w = primed({ ops: REAL, weather: WITHDRAWING, seed: SEED, run: 1 });
    const alice = accountOf(w, "alice") ?? expect.unreachable("no Account");
    const bob = accountOf(w, "bob") ?? expect.unreachable("no Account");
    const retold = (n: Name, replica: Replica): World => {
      const rt = w.hosts[n].runtime;
      const entity = rt.entities.get(ID[n]) ?? expect.unreachable("no entity");
      const accounts = mapSet(entity.accounts, ID[PEER[n]], replica);
      const entities = mapSet(rt.entities, ID[n], { ...entity, accounts });
      return withHost(w, n, { ...w.hosts[n], runtime: { ...rt, entities } });
    };
    const behind = alice.last === undefined ? undefined : parents(w).get(alice.last);
    expect([alice.head === bob.head, alice.last !== undefined, behind !== undefined]).toEqual([true, true, true]);
    expect(oneChain(w)).toEqual([]);
    if (behind === undefined) return expect.unreachable("Alice committed no frame");
    expect(oneChain(retold("bob", { ...bob, head: behind, last: undefined }))).toEqual([]);
    // Bob's head is a frame no WAL ever sent: neither side is one frame ahead of the other
    const unsent = frameName({
      author: "left", parent: alice.head, attempt: 7, slot: 2, epoch: 0n, firstNonce: 2n, txs: [],
    });
    expect(oneChain(retold("bob", { ...bob, head: unsent, last: unsent })))
      .toEqual(["the two sides committed different frames"]);
  });

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

  test("R-COSIGN-FREEZE R-C2R-FOLD a storm of withdrawals, asks and landings: signed Accounts hold still", () => {
    const v = explore(REAL, WITHDRAWING, SEED, RUNS);
    expect(v.failures).toEqual([]);
    expect(v.settledRuns).toBe(RUNS);
  }, BUDGET_MS);

  test("R-COSIGN-FREEZE planted bug: a Runtime that forgets the freeze lets a signed Account move", () => {
    const thawing: Ops = { ...REAL, apply: (rt, input) => {
      const applied = apply(rt, input);
      if (!applied.ok) return applied;
      const thaw = (e: EntityState): EntityState =>
        ({ ...e, chain: new Map([...e.chain].map(([peer, f]) => [peer, { ...f, frozen: false }])) });
      const entities = new Map([...applied.value.entities].map(([id, e]) => [id, thaw(e)]));
      return { ok: true, value: { ...applied.value, entities } };
    }, };
    expect(explore(thawing, WITHDRAWING, SEED, RUNS).failures.join("\n")).toContain("moved before the chain did");
  }, BUDGET_MS);

  test("R-C2R-FOLD planted bug: a Runtime whose settlements go out as C2Rs is seen signing over an offdelta", () => {
    const bare: Ops = { ...REAL, apply: (rt, input) => {
      const applied = apply(rt, input);
      const row = applied.ok ? applied.value.staged : undefined;
      if (!applied.ok || row === undefined) return applied;
      const chain = row.chain.map((a): JAction =>
        (a._tag === "settle" ? { _tag: "c2r", peer: a.peer, serial: a.serial, token: a.token, amount: a.amount } : a));
      return { ok: true, value: { ...applied.value, staged: { ...row, chain } } };
    } };
    expect(explore(bare, WITHDRAWING, SEED, RUNS).failures.join("\n")).toContain("signed a C2R over an offdelta");
  }, BUDGET_MS);
});
