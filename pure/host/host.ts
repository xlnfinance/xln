// The Host's moves (spec/transport/link.scm, R-DURABLE, R-X1). Nothing here reads a clock, a socket or a disk: the
// shell stamps `begin`, does each `persist` and reports it with `persisted`, and puts each `send` on the link.
//
//   receive    a message off the link is queued, or refused in place: a message for an Entity this Host does not
//              host is misrouted, and a sender over its bound is dropped. Neither halts anything.
//   heard      the J loop hands over a J height: the highest one waits for the next frame.
//   begin      the Runtime takes one frame: a waiting J height, else the queued inputs of the Entity first in line. The
//              row is staged and the Host asks for it to be made durable. Nothing leaves.
//   persisted  the row is durable, so it is the WAL's, and its outputs and chain actions leave, once. This is the only
//              function that makes a `send` or a `chain`, with `reopen`, which sends every committed output again.
//   reopen     a crash: the Runtime comes back from the durable rows alone, the queue is gone, nothing is believed
//              sent.
import { err, map, ok, type Result } from "../kernel/core/result.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import type { JHeight } from "../account/clause/clock.ts";
import type { EntityId, EntityState, JAction, Outbound } from "../entity/model.ts";
import type { Halt, Row, Runtime, Setup, Timestamp } from "../runtime/model.ts";
import { apply, commit, flush, recover } from "../runtime/tick.ts";
import type { Effect, Host, HostNotice, Item, Limits, Stepped } from "./model.ts";

/** The Runtime's four moves. A test swaps one for a planted bug; the shell never does. */
export type Tick = Readonly<{
  apply: typeof apply; commit: typeof commit; flush: typeof flush; recover: typeof recover;
}>;

export const TICK: Tick = { apply, commit, flush, recover };

export type BadLimits = Tagged<"bad_limits", { perPeer: number; perFrame: number }>;

/** A bound is at least one: a frame that takes no input, or a queue that holds none, would never move. */
export const limits = (perPeer: number, perFrame: number): Result<Limits, BadLimits> =>
  (Number.isInteger(perPeer) && Number.isInteger(perFrame) && perPeer >= 1 && perFrame >= 1
    ? ok({ perPeer, perFrame })
    : err({ _tag: "bad_limits", perPeer, perFrame }));

export const startHost = (runtime: Runtime, bounds: Limits): Host =>
  ({ runtime, limits: bounds, queue: [], height: undefined });

const hosts = (host: Host, id: EntityId): boolean => host.runtime.entities.has(id);

const queuedFrom = (host: Host, from: EntityId): number =>
  host.queue.filter((item) => item.input._tag === "peer_message" && item.input.from === from).length;

export type Received = Readonly<{ host: Host; notices: readonly HostNotice[] }>;

/** An input of the Host's own, a command or a timer. It has no peer, so no peer's bound applies. */
export const submit = (host: Host, item: Item): Host => ({ ...host, queue: [...host.queue, item] });

/**
 * A message off the link: queued for its Entity, or refused in place with a notice. `message.from` must be the
 * link-authenticated peer (Q-T-5, R-LINK-AUTH): the transport shell delivers that, this function only trusts it.
 */
export const receive = (host: Host, message: Outbound): Received => {
  const { from, to, msg } = message;
  switch (true) {
    case !hosts(host, to): return { host, notices: [{ _tag: "misrouted", to, from }] };
    case queuedFrom(host, from) >= host.limits.perPeer: return { host, notices: [{ _tag: "queue_full", from }] };
    default: return { host: submit(host, { to, input: { _tag: "peer_message", from, msg } }), notices: [] };
  }
};

/**
 * A J height from the J loop. It waits only if it is above both the one already waiting and the Runtime's view, since
 * a height that does not rise would still be a frame of every Entity and a row of the WAL, and a quiet chain announces
 * its height again at every poll. The highest waiting height is taken by one frame.
 *
 * A precondition the J loop delivers, as the shell does `from` (R-HEIGHT-ORDER): it hands a height over only after the
 * J events of its delivery are in the WAL, because a height goes ahead of the queue, and it moves the watcher's cursor
 * only once a committed `j_height` row holds the height, because a waiting height is lost in a crash.
 */
export const heard = (host: Host, height: JHeight): Host =>
  (height > host.runtime.view && (host.height === undefined || height > host.height) ? { ...host, height } : host);

/** No frame is staged: the Host can begin one. */
export const idle = (host: Host): boolean => host.runtime.staged === undefined;

const persist = (row: Row | undefined): readonly Effect[] => (row === undefined ? [] : [{ _tag: "persist", row }]);

const settled = (host: Host, runtime: Runtime): Stepped =>
  ({ host: { ...host, runtime }, effects: persist(runtime.staged) });

/** A waiting J height is a frame of every Entity, and the Runtime needs it before any deadline is judged. */
const beginHeight = (host: Host, height: JHeight, at: Timestamp, ops: Tick): Result<Stepped, Halt> =>
  map(ops.apply(host.runtime, { _tag: "j_height", at, height }), (runtime) =>
    settled({ ...host, height: undefined }, runtime));

/** The Entity first in line takes its queued inputs, up to the frame's bound, in arrival order. */
const beginEntity = (host: Host, first: Item, at: Timestamp, ops: Tick): Result<Stepped, Halt> => {
  const places = host.queue.flatMap((item, i) => (item.to === first.to ? [i] : [])).slice(0, host.limits.perFrame);
  const inputs = places.map((i) => (host.queue[i] as Item).input);
  return map(ops.apply(host.runtime, { _tag: "entity", at, to: first.to, inputs }), (runtime) =>
    settled({ ...host, queue: host.queue.filter((_, i) => !places.includes(i)) }, runtime));
};

/**
 * One frame: a waiting J height, else the Entity first in line. Between a `begin` and its `persisted` the Host is not
 * idle, and a second `begin` changes nothing.
 */
export const begin = (host: Host, at: Timestamp, ops: Tick = TICK): Result<Stepped, Halt> => {
  const first = host.queue[0];
  if (!idle(host)) return ok({ host, effects: [] });
  if (host.height !== undefined) return beginHeight(host, host.height, at, ops);
  return first === undefined ? ok({ host, effects: [] }) : beginEntity(host, first, at, ops);
};

const leaves = (leaving: readonly Outbound[], chain: readonly JAction[]): readonly Effect[] => [
  ...leaving.map((message): Effect => ({ _tag: "send", message })),
  ...chain.map((action): Effect => ({ _tag: "chain", action })),
];

/** The shell made the staged row durable: it is the WAL's now, and the outputs and chain actions not yet sent leave. */
export const persisted = (host: Host, ops: Tick = TICK): Result<Stepped, Halt> =>
  map(ops.commit(host.runtime), (committed) => {
    const flushed = ops.flush(committed);
    return { host: { ...host, runtime: flushed.runtime }, effects: leaves(flushed.leaving, flushed.chain) };
  });

/** After a crash: the Runtime from the durable rows, an empty queue, and every committed output and action again. */
export const reopen = (
  setup: Setup, genesis: readonly EntityState[], wal: readonly Row[], bounds: Limits, ops: Tick = TICK,
): Result<Stepped, Halt> =>
  map(ops.recover(setup, genesis, wal), (runtime) => {
    const flushed = ops.flush(runtime);
    return { host: startHost(flushed.runtime, bounds), effects: leaves(flushed.leaving, flushed.chain) };
  });
