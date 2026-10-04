import { describe, expect, test } from "bun:test";
import { TEST_SIG } from "../entity/fixtures.ts";
import { emptyEntity, type Command, type EntityInput, type Outbound, type Reading } from "../entity/model.ts";
import { keccakHex } from "../kernel/encoding/bytes.ts";
import { holdId } from "../account/model.ts";
import { heightOf } from "../account/fixtures.ts";
import type { FrameHash } from "../account/frame/frame.ts";
import type { Input, Row, Runtime } from "./model.ts";
import type { JHeight } from "../account/clause/clock.ts";
import { timestamp } from "./model.ts";
import { apply, commit, flush, messageId, recover } from "./tick.ts";
import {
  credit, entityOf, feed, GOLD, heightAt, hostOf, inputFor, open, pay, rise, setup, settle, stamp, start, started,
  tick, unhalted, type Cluster,
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
    _tag: "peer_message", from: CAROL, msg: { _tag: "ack", hash: `0x${"11".repeat(32)}` as FrameHash }, sig: TEST_SIG
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

  test("R-HOP-SLACK the second of the view's block rises with the height and is the WAL's, so a replay has it", () => {
    const at = (rt: Runtime, height: bigint, seconds: bigint): Runtime =>
      tick(rt, heightAt(5n, height, seconds)).runtime;
    const risen = at(at(started(BOB), 111n, 5_000n), 112n, 5_012n);
    expect(risen.seconds).toBe(5_012n);
    expect(at(risen, 112n, 9_999n).seconds).toBe(5_012n);
    expect(at(risen, 100n, 1n).seconds).toBe(5_012n);
    expect(risen.wal.map((row) => (row.input._tag === "j_height" ? row.input.seconds : undefined)))
      .toEqual([5_000n, 5_012n]);
    expect(unhalted(recover(setup, genesis, risen.wal)).seconds).toBe(5_012n);
    expect(tick(started(BOB), heightAt(5n, 111n)).runtime.seconds).toBeUndefined();
  });

  test("R-HOP-SLACK an observation copies a header second onto the view and omits one it was not given", () => {
    const before = started(BOB);
    const risen = tick(before, {
      _tag: "j_observation", at: stamp(1n), to: BOB, batches: [], height: 111n as JHeight, seconds: 5_000n,
    }).runtime;
    expect(risen.seconds).toBe(5_000n);
    expect(unhalted(recover(setup, genesis, risen.wal)).seconds).toBe(5_000n);
    const unknown = tick(before, {
      _tag: "j_observation", at: stamp(1n), to: BOB, batches: [], height: 111n as JHeight,
    }).runtime;
    expect(unknown.seconds).toBeUndefined();
    const kept = tick(risen, {
      _tag: "j_observation", at: stamp(2n), to: BOB, batches: [[]], height: 111n as JHeight,
    }).runtime;
    expect(kept.seconds).toBe(5_000n);
    const cleared = tick(risen, {
      _tag: "j_observation", at: stamp(2n), to: BOB, batches: [], height: 112n as JHeight,
    }).runtime;
    expect(cleared.seconds).toBeUndefined();
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
      frame: {
        author: "left", parent: h1, attempt: 0, slot: 2, epoch: 0n, firstNonce: 2n,
        txs: [{ _tag: "pay", token: GOLD, amount }],
      },
    });
    expect(frame(1n)).not.toBe(frame(2n));
  });
});

