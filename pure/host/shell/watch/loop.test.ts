// The J loop's poll over a port that is scripted, with a log of the calls it made (R-JLOOP): what is read, in what
// order, how much, and what a fault of the port or of the core does. The chain's events are the real Depository's ABI
// turned into logs (j/fixtures.ts).
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, unwrapOr } from "../../../kernel/core/result.ts";
import { freshChain } from "../../../entity/chain.ts";
import type { ChainFacts, EntityId, Starting } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import type { RawLog } from "../../../j/log.ts";
import { watching, type Block } from "../../../j/watch.ts";
import { blockOf, DEPOSITORY, entityOf, logOf, must } from "../../../j/fixtures.ts";
import { callsOf } from "../fixtures.ts";
import type { PortFault } from "../submit/chain.ts";
import { beginAt, poll, windowsOf, type WatchConfig, type WatchPort } from "./loop.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const DOWN: PortFault = { _tag: "port", call: "watch block", reason: "connection reset" };

type Chain = Readonly<{ head: bigint; blocks: (number: bigint) => Block; logs: readonly RawLog[] }>;

const straight = (head: bigint, logs: readonly RawLog[] = []): Chain =>
  ({ head, blocks: (number) => blockOf(number), logs });

const LOOP_DIR = join(tmpdir(), "loop-");

const logPath = (): string => join(mkdtempSync(LOOP_DIR), "calls.log");

/** A port over `chain` that writes each call it gets to `log`; `broken` is the block, or the read, that fails. */
const portOf = (chain: Chain, log: string, broken: bigint | "logs" | "account" = -1n): WatchPort => {
  appendFileSync(log, "");
  return {
    head: () => { appendFileSync(log, "head\n"); return Promise.resolve(ok(chain.head)); },
    block: (number) => {
      appendFileSync(log, `block ${number}\n`);
      return Promise.resolve(number === broken ? err(DOWN) : ok(chain.blocks(number)));
    },
    logs: (from, to) => {
      appendFileSync(log, `logs ${from}-${to}\n`);
      return Promise.resolve(
        broken === "logs" ? err(DOWN) : ok(chain.logs.filter((l) => l.block >= from && l.block <= to)),
      );
    },
    accountAt: (block, left, right) => {
      appendFileSync(log, `account ${block.slice(-4)} ${left.slice(-2)} ${right.slice(-2)}\n`);
      return Promise.resolve(broken === "account" ? err(DOWN) : ok({ epoch: 1n, nonce: 5n }));
    },
  };
};

const advanced = (block: bigint, index: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index);

const start = (depth: bigint, from: Block = blockOf(0n)) => must(watching(DEPOSITORY, depth, from));

const peer = (id: typeof RIGHT): EntityId => unwrapOr(entityId(id), () => expect.unreachable("peer"));

