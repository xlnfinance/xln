import { describe, expect, test } from "bun:test";
import { emptyEntity, type EntityInput, type Outbound } from "../entity/model.ts";
import type { FrameHash } from "../account/frame/frame.ts";
import type { Input, Row } from "./model.ts";
import type { JHeight } from "../account/clause/clock.ts";
import { timestamp } from "./model.ts";
import { apply, commit, flush, messageId, recover } from "./tick.ts";
import {
  credit, entityOf, GOLD, heightAt, inputFor, open, pay, setup, stamp, started, tick, unhalted,
} from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const CAROL = entityOf(3);

const genesis = [emptyEntity(BOB)];

/** Bob has opened an Account with Alice and proposed 100 of credit to her. */
const bobProposes = () => {
  const opened = tick(started(BOB), inputFor(BOB, 1n, open(ALICE)));
  return tick(opened.runtime, inputFor(BOB, 2n, credit(ALICE, 100n)));
};

const outputsOf = (rows: readonly Row[]) => rows.flatMap((row) => row.outputs);

describe("runtime/tick durable before send", () => {
  test("R-DURABLE a staged row sends nothing: its outputs leave once it is committed", () => {
    const opened = tick(started(BOB), inputFor(BOB, 1n, open(ALICE)));
    const staged = unhalted(apply(opened.runtime, inputFor(BOB, 2n, credit(ALICE, 100n))));
    expect(staged.staged?.outputs).toHaveLength(1);
    expect(flush(staged).leaving).toEqual([]);
    const committed = unhalted(commit(staged));
    expect(flush(committed).leaving).toEqual(outputsOf(committed.wal.slice(1)));
  });

  test("R-DURABLE the outputs of committed rows leave once each, in row order", () => {
    const first = bobProposes();
    expect(first.leaving).toHaveLength(1);
    expect(flush(first.runtime).leaving).toEqual([]);
    const second = tick(first.runtime, inputFor(BOB, 3n, credit(ALICE, 200n)));
    expect(second.leaving).toEqual([]);
    expect(second.runtime.wal.map((row) => row.height)).toEqual([1n, 2n, 3n]);
  });

  test("R-DURABLE a crash before flush loses the belief, not the outputs: they all leave again", () => {
    const { runtime } = bobProposes();
    const recovered = unhalted(recover(setup, genesis, runtime.wal));
    expect(recovered.entities).toEqual(runtime.entities);
    expect(recovered.sent).toBe(0);
    expect(flush(recovered).leaving).toEqual(outputsOf(runtime.wal));
  });

  test("R-DURABLE a crash between apply and commit loses the staged frame and nothing durable", () => {
    const { runtime } = bobProposes();
    const staged = unhalted(apply(runtime, inputFor(BOB, 3n, credit(ALICE, 7n))));
    const recovered = unhalted(recover(setup, genesis, staged.wal));
    expect(recovered.entities).toEqual(runtime.entities);
    expect(recovered.staged).toBeUndefined();
  });

  test("a Host that applies again before it commits halts, and so does one that commits nothing", () => {
    const staged = unhalted(apply(started(BOB), inputFor(BOB, 1n, open(ALICE))));
    expect(apply(staged, inputFor(BOB, 2n, open(CAROL)))).toEqual({
      ok: false, error: { _tag: "frame_in_progress", height: 1n },
    });
    expect(commit(started(BOB))).toEqual({ ok: false, error: { _tag: "nothing_staged" } });
  });
});

