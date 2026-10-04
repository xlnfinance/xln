// The clock rule for clauses (R-HTLC-CLOCK, R-CLOCK). Every time judgment about a clause is made in J height, on the
// deciding party's own view of the chain, and never on the Account clock or on a timestamp a counterparty wrote. The
// view is a `JView`, which `ownView` alone makes, and a deadline is a `JHeight`, which `jHeight` alone makes: a frame
// stamp is a plain bigint, so a decision made on one has to cast its way past the types.
//
// Each party's view lags the chain by at most `lag`, so two views differ by at most `lag` (R-DRIFT; the Runtime refuses
// to sign on a view that lags more). The reserve is what an expiry adds to the deciding party's view so that the other
// party's view is past the deadline too.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Brand, Tagged } from "../../kernel/core/tagged.ts";

/** Heights and deadlines are uint256 on the chain and in every signed body. */
export const MAX_HEIGHT = 2n ** 256n - 1n;

/** A height of the J chain: 0 .. 2^256-1. A clause's deadline is one. */
export type JHeight = Brand<bigint, "JHeight">;

/** The height a party acts on: its own view of the chain, made only by `ownView`. */
export type JView = Brand<bigint, "JView">;

export type HeightFault = Tagged<"bad_height", { height: bigint }>;

export const jHeight = (height: bigint): Result<JHeight, HeightFault> =>
  (height >= 0n && height <= MAX_HEIGHT ? ok(height as JHeight) : err({ _tag: "bad_height", height }));

/**
 * `depth` is how many blocks behind the chain's head the node's view is held (the depth its J loop reads at), or
 * undefined for a view that is the head, as the Arrival clock page has it: the page's reveal lands at once. A node that
 * reads at a depth asks for its reveal `depth + 1` heights earlier (see `revealOnChainDue`).
 */
export type ClockParams = Readonly<{
  lag: bigint; reserve: bigint; maxLockHorizon: bigint; depth: bigint | undefined; pace: Pace | undefined;
}>;

/**
 * What a node that forwards value needs to know of the chain's seconds (R-HOP-SLACK), all given by the deployment and
 * the node's own tick, none observed: `slot` is the seconds a block is due after the one before it, `missed` the
 * slots the chain may skip between two deadlines of one payment, and `pollDelay` the blocks that may pass, once a
 * block is final, before the node has read it (the bound the node's loop is checked against, never an average).
 */
export type Pace = Readonly<{ slot: bigint; missed: bigint; pollDelay: bigint }>;

export type ParamsFault =
  | Tagged<"lag_negative", { lag: bigint }>
  | Tagged<"depth_negative", { depth: bigint }>
  | Tagged<"reserve_below_lag", { lag: bigint; reserve: bigint }>
  | Tagged<"horizon_not_positive", { maxLockHorizon: bigint }>
  | Tagged<"slot_not_positive", { slot: bigint }>
  | Tagged<"missed_negative", { missed: bigint }>
  | Tagged<"poll_delay_negative", { pollDelay: bigint }>
  | Tagged<"reserve_below_react", { reserve: bigint; least: bigint }>;

/**
 * The lag is not negative and the reserve is in J heights and at least `lag`; less lets an expiry land while the payee
 * can still resolve (a negative lag admits a negative reserve: a clause is then live and expirable at its deadline).
 * With a pace, the hop a lock gives the next one (`reserve + lag`), less the slots the chain may miss in it, is more
 * than the node's reaction (`reactOf`): the hub has to hear a reveal, and claim it, inside the hop.
 */
export const clockParams = (
  lag: bigint, reserve: bigint, maxLockHorizon: bigint, depth?: bigint, pace?: Pace,
): Result<ClockParams, ParamsFault> => {
  if (lag < 0n) return err({ _tag: "lag_negative", lag });
  if (depth !== undefined && depth < 0n) return err({ _tag: "depth_negative", depth });
  if (reserve < lag) return err({ _tag: "reserve_below_lag", lag, reserve });
  if (maxLockHorizon < 1n) return err({ _tag: "horizon_not_positive", maxLockHorizon });
  const fault = pace === undefined ? undefined : paceFault(pace, reserve, depth ?? 0n);
  return fault === undefined ? ok({ lag, reserve, maxLockHorizon, depth, pace }) : err(fault);
};

const paceFault = (pace: Pace, reserve: bigint, depth: bigint): ParamsFault | undefined => {
  const least = depth + pace.pollDelay + pace.missed + 1n;
  switch (true) {
    case pace.slot < 1n: return { _tag: "slot_not_positive", slot: pace.slot };
    case pace.missed < 0n: return { _tag: "missed_negative", missed: pace.missed };
    case pace.pollDelay < 0n: return { _tag: "poll_delay_negative", pollDelay: pace.pollDelay };
    case reserve < least: return { _tag: "reserve_below_react", reserve, least };
    default: return undefined;
  }
};

