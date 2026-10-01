// R-FRAME-REFUSAL: the test that defines done for A4 (Review A of PR 82, F2). Two replicas share a J chain whose height
// moves while frames are in flight, each judging by its own view (the views drift apart by at most LAG), over a network
// that loses, duplicates and reorders. A frame can then be refused for an honest reason: a deadline passed while it was
// in flight. After the random phase the network turns reliable and the clock stops: every run must settle, with nothing
// pending and nothing queued on either side. Without a refusal message a refused pending frame stays for good, and a
// stuck Left frame blocks Right too. The Arrival frames page has no clock, so its "nothing wedges" cannot see this.
import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { draw, holdOf, secretOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger, MAX_HOLDS } from "../ledger.ts";
import { holdId, other, type Ledger, type Side } from "../model.ts";
import { emptyAccount, openHolds, withLedger } from "../state.ts";
import type { AccountTx, Judge } from "../tx.ts";
import { accountRules, emptyReplica, type AccountReplica } from "./account.ts";
import { propose, queue, receive, resend, submit, type Msg } from "./frame.ts";

const SIDES: readonly Side[] = ["left", "right"];
const LAG = 1n;
const clock = unwrapOr(clockParams(LAG, 2n, 10n), () => expect.unreachable("params"));
const TOKENS = [tokenOf(1n), tokenOf(2n)] as const;
const FUNDED: Ledger = { ...emptyLedger, collateral: 300n, ondelta: 150n, limit: { left: 60n, right: 60n } };

type Flight = Readonly<{ to: Side; msg: Msg<AccountTx> }>;
type Sided<X> = Readonly<Record<Side, X>>;

type World = Readonly<{
  rep: Sided<AccountReplica>;
  net: readonly Flight[];
  log: Sided<readonly string[]>;
  time: bigint;
  drift: Sided<bigint>;
  submitted: Sided<number>;
  committed: Sided<number>;
}>;

const viewOfSide = (w: World, side: Side): bigint => w.time + w.drift[side];
const rulesOf = (w: World, side: Side) =>
  accountRules({ clock, view: viewOf(viewOfSide(w, side)) } satisfies Judge, signing);

const funded = (side: Side): AccountReplica =>
  ({ ...emptyReplica(side), state: TOKENS.reduce((s, t) => withLedger(s, t, FUNDED), emptyAccount) });

const newWorld = (): World => ({
  rep: { left: funded("left"), right: funded("right") },
  net: [], log: { left: [], right: [] }, time: 100n, drift: { left: 0n, right: 0n },
  submitted: { left: 0, right: 0 }, committed: { left: 0, right: 0 },
});

/** The tx a side writes at one step: its own locks, resolves and cancels, expiries, payments and credit. */
const txAt = (seed: number, run: number, step: number, side: Side, view: bigint): AccountTx => {
  const q = (k: number, n: number) => draw(seed, run, step, k, n);
  const token = TOKENS[q(1, TOKENS.length)] ?? tokenOf(1n);
  const slot = BigInt(1 + q(2, 6));
  const n = 1 + q(3, 8);
  const kind = q(4, 100);
  switch (true) {
    case kind < 30:
      return { _tag: "lock", token, hold: holdOf(side, BigInt(1 + q(5, 3)), slot, view + BigInt(1 + q(6, 5)), n) };
    case kind < 50: return { _tag: "resolve", token, id: holdId(slot), secret: secretOf(n) };
    case kind < 58: return { _tag: "cancel", token, id: holdId(slot) };
    case kind < 70: return { _tag: "expire", token, id: holdId(slot) };
    case kind < 90: return { _tag: "pay", token, amount: BigInt(1 + q(5, 20)) };
    default: return { _tag: "set_credit", token, limit: BigInt(30 + q(5, 60)) };
  }
};

/** A tx has entered `side`'s mempool: from here it must end committed, or refused with notice. */
const entered = (w: World, side: Side): World =>
  ({ ...w, submitted: { ...w.submitted, [side]: w.submitted[side] + 1 } });