describe("runtime/tick watcher observations", () => {
  test("R-HEIGHT-ORDER delivery batches keep output order and old-view judgments in one durable row", () => {
    const before = tick(started(BOB), inputFor(BOB, 1n, open(ALICE), open(CAROL))).runtime;
    const batches: readonly (readonly EntityInput[])[] = [[credit(ALICE, 100n)], [credit(CAROL, 200n)]];
    const at = stamp(2n);
    const height = 101n as JHeight;
    const separate = batches.reduce((rt, inputs) => tick(rt, { _tag: "entity", at, to: BOB, inputs }).runtime, before);
    const expected = tick(separate, { _tag: "j_height", at, height }).runtime;
    const staged = unhalted(apply(before, { _tag: "j_observation", at, to: BOB, batches, height }));
    expect(staged.entities).toEqual(expected.entities);
    expect(staged.view).toBe(expected.view);
    expect(staged.staged?.outputs).toEqual(expected.wal.slice(before.wal.length).flatMap((r) => r.outputs));
    expect(flush(staged).leaving).toEqual([]);
    const lost = unhalted(recover(setup, genesis, staged.wal));
    expect(lost.entities).toEqual(before.entities);
    expect(lost.view).toBe(before.view);
    const committed = unhalted(commit(staged));
    const recovered = unhalted(recover(setup, genesis, committed.wal));
    expect(recovered.entities).toEqual(expected.entities);
    expect(BigInt(recovered.view)).toBe(BigInt(height));
    expect(committed.wal.length).toBe(before.wal.length + 1);
    expect(flush(recovered).leaving).toEqual(expected.wal.flatMap((r) => r.outputs));
  });

  test("R-HEIGHT-ORDER same-height recovery applies its payload without an extra height frame", () => {
    const before = tick(started(BOB), inputFor(BOB, 1n, open(ALICE))).runtime;
    const inputs: readonly EntityInput[] = [credit(ALICE, 100n)];
    const expected = tick(before, inputFor(BOB, 2n, ...inputs)).runtime;
    const actual = tick(before, {
      _tag: "j_observation", at: stamp(2n), to: BOB, batches: [inputs], height: BigInt(before.view) as JHeight,
    }).runtime;
    expect(actual.entities).toEqual(expected.entities);
    expect(actual.wal.at(-1)?.outputs).toEqual(expected.wal.at(-1)?.outputs);
    expect(actual.wal.at(-1)?.chain).toEqual(expected.wal.at(-1)?.chain);
    expect(actual.wal.at(-1)?.notices).toEqual(expected.wal.at(-1)?.notices);
  });
});

