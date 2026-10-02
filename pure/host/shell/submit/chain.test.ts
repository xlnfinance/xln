// The submit path's I/O against a scripted chain and a real journal file: a batch is journaled before it is sent, a
// crash at any point leaves a journal the next start rebuilds from, and no restart asks for the same deposit twice
// (R-DURABLE, R-SIMULATE, F1). The chain is a port that answers what the scenario scripts and writes what it was asked
// to a log file, so the order of the calls is read from the file and nothing here mutates.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { JAnswer } from "../../../j/batch/answer.ts";
import { MIN_GAS_BUDGET, type SealedBatch } from "../../../j/batch/sealed.ts";
import { requirement } from "../../../j/gas/gas.ts";
import type { Simulation } from "../../../j/gas/simulate.ts";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { settle, resume, step, type Arrival, type ChainPort, type Io, type PortFault } from "./chain.ts";
import {
  aliceRun, ALICE, callsOf, DEPOSIT, GAS, journalIn, START, TREASURY, walOf, DEPLOYED, WORLD,
} from "../fixtures.ts";
import { keyOf } from "../link/link.ts";
import { fileDisk } from "../node/file-disk.ts";
import { lazySigner, type Signer } from "./signer.ts";
import { take, openSubmitter, type Submitter } from "./submit.ts";

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEY = unwrapOr(keyOf(SECRET), () => expect.unreachable("key"));
const SIGNER: Signer = lazySigner(ALICE, KEY);
const WHERE = { entity: ALICE, deployment: DEPLOYED, world: WORLD };
const WAL = walOf(aliceRun, ALICE);

const REVERTS: Simulation["outcome"] = { _tag: "reverts", reason: "paused" };
const ROOM: Simulation["outcome"] = { _tag: "ok", applyGas: 100_000n };
const PORT_DOWN: PortFault = { _tag: "port", call: "send", reason: "connection reset" };

/** What the scripted chain does: its answers, and whether the send gets through. */
type Script = Readonly<{
  nonce: bigint; outcome: Simulation["outcome"]; sends: Result<void, PortFault>;
  answer: (batch: SealedBatch) => JAnswer | undefined;
}>;

const CALM: Script = { nonce: 4n, outcome: ROOM, sends: ok(undefined), answer: () => undefined };
const landed = (batch: SealedBatch): JAnswer =>
  ({ _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped: [] });

type Scene = Readonly<{ journal: string; log: string }>;

const scene = (): Scene => {
  const dir = mkdtempSync(`${tmpdir()}/chain-`);
  return { journal: `${dir}/journal.log`, log: `${dir}/calls.log` };
};

const portOf = (at: Scene, script: Script): ChainPort => ({
  nonce: () => Promise.resolve(ok(script.nonce)),
  treasury: () => Promise.resolve(ok(TREASURY)),
  simulate: (_call, gasLimit) => {
    appendFileSync(at.log, `simulate gas=${gasLimit}\n`);
    return Promise.resolve(ok(script.outcome));
  },
  send: (call, gasLimit) => {
    const head = `send ${call.nonce} ${call.encodedBatch.slice(0, 18)} gas=${gasLimit}`;
    appendFileSync(at.log, `${head} journal=${journalIn(at.journal).join(",")}\n`);
    return Promise.resolve(script.sends);
  },
  answer: (batch) => Promise.resolve(ok(script.answer(batch))),
});

const ioOf = async (at: Scene, script: Script, signer: Signer = SIGNER): Promise<Io> => {
  appendFileSync(at.log, "");
  const disk = await fileDisk(at.journal);
  return { port: portOf(at, script), signer, journal: disk.ok ? disk.value : expect.unreachable("disk"), gas: GAS };
};

/** The Io over the scene's journal for one piece of work, and the file closed after it. */
const withIo = async <T>(
  at: Scene, script: Script, work: (io: Io) => Promise<T>, signer: Signer = SIGNER,
): Promise<T> => {
  const io = await ioOf(at, script, signer);
  const out = await work(io);
  await io.journal.close();
  return out;
};