const setRep = (w: World, side: Side, rep: AccountReplica): World => ({
  ...w,
  rep: { ...w.rep, [side]: rep },
  log: rep.head === w.rep[side].head ? w.log : { ...w.log, [side]: [...w.log[side], rep.head] },
});

const send = (w: World, from: Side, msgs: readonly Msg<AccountTx>[]): World =>
  ({ ...w, net: [...w.net, ...msgs.map((msg): Flight => ({ to: other(from), msg }))] });

const doPropose = (w: World, side: Side): World => {
  const out = propose(rulesOf(w, side), w.rep[side]);
  return send(setRep(w, side, out.replica), side, out.sent);
};

const deliver = (w: World, i: number): World => {
  const flight = w.net[i];
  if (flight === undefined) return w;
  const heard = receive(rulesOf(w, flight.to), w.rep[flight.to], flight.msg);
  const own = heard.outcome._tag === "committed_own" ? (w.rep[flight.to].pending?.frame.txs.length ?? 0) : 0;
  const counted: World = { ...w, committed: { ...w.committed, [flight.to]: w.committed[flight.to] + own } };
  const rest: World = { ...counted, net: w.net.filter((_, j) => j !== i) };
  return send(setRep(rest, flight.to, heard.replica), flight.to, heard.sent);
};

const isPrefix = (a: readonly string[], b: readonly string[]): boolean => a.every((x, i) => b[i] === x);

/** What must hold after every step, whatever the network did: one history, one state per head, the caps. */
const checked = (w: World, where: string): World => {
  const { left, right } = w.log;
  expect([where, isPrefix(left, right) || isPrefix(right, left)]).toEqual([where, true]);
  expect([where, Math.abs(left.length - right.length) <= 1]).toEqual([where, true]);
  if (w.rep.left.head === w.rep.right.head) expect(w.rep.left.state).toEqual(w.rep.right.state);
  SIDES.forEach((side) => {
    const holds = openHolds(w.rep[side].state);
    expect(holds.length).toBeLessThanOrEqual(MAX_HOLDS);
    expect(new Set(holds.map((h) => h.hashlock)).size).toBe(holds.length);
  });
  return w;
};

type Chaos = Readonly<{ seed: number; run: number; maxDrift: bigint; ticks: boolean }>;

const network = (w: World, c: Chaos, step: number): World => {
  const i = draw(c.seed, c.run, step, 20, w.net.length);
  const q = draw(c.seed, c.run, step, 21, 100);
  const flight = w.net[i];
  switch (true) {
    case flight === undefined: return w;
    case q < 10: return { ...w, net: w.net.filter((_, j) => j !== i) };
    case q < 20: return { ...w, net: [...w.net, ...(flight === undefined ? [] : [flight])] };
    default: return deliver(w, i);
  }
};

/** One random event: a tx at the door or in the queue, a propose, a network event, a resend, or a block. */
const stepOf = (w: World, c: Chaos, step: number): World => {
  const side: Side = draw(c.seed, c.run, step, 0, 2) === 0 ? "left" : "right";
  const k = draw(c.seed, c.run, step, 9, 100);
  const tx = txAt(c.seed, c.run, step, side, viewOfSide(w, side));
  const moved: World = c.maxDrift > 0n && step % 5 === 0
    ? { ...w, drift: {
      left: BigInt(draw(c.seed, c.run, step, 30, Number(c.maxDrift) + 1)),
      right: BigInt(draw(c.seed, c.run, step, 31, Number(c.maxDrift) + 1)),
    } }
    : w;
  switch (true) {
    case k < 25: {
      const door = submit(rulesOf(moved, side), moved.rep[side], tx);
      return door.ok ? setRep(entered(moved, side), side, door.value) : moved;
    }
    case k < 32: return setRep(entered(moved, side), side, queue(moved.rep[side], tx));
    case k < 50: return doPropose(moved, side);
    case k < 80: return network(moved, c, step);
    case k < 90: return send(moved, side, resend(moved.rep[side]));
    default: return c.ticks ? { ...moved, time: moved.time + 1n } : moved;
  }
};