describe("host/shell/watch the J loop's poll", () => {
  test("R-JLOOP a poll reads the final blocks, their logs and readings, and delivers events and height", async () => {
    const at = logPath();
    const got = await poll(portOf(straight(6n, [advanced(2n, 0n, 1n)]), at), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual([{ _tag: "j_epoch", peer: peer(RIGHT), epoch: 1n, stored: 5n }]);
    expect(got.ok ? got.value?.height : got).toBe(4n as never);
    expect(got.ok ? got.value?.watch.applied : got).toEqual(blockOf(4n));
    expect(callsOf(at)).toEqual([
      "head", "block 1", "block 2", "block 3", "block 4", "logs 1-4", `account ${blockOf(2n).hash.slice(-4)} 11 52`,
    ]);
  });

  test("R-JLOOP a block not buried yet is not read: nothing is delivered, nothing is asked past the head", async () => {
    const at = logPath();
    const got = await poll(portOf(straight(4n), at), start(2n, blockOf(2n)), LEFT);
    expect(got).toEqual(ok(undefined));
    expect(callsOf(at)).toEqual(["head"]);
  });

  test("R-JLOOP a node that was away reads a bounded number of blocks per poll and goes on at the next", async () => {
    const at = logPath();
    const got = await poll(portOf(straight(1_000n), at), start(2n), LEFT);
    expect(got.ok ? got.value?.height : got).toBe(64n as never);
    expect(callsOf(at).filter((c) => c.startsWith("block"))).toHaveLength(64);
    expect(callsOf(at)).toContain("logs 1-64");
  });

  test("R-JLOOP a block the node cannot give is the port's fault, and no log is read after it", async () => {
    const at = logPath();
    const got = await poll(portOf(straight(10n), at, 3n), start(2n), LEFT);
    expect(got).toEqual(err(DOWN));
    expect(callsOf(at).some((c) => c.startsWith("logs") || c.startsWith("account"))).toBe(false);
  });

  test("R-JLOOP logs or a reading the node cannot give are the port's fault; nothing delivered", async () => {
    const chain = straight(6n, [advanced(2n, 0n, 1n)]);
    expect(await poll(portOf(chain, logPath(), "logs"), start(2n), LEFT)).toEqual(err(DOWN));
    expect(await poll(portOf(chain, logPath(), "account"), start(2n), LEFT)).toEqual(err(DOWN));
  });

  test("R-JLOOP a block off the cursor is a reorg deeper than the depth; nothing is read for it", async () => {
    const at = logPath();
    const forked: Chain = { head: 10n, blocks: (number) => blockOf(number, 1n), logs: [advanced(2n, 0n, 1n)] };
    const got = await poll(portOf(forked, at), start(2n), LEFT);
    expect(got.ok ? "ok" : got.error._tag).toBe("deep_reorg");
    expect(callsOf(at).some((c) => c.startsWith("account"))).toBe(false);
  });

  test("R-JLOOP the cursor begins at the chain's own block, or at the port's fault", async () => {
    const config: WatchConfig = {
      port: portOf(straight(9n), logPath()), depository: DEPOSITORY, depth: 3n, hosted: LEFT,
    };
    const begun = await beginAt(config, 5n);
    expect(begun.ok ? begun.value : begun).toEqual({ depository: DEPOSITORY, depth: 3n, applied: blockOf(5n) });
    const down = await beginAt({ ...config, port: portOf(straight(9n), logPath(), 5n) }, 5n);
    expect(down).toEqual(err(DOWN));
  });

  test("R-DISPUTE-FINALIZE a window the last block has passed is told to the Entity after the events", async () => {
    const window = { to: LEFT, peer: RIGHT, timeout: 40n };
    const chain = straight(6n, [advanced(2n, 0n, 1n)]);
    const got = await poll(portOf(chain, logPath()), start(2n), LEFT, [window]);
    expect(got.ok ? got.value?.events.map((e) => e._tag) : got).toEqual(["j_epoch", "j_window_over"]);
    const early = await poll(portOf(chain, logPath()), start(2n), LEFT, [{ ...window, timeout: 41n }]);
    expect(early.ok ? early.value?.events.map((e) => e._tag) : early).toEqual(["j_epoch"]);
  });

  test("R-DISPUTE-FINALIZE the windows an Entity waits on are the node's own the chain gave an end, until told", () => {
    const asked = { peer: peer(RIGHT) } as Starting["start"];
    const facts = (starting: Partial<Starting>): ChainFacts =>
      ({ ...freshChain, starting: { start: asked, window: 40n, over: false, countered: false, ...starting } });
    const chain = new Map<EntityId, ChainFacts>([
      [peer(RIGHT), facts({})], [peer(entityOf(0x70n)), facts({ window: undefined })],
      [peer(entityOf(0x71n)), freshChain], [peer(entityOf(0x72n)), facts({ over: true })],
    ]);
    expect(windowsOf(LEFT, chain)).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 40n }]));
    expect(windowsOf(LEFT, new Map())).toEqual(ok([]));
    const bad = "0xnot-an-id" as EntityId;
    expect(windowsOf(LEFT, new Map([[bad, facts({})]]))).toEqual(err({ _tag: "bad_peer", text: bad }));
  });

  test("R-DISPUTE-WATCH the window of a dispute against the node is waited on as well, until told", () => {
    const against = { nonce: 3n, proposerIsLeft: true, bodyHash: "0x01", window: 55n, over: false, answer: undefined };
    const told = (facts: ChainFacts) => windowsOf(LEFT, new Map([[peer(RIGHT), facts]]));
    expect(told({ ...freshChain, against })).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 55n }]));
    expect(told({ ...freshChain, against: { ...against, over: true } })).toEqual(ok([]));
  });
});