/** The host door: the chain height a party acts on is the later of the host's finalized height and the context's. */
export const ownView = (finalizedJHeight: JHeight, contextJHeight: JHeight): JView =>
  (finalizedJHeight > contextJHeight ? finalizedJHeight : contextJHeight) as bigint as JView;

/** A clause is live through its deadline height: a resolve is on time while the view is at or before it. */
export const liveAt = (deadline: JHeight, view: JView): boolean => view <= deadline;

/** An expiry needs the view strictly past deadline plus reserve, for the payer proposing it and the payee accepting. */
export const expirableAt = (p: ClockParams, deadline: JHeight, view: JView): boolean => view > deadline + p.reserve;

/** The latest deadline a party admits for a new clause (N2, R-HORIZON-RESERVE). */
export const latestDeadline = (p: ClockParams, view: JView): bigint => view + p.maxLockHorizon + p.reserve;

const ONE_BLOCK = 1n;

/**
 * A payee whose resolve is still unacked reveals the secret on chain once its view reaches `deadline - lag` (the page).
 * A node that reads at a `depth` has a view that far behind the head and its reveal, sent at the head, lands one block
 * after it: it asks for the reveal at `deadline - lag - depth - 1`, so the reveal lands `lag` blocks before the
 * deadline whatever the depth is (a reveal one block early costs nothing; one that misses costs the whole clause, and
 * this does not depend on whether the contract's deadline check is strict or inclusive).
 */
export const revealOnChainDue = (p: ClockParams, deadline: JHeight, view: JView): boolean =>
  view + p.lag + (p.depth === undefined ? 0n : p.depth + ONE_BLOCK) >= deadline;

/**
 * The blocks a hub needs between the payee's reveal landing and its own claim landing: it hears the reveal at the
 * depth it reads at, within `pollDelay` of that, and then needs `lag` blocks to be included. There is one lag, the J
 * inclusion bound, and the claim on chain always keeps room for it, because the upstream peer may be quiet.
 */
export const reactOf = (p: ClockParams): bigint => (p.depth ?? 0n) + (p.pace?.pollDelay ?? 0n) + p.lag;

/** Rounds toward minus infinity, as the contract's seconds do: a deadline already past has negative blocks left. */
export const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b));

/**
 * The blocks that fit between the head block and a deadline's second, less the slots the chain may miss. The deadline
 * is in seconds, as the contract compares it: the head's second is that of the block at the node's view (the same
 * header as its height, never the tip's), and a chain that missed slots has fewer blocks in the same seconds.
 */
export const blocksLeft = (pace: Pace, headSeconds: bigint, deadlineSeconds: bigint): bigint =>
  floorDiv(deadlineSeconds - headSeconds, pace.slot) - pace.missed;

/** What a node reads of the chain's seconds: the second of the block at its view, if it knows it, and the time map. */
export type Reading = Readonly<{ headSeconds: bigint | undefined; secondsOf: (deadline: JHeight) => bigint }>;

/**
 * The height a deadline is read as, the only way one is read against the chain's seconds: it can shorten, never
 * lengthen. With no pace the deadline is as signed; with a pace and no head second there is no reading (the view).
 */
export const effectiveDeadline = (p: ClockParams, r: Reading, view: JView, deadline: JHeight): bigint => {
  if (p.pace === undefined) return deadline;
  const left = r.headSeconds === undefined ? 0n : blocksLeft(p.pace, r.headSeconds, r.secondsOf(deadline));
  return view + (deadline - view < left ? deadline - view : left);
};

/**
 * Whether a hub may forward a lock held until `inbound` as one held until `outbound` (R-HOP-SLACK): the onward lock
 * is live past the view, and every claim the hub may have to land fits between the two deadlines as read at the
 * view. The worst case is the payee's reveal landing at the onward deadline itself, so the gap is measured between
 * the two, not from now: the blocks the deadlines are apart, and the blocks that fit in the seconds they are apart
 * less the missed slots (which cancel between two effective deadlines but not in the seconds window itself).
 */
export const forwardable = (
  p: ClockParams, r: Reading, view: JView, inbound: JHeight, outbound: JHeight,
): boolean => {
  if (p.pace === undefined) return outbound > view;
  const { slot, missed } = p.pace;
  const seconds = floorDiv(r.secondsOf(inbound) - r.secondsOf(outbound), slot) - missed;
  const gap = inbound - outbound < seconds ? inbound - outbound : seconds;
  return effectiveDeadline(p, r, view, outbound) > view && gap >= reactOf(p) + ONE_BLOCK;
};