const opened = (): Submitter =>
  unwrapOr(openSubmitter({ ...WHERE, chainNonce: 4n }, WAL, []), () => expect.unreachable("open"));

const asked = (s: Submitter): Submitter => {
  const out = take(s, DEPOSIT);
  return out._tag === "queued" ? out.submitter : expect.unreachable(`take ${out._tag}`);
};

/** The start as asked; a row of its own, since the deposit's row of another Runtime's WAL has the same height. */
const startAsked = (s: Submitter): Submitter => {
  const out = take(s, { ...START, row: { ...START.row, height: START.row.height + 100n } });
  return out._tag === "queued" ? out.submitter : expect.unreachable(`take ${out._tag}`);
};

const stepped = async (io: Io, s: Submitter, arrival: Arrival = "sure") => {
  const out = await step(io, s, arrival);
  return out.ok ? out.value : expect.unreachable(`step ${JSON.stringify(out.error)}`);
};

describe("host/shell/chain a batch is journaled before it is sent", () => {
  test("R-DURABLE the sealed record is on the journal when the send is made, and the send is that batch", async () => {
    const at = scene();
    const moved = await withIo(at, CALM, (io) => stepped(io, asked(opened())));
    expect(moved.stage).toBe("waiting");
    const carried = requirement(GAS.prelude, MIN_GAS_BUDGET) + 100_000n;
    expect(callsOf(at.log)).toEqual([
      `simulate gas=${GAS.txGasCap}`, `simulate gas=${GAS.txGasCap}`,
      expect.stringMatching(new RegExp(`^send 5 0x[0-9a-f]+ gas=${carried} journal=sealed@5$`)),
    ]);
  });

  test("the gas carried is the contract's requirement with room to spare, never above the chain's cap", async () => {
    const at = scene();
    const tight = { ...GAS, txGasCap: requirement(GAS.prelude, MIN_GAS_BUDGET) + 50_000n };
    await withIo(at, CALM, (io) => stepped({ ...io, gas: tight }, asked(opened())));
    expect(callsOf(at.log).at(-1)).toMatch(new RegExp(` gas=${tight.txGasCap} journal=`));
  });

  test("R-SIMULATE a batch that would revert is held: nothing is journaled, nothing is sent", async () => {
    const at = scene();
    const moved = await withIo(at, { ...CALM, outcome: REVERTS }, (io) => stepped(io, asked(opened())));
    expect(moved.stage).toBe("held");
    expect(moved.lapsed).toEqual([]);
    expect(moved.submitter.jbatch.draft.map((op) => op._tag)).toEqual(["reserve_to_collateral"]);
    expect(journalIn(at.journal)).toEqual([]);
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([]);
  });

  test("R-DISPUTE-LAPSED a start that would revert is dropped from the draft and named, nothing is sent", async () => {
    const at = scene();
    const held = startAsked(opened());
    const moved = await withIo(at, { ...CALM, outcome: REVERTS }, (io) => stepped(io, held));
    expect(moved.lapsed.map((op) => op._tag)).toEqual(["dispute_start"]);
    expect(moved.stage).toBe("closed");
    expect(moved.submitter.jbatch.draft).toEqual([]);
    expect(moved.submitter.waiting.size).toBe(0);
    expect(journalIn(at.journal)).toEqual([]);
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([]);
    const after = await withIo(at, { ...CALM, outcome: REVERTS }, (io) => stepped(io, moved.submitter));
    expect([after.stage, after.lapsed]).toEqual(["idle", []]);
  });

  test("R-DISPUTE-LAPSED a start held for want of gas room, not for a revert, stays in the draft", async () => {
    const small = { ...GAS, txGasCap: 1n };
    const moved = await withIo(scene(), CALM, (io) => stepped({ ...io, gas: small }, startAsked(opened())));
    expect([moved.stage, moved.lapsed]).toEqual(["held", []]);
    expect(moved.submitter.jbatch.draft.map((op) => op._tag)).toEqual(["dispute_start"]);
  });

  test("R-DISPUTE-LAPSED a start a signed batch also carries is not dropped: that batch may still land", async () => {
    const sent = await withIo(scene(), CALM, (io) => stepped(io, startAsked(opened())));
    const { jbatch } = sent.submitter;
    const batch = jbatch.phase._tag === "inflight" ? jbatch.phase.sent : expect.unreachable("not sent");
    const again = { ...sent.submitter, jbatch: { ...jbatch, phase: { _tag: "idle" } as const, draft: batch.ops,
      abandoned: [batch] } };
    const moved = await withIo(scene(), { ...CALM, outcome: REVERTS }, (io) => stepped(io, again));
    expect([moved.stage, moved.lapsed]).toEqual(["held", []]);
    expect(moved.submitter.jbatch.draft).toEqual(batch.ops);
  });

  test("R-DISPUTE-LAPSED a start that simulates cleanly is sealed and sent, not dropped", async () => {
    const at = scene();
    const moved = await withIo(at, CALM, (io) => stepped(io, startAsked(opened())));
    expect([moved.stage, moved.lapsed]).toEqual(["waiting", []]);
    expect(journalIn(at.journal)).toEqual(["sealed@5"]);
  });

  test("a Signer that cannot sign stops the step before anything is simulated, journaled or sent", async () => {
    const at = scene();
    const broken: Signer = { hanko: (digest) => err({ _tag: "cannot_sign", digest, reason: "key" }) };
    const out = await withIo(at, CALM, (io) => step(io, asked(opened()), "sure"), broken);
    expect(out).toMatchObject({ ok: false, error: { _tag: "cannot_sign" } });
    expect(callsOf(at.log)).toEqual([]);
    expect(journalIn(at.journal)).toEqual([]);
  });

  test("R-DURABLE a journal that cannot be written sends nothing", async () => {
    const at = scene();
    const dead = (io: Io): Io => ({
      ...io,
      journal: { ...io.journal, run: () => Promise.resolve(err({ _tag: "disk", op: "sync", reason: "no space" })) },
    });
    const out = await withIo(at, CALM, (io) => step(dead(io), asked(opened()), "sure"));
    expect(out).toMatchObject({ ok: false, error: { _tag: "disk", op: "sync" } });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toEqual([]);
  });
});

