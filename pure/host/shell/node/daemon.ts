// One Runtime's shell, running: the Host over its WAL and the chain (drive.ts), a listening port, the connections to
// its peers (mesh.ts) and a timer. It is the one place that owns the clock of a node and the order things happen in:
// every event (a command, a connection, a line, a tick, which also polls the J loop) is a message in one queue, handled
// whole before the next, so the Station is only ever touched by one move at a time (R-DURABLE).
//
// The state is a value, and each move gives the next one. What leaves goes out only from a move that made its rows
// durable; a message for a peer that has no connection up is dropped, and the timer is what sends it again: an Account
// that is still waiting for the same frame at two ticks is told `resend_due`
// (spec/transport/link.scm). A line that is not the peer's ends its connection (R-LINK-AUTH). A fault of the disk or
// of the chain ends the daemon's work and is what every later request answers: it never goes on after a row it could
// not keep.
import { EventEmitter, on } from "node:events";
import type { ChainFacts, EntityId, EntityInput, Outbound } from "../../../entity/model.ts";
import type { WatchFault, Watch } from "../../../j/watch.ts";
import { mapDelete, mapSet } from "../../../kernel/core/collections.ts";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { heard, submit } from "../../host.ts";
import type { HostNotice } from "../../model.ts";
import {
  command, drain, pump, start, type Boot, type DriveFault, type Shell, type Station, type Turn,
} from "../drive/drive.ts";
import { MAX_LINE, type Key, type Peer, type RuntimeId } from "../link/link.ts";
import {
  accepted, closed, dialed, line, linked, route, startMesh, wanted, type ConnId, type Mesh, type Refused, type Write,
} from "../mesh/mesh.ts";
import {
  beginAt, NO_CARRY, poll, resumeAt, windowsOf, type BadPeer, type BadSecret, type Carry, type Delivery, type JFault,
  type Standing, type Stall, type WatchConfig,
} from "../watch/loop.ts";
import type { PortFault } from "../submit/chain.ts";
import { waitsOf } from "../../../entity/paybook/paybook.ts";
import { dialTcp, type Listener, type SocketFault, type Wire } from "./link/socket.ts";

/** What a node is made of: its shell, its Entity, its key, who its peers are, and how often its timer runs. */
export type Config = Readonly<{
  shell: Shell; boot: Boot; key: Key; table: readonly Peer[]; tickMs: number; nonce: () => Uint8Array;
  /** A message the link is to lose on its way out: the chaos a test makes. A node that runs for real loses none. */
  lost: (message: Outbound) => boolean;
  /** The chain's J events for the Entity, read at depth by the node's own loop; none when the node has no J loop. */
  watch: WatchConfig | undefined;
}>;

export type Stopped = Tagged<"stopped">;

/**
 * A node that reads the chain at `depth` has a view `depth` blocks behind the chain's head. Its own reveal as a payee
 * is sent at the head and lands one block after it, so the clock asks for it `lag + depth + 1` heights before the
 * deadline (`ClockParams.depth`, R-HTLC-CLOCK) and it lands `lag` blocks before the deadline, whatever the depth. A
 * `lag` of `depth` or less is refused all the same: the hop a lock gives the next one, `reserve + lag`, is what
 * covers hearing another node's reveal at that depth. A clock whose `depth` is not the depth the node reads at would
 * ask for the reveal too late or too early, so it is refused too (`clock_depth_off`).
 */
export type ClockBelowDepth = Tagged<"clock_below_depth", { lag: bigint; depth: bigint }>;
export type ClockDepthOff = Tagged<"clock_depth_off", { clock: bigint | undefined; depth: bigint }>;

/** What ends a node's work: a disk, the chain's submit path, the Runtime, or a watcher invariant broken. */
export type NodeFault = DriveFault | WatchFault | BadPeer | BadSecret;

export type Fault = NodeFault | Stopped;

/** Lines written and lines delivered to the Host, and messages dropped for want of a connection. */
export type Counts = Readonly<{ sent: number; heard: number; dropped: number }>;