describe("runtime/tick the registry's readings are part of the row (R-REGISTRY-AT-VIEW)", () => {
  const HASHLOCK = keccakHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const deciding = { ...setup, registry: true } as const;
  const lockCommand: Command = {
    _tag: "lock", peer: BOB, token: GOLD,
    hold: { id: holdId(1n), payer: "left", amount: 10n, hashlock: HASHLOCK, deadline: heightOf(105n) },
  };
  const reading = (at: bigint, seconds = 0n): readonly Reading[] => [{ hashlock: HASHLOCK, at, seconds }];
  const registering = (c: Cluster): Cluster =>
    ({ ...c, hosts: new Map([...c.hosts].map(([id, rt]) => [id, { ...rt, setup: deciding }])) });
  const rowOf = (rt: ReturnType<typeof started>) => rt.wal.at(-1) ?? expect.unreachable("no row");
  const mempoolOf = (c: Cluster) =>
    hostOf(c, ALICE).entities.get(ALICE)?.accounts.get(BOB)?.mempool.map((tx) => tx._tag);

  /** Alice and Bob with an Account open and credit both ways, both deciding on the registry. */
  const linked = (): Cluster => {
    const opened = settle(feed(feed(registering(start()), ALICE, open(BOB)), BOB, open(ALICE)));
    return settle(feed(feed(opened, ALICE, credit(BOB, 1000n)), BOB, credit(ALICE, 1000n)));
  };

  const alice = () => hostOf(linked(), ALICE);
  const refusedFor = (rt: ReturnType<typeof started>): readonly string[] =>
    rowOf(rt).notices.flatMap((n) => (n._tag === "command_refused" && n.fault._tag === "account_refused"
      ? [n.fault.fault._tag] : []));

  test("R-REGISTRY-AT-VIEW the readings a batch carries are what its frame decides on, and the row keeps them", () => {
    const asked = { ...inputFor(ALICE, 3n, lockCommand), registry: reading(100n) } as const;
    const taken = tick(alice(), asked);
    expect(rowOf(taken.runtime).notices).toEqual([]);
    expect(rowOf(taken.runtime).input).toEqual(asked);
    expect(refusedFor(tick(alice(), inputFor(ALICE, 3n, lockCommand)).runtime)).toEqual(["registry_unknown"]);
    const stale = tick(alice(), { ...inputFor(ALICE, 3n, lockCommand), registry: reading(99n) });
    expect(refusedFor(stale.runtime)).toEqual(["registry_unknown"]);
    const paid = tick(alice(), { ...inputFor(ALICE, 3n, lockCommand), registry: reading(100n, 1n) });
    expect(refusedFor(paid.runtime)).toEqual(["paid_on_chain"]);
  });

  test("R-REGISTRY-AT-VIEW a Runtime that does not decide on the registry ignores the readings of its batch", () => {
    const plain = { ...alice(), setup };
    const taken = tick(plain, { ...inputFor(ALICE, 3n, lockCommand), registry: reading(100n, 1n) });
    expect(rowOf(taken.runtime).notices).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW a frame replays from its row: the same readings make the same Entity", () => {
    const before = alice();
    const taken = tick(before, { ...inputFor(ALICE, 3n, lockCommand), registry: reading(100n) });
    const recovered = unhalted(recover(deciding, [emptyEntity(ALICE)], taken.runtime.wal));
    expect(recovered.entities).toEqual(taken.runtime.entities);
  });

  test("R-REGISTRY-AT-VIEW a new height carries the readings the frame of every Entity decides on", () => {
    const framed = feed(linked(), ALICE, pay(BOB, 1n));
    const lockAt100 = { ...inputFor(ALICE, framed.clock, lockCommand), registry: reading(100n) };
    const asked = tick(hostOf(framed, ALICE), lockAt100);
    expect(asked.leaving).toEqual([]);
    const queued = { ...framed, hosts: new Map([...framed.hosts, [ALICE, asked.runtime]]), clock: framed.clock + 1n };
    const answered = settle(queued);
    expect(mempoolOf(answered)).toEqual(["lock"]);
    expect(answered.inflight).toEqual([]);
    const unread = rise(answered, ALICE, 101n);
    expect(mempoolOf(unread)).toEqual(["lock"]);
    expect(unread.inflight).toEqual([]);
    const read = tick(hostOf(answered, ALICE), { ...heightAt(answered.clock, 101n), registry: reading(101n) });
    expect(read.leaving.length).toBe(1);
    expect(read.runtime.entities.get(ALICE)?.accounts.get(BOB)?.mempool).toEqual([]);
    expect(rowOf(read.runtime).notices).toEqual([]);
  });

  test("R-REGISTRY-AT-VIEW an observation keeps a present list, and an empty one is not the gate off", () => {
    const before = alice();
    const height = BigInt(before.view) as JHeight;
    const accepted = tick(before, {
      _tag: "j_observation", at: stamp(3n), to: ALICE, batches: [[lockCommand]], height, registry: reading(100n),
    });
    expect(rowOf(accepted.runtime).input).toMatchObject({ _tag: "j_observation", registry: reading(100n) });
    expect(refusedFor(accepted.runtime)).toEqual([]);
    const empty = tick(before, {
      _tag: "j_observation", at: stamp(3n), to: ALICE, batches: [[lockCommand]], height, registry: [],
    });
    expect(rowOf(empty.runtime).input).toMatchObject({ _tag: "j_observation", registry: [] });
    expect(refusedFor(empty.runtime)).toEqual(["registry_unknown"]);
    const recovered = unhalted(recover(deciding, [emptyEntity(ALICE)], accepted.runtime.wal));
    expect(recovered.entities).toEqual(accepted.runtime.entities);
  });
});
