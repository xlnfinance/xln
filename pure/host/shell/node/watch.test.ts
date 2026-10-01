// A node with a J loop over a chain that is scripted (R-JLOOP, R-HEIGHT-ORDER): the events reach the Entity before
// the height does, the cursor moves only with the height's row, a restart begins at the view its WAL holds, a node
// whose reads fail goes on at the next tick, and a reorg deeper than the depth ends it.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { err, ok } from "../../../kernel/core/result.ts";
import { blockOf, DEPOSITORY, entityOf as bytes, logOf, must as made } from "../../../j/fixtures.ts";
import type { Row } from "../../../runtime/model.ts";
import { open } from "../../../runtime/fixtures.ts";
import type { Disk } from "../disk/disk.ts";
import type { PortFault } from "../submit/chain.ts";
import type { Look } from "./daemon.ts";
import type { WatchConfig, WatchPort } from "../watch/loop.ts";
import { ALICE, BOB, fresh, nodeOf, QUICK, seatOf, until, WAIT } from "./scene.ts";

const DOWN: PortFault = { _tag: "port", call: "watch head", reason: "connection reset" };

const START = 100n;
const DEPTH = 2n;
const NO_PEER = undefined;

type Chain = Readonly<{ head: bigint; fork: (block: bigint) => bigint; down?: string }>;

const callsOf = (path: string): readonly string[] => readFileSync(path, "utf8").split("\n").filter((l) => l !== "");

const advanced = (block: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: bytes(1n), right: bytes(2n), ondeltaEpoch: epoch }, block, 0n);

const settled = (block: bigint) => logOf("AccountSettled", {
  settled: [[bytes(1n), bytes(2n), [[1n, 900n, 1000n, 100n, [0n, 100n]]], 0n]],
}, block, 0n);

/** A chain with one epoch advance at block 105; `down` is a file that, while it is not there, fails the head. */
const portOf = (chain: Chain, log: string, found = [advanced(105n, 1n)]): WatchPort => ({
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
});

const watchOf = (chain: Chain, log: string, found = [advanced(105n, 1n)]): WatchConfig =>
  ({ port: portOf(chain, log, found), depository: DEPOSITORY, depth: DEPTH, hosted: bytes(1n) });

const STRAIGHT: Chain = { head: 112n, fork: () => 0n };

const factsOf = (look: Look) => look.station.host.runtime.entities.get(ALICE)?.chain.get(BOB);

const rowsOf = (look: Look): readonly Row[] => look.station.host.runtime.wal;

const delivered = (look: Look): boolean => look.cursor === 110n;

describe("host/shell/node a node with a J loop", () => {
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

  test("R-J-COLLATERAL what the chain holds for an Account reaches the Entity's ledger, and a restart's", async () => {
    const dir = fresh();
    const [first, second] = [`${dir}/first.log`, `${dir}/second.log`];
    writeFileSync(first, "");
    writeFileSync(second, "");
    const held = (look: Look) => {
      const account = look.station.host.runtime.entities.get(ALICE)?.accounts.get(BOB);
      return account === undefined
        ? undefined
        : [...account.state.ledgers.values()].map((l) => [l.collateral, l.ondelta]);
    };
    const up = `${dir}/up`;
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf({ ...STRAIGHT, down: up }, first, [settled(105n)]),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    expect(held(await alice.stop())).toEqual([[100n, 100n]]);
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, second, []),
    });
    expect(held(await again.look())).toEqual([[100n, 100n]]);
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