/** What the node is, right now: the Station, the counts, the last notices and refusals, and who is connected. */
export type Look = Readonly<{
  station: Station; counts: Counts; notices: readonly HostNotice[]; refused: readonly string[];
  linked: readonly RuntimeId[]; fatal: NodeFault | undefined; busy: boolean;
  /** The block the J loop has delivered up to, and why its last poll failed (the next tick polls again). */
  cursor: bigint | undefined; watchFault: string | undefined;
}>;

export type Daemon = Readonly<{
  /** A command for the node's Entity, run until the Host has nothing queued. */
  tell: (input: EntityInput) => Promise<Result<Turn, Fault>>;
  look: () => Promise<Look>;
  /** The connections, the timer and the files end, and what the node was is given back. */
  stop: () => Promise<Look>;
}>;

type Reply<T> = (value: T) => void;

type Mail =
  | Tagged<"tell", { input: EntityInput; reply: Reply<Result<Turn, Fault>> }>
  | Tagged<"look", { reply: Reply<Look> }>
  | Tagged<"accepted", { wire: Wire }>
  | Tagged<"dialed", { peer: Peer; wire: Result<Wire, SocketFault> }>
  | Tagged<"line", { conn: ConnId; text: string; done: () => void }>
  | Tagged<"closed", { conn: ConnId }>
  | Tagged<"tick">;

type Rig = Readonly<{ config: Config; bus: EventEmitter; self: EntityId; listener: Listener }>;

type State = Readonly<{
  station: Station;
  mesh: Mesh;
  wires: ReadonlyMap<ConnId, Wire>;
  next: ConnId;
  dialing: ReadonlySet<RuntimeId>;
  /** The Accounts that were waiting for a frame at the last tick, with the head and attempt they waited at. */
  stalled: ReadonlyMap<EntityId, string>;
  counts: Counts;
  notices: readonly HostNotice[];
  refused: readonly string[];
  fatal: NodeFault | undefined;
  cursor: Watch | undefined;
  /** The head block the probe last asked a transaction of, while the node's Entity is blind. */
  probed: bigint | undefined;
  /** Whether the notice that the provider does not trace was told since the node last was shown a trace. */
  untraced: boolean;
  watchFault: string | undefined;
  /** What the J loop carries between polls: the transactions it cannot read, their reads, the events held back. */
  carry: Carry;
  timer: ReturnType<typeof setTimeout> | undefined;
}>;

const RECENT = 64;

const recent = <T>(items: readonly T[]): readonly T[] => items.slice(-RECENT);

const post = (rig: Rig, mail: Mail): void => {
  rig.bus.emit("mail", mail);
};

// ---- what the Station is waiting for

const waitingOn = (station: Station, self: EntityId): ReadonlyMap<EntityId, string> =>
  new Map([...(station.host.runtime.entities.get(self)?.accounts ?? [])].flatMap(([peer, account]) =>
    (account.pending === undefined ? [] : [[peer, `${account.head}:${account.attempt}`] as const])));

const busy = (station: Station): boolean =>
  station.submitter.jbatch.phase._tag === "inflight" || station.submitter.jbatch.draft.length > 0
  || station.submitter.waiting.size > 0;

const resending = (state: State, self: EntityId, peers: readonly EntityId[]): State => ({
  ...state,
  station: {
    ...state.station,
    host: peers.reduce((host, peer) => submit(host, { to: self, input: { _tag: "resend_due", peer } }),
      state.station.host),
  },
});

// ---- connections

const reading = (rig: Rig, conn: ConnId, wire: Wire, rest: string): Promise<void> =>
  wire.next(rest).then((got) => {
    if (got === undefined) {
      post(rig, { _tag: "closed", conn });
      return undefined;
    }
    return new Promise<void>((done) => { post(rig, { _tag: "line", conn, text: got.line, done }); })
      .then(() => reading(rig, conn, wire, got.rest));
  });

const withWire = (rig: Rig, state: State, wire: Wire): State => {
  void reading(rig, state.next, wire, "");
  return { ...state, wires: mapSet(state.wires, state.next, wire), next: state.next + 1 };
};

const without = (state: State, conn: ConnId): State => ({
  ...state, mesh: closed(state.mesh, conn), wires: mapDelete(state.wires, conn),
});

/** A write that fails is a connection that is going, and its read says so. */
const put = async (state: State, write: Write): Promise<void> => {
  await state.wires.get(write.conn)?.write(write.text);
};