describe("host/shell/chain what the chain says closes the batch, and a lost send is sent again", () => {
  test("a send that faults leaves the batch signed and journaled: an unsure step sends the same batch", async () => {
    const at = scene();
    const first = await withIo(at, { ...CALM, sends: err(PORT_DOWN) }, (io) => stepped(io, asked(opened())));
    expect(first.stage).toBe("unsent");
    const again = await withIo(at, CALM, (io) => stepped(io, first.submitter, "unsure"));
    expect(again.stage).toBe("waiting");
    const sends = callsOf(at.log).filter((c) => c.startsWith("send")).map((c) => c.split(" journal=")[0]);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe(sends[0]);
    expect(journalIn(at.journal)).toEqual(["sealed@5"]);
  });

  test("a landed answer is journaled and frees the builder; a sure step does not send again", async () => {
    const at = scene();
    const sent = await withIo(at, CALM, (io) => stepped(io, asked(opened())));
    const waiting = await withIo(at, CALM, (io) => stepped(io, sent.submitter));
    expect(waiting.stage).toBe("waiting");
    const closed = await withIo(at, { ...CALM, answer: landed }, (io) => stepped(io, sent.submitter));
    expect(closed.stage).toBe("closed");
    expect(journalIn(at.journal)).toEqual(["sealed@5", "answered@5"]);
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toHaveLength(1);
  });

  test("R-DURABLE a landed deposit is known: the Runtime asking again queues nothing, nothing is sent", async () => {
    const at = scene();
    const sent = await withIo(at, CALM, (io) => stepped(io, asked(opened())));
    const closed = await withIo(at, { ...CALM, answer: landed }, (io) => stepped(io, sent.submitter));
    expect(take(closed.submitter, DEPOSIT)._tag).toBe("known");
    const after = await withIo(at, CALM, (io) => settle(io, closed.submitter, "sure"));
    expect(after).toMatchObject({ ok: true, value: { stage: "idle" } });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toHaveLength(1);
  });

  test("F1 a failed batch spent its nonce: the deposit is signed again at the next, a different batch", async () => {
    const at = scene();
    const failed = (batch: SealedBatch): JAnswer => ({ _tag: "failed", nonce: batch.nonce, reason: "BatchFailed" });
    const sent = await withIo(at, CALM, (io) => stepped(io, asked(opened())));
    const settled = await withIo(at, { ...CALM, answer: failed }, (io) => settle(io, sent.submitter, "sure"));
    expect(settled).toMatchObject({ ok: true, value: { stage: "waiting" } });
    expect(journalIn(at.journal)).toEqual(["sealed@5", "answered@5", "sealed@6"]);
    const sends = callsOf(at.log).filter((c) => c.startsWith("send")).map((c) => c.slice(0, 7));
    expect(sends).toEqual(["send 5 ", "send 6 "]);
  });
});

