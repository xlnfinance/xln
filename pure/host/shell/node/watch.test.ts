// A node with a J loop over a chain that is scripted (R-JLOOP, R-HEIGHT-ORDER): the events reach the Entity before
// the height does, the cursor moves only with the height's row, a restart begins at the view its WAL holds, a node
// whose reads fail goes on at the next tick, and a reorg deeper than the depth ends it.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { err, ok } from "../../../kernel/core/result.ts";
import {
  blockOf, DEPOSITORY, entityOf as bytes, evidenceOf, finalizeOp, hexOf, logOf, must as made,
} from "../../../j/fixtures.ts";
import type { Row } from "../../../runtime/model.ts";
import { open } from "../../../runtime/fixtures.ts";
import type { Disk } from "../disk/disk.ts";
import { callsOf } from "../fixtures.ts";
import type { PortFault } from "../submit/chain.ts";
import type { Look } from "./daemon.ts";
import { MOST_TRIES, type WatchConfig, type WatchPort } from "../watch/loop.ts";
import { startDaemon } from "./daemon.ts";
import { ALICE, BOB, configOf, fresh, nodeOf, QUICK, seatOf, until, WAIT } from "./scene.ts";

const DOWN: PortFault = { _tag: "port", call: "watch head", reason: "connection reset" };

const START = 100n;
const DEPTH = 2n;
const NO_PEER = undefined;

type Chain = Readonly<{ head: bigint; fork: (block: bigint) => bigint; down?: string }>;

const advanced = (block: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: bytes(1n), right: bytes(2n), ondeltaEpoch: epoch }, block, 0n);

const settled = (block: bigint) => logOf("AccountSettled", {
  settled: [[bytes(1n), bytes(2n), [[1n, 900n, 1000n, 100n, [0n, 100n]]], 0n]],
}, block, 0n);

/** Whether the node may hold value, and whether its provider has a call trace. */
type Kind = Readonly<{ value: boolean; traces: boolean }>;
const QUIET: Kind = { value: false, traces: true };
const VALUE_BLIND: Kind = { value: true, traces: false };
const NO_VALUE_BLIND: Kind = { value: false, traces: false };
const VALUE_TRACED: Kind = { value: true, traces: true };

/** A chain with one epoch advance at block 105; `down` is a file that, while it is not there, fails the head. */
const portOf = (chain: Chain, log: string, found = [advanced(105n, 1n)], kind = QUIET): WatchPort => ({
  head: () => {
    appendFileSync(log, "head\n");
    return Promise.resolve(chain.down !== undefined && !existsSync(chain.down) ? err(DOWN) : ok(chain.head));
  },
  block: (number) => {
    appendFileSync(log, `block ${number}\n`);
    return Promise.resolve(ok(blockOf(number, chain.fork(number))));
  },
  logs: (from, to) => Promise.resolve(ok(found.filter((l) => l.block >= from && l.block <= to))),
  accountAt: () => Promise.resolve(ok({ epoch: 1n, nonce: 5n })),
  input: () => {
    appendFileSync(log, "input\n");
    return Promise.resolve(err(DOWN));
  },
  trace: () => Promise.resolve(ok(undefined)),
  traced: () => Promise.resolve(ok(kind.traces)),
});

const watchOf = (chain: Chain, log: string, found = [advanced(105n, 1n)], kind = QUIET, slack = 0n): WatchConfig => ({
  port: portOf(chain, log, found, kind), depository: DEPOSITORY, depth: DEPTH, hosted: bytes(1n), value: kind.value,
  slack,
});

const STRAIGHT: Chain = { head: 112n, fork: () => 0n };

const factsOf = (look: Look) => look.station.host.runtime.entities.get(ALICE)?.chain.get(BOB);

const rowsOf = (look: Look): readonly Row[] => look.station.host.runtime.wal;

const delivered = (look: Look): boolean => look.cursor === 110n;

const booted = async (kind: Kind) => {
  const dir = fresh();
  const log = `${dir}/calls.log`;
  writeFileSync(log, "");
  const seat = await seatOf(ALICE, dir, 0);
  const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n)], kind);
  const config = await configOf(seat, NO_PEER, { tickMs: QUICK, watch });
  const started = await startDaemon(config, seat.listener);
  if (started.ok) await started.value.stop();
  else {
    await config.shell.wal.close();
    await config.shell.io.journal.close();
  }
  return started.ok ? "started" : started.error;
};

