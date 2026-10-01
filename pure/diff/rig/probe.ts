// The capacity probe. The walk's draws send payments of at most 600 against credit of up to 20,000, so no draw is ever refused for capacity and the
// lane has nothing to compare there (review A of #69, F1). After the walk has ended clean, the probe sends what only an edge can tell apart, to
// Accounts that hold nothing in flight, and the lane and the properties judge every frame:
//   a direct payment one above the Account's out capacity (both sides must refuse it), then one exactly at it (both must take it);
//   a lock one above the out capacity (refused);
//   a lock whose amount fits the capacity but not what an open lock's hold leaves of it, sent in the same input as that lock (refused);
//   a lock one above what a committed open lock's hold leaves, sent while that lock is still open (refused at the Entity, before any Account frame).
// A lock costs its sender the amount plus the hub's fee, a share of the amount (11,200 on 200 million; the draws set under 100 ppm), which would let the
// fee alone refuse a lock the hold is meant to refuse and test no hold. So the lock probes first pay the Account's capacity down to SMALL, where every
// amount is under 6,666 and a fee of under 100 ppm of it rounds to nothing: the window between "what the capacity admits" and "what the hold leaves"
// is then exactly HOLD wide.
// It runs after the draws, so the walk's own random stream, and every pinned seed's frames, are the ones they were. A step that was not
// refused (og's capacity moved by more than the step meant to take) counts for nothing, so a property that never saw a refusal shows as unfired (fired.ts).
import { deriveDelta } from "../../../core/account/utils.ts";
import { active, activePairs, isLeft, one, pairs, quiet, replica } from "../draws/world-view.ts";
import type { EntityTx } from "../../xln.ts";
import { judgeFrame, type Memory } from "./frame-checks.ts";
import { HUB, SPOKES, type World } from "./world.ts";

/** Quiet frames to wait for the Accounts to settle after an input. */
const PATIENCE = 12;
/** The capacity the lock probes work at, a hold the probe opens on it, and how far under the raw capacity the lock beside it sits. */
const SMALL = 5000n;
const HOLD = 100n;
const SLACK = 10n;

type Probed = Readonly<{ lines: readonly string[]; memory: Memory }>;
type OgSide = Readonly<{ deltas?: ReadonlyMap<number, Parameters<typeof deriveDelta>[0]>; locks?: ReadonlyMap<string, unknown>; swapOffers?: ReadonlyMap<string, unknown> }>;

const sideOf = (w: World, x: number, y: number): OgSide | undefined => replica(w, x, y)?.state as OgSide | undefined;
/** og deriveDelta of x's side of its Account with y: what x can send now, holds included. */
const outCapacity = (w: World, x: number, y: number): bigint => {
  const delta = sideOf(w, x, y)?.deltas?.get(1);
  return delta === undefined ? 0n : deriveDelta(delta, isLeft(w, x, y)).outCapacity;
};
/** Both sides active, nothing in flight on either, and no clause open on x's side. */
const free = (w: World, x: number, y: number): boolean =>
  active(w, x, y) && active(w, y, x) && quiet(w, x, y)
  && (sideOf(w, x, y)?.locks?.size ?? 0) === 0 && (sideOf(w, x, y)?.swapOffers?.size ?? 0) === 0;
/** Every Account is out of flight, so a lock the probe opened has resolved. */
const allQuiet = (w: World): boolean => pairs(w).every(([x, y]) => quiet(w, x, y) && (sideOf(w, x, y)?.locks?.size ?? 0) === 0);

const tickJudged = async (w: World, name: string, memory: Memory, users: Parameters<World["lane"]["tick"]>[1]): Promise<Probed> => {
  const diffs = await w.lane.tick([], users);
  const framed = await judgeFrame(w, name, memory);
  return { lines: [...diffs, ...framed.violations], memory: framed.memory };
};
/** Quiet frames until every Account is out of flight, or a frame says something. */
const settle = async (w: World, name: string, run: Probed, left = PATIENCE): Promise<Probed> =>
  run.lines.length > 0 || left === 0 || allQuiet(w) ? run : settle(w, name, await tickJudged(w, name, run.memory, []), left - 1);

const bump = (w: World, counter: string): void => { w.coverage.actions[counter] = (w.coverage.actions[counter] ?? 0) + 1; };