describe("host/shell/chain a restart finds the batch in the journal and asks the chain what became of it", () => {
  const afterCrash = async (script: Script, crashed: Script) => {
    const at = scene();
    await withIo(at, crashed, (io) => stepped(io, asked(opened())));
    const back = await withIo(at, script, (io) => resume(io, WHERE, WAL));
    return { at, back };
  };

  test("R-DURABLE a crash after the send: the chain has not seen it, so the same batch goes out again", async () => {
    const { at, back } = await afterCrash(CALM, CALM);
    expect(back).toMatchObject({ ok: true, value: { stage: "waiting" } });
    const sends = callsOf(at.log).filter((c) => c.startsWith("send")).map((c) => c.split(" journal=")[0]);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe(sends[0]);
    expect(journalIn(at.journal)).toEqual(["sealed@5"]);
  });

  test("R-DURABLE a crash between the journal and the send is the same: the journaled batch goes out", async () => {
    const { at, back } = await afterCrash(CALM, { ...CALM, sends: err(PORT_DOWN) });
    expect(back).toMatchObject({ ok: true, value: { stage: "waiting" } });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toHaveLength(2);
  });

  test("F1 a batch that landed while the Host was down is closed by the chain's answer, not sent again", async () => {
    const { at, back } = await afterCrash({ ...CALM, nonce: 5n, answer: landed }, CALM);
    expect(back).toMatchObject({ ok: true, value: { stage: "idle" } });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toHaveLength(1);
    expect(journalIn(at.journal)).toEqual(["sealed@5", "answered@5"]);
  });

  test("R-DURABLE the Runtime's re-ask after that restart is the deposit already made: no second batch", async () => {
    const { at, back } = await afterCrash({ ...CALM, nonce: 5n, answer: landed }, CALM);
    const submitter = back.ok ? back.value.submitter : expect.unreachable("resume");
    expect(take(submitter, DEPOSIT)._tag).toBe("known");
    const after = await withIo(at, CALM, (io) => settle(io, submitter, "sure"));
    expect(after).toMatchObject({ ok: true, value: { stage: "idle" } });
    expect(callsOf(at.log).filter((c) => c.startsWith("send"))).toHaveLength(1);
  });

  test("a damaged journal stops the start: nothing is read from it and nothing is sent", async () => {
    const at = scene();
    await withIo(at, CALM, (io) => stepped(io, asked(opened())));
    const raw = readFileSync(at.journal);
    const damaged = Uint8Array.from(raw, (byte, i) => (i === 6 ? byte ^ 0xff : byte));
    const other = scene();
    writeFileSync(other.journal, Uint8Array.from([...damaged, ...raw]));
    const back = await withIo(other, CALM, (io) => resume(io, WHERE, WAL));
    expect(back).toMatchObject({ ok: false, error: { _tag: "corrupt" } });
    expect(callsOf(other.log).filter((c) => c.startsWith("send"))).toEqual([]);
  });
});