const endpointOf = (text: string): Result<Readonly<{ host: string; port: number }>, SocketFault> => {
  const cut = text.lastIndexOf(":");
  const port = Number(text.slice(cut + 1));
  return cut > 0 && Number.isInteger(port) && port > 0 && port < 65_536
    ? ok({ host: text.slice(0, cut), port })
    : err({ _tag: "socket", reason: `no host:port in ${text}` });
};

const dialling = (rig: Rig, peer: Peer): void => {
  const at = endpointOf(peer.endpoint);
  const made: Promise<Result<Wire, SocketFault>> = at.ok
    ? dialTcp(at.value.host, at.value.port, MAX_LINE)
    : Promise.resolve(err(at.error));
  void made.then((wire) => { post(rig, { _tag: "dialed", peer, wire }); });
};

/** Every peer this Runtime dials and has no connection to, and none being made, is dialed. */
const redialed = (rig: Rig, state: State): State => {
  const todo = wanted(state.mesh).filter((peer) => !state.dialing.has(peer.runtime));
  todo.forEach((peer) => { dialling(rig, peer); });
  return { ...state, dialing: new Set([...state.dialing, ...todo.map((peer) => peer.runtime)]) };
};

const connected = async (rig: Rig, state: State, peer: Peer, made: Result<Wire, SocketFault>): Promise<State> => {
  const open = { ...state, dialing: new Set([...state.dialing].filter((runtime) => runtime !== peer.runtime)) };
  if (!made.ok) return open;
  const hello = dialed(open.mesh, peer, open.next, rig.config.nonce());
  const next = { ...withWire(rig, open, made.value), mesh: hello.mesh };
  await put(next, hello.write);
  return next;
};

const arrived = (rig: Rig, state: State, wire: Wire): State =>
  ({ ...withWire(rig, state, wire), mesh: accepted(state.mesh, state.next) });

// ---- what leaves

/**
 * The Host's messages, each on its peer's connection; one with no connection up is dropped, and the timer is its
 * resend.
 */
const leaving = async (rig: Rig, state: State, sent: readonly Outbound[]): Promise<State> => {
  const going = sent.filter((message) => !rig.config.lost(message));
  const routed = route(state.mesh, going);
  await Promise.all(routed.writes.map((write) => put(state, write)));
  const counts = {
    ...state.counts, sent: state.counts.sent + routed.writes.length,
    dropped: state.counts.dropped + routed.dropped.length + sent.length - going.length,
  };
  return { ...state, mesh: routed.mesh, counts };
};

const concluded = (rig: Rig, state: State, made: Result<Turn, DriveFault>): Promise<State> =>
  (made.ok
    ? leaving(rig, { ...state, station: made.value.station }, made.value.sent)
    : Promise.resolve({ ...state, fatal: made.error }));

const refusedLine = (state: State, refused: Refused): State => {
  state.wires.get(refused.conn)?.close();
  return { ...without(state, refused.conn), refused: recent([...state.refused, refused.fault._tag]) };
};

const heardLine = async (rig: Rig, state: State, conn: ConnId, text: string): Promise<State> => {
  const got = line(state.mesh, state.station.host, conn, text, rig.config.nonce());
  if (!got.ok) return refusedLine(state, got.error);
  const { mesh, host, notices, write, delivered } = got.value;
  if (write !== undefined) await put(state, write);
  const counts = { ...state.counts, heard: state.counts.heard + (delivered ? 1 : 0) };
  const next = {
    ...state, mesh, counts, station: { ...state.station, host }, notices: recent([...state.notices, ...notices]),
  };
  return delivered ? concluded(rig, next, await drain(rig.config.shell, next.station)) : next;
};

// ---- moves of the Station

type Run = (station: Station) => Promise<Result<Turn, DriveFault>>;

const ran = async (rig: Rig, state: State, run: Run, reply: Reply<Result<Turn, Fault>>): Promise<State> => {
  const made = await run(state.station);
  const next = await concluded(rig, state, made);
  reply(made);
  return next;
};

// ---- the J loop

const chainOf = (rig: Rig, state: State): ReadonlyMap<EntityId, ChainFacts> =>
  state.station.host.runtime.entities.get(rig.self)?.chain ?? new Map();

