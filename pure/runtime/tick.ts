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
import type { EntityId, EntityInput, EntityState, Fold, JAction, Outbound } from "../entity/model.ts";
import type { Frame } from "../entity/frame.ts";
import { ownView } from "../account/clause/clock.ts";
import { proofBodyHash, type ProofBody } from "../chain/proof/proof.ts";
import type { EntityBatch, Halt, NewHeight, Input, Row, Runtime, Setup, Timestamp } from "./model.ts";

export const startRuntime = (setup: Setup, entities: readonly EntityState[]): Runtime => ({
  setup, stamp: 0n as Timestamp, view: setup.view, entities: new Map(entities.map((e) => [e.id, e])),
  wal: [], staged: undefined, sent: 0,
});

const later = (a: Timestamp, b: Timestamp): Timestamp => (a > b ? a : b);

const frameOf = (rt: Runtime, entity: EntityState, inputs: readonly EntityInput[]): Frame =>
  entityFrame({ clock: rt.setup.clock, view: rt.view }, rt.setup.anchor, entity, inputs);

/** The frame an input makes on the Runtime as it stands: the entities' next states and the row that records it. */
const stageEntity = (rt: Runtime, stamp: Timestamp, input: EntityBatch): Runtime => {
  const height = BigInt(rt.wal.length) + 1n;
  const entity = rt.entities.get(input.to);
  if (entity === undefined) {
    const unknown = { _tag: "unknown_entity", entity: input.to } as const;
    const refused: Row = { height, stamp, input, outputs: [], chain: [], notices: [unknown] };
    return { ...rt, stamp, staged: refused };
  }
  const frame = frameOf(rt, entity, input.inputs);
  const row: Row = { height, stamp, input, outputs: frame.outputs, chain: frame.chain, notices: frame.notices };
  return { ...rt, stamp, entities: mapSet(rt.entities, input.to, frame.state), staged: row };
};

const byId = ([a]: readonly [EntityId, unknown], [b]: readonly [EntityId, unknown]): number => (a < b ? -1 : 1);

/** The view only rises; a frame of every Entity follows, in id order, so Accounts that waited for it propose. */
const stageHeight = (rt: Runtime, stamp: Timestamp, input: NewHeight): Runtime => {
  const view = input.height > rt.view ? ownView(input.height, input.height) : rt.view;
  const raised = { ...rt, view };
  const frames = [...rt.entities].toSorted(byId).map(([id, entity]) => [id, frameOf(raised, entity, [])] as const);
  const row: Row = {
    height: BigInt(rt.wal.length) + 1n, stamp, input,
    outputs: frames.flatMap(([, f]) => f.outputs), chain: frames.flatMap(([, f]) => f.chain),
    notices: frames.flatMap(([, f]) => f.notices),
  };
  return { ...raised, stamp, entities: new Map(frames.map(([id, f]) => [id, f.state])), staged: row };
};

const stage = (rt: Runtime, stamp: Timestamp, input: Input): Runtime =>
  (input._tag === "entity" ? stageEntity(rt, stamp, input) : stageHeight(rt, stamp, input));

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

export type Flushed = Readonly<{ runtime: Runtime; leaving: readonly Outbound[]; chain: readonly JAction[] }>;

/** The outputs and chain actions of the committed rows not yet sent, in row order; then it believes them sent. */
export const flush = (rt: Runtime): Flushed => {
  const unsent = rt.wal.slice(rt.sent);
  return {
    runtime: { ...rt, sent: rt.wal.length },
    leaving: unsent.flatMap((row) => row.outputs),
    chain: unsent.flatMap((row) => row.chain),
  };
};

/** What names a message to whoever compares two runs of the same frame: not the bytes, which are the transport's. */
export const messageId = (msg: Msg<AccountTx>): string =>
  match(msg, {
    frame: (m) => `frame ${frameName(m.frame)}`,
    ack: (m) => `ack ${m.hash}`,
    refusal: (m) => `refusal ${m.hash} ${m.index} ${m.fault} ${m.mark} ${m.floor}`,
  });

const outputIds = (row: Row): readonly string[] => row.outputs.map((o) => `${o.from} ${o.to} ${messageId(o.msg)}`);

const foldId = (f: Fold): string => `${f.token}:${f.offdelta}`;

/** A proof body by its hash: every field of it is in the identity of the dispute that carries it. */
const bodyId = (body: ProofBody): string => {
  const hashed = proofBodyHash(body);
  return hashed.ok ? hashed.value : "unhashable";
};

const chainId = (action: JAction): string =>
  match(action, {
    fund: (f) => `fund ${f.token} ${f.amount}`,
    reveal: (r) => `reveal ${r.peer} ${r.token} ${r.id} ${r.hashlock}`,
    deposit: (d) => `deposit ${d.peer} ${d.token} ${d.amount}`,
    dispute_start: (d) =>
      `dispute_start ${d.peer} ${d.nonce} ${d.epoch} ${d.proposerIsLeft} ${bodyId(d.body)} ${d.sig}`,
    dispute_finalize: (d) =>
      `dispute_finalize ${d.peer} ${d.nonce} ${d.proposerIsLeft} ${d.startedByLeft} ${bodyId(d.body)}`,
    counter: (c) => `counter ${c.peer} ${c.nonce} ${c.head}`,
    c2r: (c) => `c2r ${c.peer} ${c.serial} ${c.token} ${c.amount}`,
    settle: (s) => `settle ${s.peer} ${s.serial} ${s.token} ${s.amount} ${s.folds.map(foldId).join(",")}`,
  });

const chainIds = (row: Row): readonly string[] => row.chain.map(chainId);

const sameOutputs = (a: Row, b: Row): boolean =>
  outputIds(a).join("\n") === outputIds(b).join("\n") && chainIds(a).join("\n") === chainIds(b).join("\n");

/** One row again: its own stamp and input, and it has to make the outputs and chain actions it made before. */
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

