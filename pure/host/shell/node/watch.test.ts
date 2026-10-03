// A node with a J loop over a chain that is scripted (R-JLOOP, R-HEIGHT-ORDER): the events reach the Entity before
// the height does, the cursor moves only with the height's row, a restart begins at the view its WAL holds, a node
// whose reads fail goes on at the next tick, and a reorg deeper than the depth ends it.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { err, ok } from "../../../kernel/core/result.ts";
import {
  blockOf, DEPOSITORY, entityOf as bytes, evidenceOf, finalizeInput, finalizeOp, hexOf, logOf, must as made,
} from "../../../j/fixtures.ts";
import type { Row } from "../../../runtime/model.ts";
import { entityOf as entityNumbered, forwarded } from "../../../entity/fixtures.ts";
import { open } from "../../../runtime/fixtures.ts";
import type { Disk } from "../disk/disk.ts";
import { callsOf } from "../fixtures.ts";
import type { PortFault } from "../submit/chain.ts";
import type { Look } from "./daemon.ts";
import {
  FEW_TRIES, NO_CARRY, type Carry, type Probe, type Traced, type WatchConfig, type WatchPort,
} from "../watch/loop.ts";
import { startDaemon, stallNotices } from "./daemon.ts";
import { ALICE, BOB, configOf, fresh, nodeOf, QUICK, seatOf, until, WAIT } from "./scene.ts";

const DOWN: PortFault = { _tag: "port", call: "watch head", reason: "connection reset" };

const START = 100n;
const DEPTH = 2n;
const NO_PEER = undefined;

/** `rises` is a head that is one block higher at each poll of it: the chain goes on while the node waits. */
type Chain = Readonly<{ head: bigint; fork: (block: bigint) => bigint; down?: string; rises?: boolean }>;

const advanced = (block: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: bytes(1n), right: bytes(2n), ondeltaEpoch: epoch }, block, 0n);

const settled = (block: bigint) => logOf("AccountSettled", {
  settled: [[bytes(1n), bytes(2n), [[1n, 900n, 1000n, 100n, [0n, 100n]]], 0n]],
}, block, 0n);

/** Whether the node may hold value, what its provider says of a call trace, and what it gives of a transaction. */
type Kind = Readonly<{
  value: boolean; probe: Probe; trace: Traced; input: "down" | "given" | "hidden";
}>;
const UNREADABLE: Traced = { _tag: "unreadable" };
const QUIET: Kind = { value: false, probe: "traces", trace: UNREADABLE, input: "down" };
const VALUE_BLIND: Kind = { ...QUIET, value: true, probe: "none" };
const NO_VALUE_BLIND: Kind = { ...QUIET, probe: "none" };
const VALUE_TRACED: Kind = { ...QUIET, value: true };
const VALUE_NO_TX: Kind = { ...QUIET, value: true, probe: "no_transaction" };
const FINALIZE = finalizeOp();
const HIDDEN = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);

/** The finalize the tests' chain holds, at block 105: its Account is the node's with BOB. */
const finalized = logOf("DisputeFinalized", {
  sender: bytes(2n), counterentity: bytes(1n), nonce: 7n, finalProofbodyHash: hexOf(5n),
  finalizationEvidenceHash: evidenceOf(FINALIZE),
}, 105n, 1n);

const inputOf = (kind: Kind) => {
  if (kind.input === "down") return err(DOWN);
  const data = kind.input === "given" ? finalizeInput(bytes(2n), [FINALIZE]) : HIDDEN;
  return ok({ data, route: kind.input === "given" ? "direct" as const : "wrapper" as const });
};

/** A chain with one epoch advance at block 105; `down` is a file that, while it is not there, fails the head. */
const portOf = (chain: Chain, log: string, found = [advanced(105n, 1n)], kind = QUIET): WatchPort => ({
  head: () => {
    appendFileSync(log, "head\n");
    const rose = chain.rises === true ? BigInt(callsOf(log).filter((c) => c === "head").length) - 1n : 0n;
    return Promise.resolve(chain.down !== undefined && !existsSync(chain.down) ? err(DOWN) : ok(chain.head + rose));
  },
  block: (number) => {
    appendFileSync(log, `block ${number}\n`);
    return Promise.resolve(ok(blockOf(number, chain.fork(number))));
  },
  logs: (from, to) => Promise.resolve(ok(found.filter((l) => l.block >= from && l.block <= to))),
  accountAt: () => Promise.resolve(ok({ epoch: 1n, nonce: 5n })),
  input: () => {
    appendFileSync(log, "input\n");
    return Promise.resolve(inputOf(kind));
  },
  trace: () => Promise.resolve(ok(kind.trace)),
  traced: () => Promise.resolve(ok(kind.probe)),
});

