// A node with a J loop over a chain that is scripted (R-JLOOP, R-HEIGHT-ORDER): the events reach the Entity before
// the height does within one atomic observation, a restart begins at the view its WAL holds, a node
// whose reads fail goes on at the next tick, and a reorg deeper than the depth ends it.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { err, ok } from "../../../kernel/core/result.ts";
import {
  blockOf, DEPLOYED, entityOf as bytes, evidenceOf, finalizeInput, finalizeOp, hexOf, logOf, must as made,
} from "../../../j/fixtures.ts";
import type { Row } from "../../../runtime/model.ts";
import { entityOf as entityNumbered, forwarded } from "../../../entity/fixtures.ts";
import { open } from "../../../runtime/fixtures.ts";
import type { Disk } from "../disk/disk.ts";
import { scanWal } from "../disk/wal.ts";
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
  /** A file that, once there, makes the provider answer the probe `none`: the trace method goes away at run time. */
  off?: string;
  /** The provider no longer serves the state of the blocks the node's readings of an Account need. */
  pruned?: boolean;
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
  accountAt: () => {
    appendFileSync(log, "account\n");
    return Promise.resolve(ok(kind.pruned === true ? "pruned" as const : { epoch: 1n, nonce: 5n }));
  },
  input: () => {
    appendFileSync(log, "input\n");
    return Promise.resolve(inputOf(kind));
  },
  trace: () => {
    if (kind.off !== undefined && kind.trace._tag === "no_method") writeFileSync(kind.off, "off");
    return Promise.resolve(ok(kind.trace));
  },
  traced: (at) => {
    appendFileSync(log, `probe ${at}\n`);
    const off = kind.off !== undefined && existsSync(kind.off);
    return Promise.resolve(ok(off ? "none" : kind.probe));
  },
});

const watchOf = (chain: Chain, log: string, found = [advanced(105n, 1n)], kind = QUIET): WatchConfig => ({
  port: portOf(chain, log, found, kind), deployed: DEPLOYED, depth: DEPTH, hosted: bytes(1n), value: kind.value,
});

const STRAIGHT: Chain = { head: 112n, fork: () => 0n };

const factsOf = (look: Look) => look.station.host.runtime.entities.get(ALICE)?.chain.get(BOB);

const entriesOf = (look: Look): readonly string[] =>
  [...(look.station.host.runtime.entities.get(ALICE)?.paybook.values() ?? [])].map((entry) => entry._tag);

const blindOf = (look: Look): boolean => look.station.host.runtime.entities.get(ALICE)?.blind === true;

const rowsOf = (look: Look): readonly Row[] => look.station.host.runtime.wal;

const inputsOf = (row: Row) => {
  switch (row.input._tag) {
    case "entity": return row.input.inputs;
    case "j_observation": return row.input.batches.flat();
    case "j_height": return [];
  }
};