describe("runtime/tick bad inputs", () => {
  const staleAck: EntityInput = {
    _tag: "peer_message", from: CAROL, msg: { _tag: "ack", hash: `0x${"11".repeat(32)}` as FrameHash },
  };

  test("R-X1 an input for an Entity this Runtime does not host is refused with notice, as a row", () => {
    const ticked = tick(started(BOB), inputFor(ALICE, 1n, open(BOB)));
    expect(ticked.runtime.wal[0]?.notices).toEqual([{ _tag: "unknown_entity", entity: ALICE }]);
    expect(ticked.leaving).toEqual([]);
    expect(ticked.runtime.entities).toEqual(started(BOB).entities);
  });

  test("R-X1 no peer input halts the Runtime: strangers, stale acks and repeats are refused in place", () => {
    const inputs = [
      inputFor(BOB, 1n, staleAck),
      inputFor(BOB, 2n, open(BOB)),
      inputFor(BOB, 3n, pay(CAROL, 1n)),
      inputFor(BOB, 4n, { _tag: "resend_due", peer: CAROL }),
      inputFor(entityOf(9), 5n, staleAck),
    ];
    const last = inputs.reduce((rt, input) => tick(rt, input).runtime, started(BOB));
    expect(last.wal.map((row) => row.height)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(last.wal.flatMap((row) => row.notices).map((n) => n._tag)).toEqual([
      "unknown_peer", "command_refused", "command_refused", "unknown_entity",
    ]);
  });
});

describe("runtime/tick the stamp", () => {
  const stampsOf = (ats: readonly bigint[]) =>
    ats.reduce((rt, at) => tick(rt, inputFor(BOB, at, open(ALICE))).runtime, started(BOB)).wal.map((row) => row.stamp);

  test("R-CLOCK a frame's stamp is the later of the Runtime's and the input's, and never goes back", () => {
    expect(stampsOf([5n, 3n, 9n, 9n, 2n])).toEqual([5n, 5n, 9n, 9n, 9n].map(stamp));
  });

  test("R-CLOCK a new height of J moves the stamp: a later input stamped earlier does not go back", () => {
    const risen = tick(started(BOB), heightAt(500n, 111n)).runtime;
    const later = tick(risen, inputFor(BOB, 10n, open(ALICE))).runtime;
    expect(later.wal.map((row) => row.stamp)).toEqual([500n, 500n].map(stamp));
  });

  test("R-CLOCK the stamp decides nothing: the same inputs at other stamps make the same Entities", () => {
    const run = (at: bigint) =>
      [open(ALICE), credit(ALICE, 100n)]
        .reduce((rt, c, i) => tick(rt, inputFor(BOB, at + BigInt(i), c)).runtime, started(BOB));
    const early = run(1n);
    const late = run(5_000_000_000_000n);
    expect(late.entities).toEqual(early.entities);
    expect(outputsOf(late.wal)).toEqual(outputsOf(early.wal));
  });

  test("R-CLOCK a peer input with no Host timestamp does not type: the Runtime reads no clock of its own", () => {
    // @ts-expect-error an input carries the Host's stamp, made by `timestamp`; a bare number is not one
    const bare: Input = { _tag: "j_height", at: 5n, height: 3n as JHeight };
    // @ts-expect-error and an entity batch without `at` is not a batch
    const unstamped: Input = { _tag: "entity", to: BOB, inputs: [] };
    expect([bare, unstamped]).toHaveLength(2);
  });

  test("R-CLOCK a stamp is not negative: the Host cannot hand over a time before the epoch", () => {
    expect(timestamp(0n).ok).toBe(true);
    expect(timestamp(-1n)).toEqual({ ok: false, error: { _tag: "bad_timestamp", ms: -1n } });
  });
});

describe("runtime/tick recovery", () => {
  const rows = (): readonly Row[] => bobProposes().runtime.wal;

  test("replaying the WAL makes the Runtime that wrote it, row for row", () => {
    const original = bobProposes().runtime;
    const replayed = unhalted(recover(setup, genesis, original.wal));
    expect(replayed.entities).toEqual(original.entities);
    expect(replayed.wal).toEqual(original.wal);
    expect(replayed.stamp).toBe(original.stamp);
  });

  test("a WAL with a row missing halts at the gap", () => {
    expect(recover(setup, genesis, rows().slice(1))).toEqual({
      ok: false, error: { _tag: "wal_gap", expected: 1n, found: 2n },
    });
  });

  test("R-CLOCK a row whose stamp goes back halts the replay", () => {
    const [first, ...rest] = rows();
    const back = rest.map((row): Row => ({ ...row, stamp: stamp(0n) }));
    expect(recover(setup, genesis, first === undefined ? back : [first, ...back])).toEqual({
      ok: false, error: { _tag: "stamp_went_back", height: 2n },
    });
  });

  test("a row that does not make the outputs it recorded halts: the log and the code disagree", () => {
    const [first, ...rest] = rows();
    const silent = rest.map((row): Row => ({ ...row, outputs: [] }));
    expect(recover(setup, genesis, first === undefined ? silent : [first, ...silent])).toEqual({
      ok: false, error: { _tag: "replay_diverged", height: 2n },
    });
  });

  test("the rows of refused inputs replay too", () => {
    const refused = tick(started(BOB), inputFor(entityOf(7), 1n, open(BOB))).runtime;
    expect(unhalted(recover(setup, genesis, refused.wal)).wal).toEqual(refused.wal);
  });
});

describe("runtime/tick review A: stamps, and what a replay compares", () => {
  test("R-CLOCK a WAL whose rows share a stamp replays: a Host stamps in milliseconds, equal stamps are usual", () => {
    const rt = [open(ALICE), credit(ALICE, 100n), credit(ALICE, 200n)]
      .reduce((acc, c) => tick(acc, inputFor(BOB, 7n, c)).runtime, started(BOB));
    expect(rt.wal.map((row) => row.stamp)).toEqual([7n, 7n, 7n].map(stamp));
    expect(unhalted(recover(setup, genesis, rt.wal)).entities).toEqual(rt.entities);
  });

  test("R-CLOCK a refused input moves the stamp like any other: a later one stamped earlier does not go back", () => {
    const refused = tick(started(BOB), inputFor(entityOf(7), 100n, open(BOB))).runtime;
    const later = tick(refused, inputFor(BOB, 50n, open(ALICE))).runtime;
    expect(later.wal.map((row) => row.stamp)).toEqual([100n, 100n].map(stamp));
    expect(unhalted(recover(setup, genesis, later.wal)).wal).toEqual(later.wal);
  });

  const withOutputs = (rows: readonly Row[], at: number, outputs: Row["outputs"]): readonly Row[] =>
    rows.map((row, i) => (i === at ? { ...row, outputs } : row));

  test("a recorded output replaced by another of the same count, or sent to another peer, halts the replay", () => {
    const { runtime } = bobProposes();
    const recorded = runtime.wal[1]?.outputs ?? expect.unreachable("no outputs");
    const otherHash = `0x${"cd".repeat(32)}` as FrameHash;
    const otherAck: Outbound = { from: BOB, to: ALICE, msg: { _tag: "ack", hash: otherHash } };
    const elsewhere = recorded.map((o): Outbound => ({ ...o, to: CAROL }));
    const halted = { ok: false, error: { _tag: "replay_diverged", height: 2n } } as const;
    expect(recover(setup, genesis, withOutputs(runtime.wal, 1, [otherAck]))).toEqual(halted);
    expect(recover(setup, genesis, withOutputs(runtime.wal, 1, elsewhere))).toEqual(halted);
  });

  test("messageId tells apart messages that differ in any one field", () => {
    const h1 = `0x${"01".repeat(32)}` as FrameHash;
    const h2 = `0x${"02".repeat(32)}` as FrameHash;
    const refusal = { _tag: "refusal", hash: h1, index: 0, fault: "x", mark: 0, floor: 0 } as const;
    const refusals = [
      refusal, { ...refusal, hash: h2 }, { ...refusal, index: 1 }, { ...refusal, fault: "y" }, { ...refusal, mark: 1 },
      { ...refusal, floor: 1 },
    ];
    expect(new Set(refusals.map(messageId)).size).toBe(refusals.length);
    expect(messageId({ _tag: "ack", hash: h1 })).not.toBe(messageId({ _tag: "ack", hash: h2 }));
    const frame = (amount: bigint) => messageId({
      _tag: "frame",
      frame: { author: "left", parent: h1, attempt: 0, slot: 2, txs: [{ _tag: "pay", token: GOLD, amount }] },
    });
    expect(frame(1n)).not.toBe(frame(2n));
  });
});
