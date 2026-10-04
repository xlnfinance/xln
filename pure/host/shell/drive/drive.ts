// The Host's shell joined up: the pure Host core, a WAL on a disk, and the submit path to the chain, for one Entity.
// Every move of the core is followed by what the shell owes it (R-DURABLE): a staged row is written and synced before
// `persisted`, and only the rows that came back from `persisted` send a message or ask the chain. A chain effect goes
// to the builder (`take`) once, by its row, and the builder's batch is signed, journaled and sent by `settle`.
//
// This module reads no clock and holds no state of its own: the clock is the shell's `now`, and the Station it returns
// is the whole state, so a crash is a Station thrown away and `start` run again over the same two files.
import type { EntityId, EntityInput, EntityState, Outbound, Reading } from "../../../entity/model.ts";
import { wantsOf } from "../../../entity/paybook/registry.ts";
import type { Returned, Skipped } from "../../../j/batch/answer.ts";
import type { JOp } from "../../../j/op/ops.ts";
import { err, map, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { JHeight } from "../../../account/clause/clock.ts";
import { apply, startRuntime } from "../../../runtime/tick.ts";
import type { Halt, Row, Setup, Timestamp } from "../../../runtime/model.ts";
import { begin, persisted, reopen, startHost, submit, TICK, upcoming, type Readings } from "../../host.ts";
import type { Effect, Host, Limits, Stepped } from "../../model.ts";
import type { Disk } from "../disk/disk.ts";
import { keep, openWal, type StoreFault, type Unwritable } from "../disk/store.ts";
import {
  COUNTER_SKIPPED_FOR_GOOD, resume, settle, type Io, type PortFault, type Pumped, type RegistryRead, type ShellFault,
  type Where,
} from "../submit/chain.ts";
import type { Signer } from "../submit/signer.ts";
import { take, type Submitter, type Taken } from "../submit/submit.ts";

/**
 * What the shell is made of: where the rows are kept, how the chain is reached, and the time. `registry` reads the
 * chain's registry at a J block for the frames of a Runtime that decides on it (`Setup.registry`, R-REGISTRY-AT-VIEW).
 */
export type Shell = Readonly<{ wal: Disk; io: Io; now: () => Timestamp; registry?: RegistryRead }>;

/** What a Host is started with: its Runtime's setup, the Entity's state, and the chain's address of the Entity. */
export type Boot = Readonly<{ setup: Setup; genesis: EntityState; limits: Limits; where: Where }>;

export type Station = Readonly<{ host: Host; submitter: Submitter }>;

/** Pre-observation WALs cannot identify which finalizes were held versus already applied. Do not guess on upgrade. */
export type ReadWaitUpgrade = Tagged<"read_wait_upgrade", { peers: readonly EntityId[] }>;

export type DriveFault = StoreFault | Unwritable | ShellFault | Halt | ReadWaitUpgrade
  | Tagged<"stuck", { height: bigint }>
  | Tagged<"no_registry">;

/**
 * A read of the registry the node could not make, or the node no longer serves: the hashlock and why (`fault` is none
 * for a block the node no longer serves). The list stays present without that hashlock, so the decision waits, and
 * the owner is told. An empty list is not the gate being off.
 */
export type Unread = Readonly<{ hashlock: string; fault: PortFault | undefined }>;

/** What a move of the shell made: the messages that leave, what the builder did with each ask, and what came back. */
export type Turn = Readonly<{
  station: Station;
  sent: readonly Outbound[];
  taken: readonly Taken[];
  returned: readonly Returned[];
  skipped: readonly Skipped[];
  /** The dispute starts the builder dropped because they would revert; the Entity is told (R-DISPUTE-LAPSED). */
  lapsed: readonly JOp[];
  /** The registry reads that failed or were no longer served, in the order they were asked. */
  unread: readonly Unread[];
}>;

const nothing = (station: Station): Turn =>
  ({ station, sent: [], taken: [], returned: [], skipped: [], lapsed: [], unread: [] });

/** The Entity's own rows are all it asks of the chain for: a row that names an Entity this Station is not is no ask. */
const takeOne = (turn: Turn, effect: Effect): Turn => {
  switch (effect._tag) {
    case "persist": return turn;
    case "send": return { ...turn, sent: [...turn.sent, effect.message] };
    case "chain": {
      const taken = take(turn.station.submitter, { action: effect.action, row: effect.row });
      const submitter = taken._tag === "queued" ? taken.submitter : turn.station.submitter;
      return { ...turn, station: { ...turn.station, submitter }, taken: [...turn.taken, taken] };
    }
  }
};

/**
 * R-SIGNED-HEADS-ON-THE-WIRE: a message that commits its sender to a head leaves signed over it, by the one thing the
 * shell holds that signs; the Host's core only names the head (`attest`). A message with none leaves as it is.
 */
const signed = (signer: Signer, effects: readonly Effect[]): Result<readonly Effect[], ShellFault> => {
  const one = (effect: Effect): Result<Effect, ShellFault> => {
    if (effect._tag !== "send" || effect.message.attest === undefined) return ok(effect);
    const hanko = signer.hanko(effect.message.attest);
    return hanko.ok ? ok({ _tag: "send", message: { ...effect.message, sig: hanko.value } }) : hanko;
  };
  return effects.reduce<Result<readonly Effect[], ShellFault>>(
    (before, effect) => (before.ok ? map(one(effect), (done) => [...before.value, done]) : before), ok([]));
};

const taking = (shell: Shell, turn: Turn, effects: readonly Effect[]): Result<Turn, ShellFault> =>
  map(signed(shell.io.signer, effects), (all) => all.reduce(takeOne, turn));

const queuedIn = (turn: Turn): boolean => turn.taken.some((taken) => taken._tag === "queued");

const pumped = (turn: Turn, out: Pumped): Turn => ({
  ...turn,
  station: { ...turn.station, submitter: out.submitter },
  returned: [...turn.returned, ...out.returned],
  skipped: [...turn.skipped, ...out.skipped],
  lapsed: [...turn.lapsed, ...out.lapsed],
});

/**
 * R-DISPUTE-LAPSED: a start or a counter the builder dropped because it would revert is no dispute and no answer, so
 * the Entity that asked for it is told which one (its peer and the nonce): a start is forgotten and may be asked again,
 * a counter is not restated. The op names its peer as the chain does, so the Entity's own Accounts say which peer that
 * is.
 */
const lapsedInputs = (station: Station, ops: readonly JOp[]): readonly EntityInput[] => {
  const peers = [...(station.host.runtime.entities.get(station.submitter.entity)?.accounts.keys() ?? [])];
  const named = (counterentity: string) => peers.filter((peer) => peer.toLowerCase() === counterentity.toLowerCase());
  return ops.flatMap((op): readonly EntityInput[] => {
    switch (op._tag) {
      case "dispute_start":
        return named(op.start.counterentity).map((peer) => ({ _tag: "j_start_lapsed", peer, nonce: op.start.nonce }));
      case "dispute_counter":
        return named(op.counter.counterentity)
          .map((peer) => ({ _tag: "j_counter_lapsed", peer, nonce: op.counter.counterNonce }));
      default:
        return [];
    }
  });
};

const told = (shell: Shell, turn: Turn, ops: readonly JOp[]): Promise<Result<Turn, DriveFault>> => {
  const inputs = lapsedInputs(turn.station, ops);
  const host = inputs.reduce((now, input) => submit(now, { to: turn.station.submitter.entity, input }),
    turn.station.host);
  return inputs.length === 0 ? Promise.resolve(ok(turn)) : drained(shell, withHost(turn, host));
};

/**
 * The reasons the contract skips a start for good (Account.sol 73-83): the stored nonce already reached it (0), or the
 * Account has left the epoch it was signed in (11). A start skipped because a dispute is already open (1) is not here:
 * it may be the node's own start, restated after it landed, and the dispute reaches the Entity as a chain fact.
 */
const START_SKIPPED_FOR_GOOD: ReadonlySet<number> = new Set([0, 11]);

/** The ops a landed batch had skipped for good: the Entity that asked for each is told it lapsed, as if dropped. */
const skippedForGood = (skipped: readonly Skipped[]): readonly JOp[] =>
  skipped.flatMap(({ op, reason }) => (
    (op._tag === "dispute_start" && START_SKIPPED_FOR_GOOD.has(reason))
    || (op._tag === "dispute_counter" && COUNTER_SKIPPED_FOR_GOOD.has(reason)) ? [op] : []));

/** Move the builder as far as the chain lets it: seal what is waiting, send it, read what became of it. */
export const pump = async (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> => {
  const out = await settle(shell.io, turn.station.submitter, "sure");
  if (!out.ok) return out;
  return told(shell, pumped(turn, out.value), [...out.value.lapsed, ...skippedForGood(out.value.skipped)]);
};

const afterAsks = (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> =>
  (queuedIn(turn) ? pump(shell, turn) : Promise.resolve(ok(turn)));

const withHost = (turn: Turn, host: Host): Turn => ({ ...turn, station: { ...turn.station, host } });

/** The staged row is on the medium: it is the WAL's now, and what it sends and asks leaves. */
const durable = async (shell: Shell, turn: Turn, row: Row): Promise<Result<Turn, DriveFault>> => {
  const kept = await keep(shell.wal, row);
  if (!kept.ok) return kept;
  const committed = persisted(turn.station.host);
  if (!committed.ok) return committed;
  const taken = taking(shell, withHost(turn, committed.value.host), committed.value.effects);
  return taken.ok ? afterAsks(shell, taken.value) : taken;
};

type Asked = Readonly<{ hashlock: string; read: Awaited<ReturnType<RegistryRead>> }>;

const unreadOf = (a: Asked): readonly Unread[] => {
  if (!a.read.ok) return [{ hashlock: a.hashlock, fault: a.read.error }];
  return a.read.value === "pruned" ? [{ hashlock: a.hashlock, fault: undefined }] : [];
};

/**
 * R-REGISTRY-AT-VIEW: the hashlocks a frame decides on, read at `view`. A failed or pruned read stays out of the list
 * and is told. The list itself stays present, including when nothing was wanted: an empty list is the gate on.
 */
const readAt = async (
  shell: Shell, host: Host, view: bigint, to: EntityId | undefined, inputs: readonly EntityInput[],
): Promise<Readonly<{ got: readonly Reading[]; unread: readonly Unread[] }>> => {
  if (shell.registry === undefined) return { got: [], unread: [] };
  const { registry } = shell;
  const entities = [...host.runtime.entities.values()].filter((e) => to === undefined || e.id === to);
  const wanted = [...new Set(entities.flatMap((e) => wantsOf(e, inputs)))].toSorted();
  const asked: readonly Asked[] = await Promise.all(
    wanted.map(async (hashlock) => ({ hashlock, read: await registry(hashlock, view) })));
  const seen = asked.flatMap((a): readonly Reading[] =>
    (a.read.ok && a.read.value !== "pruned" ? [{ hashlock: a.hashlock, at: view, seconds: a.read.value }] : []));
  return { got: seen, unread: asked.flatMap(unreadOf) };
};

/** What the next frame decides on, at the view it decides at. A Runtime that does not decide on the registry reads nothing. */
const readings = async (shell: Shell, turn: Turn): Promise<Readonly<{ got: Readings; unread: readonly Unread[] }>> => {
  const { host } = turn.station;
  const next = host.runtime.setup.registry === true ? upcoming(host) : undefined;
  if (next === undefined) return { got: undefined, unread: [] };
  return readAt(shell, host, next.view, next.to, next.inputs);
};

/**
 * A delivery is judged twice when its height rises: the batches at the view they keep, the height frame at the new
 * height. One list carries both, and each frame keeps the readings whose block is its own view.
 */
const deliveryReadings = async (
  shell: Shell, host: Host, to: EntityId, inputs: readonly EntityInput[], height: JHeight,
): Promise<Readonly<{ got: Readings; unread: readonly Unread[] }>> => {
  if (host.runtime.setup.registry !== true) return { got: undefined, unread: [] };
  const atView = await readAt(shell, host, host.runtime.view, to, inputs);
  const atHeight = height > host.runtime.view
    ? await readAt(shell, host, height, undefined, [])
    : { got: [] as readonly Reading[], unread: [] as readonly Unread[] };
  return { got: [...atView.got, ...atHeight.got], unread: [...atView.unread, ...atHeight.unread] };
};

/** One frame: staged, made durable, committed, and what it leaves handed on. Nothing leaves before the sync. */
const frame = async (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> => {
  const read = await readings(shell, turn);
  const stepped = begin(turn.station.host, shell.now(), TICK, read.got);
  if (!stepped.ok) return stepped;
  const staged = { ...withHost(turn, stepped.value.host), unread: [...turn.unread, ...read.unread] };
  const [first] = stepped.value.effects;
  return first?._tag === "persist" ? durable(shell, staged, first.row) : ok(staged);
};

/** Frames until the Host has nothing queued: each one is durable before the next begins. */
const drained = async (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> => {
  const { host } = turn.station;
  if (host.queue.length === 0 && host.height === undefined) return ok(turn);
  const framed = await frame(shell, turn);
  if (!framed.ok) return framed;
  const rows = framed.value.station.host.runtime.wal.length;
  return rows === host.runtime.wal.length
    ? err({ _tag: "stuck", height: BigInt(rows) })
    : drained(shell, framed.value);
};

/** An input for the Entity, run until the Host has nothing queued. */
export const command = (
  shell: Shell, station: Station, to: EntityId, input: EntityInput,
): Promise<Result<Turn, DriveFault>> =>
  drained(shell, nothing({ ...station, host: submit(station.host, { to, input }) }));

/** The Host as it is, run until it has nothing queued: what the link or the J loop put in its queue is taken. */
export const drain = (shell: Shell, station: Station): Promise<Result<Turn, DriveFault>> =>
  drained(shell, nothing(station));

/**
 * A complete J delivery is one durable Runtime input. Drain earlier commands first, retain the Host's frame bound,
 * and publish no delivery effect until both its read-wait facts and height have reached the same WAL record.
 */
export const observe = async (
  shell: Shell, station: Station, to: EntityId, inputs: readonly EntityInput[], height: JHeight,
): Promise<Result<Turn, DriveFault>> => {
  const earlier = await drain(shell, station);
  if (!earlier.ok) return earlier;
  const { host } = earlier.value.station;
  if (inputs.length === 0 && height <= host.runtime.view) return earlier;
  const size = host.limits.perFrame;
  const batches = Array.from({ length: Math.ceil(inputs.length / size) },
    (_, i) => inputs.slice(i * size, (i + 1) * size));
  const read = await deliveryReadings(shell, host, to, inputs, height);
  const staged = apply(host.runtime, {
    _tag: "j_observation", at: shell.now(), to, batches, height,
    ...(read.got === undefined ? {} : { registry: read.got }),
  });
  const told = { ...earlier.value, unread: [...earlier.value.unread, ...read.unread] };
  if (!staged.ok) return staged;
  const row = staged.value.staged;
  return row === undefined ? err({ _tag: "nothing_staged" })
    : durable(shell, withHost(told, { ...host, runtime: staged.value }), row);
};

/** The Station over the WAL and the journal as they are: new on empty files, and after a crash what they hold. */
export const start = async (shell: Shell, boot: Boot): Promise<Result<Turn, DriveFault>> => {
  if (boot.setup.registry === true && shell.registry === undefined) return err({ _tag: "no_registry" });
  const rows = await openWal(shell.wal);
  if (!rows.ok) return rows;
  const reopened = rows.value.length === 0
    ? ok<Stepped>({ host: startHost(startRuntime(boot.setup, [boot.genesis]), boot.limits), effects: [] })
    : reopen(boot.setup, [boot.genesis], rows.value, boot.limits);
  if (!reopened.ok) return reopened;
  const peers = [...reopened.value.host.runtime.entities.values()].flatMap((entity) =>
    [...entity.chain].flatMap(([peer, facts]) =>
      (facts.behind !== undefined && !facts.lost && facts.readWaits === undefined ? [peer] : [])));
  if (peers.length > 0) return err({ _tag: "read_wait_upgrade", peers });
  const resumed = await resume(shell.io, boot.where, rows.value);
  if (!resumed.ok) return resumed;
  const base = pumped(nothing({ host: reopened.value.host, submitter: resumed.value.submitter }), resumed.value);
  const taken = taking(shell, base, reopened.value.effects);
  return taken.ok ? afterAsks(shell, taken.value) : taken;
};