/**
 * The cursor: the chain's own block at the Runtime's view, which the WAL holds, unless the node has one. A restart
 * that finds the Entity was told events of an Account were held back begins before the first of them (`resumeAt`).
 */
const cursorOf = (rig: Rig, watch: WatchConfig, state: State): Promise<Result<Watch, JFault>> =>
  (state.cursor === undefined
    ? beginAt(watch, resumeAt(state.station.host.runtime.view, chainOf(rig, state)))
    : Promise.resolve(ok(state.cursor)));

const NO_WAITS = { lastHeard: new Map<EntityId, bigint>(), behind: new Set<EntityId>(), lost: new Set<EntityId>() };

/** What the loop needs of the Entity: where waiting for a secret stops paying, who is held back, and the view. */
const standing = (rig: Rig, state: State): Standing => {
  const { runtime } = state.station.host;
  const entity = runtime.entities.get(rig.self);
  const waits = entity === undefined ? NO_WAITS : waitsOf(entity, rig.config.boot.setup.clock);
  const pending = new Map([...chainOf(rig, state)].flatMap(([peer, facts]) =>
    (facts.readWaits === undefined ? [] : [[peer, facts.readWaits] as const])));
  return { ...waits, view: runtime.view, pending };
};

/** A fault of the node's reads of the chain is tried again at the next tick; one of the watcher's checks is final. */
const heldUp = (state: State, fault: JFault): State =>
  (fault._tag === "port" ? { ...state, watchFault: `${fault.call}: ${fault.reason}` } : { ...state, fatal: fault });

/**
 * A transaction the node cannot read is told once (`watch_stalled`), and again only when the class of its fault (the
 * call that failed) is another: a stall of many polls with a changing reason is one notice, not one per poll.
 */
export const stallNotices = (was: Carry, stalls: readonly Stall[]): readonly HostNotice[] =>
  stalls.filter((s) => was.failing.get(s.tx)?.fault.call !== s.fault.call)
    .map((s): HostNotice => ({ _tag: "watch_stalled", tx: s.tx, reason: s.fault.reason }));

const watchFaultOf = (stalls: readonly Stall[]): string | undefined =>
  stalls.map((s) => `${s.fault.call}: ${s.fault.reason}`).at(0);

/**
 * A node that may hold value and finds its provider answers no call trace at run time is told to its Entity
 * (`j_blind`), which forwards no lock from then on; the node keeps watching and defending every Account, which an
 * exit would stop. It is told once: the Entity knows (`blind`). The probe then asks for a trace at each new head.
 */
const blinding = (rig: Rig, state: State, delivery: Delivery): readonly EntityInput[] => {
  const known = state.station.host.runtime.entities.get(rig.self)?.blind === true;
  return rig.config.watch?.value === true && delivery.untraceable && !known ? [{ _tag: "j_blind", boot: false }] : [];
};

/** The provider does not trace: told once for each time the node goes blind, naming what said so. */
const untracedNotices = (state: State, why: string | undefined): readonly HostNotice[] =>
  (why === undefined || state.untraced ? [] : [{ _tag: "no_call_trace", why }]);

/** The events are in the WAL before the height is; the cursor moves only after the height's row (R-HEIGHT-ORDER). */
const delivered = async (rig: Rig, state: State, delivery: Delivery): Promise<State> => {
  const { shell } = rig.config;
  const inputs = [...blinding(rig, state, delivery), ...delivery.events];
  const queued = inputs.reduce((host, input) => submit(host, { to: rig.self, input }), state.station.host);
  const first = await concluded(rig, state, await drain(shell, { ...state.station, host: queued }));
  if (first.fatal !== undefined) return first;
  const height = { ...first.station, host: heard(first.station.host, delivery.height) };
  const second = await concluded(rig, first, await drain(shell, height));
  const { carry, stalls } = delivery;
  const said = rig.config.watch?.value === true && delivery.untraceable
    ? untracedNotices(state, "a transaction's call trace: no such method") : [];
  const told = recent([...second.notices, ...stallNotices(state.carry, stalls), ...said]);
  return second.fatal === undefined
    ? {
      ...second, cursor: delivery.watch, carry, notices: told, watchFault: watchFaultOf(stalls), fatal: undefined,
      untraced: second.untraced || said.length > 0,
    }
    : second;
};