describe("host/shell/node a node with a J loop", () => {
  test("R-HTLC-FORWARD a node whose clock lag is not above its read depth is not started", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const seat = await seatOf(ALICE, dir, 0);
    const config = await configOf(seat, NO_PEER, { tickMs: QUICK, watch: watchOf(STRAIGHT, log), lag: DEPTH });
    const refused = await startDaemon(config, seat.listener);
    await config.shell.wal.close();
    await config.shell.io.journal.close();
    expect(refused).toEqual(err({ _tag: "clock_below_depth", lag: DEPTH, depth: DEPTH }));
    expect(readFileSync(`${dir}/wal.log`, "utf8")).toBe("");
  });

  test("R-WATCH-CALLDATA a provider with no call trace refuses a node with value, and writes nothing", async () => {
    expect(await booted(VALUE_BLIND)).toEqual({ _tag: "no_call_trace" });
  });

  test("R-WATCH-CALLDATA a no-value node starts with no call trace, and a node with value with one", async () => {
    expect(await booted(NO_VALUE_BLIND)).toBe("started");
    expect(await booted(VALUE_TRACED)).toBe("started");
  });

  test("R-WATCH-CALLDATA the hold is the hop less the slack, the lag and the depth the node reads at", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const op = finalizeOp();
    const finalize = logOf("DisputeFinalized", {
      sender: bytes(2n), counterentity: bytes(1n), nonce: 7n, finalProofbodyHash: hexOf(5n),
      finalizationEvidenceHash: evidenceOf(op),
    }, 105n, 1n);
    // hop 63 (reserve 60, lag 3), slack 50: hold = 63 - 50 - 3 - 2 - 1 = 7; the finalize of block 105 is 8 old at 115
    const watch = watchOf({ ...STRAIGHT, head: 115n }, log, [advanced(105n, 1n), finalize], QUIET, 50n);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch, reserve: 60n });
    expect(await until(async () => (await alice.look()).cursor === 113n, WAIT)).toBe(true);
    await alice.stop();
    expect(callsOf(log).filter((c) => c === "input")).toHaveLength(3);
  });

  test("R-WATCH-CALLDATA a node whose hop leaves no block to hold delivery for is not started", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const seat = await seatOf(ALICE, dir, 0);
    const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n)], QUIET, 1n);
    const config = await configOf(seat, NO_PEER, { tickMs: QUICK, watch });
    const refused = await startDaemon(config, seat.listener);
    await config.shell.wal.close();
    await config.shell.io.journal.close();
    expect(refused).toEqual(err({ _tag: "hold_below_zero", hop: 6n, slack: 1n, lag: 3n, depth: DEPTH }));
    expect(readFileSync(`${dir}/wal.log`, "utf8")).toBe("");
  });

  test("R-HTLC-CLOCK a node whose clock names another depth than it reads at is not started", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const seat = await seatOf(ALICE, dir, 0);
    const config = await configOf(seat, NO_PEER, { tickMs: QUICK, watch: watchOf(STRAIGHT, log), depth: 0n });
    const refused = await startDaemon(config, seat.listener);
    await config.shell.wal.close();
    await config.shell.io.journal.close();
    expect(refused).toEqual(err({ _tag: "clock_depth_off", clock: 0n, depth: DEPTH }));
  });

  test("R-JLOOP a node tells its Entity what the chain's final blocks hold; its view moves up to them", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, log),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(factsOf(look)).toMatchObject({ epoch: 1n, stored: 5n });
    expect(look.station.host.runtime.view).toBe(110n as never);
    expect(look.watchFault).toBeUndefined();
    expect(callsOf(log).slice(0, 2)).toEqual(["block 100", "head"]);
  });

  test("R-HEIGHT-ORDER the events are in the WAL before the height, and the cursor is the height's", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, log),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const rows = rowsOf(await alice.stop());
    const eventRow = rows.findIndex(
      (r) => r.input._tag === "entity" && r.input.inputs.some((i) => i._tag === "j_epoch"),
    );
    const heightRow = rows.findIndex((r) => r.input._tag === "j_height");
    expect(eventRow).toBeGreaterThanOrEqual(0);
    expect(heightRow).toBeGreaterThan(eventRow);
  });

  test("R-J-COLLATERAL what the chain holds reaches the Entity, and a restart from the WAL has it", async () => {
    const dir = fresh();
    const [first, second] = [`${dir}/first.log`, `${dir}/second.log`];
    writeFileSync(first, "");
    writeFileSync(second, "");
    const held = (look: Look) => [...(factsOf(look)?.held ?? [])].map(([token, h]) => [token, h.collateral, h.ondelta]);
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, first, [settled(105n)]),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    expect(held(await alice.stop())).toEqual([[1n, 100n, 100n]]);
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, second, []),
    });
    expect(held(await again.look())).toEqual([[1n, 100n, 100n]]);
    await again.stop();
  });

  test("R-JLOOP a restart begins the J loop at the view its WAL holds, not at the chain's start", async () => {
    const dir = fresh();
    const first = `${dir}/first.log`;
    writeFileSync(first, "");
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, first),
    });
    await alice.tell(open(BOB));
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    await alice.stop();
    const second = `${dir}/second.log`;
    writeFileSync(second, "");
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, second),
    });
    expect(await until(async () => (await again.look()).cursor !== undefined, WAIT)).toBe(true);
    await again.stop();
    expect(callsOf(second).find((c) => c.startsWith("block"))).toBe("block 110");
  });

  test("R-JLOOP a read of the chain that fails is tried again at the next tick, and the node goes on", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, log),
    });
    expect(await until(async () => (await alice.look()).watchFault !== undefined, WAIT)).toBe(true);
    expect((await alice.look()).fatal).toBeUndefined();
    expect((await alice.look()).watchFault).toBe("watch head: connection reset");
    writeFileSync(up, "up");
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    expect((await alice.stop()).watchFault).toBeUndefined();
  });

  test("R-WATCH-CALLDATA a tx the provider always refuses holds the node MOST_TRIES ticks, then goes on", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const op = finalizeOp();
    const finalize = logOf("DisputeFinalized", {
      sender: bytes(2n), counterentity: bytes(1n), nonce: 7n, finalProofbodyHash: hexOf(5n),
      finalizationEvidenceHash: evidenceOf(op),
    }, 105n, 1n);
    const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n), finalize]);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch, reserve: 60n });
    expect(await until(async () => (await alice.look()).watchFault !== undefined, WAIT)).toBe(true);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(callsOf(log).filter((c) => c === "input")).toHaveLength(MOST_TRIES + 1);
    expect(look.watchFault).toBeUndefined();
    expect(look.notices.filter((n) => n._tag === "watch_stalled")).toEqual([
      { _tag: "watch_stalled", tx: finalize.tx, reason: "connection reset" },
    ]);
    expect(callsOf(log).filter((c) => c === "head").length).toBeGreaterThan(MOST_TRIES);
    expect(factsOf(look)).toMatchObject({ epoch: 1n });
  });

  test("R-WATCH-CALLDATA a tx the provider refuses past the hold the hop leaves holds three tries", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const op = finalizeOp();
    const finalize = logOf("DisputeFinalized", {
      sender: bytes(2n), counterentity: bytes(1n), nonce: 7n, finalProofbodyHash: hexOf(5n),
      finalizationEvidenceHash: evidenceOf(op),
    }, 105n, 1n);
    const watch = watchOf({ ...STRAIGHT, head: 140n }, log, [advanced(105n, 1n), finalize]);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch });
    expect(await until(async () => (await alice.look()).cursor === 138n, WAIT)).toBe(true);
    await alice.stop();
    expect(callsOf(log).filter((c) => c === "input")).toHaveLength(3);
  });

  test("R-JLOOP a block off the cursor's chain ends the node, and every request gets that answer", async () => {
    const log = `${fresh()}/calls.log`;
    writeFileSync(log, "");
    const forked: Chain = { head: 112n, fork: (block) => (block === START ? 0n : 1n) };
    const alice = await nodeOf(await seatOf(ALICE, fresh(), 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(forked, log),
    });
    expect(await until(async () => (await alice.look()).fatal !== undefined, WAIT)).toBe(true);
    const told = await alice.tell(open(BOB));
    expect(told.ok ? "ok" : told.error._tag).toBe("deep_reorg");
    const look = await alice.stop();
    expect(look.fatal?._tag).toBe("deep_reorg");
    expect(look.cursor).toBe(START);
    expect(made(ok(callsOf(log).filter((c) => c === "head").length)) > 0).toBe(true);
  });

  const failingAt = (count: string, at: number) => (disk: Disk): Disk => ({
    ...disk,
    run: (ops) => {
      appendFileSync(count, ".");
      return readFileSync(count, "utf8").length === at
        ? Promise.resolve(err({ _tag: "disk", op: "write", reason: "full" } as const))
        : disk.run(ops);
    },
  });

  test.each([
    ["the events' row", 2], ["the height's row", 3],
  ])("R-HEIGHT-ORDER a delivery whose WAL write fails ends it: no height after lost events (%s)", async (_, at) => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const count = `${dir}/count`;
    writeFileSync(count, "");
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, log), wrap: failingAt(count, at),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => (await alice.look()).fatal !== undefined, WAIT)).toBe(true);
    const look = await alice.stop();
    expect(look.fatal?._tag).toBe("disk");
    expect(look.cursor).toBe(START);
    expect(rowsOf(look).some((r) => r.input._tag === "j_height")).toBe(false);
  });
});