/** One input from `from`, settled; `counter` rises when og's out capacity of `watch` fell by no more than `taken` (what the input was meant to take, the rest refused). */
const refused = async (
  w: World, name: string, run: Probed, counter: string, from: number, txs: readonly EntityTx[], watch: readonly [number, number], taken = 0n,
): Promise<Probed> => {
  const had = outCapacity(w, watch[0], watch[1]);
  const sent = await settle(w, name, await tickJudged(w, name, run.memory, one(w, from, txs).users));
  if (sent.lines.length === 0 && had - outCapacity(w, watch[0], watch[1]) <= taken) bump(w, counter);
  return sent;
};

/** Quiet frames until s's Account with the hub shows an open lock; then one lock above what is left, as it stands, while the first is open. */
const openLock = async (w: World, name: string, run: Probed, s: number, u: number, left = 4): Promise<Probed> => {
  const open = (sideOf(w, s, HUB)?.locks?.size ?? 0) > 0;
  if (run.lines.length > 0 || left === 0) return run;
  return open
    ? refused(w, name, run, "P2:probeHold", s, [w.htlc(s, u, outCapacity(w, s, HUB) + 1n)], [s, HUB])
    : openLock(w, name, await tickJudged(w, name, run.memory, []), s, u, left - 1);
};

/** Spokes s and u with a route through the hub, s's Account with the hub free and holding room for the hold and the lock beside it. */
const lockPair = (w: World): readonly [number, number] | undefined =>
  SPOKES.flatMap((s) => SPOKES.filter((u) => u !== s).map((u) => [s, u] as const))
    .find(([s, u]) => w.routable(s, u) && free(w, s, HUB) && free(w, HUB, u) && outCapacity(w, s, HUB) > HOLD + SLACK);

/** The probe over a walk that ended clean; the lines it returns are the lane's diffs and the properties' violations, none when both sides agree throughout. */
export const probeCapacity = async (w: World, memory: Memory): Promise<Probed> => {
  const start = await settle(w, "capacity probe", { lines: [], memory });
  const route = lockPair(w);
  const lock = async (run: Probed): Promise<Probed> => {
    if (route === undefined || run.lines.length > 0) return run;
    const [s, u] = route;
    const down = await payDown(run, s);
    if (down.lines.length > 0) return down;
    const cap = outCapacity(w, s, HUB);
    // the lock above the capacity, alone; then a lock the raw capacity admits beside one whose hold it does not
    const over = await refused(w, "capacity probe", down, "P2:probeLock", s, [w.htlc(s, u, cap + 1n)], [s, HUB]);
    const held = over.lines.length === 0 && free(w, s, HUB) ? outCapacity(w, s, HUB) : 0n;
    const same = held > HOLD + SLACK
      ? await refused(w, "capacity probe", over, "P2:probeHoldSame", s, [w.htlc(s, u, HOLD), w.htlc(s, u, held - SLACK)], [s, HUB], HOLD + SLACK)
      : over;
    return same.lines.length === 0 ? beside(same, s, u) : same;
  };
  /** Pay s's Account with the hub down to SMALL by a direct payment, which both sides accept and the lane and the properties judge. */
  const payDown = async (run: Probed, s: number): Promise<Probed> => {
    const cap = outCapacity(w, s, HUB);
    return run.lines.length > 0 || cap <= SMALL
      ? run
      : settle(w, "capacity probe", await tickJudged(w, "capacity probe", run.memory, one(w, s, [w.direct(s, HUB, cap - SMALL)]).users));
  };
  /** A lock open and committed: one more above what its hold leaves is refused at the Entity, which reads the committed hold. */
  const beside = async (run: Probed, s: number, u: number): Promise<Probed> => {
    const settled = await settle(w, "capacity probe", run);
    return settled.lines.length > 0 || !free(w, s, HUB) || outCapacity(w, s, HUB) <= HOLD + SLACK
      ? settled
      : openLock(w, "capacity probe", await tickJudged(w, "capacity probe", settled.memory, one(w, s, [w.htlc(s, u, HOLD)]).users), s, u);
  };
  const direct = async (run: Probed): Promise<Probed> => {
    const pair = activePairs(w).find(([x, y]) => free(w, x, y));
    if (pair === undefined || run.lines.length > 0) return run;
    const [x, y] = pair;
    const cap = outCapacity(w, x, y);
    const over = await refused(w, "capacity probe", run, "P2:probeDirect", x, [w.direct(x, y, cap + 1n)], [x, y]);
    return over.lines.length > 0 || cap === 0n
      ? over
      : settle(w, "capacity probe", await tickJudged(w, "capacity probe", over.memory, one(w, x, [w.direct(x, y, cap)]).users));
  };
  return direct(await lock(start));
};