const listening = async (rig: Rig, state: State): Promise<State> => {
  const { watch } = rig.config;
  if (watch === undefined) return state;
  const cursor = await cursorOf(rig, watch, state);
  if (!cursor.ok) return heldUp(state, cursor.error);
  const next = { ...state, cursor: cursor.value };
  const windows = windowsOf(watch.hosted, chainOf(rig, state));
  if (!windows.ok) return heldUp(next, windows.error);
  const got = await poll(watch.port, cursor.value, watch.hosted, windows.value, state.carry, standing(rig, state));
  if (!got.ok) return heldUp(next, got.error);
  const quiet = { ...next, watchFault: undefined };
  return got.value === undefined ? quiet : delivered(rig, quiet, got.value);
};

/** The Entity is told the provider was shown tracing calls: it forwards again (R-WATCH-CALLDATA). */
const sighted = async (rig: Rig, state: State): Promise<State> => {
  const input: EntityInput = { _tag: "j_blind_over" };
  const host = submit(state.station.host, { to: rig.self, input });
  return concluded(rig, { ...state, untraced: false }, await drain(rig.config.shell, { ...state.station, host }));
};

/**
 * While the Entity of a node that may hold value is blind, the probe asks the first transaction of each new head
 * block for a `callTracer` tree (no chosen window of blocks: a block with none waits for the next); the first tree
 * ends the blindness. A provider that answers no method, or something else, is asked again at the next head; a fault
 * of the node's reads is tried again at the next tick.
 */
const probing = async (rig: Rig, state: State): Promise<State> => {
  const { watch } = rig.config;
  const blind = state.station.host.runtime.entities.get(rig.self)?.blind === true;
  if (watch?.value !== true || !blind || state.fatal !== undefined) return state;
  const head = await watch.port.head();
  if (!head.ok) return heldUp(state, head.error);
  if (state.probed === head.value) return state;
  const probe = await watch.port.traced(head.value);
  if (!probe.ok) return heldUp(state, probe.error);
  const said = probe.value === "none" ? untracedNotices(state, "the probe: no call tree") : [];
  const untraced = state.untraced || said.length > 0;
  const asked = { ...state, probed: head.value, notices: recent([...state.notices, ...said]), untraced };
  return probe.value === "traces" ? sighted(rig, asked) : asked;
};

const tick = async (rig: Rig, state: State): Promise<State> => {
  const now = waitingOn(state.station, rig.self);
  const due = [...now].filter(([peer, mark]) => state.stalled.get(peer) === mark).map(([peer]) => peer);
  const resent = resending({ ...state, stalled: now }, rig.self, due);
  const drained = await drain(rig.config.shell, resent.station);
  const made = drained.ok && busy(drained.value.station) ? await pump(rig.config.shell, drained.value) : drained;
  const next = await probing(rig, await listening(rig, await concluded(rig, resent, made)));
  const timer = setTimeout(() => { post(rig, { _tag: "tick" }); }, rig.config.tickMs);
  return { ...redialed(rig, next), timer };
};

const replied = <T>(reply: Reply<T>, value: T, state: State): Promise<State> => {
  reply(value);
  return Promise.resolve(state);
};

const looked = (state: State): Look => ({
  station: state.station, counts: state.counts, notices: state.notices, refused: state.refused,
  linked: linked(state.mesh), fatal: state.fatal, busy: busy(state.station),
  cursor: state.cursor?.applied.number, watchFault: state.watchFault,
});

const handled = (rig: Rig, state: State, mail: Mail): Promise<State> => {
  switch (mail._tag) {
    case "look": return replied(mail.reply, looked(state), state);
    case "accepted": return Promise.resolve(arrived(rig, state, mail.wire));
    case "closed": return Promise.resolve(without(state, mail.conn));
    case "tell": return ran(
      rig, state, (station) => command(rig.config.shell, station, rig.self, mail.input), mail.reply,
    );
    case "dialed": return connected(rig, state, mail.peer, mail.wire);
    case "line": return heardLine(rig, state, mail.conn, mail.text).finally(mail.done);
    case "tick": return tick(rig, state);
  }
};

