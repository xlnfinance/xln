// The submit path's I/O (R-SIMULATE, R-DURABLE, F1). submit.ts holds the state; this file asks the chain what it needs
// through a port, signs through a signer, and writes the journal before anything leaves:
//   treasury -> seal -> (simulate -> seal)* -> sign -> journal `sealed` (synced) -> send -> ... -> answer -> journal.
// A batch is journaled before it is sent, so a crash after the send finds it in the journal and the shell asks the
// chain what became of it instead of signing a second batch at the same nonce. A step moves the batch one stage and
// returns; `settle` repeats it until the batch is on its way, the chain has nothing more to say, or something is held.
import type { SignFault, Signer } from "./signer.ts";
import { requirement } from "../../../j/gas/gas.ts";
import type { Gas, Simulation } from "../../../j/gas/simulate.ts";
import { seal, type JBatch, type SealOutcome } from "../../../j/batch/jbatch.ts";
import type { JAnswer, Returned, Skipped } from "../../../j/batch/answer.ts";
import { processBatchCall, type ProcessBatchCall, type SealedBatch } from "../../../j/batch/sealed.ts";
import type { Treasury } from "../../../j/plan/funded.ts";
import { ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { Row } from "../../../runtime/model.ts";
import type { Disk, DiskFault } from "../disk/disk.ts";
import { scanJournal } from "./journal.ts";
import type { JournalFault } from "./journal.ts";
import { openRecords, keep, type Unwritable } from "../disk/store.ts";
import type { JOp } from "../../../j/op/ops.ts";
import {
  answeredBy, dropped, openSubmitter, sealedBy, type Chain, type OpenFault, type Submitter, type UnmappedOp,
} from "./submit.ts";

/** What the shell asks of the chain: each is one read or one transaction, and none of them signs. */
export type PortFault = Tagged<"port", { call: string; reason: string }>;

export type ChainPort = Readonly<{
  /** The Entity's stored batch nonce. */
  nonce: () => Promise<Result<bigint, PortFault>>;
  /** What the Entity holds for the funded check. */
  treasury: () => Promise<Result<Treasury, PortFault>>;
  /** The batch run at the head and undone (R-SIMULATE). */
  simulate: (call: ProcessBatchCall, gasLimit: bigint) => Promise<Result<Simulation["outcome"], PortFault>>;
  send: (call: ProcessBatchCall, gasLimit: bigint) => Promise<Result<void, PortFault>>;
  /** What the chain did with the batch, or nothing yet. */
  answer: (batch: SealedBatch) => Promise<Result<JAnswer | undefined, PortFault>>;
}>;

export type Io = Readonly<{ port: ChainPort; signer: Signer; journal: Disk; gas: Gas }>;

export type ShellFault =
  | DiskFault
  | Unwritable
  | PortFault
  | UnmappedOp
  | OpenFault
  | JournalFault
  | SignFault;

/** Carried over what the contract asks for, so an estimate that is a little low does not starve the batch. */
const SLACK = 100_000n;

const gasLimitFor = (io: Io, batch: SealedBatch): bigint => {
  const padded = requirement(io.gas.prelude, batch.gasBudget) + SLACK;
  return padded < io.gas.txGasCap ? padded : io.gas.txGasCap;
};

const callOf = (io: Io, batch: SealedBatch): Result<ProcessBatchCall, ShellFault> => {
  const hanko = io.signer.hanko(batch.digest);
  return hanko.ok ? ok(processBatchCall(batch, hanko.value)) : hanko;
};

/** Whether the batch on its way is known to have reached the chain: after a restart or a faulted send it is not. */
export type Arrival = "sure" | "unsure";

/**
 * Where a step left the batch: nothing to do, on its way, signed but unsent, held, or closed: by the chain's answer, or
 * by the draft having lost the starts that would revert, so that what is behind them is tried.
 */
export type Stage = "idle" | "waiting" | "unsent" | "held" | "closed";

export type Pumped = Readonly<{
  submitter: Submitter; stage: Stage; returned: readonly Returned[]; skipped: readonly Skipped[];
  /** The dispute starts dropped from the draft because they would revert (R-DISPUTE-LAPSED). */
  lapsed: readonly JOp[];
}>;

const quiet = (submitter: Submitter, stage: Stage): Result<Pumped, ShellFault> =>
  ok({ submitter, stage, returned: [], skipped: [], lapsed: [] });

/** The batch is signed and journaled: send it. A fault here leaves it in flight, and a later step sends it again. */
const sent = async (io: Io, submitter: Submitter, batch: SealedBatch): Promise<Result<Pumped, ShellFault>> => {
  const call = callOf(io, batch);
  if (!call.ok) return call;
  const out = await io.port.send(call.value, gasLimitFor(io, batch));
  return quiet(submitter, out.ok ? "waiting" : "unsent");
};

/** What sealing the builder's draft comes to once every simulation it asks for is answered (R-SIMULATE). */
const sealOutcome = async (
  io: Io, s: Submitter, jbatch: JBatch, answers: readonly Simulation[],
): Promise<Result<Exclude<SealOutcome, Tagged<"simulate">>, ShellFault>> => {
  const treasury = await io.port.treasury();
  if (!treasury.ok) return treasury;
  const out = seal(jbatch, { deployment: s.deployment, treasury: treasury.value, gas: io.gas, answers });
  if (out._tag !== "simulate") return ok(out);
  const call = callOf(io, out.candidate);
  if (!call.ok) return call;
  const outcome = await io.port.simulate(call.value, io.gas.txGasCap);
  return outcome.ok
    ? sealOutcome(io, s, jbatch, [...answers, { digest: out.candidate.digest, outcome: outcome.value }])
    : outcome;
};

/**
 * R-DISPUTE-LAPSED: the starts in the draft that would revert on their own. A start alone is sealed and simulated at
 * the head: one the chain would revert for ever (its signature is no longer the Account's) is dropped from the draft,
 * and named, so the Entity that asked for it is told and may ask again. One that is held for any other reason (a
 * limit, the cap), or only with the ops it is grouped with, or one a signed batch also carries, stays.
 */
const lapsedStarts = async (io: Io, s: Submitter): Promise<Result<Pumped, ShellFault>> => {
  const starts = s.jbatch.draft.filter((op) => op._tag === "dispute_start");
  const probes = await Promise.all(starts.map((op) => sealOutcome(io, s, { ...s.jbatch, draft: [op] }, [])));
  const failed = probes.find((probe) => !probe.ok);
  if (failed !== undefined && !failed.ok) return failed;
  const lapsed = starts.filter((_, i) => {
    const probe = probes[i];
    return probe !== undefined && probe.ok && probe.value._tag === "held"
      && probe.value.why.some((why) => why._tag === "would_revert");
  });
  const left = lapsed.reduce<Submitter>((now, op) => dropped(now, op), s);
  const gone = lapsed.filter((op) => !left.jbatch.draft.includes(op));
  return ok({ submitter: left, stage: gone.length > 0 ? "closed" : "held", returned: [], skipped: [], lapsed: gone });
};

const sealing = async (io: Io, s: Submitter): Promise<Result<Pumped, ShellFault>> => {
  const out = await sealOutcome(io, s, s.jbatch, []);
  if (!out.ok) return out;
  switch (out.value._tag) {
    case "nothing_to_send": return quiet(s, "idle");
    case "in_flight": return quiet(s, "waiting");
    case "held": return lapsedStarts(io, s);
    case "sealed": {
      const done = sealedBy(s, out.value.jbatch, out.value.batch);
      if (!done.ok) return done;
      const kept = await keep(io.journal, done.value.record);
      return kept.ok ? sent(io, done.value.submitter, out.value.batch) : kept;
    }
  }
};

const waited = async (
  io: Io, s: Submitter, batch: SealedBatch, arrival: Arrival,
): Promise<Result<Pumped, ShellFault>> => {
  const answer = await io.port.answer(batch);
  if (!answer.ok) return answer;
  if (answer.value === undefined) return arrival === "unsure" ? sent(io, s, batch) : quiet(s, "waiting");
  const closed = answeredBy(s, answer.value);
  const kept = closed.record === undefined ? ok(undefined) : await keep(io.journal, closed.record);
  if (!kept.ok) return kept;
  const { submitter, returned, skipped } = closed;
  const stage = submitter.jbatch.phase._tag === "inflight" ? "waiting" : "closed";
  return ok({ submitter, stage, returned, skipped, lapsed: [] });
};

/**
 * One move of the submit path. With a batch on its way it asks the chain about it (and sends it again when its
 * `arrival` is unsure: after a restart, or after a send that faulted); with none it seals one.
 */
export const step = (io: Io, s: Submitter, arrival: Arrival): Promise<Result<Pumped, ShellFault>> =>
  (s.jbatch.phase._tag === "inflight" ? waited(io, s, s.jbatch.phase.sent, arrival) : sealing(io, s));

/**
 * Steps until a batch is waiting on the chain or nothing more can move: a landed batch frees the builder to seal the
 * next one. Returned, skipped and lapsed ops of every step are collected for the caller to hand to the Entity.
 */
export const settle = async (io: Io, s: Submitter, arrival: Arrival): Promise<Result<Pumped, ShellFault>> => {
  const moved = await step(io, s, arrival);
  if (!moved.ok) return moved;
  if (moved.value.stage !== "closed") return moved;
  const next = await settle(io, moved.value.submitter, "sure");
  return next.ok
    ? ok({ ...next.value, returned: [...moved.value.returned, ...next.value.returned],
      skipped: [...moved.value.skipped, ...next.value.skipped],
      lapsed: [...moved.value.lapsed, ...next.value.lapsed] })
    : next;
};

export type Where = Omit<Chain, "chainNonce">;

/**
 * After a restart: the journal over the WAL's rows gives the batches that were signed, and the chain says what became
 * of the one that was on its way. An unanswered batch is sent again.
 */
export const resume = async (io: Io, where: Where, wal: readonly Row[]): Promise<Result<Pumped, ShellFault>> => {
  const nonce = await io.port.nonce();
  if (!nonce.ok) return nonce;
  const journal = await openRecords(io.journal, scanJournal);
  if (!journal.ok) return journal;
  const opened = openSubmitter({ ...where, chainNonce: nonce.value }, wal, journal.value);
  return opened.ok ? settle(io, opened.value, "unsure") : opened;
};