/** How many notices of the Host the node told, and how many of the Entity the WAL holds, of one kind. */
const told = (look: Look, tag: string): number => look.notices.filter((n) => n._tag === tag).length;
const entityTold = (look: Look, tag: string): number =>
  rowsOf(look).flatMap((r) => r.notices).filter((n) => n._tag === tag).length;

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

  test("R-WATCH-CALLDATA a node with value boots blind on any provider, watches, and probes at each head", async () => {
    const [dir, none, quiet] = [fresh(), fresh(), fresh()];
    const probes = (log: string) => callsOf(log).filter((c) => c.startsWith("probe"));
    const blinded = async (where: string, kind: Kind) => {
      const log = `${where}/calls.log`;
      writeFileSync(log, "");
      const watch = watchOf({ ...STRAIGHT, rises: true }, log, [advanced(105n, 1n)], kind);
      const alice = await nodeOf(await seatOf(ALICE, where, 0), NO_PEER, { tickMs: QUICK, watch });
      expect(await until(async () => probes(log).length >= 3, WAIT)).toBe(true);
      return { look: await alice.stop(), log };
    };
    const refused = await blinded(dir, VALUE_BLIND);
    expect(refused.look.fatal).toBeUndefined();
    expect(blindOf(refused.look)).toBe(true);
    expect(factsOf(refused.look)).toMatchObject({ epoch: 1n });
    expect(new Set(probes(refused.log)).size).toBeGreaterThanOrEqual(3);
    expect(told(refused.look, "no_call_trace")).toBe(1);
    expect(entityTold(refused.look, "chain_blind")).toBe(0);
    const empty = await blinded(none, VALUE_NO_TX);
    expect(blindOf(empty.look)).toBe(true);
    expect(empty.look.fatal).toBeUndefined();
    const log = `${quiet}/calls.log`;
    writeFileSync(log, "");
    const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n)], { ...VALUE_BLIND, value: false });
    const free = await nodeOf(await seatOf(ALICE, quiet, 0), NO_PEER, { tickMs: QUICK, watch });
    expect(await until(async () => delivered(await free.look()), WAIT)).toBe(true);
    expect(blindOf(await free.stop())).toBe(false);
    expect(callsOf(log).filter((c) => c.startsWith("probe"))).toEqual([]);
  });

  test("R-WATCH-CALLDATA the first call tree the probe is shown ends the blindness, and it asks no more", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const watch = watchOf({ ...STRAIGHT, rises: true }, log, [advanced(105n, 1n)], VALUE_TRACED);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch });
    expect(await until(async () => callsOf(log).some((c) => c.startsWith("probe")), WAIT)).toBe(true);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const asked = callsOf(log).filter((c) => c.startsWith("probe")).length;
    await new Promise((done) => setTimeout(done, QUICK * 10));
    const look = await alice.stop();
    expect(blindOf(look)).toBe(false);
    expect(asked).toBe(1);
    expect(callsOf(log).filter((c) => c.startsWith("probe"))).toHaveLength(1);
    const rows = rowsOf(look).flatMap(inputsOf).map((i) => i._tag);
    expect(rows.filter((t) => t === "j_blind")).toHaveLength(1);
    expect(rows.filter((t) => t === "j_blind_over")).toHaveLength(1);
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
      (r) => inputsOf(r).some((i) => i._tag === "j_epoch"),
    );
    const heightRow = rows.findIndex((r) => r.input._tag === "j_observation");
    expect(eventRow).toBeGreaterThanOrEqual(0);
    expect(heightRow).toBe(eventRow);
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

  const caughtUp = (facts: ReturnType<typeof factsOf>): boolean => facts?.epoch === 1n && facts.behind === undefined;

  test("R-WATCH-STALL a tx the provider refuses holds its finalize only; the Entity is told it is behind", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    const alice = await stalling(dir, log, STRAIGHT, QUIET);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(factsOf(look)).toMatchObject({ epoch: 1n, behind: 105n });
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
    expect(await until(async () => caughtUp(factsOf(await alice.look())), WAIT)).toBe(true);
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
    const waiting = await alice.look();
    expect(factsOf(waiting)).toMatchObject({ epoch: 1n, behind: 105n });
    expect(entriesOf(waiting)).toEqual(["locked"]);
    const wal = (look: Look) => rowsOf(look).flatMap(inputsOf);
    expect(wal(waiting).some((i) => i._tag === "j_dispute_over")).toBe(false);
    expect(await until(async () => caughtUp(factsOf(await alice.look())), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(tries()).toBeGreaterThanOrEqual(8);
    expect(factsOf(look)?.behind).toBeUndefined();
    expect(wal(look).filter((i) => i._tag === "j_finalize_unread")).toHaveLength(1);
  });

  test("R-WATCH-WINDOW a provider with no more state of an Account loses it loudly; the node goes on", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n)], { ...QUIET, pruned: true });
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch });
    await alice.tell(open(BOB));
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const look = await alice.stop();
    expect(look.fatal).toBeUndefined();
    expect(factsOf(look)).toMatchObject({ epoch: 0n, behind: 105n, lost: true });
    const told = rowsOf(look).flatMap((r) => r.notices).map((n) => JSON.stringify(n, (_, v: unknown) =>
      (typeof v === "bigint" ? String(v) : v)));
    expect(told.filter((n) => n.includes("account_lost"))).toHaveLength(1);
    const second = `${dir}/second.log`;
    writeFileSync(second, "");
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, second, [advanced(105n, 1n)], QUIET),
    });
    expect(await until(async () => delivered(await again.look()), WAIT)).toBe(true);
    const restarted = await again.stop();
    expect(factsOf(restarted)).toMatchObject({ epoch: 0n, behind: 105n, lost: true });
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

  test("R-WATCH-WINDOW a restart recovers a pending finalize without rereading WAL-covered pruned state", async () => {
    const dir = fresh();
    const first = await stalling(dir, `${dir}/first.log`, STRAIGHT, QUIET);
    expect(await until(async () => delivered(await first.look()), WAIT)).toBe(true);
    const before = await first.stop();
    expect(factsOf(before)?.readWaits).toHaveLength(1);
    const log = `${dir}/recovered.log`;
    writeFileSync(log, "");
    const watch = watchOf(STRAIGHT, log, [advanced(105n, 1n), finalized], { ...QUIET, input: "given", pruned: true });
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, { tickMs: QUICK, watch });
    expect(await until(async () => caughtUp(factsOf(await again.look())), WAIT)).toBe(true);
    const after = await again.stop();
    expect(after.fatal).toBeUndefined();
    expect(factsOf(after)).toMatchObject({ epoch: 1n, lost: false, readWaits: [] });
    expect(callsOf(log).filter((call) => call === "account")).toEqual([]);
    expect(entityTold(after, "account_lost")).toBe(0);
    const inputs = rowsOf(after).flatMap(inputsOf);
    expect(inputs.filter((input) => input._tag === "j_epoch")).toHaveLength(1);
    expect(inputs.filter((input) => input._tag === "j_dispute_over")).toEqual([
      { _tag: "j_dispute_over", peer: BOB, late: true },
    ]);
  });

  test("R-HEIGHT-ORDER a crash after persisting a read wait cannot leave its effects ahead of its view", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const up = `${dir}/up`;
    const crashOn = (state: "pending" | "cleared") => (disk: Disk): Disk => ({
      ...disk,
      run: async (ops) => {
        const row = ops.flatMap((op) => op._tag === "write" ? made(scanWal(op.bytes)).rows : [])[0];
        const inputs = row === undefined ? [] : inputsOf(row);
        const marker = inputs.some((input) => input._tag === "j_read_waits"
          && (input.pending.length === 0) === (state === "cleared"));
        const written = await disk.run(ops);
        return written.ok && marker ? err({ _tag: "disk", op: "sync", reason: "crash after sync" }) : written;
      },
    });
    const watch = watchOf({ ...STRAIGHT, down: up }, log, [advanced(105n, 1n), finalized]);
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch, wrap: crashOn("pending"),
    });
    await alice.tell(open(BOB));
    writeFileSync(up, "up");
    expect(await until(async () => (await alice.look()).fatal !== undefined, WAIT)).toBe(true);
    await alice.stop();
    const resumed = `${dir}/resumed`;
    const given = { ...QUIET, input: "given" as const, pruned: true };
    const again = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, wrap: crashOn("cleared"),
      watch: watchOf({ ...STRAIGHT, down: resumed }, log, [advanced(105n, 1n), finalized], given),
    });
    expect((await again.look()).station.host.runtime.view).toBe(110n as never);
    const newer = {
      _tag: "j_dispute", peer: BOB, epoch: 1n, by: "right", nonce: 11n, timeout: 500n,
      proposerIsLeft: false, bodyHash: hexOf(91n),
    } as const;
    expect((await again.tell(newer)).ok).toBe(true);
    writeFileSync(resumed, "up");
    expect(await until(async () => (await again.look()).fatal !== undefined, WAIT)).toBe(true);
    await again.stop();
    const last = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, log, [advanced(105n, 1n), finalized], given),
    });
    expect(await until(async () => delivered(await last.look()), WAIT)).toBe(true);
    const after = await last.stop();
    expect(factsOf(after)?.against?.nonce).toBe(11n);
    expect(factsOf(after)?.readWaits).toEqual([]);
    const inputs = rowsOf(after).flatMap(inputsOf);
    expect(inputs.filter((input) => input._tag === "j_dispute_over")).toEqual([
      { _tag: "j_dispute_over", peer: BOB, late: true },
    ]);
    expect(inputs.filter((input) => input._tag === "j_epoch")).toHaveLength(1);
  });

  test("R-WATCH-CALLDATA no call trace at run time blinds a node with value and does not end it", async () => {
    const dir = fresh();
    const hidden: Kind = { ...VALUE_TRACED, input: "hidden", trace: { _tag: "no_method" }, off: `${dir}/off` };
    const log = `${dir}/calls.log`;
    const alice = await stalling(dir, log, { ...STRAIGHT, rises: true }, hidden);
    expect(await until(async () => existsSync(`${dir}/off`), WAIT)).toBe(true);
    expect(await until(async () => blindOf(await alice.look()), WAIT)).toBe(true);
    expect(await until(async () => delivered(await alice.look()), WAIT)).toBe(true);
    const later = callsOf(log).filter((c) => c.startsWith("probe")).length;
    expect(await until(async () => callsOf(log).filter((c) => c.startsWith("probe")).length > later, WAIT)).toBe(true);
    const look = await alice.stop();
    expect(blindOf(look)).toBe(true);
    expect(look.fatal).toBeUndefined();
    expect(factsOf(look)).toMatchObject({ epoch: 1n });
    expect(look.notices.filter((n) => n._tag === "watch_stalled")).toEqual([]);
    expect(told(look, "no_call_trace")).toBe(1);
    expect(entityTold(look, "chain_blind")).toBe(0);
    const quiet = await stalling(fresh(), `${dir}/quiet.log`, STRAIGHT, { ...hidden, value: false });
    expect(await until(async () => factsOf(await quiet.look())?.epoch === 1n, WAIT)).toBe(true);
    expect(blindOf(await quiet.stop())).toBe(false);
  });

  test("R-WATCH-CALLDATA a blind node that boots on a provider that traces is told its Entity sees again", async () => {
    const dir = fresh();
    const hidden: Kind = { ...VALUE_BLIND, input: "hidden", trace: { _tag: "no_method" } };
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
    ["the atomic delivery row", 2],
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
    expect(rowsOf(look).some((r) => r.input._tag === "j_height" || r.input._tag === "j_observation")).toBe(false);
  });

  test("R-REGISTRY-AT-VIEW a node that may hold value and ignores the registry is not started", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const seat = await seatOf(ALICE, dir, 0);
    const config = await configOf(seat, NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, log, [advanced(105n, 1n)], VALUE_TRACED), registry: false,
    });
    const refused = await startDaemon(config, seat.listener);
    await config.shell.wal.close();
    await config.shell.io.journal.close();
    expect(refused).toEqual(err({ _tag: "registry_off" }));
  });

  test("R-REGISTRY-AT-VIEW a failed read is told once for its hashlock, however often it is asked", async () => {
    const dir = fresh();
    const log = `${dir}/calls.log`;
    writeFileSync(log, "");
    const reads: string[] = [];
    const read = (hashlock: string) => {
      reads.push(hashlock);
      return Promise.resolve(err(DOWN));
    };
    const alice = await nodeOf(await seatOf(ALICE, dir, 0), NO_PEER, {
      tickMs: QUICK, watch: watchOf(STRAIGHT, log, [], VALUE_TRACED), read,
    });
    const forward = { _tag: "forward", hashlock: hexOf(9n), from: bytes(2n), to: bytes(3n) } as const;
    await alice.tell(forward);
    await alice.tell(forward);
    const look = await alice.stop();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(told(look, "registry_unread")).toBe(1);
    expect(look.notices.find((n) => n._tag === "registry_unread")).toEqual({
      _tag: "registry_unread", hashlock: hexOf(9n), reason: "watch head: connection reset",
    });
  });
});
