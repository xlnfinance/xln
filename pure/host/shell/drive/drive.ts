// The Host's shell joined up: the pure Host core, a WAL on a disk, and the submit path to the chain, for one Entity.
// Every move of the core is followed by what the shell owes it (R-DURABLE): a staged row is written and synced before
// `persisted`, and only the rows that came back from `persisted` send a message or ask the chain. A chain effect goes
// to the builder (`take`) once, by its row, and the builder's batch is signed, journaled and sent by `settle`.
//
// This module reads no clock and holds no state of its own: the clock is the shell's `now`, and the Station it returns
// is the whole state, so a crash is a Station thrown away and `start` run again over the same two files.
import type { Command, EntityId, EntityState, Outbound } from "../../../entity/model.ts";
import type { Returned, Skipped } from "../../../j/batch/answer.ts";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { startRuntime } from "../../../runtime/tick.ts";
import type { Halt, Row, Setup, Timestamp } from "../../../runtime/model.ts";
import { begin, persisted, reopen, startHost, submit } from "../../host.ts";
import type { Effect, Host, Limits, Stepped } from "../../model.ts";
import type { Disk } from "../disk/disk.ts";
import { keep, openWal, type StoreFault, type Unwritable } from "../disk/store.ts";
import { resume, settle, type Io, type Pumped, type ShellFault, type Where } from "../submit/chain.ts";
import { take, type Submitter, type Taken } from "../submit/submit.ts";

/** What the shell is made of: where the rows are kept, how the chain is reached, and the time. */
export type Shell = Readonly<{ wal: Disk; io: Io; now: () => Timestamp }>;

/** What a Host is started with: its Runtime's setup, the Entity's state, and the chain's address of the Entity. */
export type Boot = Readonly<{ setup: Setup; genesis: EntityState; limits: Limits; where: Where }>;

export type Station = Readonly<{ host: Host; submitter: Submitter }>;

export type DriveFault = StoreFault | Unwritable | ShellFault | Halt | Tagged<"stuck", { height: bigint }>;

/** What a move of the shell made: the messages that leave, what the builder did with each ask, and what came back. */
export type Turn = Readonly<{
  station: Station;
  sent: readonly Outbound[];
  taken: readonly Taken[];
  returned: readonly Returned[];
  skipped: readonly Skipped[];
}>;

const nothing = (station: Station): Turn => ({ station, sent: [], taken: [], returned: [], skipped: [] });

const joined = (a: Turn, b: Turn): Turn => ({
  station: b.station,
  sent: [...a.sent, ...b.sent],
  taken: [...a.taken, ...b.taken],
  returned: [...a.returned, ...b.returned],
  skipped: [...a.skipped, ...b.skipped],
});

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

const queuedIn = (turn: Turn): boolean => turn.taken.some((taken) => taken._tag === "queued");

const pumped = (turn: Turn, out: Pumped): Turn => ({
  ...turn,
  station: { ...turn.station, submitter: out.submitter },
  returned: [...turn.returned, ...out.returned],
  skipped: [...turn.skipped, ...out.skipped],
});

/** Move the builder as far as the chain lets it: seal what is waiting, send it, read what became of it. */
export const pump = async (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> => {
  const out = await settle(shell.io, turn.station.submitter, "sure");
  return out.ok ? ok(pumped(turn, out.value)) : out;
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
  return afterAsks(shell, committed.value.effects.reduce(takeOne, withHost(turn, committed.value.host)));
};

/** One frame: staged, made durable, committed, and what it leaves handed on. Nothing leaves before the sync. */
const frame = async (shell: Shell, turn: Turn): Promise<Result<Turn, DriveFault>> => {
  const stepped = begin(turn.station.host, shell.now());
  if (!stepped.ok) return stepped;
  const staged = withHost(turn, stepped.value.host);
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

/** A command for the Entity, run until the Host has nothing queued. */
export const command = (
  shell: Shell, station: Station, to: EntityId, input: Command,
): Promise<Result<Turn, DriveFault>> =>
  drained(shell, nothing({ ...station, host: submit(station.host, { to, input }) }));

/** The Station over the WAL and the journal as they are: new on empty files, and after a crash what they hold. */
export const start = async (shell: Shell, boot: Boot): Promise<Result<Turn, DriveFault>> => {
  const rows = await openWal(shell.wal);
  if (!rows.ok) return rows;
  const reopened = rows.value.length === 0
    ? ok<Stepped>({ host: startHost(startRuntime(boot.setup, [boot.genesis]), boot.limits), effects: [] })
    : reopen(boot.setup, [boot.genesis], rows.value, boot.limits);
  if (!reopened.ok) return reopened;
  const resumed = await resume(shell.io, boot.where, rows.value);
  if (!resumed.ok) return resumed;
  const base = pumped(nothing({ host: reopened.value.host, submitter: resumed.value.submitter }), resumed.value);
  return afterAsks(shell, reopened.value.effects.reduce(takeOne, base));
};
