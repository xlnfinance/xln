// The Host's submit path, as state (R-DURABLE, R-SIMULATE, F1): a chain action the Runtime asked for becomes an op in
// the J batch builder's draft, a batch is signed from the draft, and the chain's answer closes it. This file is the
// part that has no I/O: what a chain effect is taken for, which rows are already in a batch, and the state a restart
// rebuilds from the journal and the WAL. The I/O (what the chain holds, the simulation, the send) is chain.ts's.
//
// An action is identified by the row it came from (height and place in the row). The Runtime asks for every committed
// action again after a crash, so an action whose row is in a batch that is on its way or landed is known, and is not
// queued a second time: a deposit is not made twice. A batch that failed (it applied nothing and spent its nonce)
// forgets its rows, and the action is queued again at a fresh nonce.
import type { JAction } from "../../entity/model.ts";
import type { EntityId } from "../../entity/model.ts";
import type { Deployment } from "../../chain/proof/deployment.ts";
import { observe, type JAnswer, type Observed, type Returned, type Skipped } from "../../j/batch/answer.ts";
import { openJBatch, queue, type JBatch, type QueueFault } from "../../j/batch/jbatch.ts";
import { sealBatch, type SealedBatch, type SealFault } from "../../j/batch/sealed.ts";
import type { JOp } from "../../j/op/ops.ts";
import { err, flatMap, foldResult, map, ok, traverse, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { Row } from "../../runtime/model.ts";
import { opOf, type ChainWorld, type OpFault } from "../ops.ts";
import type { RowId } from "../model.ts";
import type { Answered, JournalRecord, Sealed } from "./journal.ts";

const keyOf = (id: RowId): string => `${id.height}:${id.index}`;

type Signed = Readonly<{ rows: readonly RowId[]; state: "sent" | "landed" }>;

export type Submitter = Readonly<{
  entity: EntityId;
  deployment: Deployment;
  world: ChainWorld;
  jbatch: JBatch;
  /** The ops in the draft, each with the row it came from. */
  waiting: ReadonlyMap<JOp, RowId>;
  /** The batches signed, by digest, with the rows they carry: on their way, or landed. */
  signed: ReadonlyMap<string, Signed>;
}>;

export type Chain = Readonly<{ entity: EntityId; deployment: Deployment; world: ChainWorld; chainNonce: bigint }>;

const fresh = (c: Chain): Submitter =>
  ({ entity: c.entity, deployment: c.deployment, world: c.world, jbatch: openJBatch(c.entity, c.chainNonce),
    waiting: new Map(), signed: new Map() });

const known = (s: Submitter, id: RowId): boolean =>
  [...s.signed.values()].some((batch) => batch.rows.some((row) => keyOf(row) === keyOf(id)))
  || [...s.waiting.values()].some((row) => keyOf(row) === keyOf(id));

export type Taken =
  | Tagged<"queued", { submitter: Submitter }>
  | Tagged<"known">
  | Tagged<"skipped">
  | Tagged<"needs_signature", { fault: OpFault }>
  | Tagged<"refused", { fault: QueueFault }>;

/** A chain effect: the action and the row it was made from. */
export type Asked = Readonly<{ action: JAction; row: RowId }>;

/**
 * What the Host does with a chain effect: nothing if its row is already in a batch or the draft, a refusal that names
 * what is missing if the action holds signed material the Host does not keep, else the op joins the builder's draft.
 */
export const take = (s: Submitter, asked: Asked): Taken => {
  if (known(s, asked.row)) return { _tag: "known" };
  const op = opOf(s.entity, asked.action, s.world);
  if (!op.ok) return { _tag: "needs_signature", fault: op.error };
  const out = queue(s.jbatch, op.value);
  switch (out._tag) {
    case "queued": {
      const waiting = new Map([...s.waiting, [op.value, asked.row]]);
      return { _tag: "queued", submitter: { ...s, jbatch: out.jbatch, waiting } };
    }
    case "skipped": return { _tag: "skipped" };
    case "refused": return { _tag: "refused", fault: out.fault };
  }
};

export type UnmappedOp = Tagged<"unmapped_op", { kind: JOp["_tag"] }>;

/** The batch the builder signed: its record, written before the batch is sent, and the state with it in flight. */
export const sealedBy = (
  s: Submitter, jbatch: JBatch, batch: SealedBatch,
): Result<Readonly<{ submitter: Submitter; record: Sealed }>, UnmappedOp> =>
  map(traverse(batch.ops, (op) => {
    const row = s.waiting.get(op);
    return row === undefined ? err<UnmappedOp>({ _tag: "unmapped_op", kind: op._tag }) : ok(row);
  }), (rows) => ({
    submitter: { ...s, jbatch, waiting: new Map([...s.waiting].filter(([op]) => !batch.ops.includes(op))),
      signed: new Map([...s.signed, [batch.digest, { rows, state: "sent" }]]) },
    record: { _tag: "sealed", nonce: batch.nonce, gasBudget: batch.gasBudget, digest: batch.digest, rows },
  }));

export type Closed = Readonly<{
  submitter: Submitter; record: Answered | undefined; returned: readonly Returned[]; skipped: readonly Skipped[];
}>;

const sentWith = (s: Submitter, nonce: bigint): SealedBatch | undefined =>
  (s.jbatch.phase._tag === "inflight" && s.jbatch.phase.sent.nonce === nonce ? s.jbatch.phase.sent : undefined);

/** The ops of a failed batch that went back to the draft keep the rows they came from. */
const requeued = (s: Submitter, batch: SealedBatch, rows: readonly RowId[], draft: readonly JOp[]) =>
  new Map([...s.waiting, ...batch.ops.flatMap((op, i): [JOp, RowId][] => {
    const row = rows[i];
    return row !== undefined && draft.includes(op) ? [[op, row]] : [];
  })]);

const landedBy = (s: Submitter, a: Extract<JAnswer, { _tag: "landed" }>, seen: Observed): Closed => {
  const batch = s.signed.get(a.batchHash);
  if (batch === undefined) return { submitter: { ...s, jbatch: seen.jbatch }, record: undefined, ...rest(seen) };
  const signed = new Map([...s.signed, [a.batchHash, { ...batch, state: "landed" as const }]]);
  const record: Answered = { _tag: "answered", nonce: a.nonce, digest: a.batchHash, outcome: "landed" };
  return { submitter: { ...s, jbatch: seen.jbatch, signed }, record, ...rest(seen) };
};

const failedBy = (s: Submitter, a: Extract<JAnswer, { _tag: "failed" }>, seen: Observed): Closed => {
  const batch = sentWith(s, a.nonce);
  const rows = batch === undefined ? undefined : s.signed.get(batch.digest)?.rows;
  if (batch === undefined || rows === undefined) {
    return { submitter: { ...s, jbatch: seen.jbatch }, record: undefined, ...rest(seen) };
  }
  const signed = new Map([...s.signed].filter(([digest]) => digest !== batch.digest));
  const waiting = requeued(s, batch, rows, seen.jbatch.draft);
  const record: Answered = { _tag: "answered", nonce: a.nonce, digest: batch.digest, outcome: "failed" };
  return { submitter: { ...s, jbatch: seen.jbatch, signed, waiting }, record, ...rest(seen) };
};

const rest = (seen: Observed) => ({ returned: seen.returned, skipped: seen.skipped });

/** What the chain said about a batch of ours: landed is done, failed forgets its rows, starved waits. */
export const answeredBy = (s: Submitter, answer: JAnswer): Closed => {
  const seen = observe(s.jbatch, answer);
  switch (answer._tag) {
    case "landed": return landedBy(s, answer, seen);
    case "failed": return failedBy(s, answer, seen);
    case "starved": return { submitter: { ...s, jbatch: seen.jbatch }, record: undefined, ...rest(seen) };
  }
};

export type OpenFault =
  | Tagged<"journal_row", { row: RowId }>
  | Tagged<"journal_op", { row: RowId; fault: OpFault }>
  | Tagged<"journal_seal", { nonce: bigint; fault: SealFault }>
  | Tagged<"journal_digest", { nonce: bigint; recorded: string; rebuilt: string }>;

type Replay = Readonly<{ s: Submitter; wal: ReadonlyMap<bigint, Row> }>;

const actionAt = (wal: ReadonlyMap<bigint, Row>, id: RowId): Result<JAction, OpenFault> => {
  const action = wal.get(id.height)?.chain[id.index];
  return action === undefined ? err({ _tag: "journal_row", row: id }) : ok(action);
};

const opsAt = (
  s: Submitter, wal: ReadonlyMap<bigint, Row>, rows: readonly RowId[],
): Result<readonly JOp[], OpenFault> =>
  traverse(rows, (id) => flatMap(actionAt(wal, id), (action) => {
    const op = opOf(s.entity, action, s.world);
    return op.ok ? ok(op.value) : err<OpenFault>({ _tag: "journal_op", row: id, fault: op.error });
  }));

/** The batch the journal says was signed, rebuilt from the rows it names: it has to come out with the digest signed. */
const rebuilt = (s: Submitter, wal: ReadonlyMap<bigint, Row>, r: Sealed) =>
  flatMap(opsAt(s, wal, r.rows), (ops) => {
    const sealing = { deployment: s.deployment, entity: s.entity, nonce: r.nonce, gasBudget: r.gasBudget };
    const batch = sealBatch(sealing, ops);
    if (!batch.ok) return err<OpenFault>({ _tag: "journal_seal", nonce: r.nonce, fault: batch.error });
    return batch.value.digest === r.digest
      ? ok(batch.value)
      : err<OpenFault>({ _tag: "journal_digest", nonce: r.nonce, recorded: r.digest, rebuilt: batch.value.digest });
  });

const resent = (replay: Replay, r: Sealed): Result<Replay, OpenFault> =>
  map(rebuilt(replay.s, replay.wal, r), (batch) => {
    const { s } = replay;
    const earlier = s.jbatch.phase._tag === "inflight" ? [s.jbatch.phase.sent] : [];
    const jbatch: JBatch = {
      ...s.jbatch, phase: { _tag: "inflight", sent: batch }, signedMax: batch.nonce,
      abandoned: [...s.jbatch.abandoned, ...earlier],
    };
    const signed = new Map([...s.signed, [batch.digest, { rows: r.rows, state: "sent" as const }]]);
    return { ...replay, s: { ...s, jbatch, signed } };
  });

const closed = (replay: Replay, r: Answered): Replay => {
  const answer: JAnswer = r.outcome === "landed"
    ? { _tag: "landed", nonce: r.nonce, batchHash: r.digest, skipped: [] }
    : { _tag: "failed", nonce: r.nonce, reason: "journal" };
  return { ...replay, s: answeredBy(replay.s, answer).submitter };
};

/**
 * The state after a restart: a fresh builder at the chain's nonce, then the journal replayed over the WAL, so a batch
 * that was on its way is in flight again (the shell asks the chain what became of it) and the rows of every signed
 * batch are known. What was only in the draft is not in the journal and is asked again by the Runtime.
 */
export const openSubmitter = (
  c: Chain, wal: readonly Row[], journal: readonly JournalRecord[],
): Result<Submitter, OpenFault> =>
  map(foldResult(journal, { s: fresh(c), wal: new Map(wal.map((row) => [row.height, row])) },
    (replay: Replay, r) => (r._tag === "sealed" ? resent(replay, r) : ok(closed(replay, r)))), (replay) => replay.s);