/** A request that reaches a node whose work ended is answered with the fault that ended it. */
const answered = (rig: Rig, state: State, mail: Mail): Promise<State> => {
  if (state.fatal === undefined) return handled(rig, state, mail);
  switch (mail._tag) {
    case "tell": return replied(mail.reply, err(state.fatal), state);
    case "line": mail.done(); return Promise.resolve(state);
    case "look": case "accepted": case "closed": return handled(rig, state, mail);
    case "dialed": case "tick": return Promise.resolve(state);
  }
};

const run = async (rig: Rig, mails: AsyncIterator<readonly unknown[]>, state: State): Promise<State> => {
  const got = await mails.next();
  return got.done ? state : run(rig, mails, await answered(rig, state, got.value[0] as Mail));
};

/** The connections, the timer and the two files end; a file that will not close is the fault the node ends with. */
const ended = async (rig: Rig, state: State): Promise<State> => {
  clearTimeout(state.timer);
  state.wires.forEach((wire) => { wire.close(); });
  rig.listener.close();
  const files = await Promise.all([rig.config.shell.wal.close(), rig.config.shell.io.journal.close()]);
  const failed = files.find((closing) => !closing.ok);
  return failed !== undefined && !failed.ok && state.fatal === undefined ? { ...state, fatal: failed.error } : state;
};

const accepting = (rig: Rig): void => {
  void rig.listener.accept().then((wire) => {
    if (wire === undefined) return;
    post(rig, { _tag: "accepted", wire });
    accepting(rig);
  });
};

const STOPPED: Result<never, Stopped> = err({ _tag: "stopped" });

/**
 * A node that may hold value boots blind: its Entity forwards no lock until the probe is shown a trace in this run
 * (R-WATCH-CALLDATA). The node still watches and defends every Account from its first block.
 */
const blindStart = (config: Config, station: Station): Station => {
  const self = config.boot.genesis.id;
  const blind = station.host.runtime.entities.get(self)?.blind === true;
  return config.watch?.value === true && !blind
    ? { ...station, host: submit(station.host, { to: self, input: { _tag: "j_blind", boot: true } }) }
    : station;
};

/**
 * A node over `listener`, which the caller has made so that its port is known to the peers' tables. It dials the peers
 * it is to dial, answers the ones that dial it, and runs until `stop`.
 */
export const startDaemon = async (
  config: Config, listener: Listener,
): Promise<Result<Daemon, DriveFault | ClockBelowDepth | ClockDepthOff>> => {
  const { lag, depth } = config.boot.setup.clock;
  if (config.watch !== undefined && lag <= config.watch.depth) {
    return err({ _tag: "clock_below_depth", lag, depth: config.watch.depth });
  }
  if (config.watch !== undefined && depth !== config.watch.depth) {
    return err({ _tag: "clock_depth_off", clock: depth, depth: config.watch.depth });
  }
  const started = await start(config.shell, config.boot);
  if (!started.ok) return started;
  const bus = new EventEmitter();
  const mails = on(bus, "mail", { close: ["stop"] })[Symbol.asyncIterator]();
  const rig: Rig = { config, bus, self: config.boot.genesis.id, listener };
  const first: State = {
    station: blindStart(config, started.value.station), mesh: startMesh(config.key, config.table), wires: new Map(),
    next: 1, dialing: new Set(), stalled: new Map(), counts: { sent: 0, heard: 0, dropped: 0 }, notices: [],
    refused: [],
    fatal: undefined, cursor: undefined, probed: undefined, untraced: false, watchFault: undefined, carry: NO_CARRY,
    timer: undefined,
  };
  const finished = leaving(rig, first, started.value.sent)
    .then((state) => run(rig, mails, state)).then((state) => ended(rig, state));
  accepting(rig);
  post(rig, { _tag: "tick" });
  const asked = <T>(make: (reply: Reply<T>) => Mail, after: (state: State) => T): Promise<T> =>
    Promise.race([new Promise<T>((resolve) => { post(rig, make(resolve)); }), finished.then(after)]);
  return ok({
    tell: (input) => asked<Result<Turn, Fault>>((reply) => ({ _tag: "tell", input, reply }), () => STOPPED),
    look: () => asked((reply) => ({ _tag: "look", reply }), looked),
    stop: () => { bus.emit("stop"); return finished.then(looked); },
  });
};