/** The reliable phase: no drift, a still clock, no new txs; deliver everything in order, resend, propose again. */
const drain = (w: World, fuel: number): World =>
  (w.net.length === 0 || fuel === 0 ? w : drain(checked(deliver(w, 0), "settle"), fuel - 1));

const idle = (w: World): boolean =>
  w.net.length === 0 && SIDES.every((s) => w.rep[s].pending === undefined && w.rep[s].mempool.length === 0);

/** Progress, not just quiet: every tx a side let in is committed, or refused with notice; none is both or neither. */
const accounted = (w: World): boolean =>
  SIDES.every((s) => w.submitted[s] === w.committed[s] + w.rep[s].refused.length);

const settle = (w: World, rounds: number): World => {
  if (idle(w) || rounds === 0) return w;
  const resent = SIDES.reduce((acc, s) => send(acc, s, resend(acc.rep[s])), w);
  const proposed = SIDES.reduce(doPropose, drain(resent, 400));
  return settle(proposed, rounds - 1);
};

type Summary = Readonly<{ runs: number; stuck: number; lost: number; committed: number; collisions: number }>;

const runOne = (c: Chaos, steps: number) => {
  const start: World = { ...newWorld(), drift: { left: 0n, right: 0n } };
  const stepped = Array.from({ length: steps }, (_, i) => i).reduce<{ w: World; collisions: number }>((acc, step) => {
    const w = checked(stepOf(acc.w, c, step), `seed ${c.seed} run ${c.run} step ${step}`);
    const both = w.rep.left.pending !== undefined && w.rep.right.pending !== undefined;
    return { w, collisions: acc.collisions + (both ? 1 : 0) };
  }, { w: start, collisions: 0 });
  const calm: World = { ...stepped.w, drift: { left: 0n, right: 0n } };
  const committed = Math.max(calm.log.left.length, calm.log.right.length);
  const end = settle(calm, 60);
  const lost = idle(end) && !accounted(end);
  return { stuck: idle(end) ? 0 : 1, lost: lost ? 1 : 0, committed, collisions: stepped.collisions };
};

type Weather = Readonly<{ maxDrift: bigint; ticks: boolean }>;
const FROZEN: Weather = { maxDrift: 0n, ticks: false };
const MOVING: Weather = { maxDrift: 0n, ticks: true };
const DRIFTING: Weather = { maxDrift: LAG, ticks: true };

const simulate = (seed: number, runs: number, steps: number, weather: Weather): Summary => {
  const each = Array.from({ length: runs }, (_, run) => runOne({ seed, run, ...weather }, steps));
  return {
    runs,
    stuck: each.reduce((n, r) => n + r.stuck, 0),
    lost: each.reduce((n, r) => n + r.lost, 0),
    committed: each.reduce((n, r) => n + r.committed, 0),
    collisions: each.reduce((n, r) => n + r.collisions, 0),
  };
};

describe("account/frame R-FRAME-REFUSAL no run is stuck while J moves and the views drift", () => {
  test("R-FRAME-REFUSAL a frozen J: every run settles, and the round did real work", () => {
    const out = simulate(5, 300, 120, FROZEN);
    expect([out.stuck, out.lost]).toEqual([0, 0]);
    expect(out.committed).toBeGreaterThan(300);
    expect(out.collisions).toBeGreaterThan(300);
  }, 30_000);

  test("R-FRAME-REFUSAL J moves while frames are in flight, the views agree: no run stuck or losing a tx", () => {
    const out = simulate(5, 300, 120, MOVING);
    expect([out.stuck, out.lost]).toEqual([0, 0]);
  }, 30_000);

  test("R-FRAME-REFUSAL J moves and the views drift apart by up to LAG: no run stuck or losing a tx", () => {
    const out = simulate(6, 300, 120, DRIFTING);
    expect([out.stuck, out.lost]).toEqual([0, 0]);
  }, 30_000);
});