const watchOf = (chain: Chain, log: string, found = [advanced(105n, 1n)], kind = QUIET): WatchConfig => ({
  port: portOf(chain, log, found, kind), depository: DEPOSITORY, depth: DEPTH, hosted: bytes(1n), value: kind.value,
});

const STRAIGHT: Chain = { head: 112n, fork: () => 0n };

const factsOf = (look: Look) => look.station.host.runtime.entities.get(ALICE)?.chain.get(BOB);

const blindOf = (look: Look): boolean => look.station.host.runtime.entities.get(ALICE)?.blind === true;

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

  test("R-WATCH-CALLDATA a node with value waits for a transaction to tell if the provider traces", async () => {
    expect(await booted(VALUE_NO_TX)).toEqual({ _tag: "no_probe_tx" });
    expect(await booted({ ...VALUE_NO_TX, value: false })).toBe("started");
  });

  test("R-WATCH-CALLDATA a no-value node starts with no call trace, and a node with value with one", async () => {
    expect(await booted(NO_VALUE_BLIND)).toBe("started");
    expect(await booted(VALUE_TRACED)).toBe("started");
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

  /** A node of ALICE with BOB on `chain`, over a finalize whose transaction the provider answers as `kind` says. */
  const stalling = async (dir: string, log: string, chain: Chain, kind: Kind) => {
    writeFileSync(log, "");
    const watch = watchOf(chain, log, [advanced(105n, 1n), finalized], kind);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch });
    await alice.tell(open(BOB));
    return alice;
  };

  test("R-WATCH-STALL a tx the provider refuses holds its Account only; the Entity is told it is behind", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    const alice = await stalling(dir, log, STRAIGHT, QUIET);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(factsOf(look)).toMatchObject({ epoch: 0n, behind: 105n });
    expect(look.station.host.runtime.view).toBe(110n as never);
    expect(look.watchFault).toBe("watch head: connection reset");
    expect(look.notices.filter((n) => n._tag === "watch_stalled")).toEqual([
      { _tag: "watch_stalled", tx: finalized.tx, reason: "connection reset" },
    ]);
    expect(callsOf(log).filter((c) => c === "input")).toHaveLength(1);
  });

  test("R-WATCH-STALL a tx the provider keeps refusing is waited on FEW_TRIES blocks, then told unread", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    const alice = await stalling(dir, log, { ...STRAIGHT, rises: true }, QUIET);
    expect(await until(async () => factsOf(await alice.look())?.epoch === 1n, WAIT)).toBe(true);
    const look = await alice.stop();
    expect(callsOf(log).filter((c) => c === "input")).toHaveLength(3);
    expect(look.watchFault).toBeUndefined();
    expect(look.notices.filter((n) => n._tag === "watch_stalled")).toHaveLength(1);
    expect(factsOf(look)?.behind).toBeUndefined();
  });

  test("R-WATCH-STALL a node with a forward to the peer waits past FEW_TRIES, until its lock's last view", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const watch = watchOf({ ...STRAIGHT, rises: true }, log, [advanced(105n, 1n), finalized], QUIET);
    const genesis = forwarded(ALICE, entityNumbered(3), BOB, 111n, 121n);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch, genesis });
    const tries = () => callsOf(log).filter((c) => c === "input").length;
    expect(await until(async () => tries() >= FEW_TRIES + 2, WAIT)).toBe(true);
    expect(factsOf(await alice.look())).toMatchObject({ epoch: 0n, behind: 105n });
    expect(await until(async () => factsOf(await alice.look())?.epoch === 1n, WAIT)).toBe(true);
    const look = await alice.stop();
    expect(tries()).toBeGreaterThanOrEqual(8);
    expect(factsOf(look)?.behind).toBeUndefined();
  });

  test("R-WATCH-STALL an Account stays behind after a restart until a delivery reaches the WAL's view", async () => {
    const dir = fresh();
    const alice = await stalling(dir, `${dir}/first.log`, STRAIGHT, QUIET);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    await alice.stop();
    const second = `${dir}/second.log`;
    writeFileSync(second, "");
    const lower: Chain = { head: 108n, fork: () => 0n };
    const given = watchOf(lower, second, [advanced(105n, 1n), finalized], { ...QUIET, input: "given" });
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch: given });
    expect(await until(async () => (await again.look()).cursor === 106n, WAIT)).toBe(true);
    const look = await again.stop();
    expect(factsOf(look)).toMatchObject({ epoch: 1n, behind: 105n });
    expect(look.station.host.runtime.view).toBe(110n as never);
  });

  test("R-WATCH-STALL a stall is told once, and again only when the call that fails is another", () => {
    const fault = (call: string, reason: string): PortFault => ({ _tag: "port", call, reason });
    const tx = finalized.tx;
    const stall = (call: string, reason: string) => ({ tx, peer: bytes(2n), fault: fault(call, reason), tries: 1 });
    const was = (call: string): Carry =>
      ({ ...NO_CARRY, failing: new Map([[tx, { tries: 1, head: 7n, fault: fault(call, "first") }]]) });
    expect(stallNotices(NO_CARRY, [stall("watch tx", "503")])).toEqual([{ _tag: "watch_stalled", tx, reason: "503" }]);
    expect(stallNotices(was("watch tx"), [stall("watch tx", "timeout")])).toEqual([]);
    expect(stallNotices(was("watch tx"), [stall("watch trace", "timeout")])).toEqual([
      { _tag: "watch_stalled", tx, reason: "timeout" },
    ]);
  });

  test("R-WATCH-STALL a restart begins before the block its Account was held back from", async () => {
    const dir = fresh();
    const first = `${dir}/first.log`;
    const alice = await stalling(dir, first, STRAIGHT, QUIET);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    await alice.stop();
    const second = `${dir}/second.log`;
    writeFileSync(second, "");
    const given = watchOf(STRAIGHT, second, [advanced(105n, 1n), finalized], { ...QUIET, input: "given" });
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch: given });
    expect(await until(async () => factsOf(await again.look())?.epoch === 1n, WAIT)).toBe(true);
    const look = await again.stop();
    expect(callsOf(second).find((c) => c.startsWith("block"))).toBe("block 104");
    expect(factsOf(look)?.behind).toBeUndefined();
    expect(look.station.host.runtime.view).toBe(110n as never);
  });

  test("R-WATCH-CALLDATA no call trace at run time blinds a node with value and does not end it", async () => {
    const dir = fresh();
    const hidden: Kind = { ...VALUE_TRACED, input: "hidden", trace: { _tag: "no_method" } };
    const alice = await stalling(dir, `${dir}/calls.log`, STRAIGHT, hidden);
    expect(await until(async () => blindOf(await alice.look()), WAIT)).toBe(true);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(look.fatal).toBeUndefined();
    expect(factsOf(look)).toMatchObject({ epoch: 1n });
    expect(look.notices.filter((n) => n._tag === "watch_stalled")).toEqual([]);
    const quiet = await stalling(fresh(), `${dir}/quiet.log`, STRAIGHT, { ...hidden, value: false });
    expect(await until(async () => factsOf(await quiet.look())?.epoch === 1n, WAIT)).toBe(true);
    expect(blindOf(await quiet.stop())).toBe(false);
  });

  test("R-WATCH-CALLDATA a blind node that boots on a provider that traces is told its Entity sees again", async () => {
    const dir = fresh();
    const hidden: Kind = { ...VALUE_TRACED, input: "hidden", trace: { _tag: "no_method" } };
    const alice = await stalling(dir, `${dir}/first.log`, STRAIGHT, hidden);
    expect(await until(async () => blindOf(await alice.look()), WAIT)).toBe(true);
    await alice.stop();
    const second = `${dir}/second.log`;
    writeFileSync(second, "");
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, second, [advanced(105n, 1n), finalized], VALUE_TRACED),
    });
    expect(await until(async () => !blindOf(await again.look()), WAIT)).toBe(true);
    expect((await again.stop()).fatal).toBeUndefined();
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
