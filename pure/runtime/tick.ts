// The Runtime tick (spec/runtime/tick.scm): `apply` stages one frame, `commit` makes it the WAL's once the Host has
// persisted it, `flush` lets the outputs of committed rows leave, `recover` replays the WAL. Outputs are read from the
// WAL alone, so nothing leaves before its row is committed (R-DURABLE): there is no function that reads them off a
// staged row. A tick reads no clock and draws no number: the Host brings the stamp, and a replay uses the row's own.
import { mapSet } from "../kernel/core/collections.ts";
import { err, foldResult, ok, type Result } from "../kernel/core/result.ts";
import { match } from "../kernel/core/tagged.ts";
import { frameName } from "../account/frame/account.ts";
import type { Msg } from "../account/frame/frame.ts";
import type { AccountTx } from "../account/tx.ts";
import { entityFrame } from "../entity/frame.ts";
import type { EntityState, Outbound } from "../entity/model.ts";
import type { Halt, Input, Row, Runtime, Setup, Timestamp } from "./model.ts";

export const startRuntime = (setup: Setup, entities: readonly EntityState[]): Runtime => ({
  setup, stamp: 0n as Timestamp, entities: new Map(entities.map((e) => [e.id, e])), wal: [], staged: undefined, sent: 0,
});

const later = (a: Timestamp, b: Timestamp): Timestamp => (a > b ? a : b);

/** The frame an input makes on the Runtime as it stands: the entity's next state and the row that records it. */
const stage = (rt: Runtime, stamp: Timestamp, input: Input): Runtime => {
  const height = BigInt(rt.wal.length) + 1n;
  const entity = rt.entities.get(input.to);
  if (entity === undefined) {
    const refused: Row = { height, stamp, input, outputs: [], notices: [{ _tag: "unknown_entity", entity: input.to }] };
    return { ...rt, stamp, staged: refused };
  }
  const frame = entityFrame({ clock: rt.setup.clock, view: rt.setup.view }, rt.setup.signing, entity, input.inputs);
  const row: Row = { height, stamp, input, outputs: frame.outputs, notices: frame.notices };
  return { ...rt, stamp, entities: mapSet(rt.entities, input.to, frame.state), staged: row };
};

/** Takes the Host's next input. A bad input is a row that refuses it; only a Host that skips `commit` can halt. */
export const apply = (rt: Runtime, input: Input): Result<Runtime, Halt> =>
  (rt.staged === undefined
    ? ok(stage(rt, later(rt.stamp, input.at), input))
    : err({ _tag: "frame_in_progress", height: rt.staged.height }));

/** The Host has made the staged row durable: it is the WAL's now. */
export const commit = (rt: Runtime): Result<Runtime, Halt> =>
  (rt.staged === undefined
    ? err({ _tag: "nothing_staged" })
    : ok({ ...rt, wal: [...rt.wal, rt.staged], staged: undefined }));

export type Flushed = Readonly<{ runtime: Runtime; leaving: readonly Outbound[] }>;

/** The outputs of the committed rows not yet sent, in row order; the Runtime then believes them sent. */
export const flush = (rt: Runtime): Flushed =>
  ({ runtime: { ...rt, sent: rt.wal.length }, leaving: rt.wal.slice(rt.sent).flatMap((row) => row.outputs) });

/** What names a message to whoever compares two runs of the same frame: not the bytes, which are the transport's. */
export const messageId = (msg: Msg<AccountTx>): string =>
  match(msg, {
    frame: (m) => `frame ${frameName(m.frame)}`,
    ack: (m) => `ack ${m.hash}`,
    refusal: (m) => `refusal ${m.hash} ${m.index} ${m.fault} ${m.mark} ${m.floor}`,
  });

const outputIds = (row: Row): readonly string[] => row.outputs.map((o) => `${o.from} ${o.to} ${messageId(o.msg)}`);

const sameOutputs = (a: Row, b: Row): boolean => outputIds(a).join("\n") === outputIds(b).join("\n");

/** One row again: its own stamp, its own input, and it has to make the outputs it made the first time. */
const replayed = (rt: Runtime, row: Row): Result<Runtime, Halt> => {
  const expected = BigInt(rt.wal.length) + 1n;
  if (row.height !== expected) return err({ _tag: "wal_gap", expected, found: row.height });
  if (row.stamp < rt.stamp) return err({ _tag: "stamp_went_back", height: row.height });
  const again = stage(rt, row.stamp, row.input);
  const made = again.staged;
  if (made === undefined || !sameOutputs(made, row)) return err({ _tag: "replay_diverged", height: row.height });
  return commit(again);
};

/** A Runtime after a crash: the WAL replayed from the genesis entities, with nothing believed sent. */
export const recover = (setup: Setup, genesis: readonly EntityState[], wal: readonly Row[]): Result<Runtime, Halt> =>
  foldResult(wal, startRuntime(setup, genesis), replayed);

