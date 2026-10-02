// The J loop's poll over a port that is scripted, with a log of the calls it made (R-JLOOP): what is read, in what
// order, how much, and what a fault of the port or of the core does. The chain's events are the real Depository's ABI
// turned into logs (j/fixtures.ts).
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, unwrapOr } from "../../../kernel/core/result.ts";
import { freshChain } from "../../../entity/chain.ts";
import type { ChainFacts, EntityId, EntityInput, Starting } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import type { Bytes32, RawLog } from "../../../j/log.ts";
import { proofBodyHash } from "../../../chain/proof/proof.ts";
import { watching, type Block } from "../../../j/watch.ts";
import {
  argumentsOf, blockOf, CLAUSED, DEPOSITORY, entityOf, finalizedOf, finalizeInput, finalizeOp, hexOf, logOf, must,
  multicalled, relayed, startInput, startOp, txOf,
} from "../../../j/fixtures.ts";
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
const portOf = (
  chain: Chain, log: string, broken: bigint | "logs" | "account" | "input" | "unknown" = -1n,
  inputs: ReadonlyMap<Bytes32, Uint8Array> = new Map(),
  traces: ReadonlyMap<Bytes32, readonly Uint8Array[] | "down"> = new Map(),
): WatchPort => {
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
    input: (tx) => {
      appendFileSync(log, `input ${tx.slice(-4)}\n`);
      const found = inputs.get(tx);
      if (broken === "unknown") return Promise.resolve(ok(undefined));
      return Promise.resolve(broken === "input" || found === undefined ? err(DOWN) : ok(found));
    },
    // A node with no call trace says so (`undefined`); one that is asked and fails is the port's fault.
    trace: (tx) => {
      appendFileSync(log, `trace ${tx.slice(-4)}\n`);
      const found = traces.get(tx);
      return Promise.resolve(found === "down" ? err(DOWN) : ok(found));
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

  test("R-DISPUTE-FREEZE a secret the chain showed reaches the Entity as j_secret, in bytes", async () => {
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: RIGHT, secret: hexOf(8n) }, 2n, 0n);
    const got = await poll(portOf(straight(6n, [shown]), logPath()), start(2n), LEFT);
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 8 : 0));
    expect(got.ok ? got.value?.events : got).toEqual([{ _tag: "j_secret", secret: bytes }]);
  });

  test("R-WATCH-CALLDATA a finalize's arguments are read from its transaction's input, asked for once", async () => {
    const at = logPath();
    const op = finalizeOp({ otherArguments: argumentsOf([hexOf(8n)]) });
    const tx = txOf(2n, 1n);
    const finalize = finalizedOf(op, 2n, 1n, tx);
    const inputs = new Map([[tx, finalizeInput(RIGHT, [op])]]);
    const got = await poll(portOf(straight(6n, [advanced(2n, 0n, 1n), finalize]), at, -1n, inputs), start(2n), LEFT);
    const secret = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 8 : 0));
    expect(got.ok ? got.value?.events : got).toEqual([
      { _tag: "j_secret", secret },
      { _tag: "j_epoch", peer: peer(RIGHT), epoch: 1n, stored: 5n, finalBodyHash: hexOf(5n) },
      { _tag: "j_dispute_over", peer: peer(RIGHT) },
    ]);
    expect(callsOf(at).filter((c) => c.startsWith("input"))).toEqual([`input ${tx.slice(-4)}`]);
  });

  test("R-WATCH-CALLDATA a dispute start's secret and body reach the Entity, the input asked for once", async () => {
    const at = logPath();
    const opened = logOf("DisputeStarted", {
      sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: must(proofBodyHash(CLAUSED)),
      watchSeed: hexOf(2n), starterInitialArguments: argumentsOf([hexOf(8n)]), starterCounterArguments: "0x",
      starterCounterProofCommitment: hexOf(3n), disputeTimeout: 5n, disputeStartTimestamp: 6n,
      leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    }, 2n, 0n);
    const inputs = new Map([[txOf(2n, 0n), startInput(RIGHT, [startOp(CLAUSED)])]]);
    const got = await poll(portOf(straight(6n, [opened]), at, -1n, inputs), start(2n), LEFT);
    const secret = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 8 : 0));
    expect(got.ok ? got.value?.events.map((e) => e._tag) : got).toEqual(["j_secret", "j_dispute"]);
    expect(got.ok ? got.value?.events[0] : got).toEqual({ _tag: "j_secret", secret });
    expect(got.ok ? got.value?.events[1] : got).toMatchObject({ _tag: "j_dispute", body: CLAUSED });
    expect(callsOf(at).filter((c) => c.startsWith("input"))).toEqual([`input ${txOf(2n, 0n).slice(-4)}`]);
  });

  const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 8 : 0));

  /** A finalize at block 2 that shows a secret, in the transaction `tx`, after an epoch advance of the same block. */
  const finalizing = (tx = txOf(2n, 1n)) => {
    const op = finalizeOp({ otherArguments: argumentsOf([hexOf(8n)]) });
    return { op, tx, logs: [advanced(2n, 0n, 1n), finalizedOf(op, 2n, 1n, tx)] as const };
  };
  const EPOCH: EntityInput = { _tag: "j_epoch", peer: peer(RIGHT), epoch: 1n, stored: 5n, finalBodyHash: hexOf(5n) };
  const OVER: EntityInput = { _tag: "j_dispute_over", peer: peer(RIGHT) };
  const TOLD: readonly EntityInput[] = [{ _tag: "j_secret", secret: SECRET_BYTES }, EPOCH, OVER];

  test("R-WATCH-CALLDATA a finalize relayed through a contract is read from the call the input carries", async () => {
    const at = logPath();
    const { op, tx, logs } = finalizing();
    const input = relayed(finalizeInput(RIGHT, [op]));
    const got = await poll(portOf(straight(6n, logs), at, -1n, new Map([[tx, input]])), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual(TOLD);
    expect(callsOf(at).some((c) => c.startsWith("trace"))).toBe(false);
  });

  test("R-WATCH-CALLDATA a finalize in a multicall among other calls is read, whichever entry carries it", async () => {
    const { op, tx, logs } = finalizing();
    const other = finalizeInput(RIGHT, [finalizeOp({ finalNonce: 99n })]);
    const input = multicalled([other, finalizeInput(RIGHT, [op])]);
    const got = await poll(portOf(straight(6n, logs), logPath(), -1n, new Map([[tx, input]])), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual(TOLD);
  });

  test("R-WATCH-CALLDATA an embedded call with another evidence hash is ignored, and the node says so", async () => {
    const at = logPath();
    const { tx, logs } = finalizing();
    const liar = finalizeOp({ finalNonce: 99n, otherArguments: argumentsOf([hexOf(9n)]) });
    const got = await poll(portOf(straight(6n, logs), at, -1n, new Map([[tx, relayed(finalizeInput(RIGHT, [liar]))]])),
      start(2n), LEFT);
    const tags = got.ok ? got.value?.events.map((e) => e._tag) : got;
    expect(tags).toEqual(["j_epoch", "j_dispute_over", "j_finalize_unread"]);
    expect(got.ok ? got.value?.events.at(-1) : got).toEqual({ _tag: "j_finalize_unread", peer: peer(RIGHT), tx });
    expect(callsOf(at).filter((c) => c.startsWith("trace"))).toEqual([`trace ${tx.slice(-4)}`]);
  });

  test("R-WATCH-CALLDATA a call the input hides is read from the node's call trace, asked for once", async () => {
    const at = logPath();
    const { op, tx, logs } = finalizing();
    const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
    const traces = new Map([[tx, [finalizeInput(RIGHT, [op])]]]);
    const got = await poll(portOf(straight(6n, logs), at, -1n, new Map([[tx, hidden]]), traces), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual(TOLD);
    expect(callsOf(at).filter((c) => c.startsWith("trace"))).toEqual([`trace ${tx.slice(-4)}`]);
  });

  test("R-WATCH-CALLDATA a hidden call on a node with no call trace is told unread, with its tx", async () => {
    const { tx, logs } = finalizing();
    const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
    const got = await poll(portOf(straight(6n, logs), logPath(), -1n, new Map([[tx, hidden]])), start(2n), LEFT);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(got.ok ? got.value?.events : got).toEqual([EPOCH, OVER, unread]);
  });

  test("R-WATCH-CALLDATA a trace that fails stalls the delivery at its block; what lies before is told", async () => {
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: RIGHT, secret: hexOf(8n) }, 1n, 0n);
    const { tx, logs } = finalizing();
    const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
    const traces = new Map<Bytes32, "down">([[tx, "down"]]);
    const port = portOf(straight(6n, [shown, ...logs]), logPath(), -1n, new Map([[tx, hidden]]), traces);
    const got = await poll(port, start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual([{ _tag: "j_secret", secret: SECRET_BYTES }]);
    expect(got.ok ? got.value?.height : got).toBe(1n as never);
  });

  test("R-WATCH-CALLDATA an input the node cannot give stalls the delivery at its block, no later", async () => {
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: RIGHT, secret: hexOf(8n) }, 1n, 0n);
    const { logs } = finalizing();
    const early = await poll(portOf(straight(6n, [shown, ...logs]), logPath()), start(2n), LEFT);
    expect(early.ok ? early.value?.events : early).toEqual([{ _tag: "j_secret", secret: SECRET_BYTES }]);
    expect(early.ok ? early.value?.height : early).toBe(1n as never);
    const first = await poll(portOf(straight(6n, logs.slice(0, 1) as never), logPath(), "input"), start(2n), LEFT);
    expect(first.ok ? first.value?.events.map((e) => e._tag) : first).toEqual(["j_epoch"]);
  });

  test("R-WATCH-CALLDATA a transaction of an old block the node does not know is told unread, no stall", async () => {
    const at = logPath();
    const { tx, logs } = finalizing();
    const got = await poll(portOf(straight(400n, logs), at, "unknown"), start(2n), LEFT);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(got.ok ? got.value?.events : got).toEqual([EPOCH, OVER, unread]);
    expect(callsOf(at).some((c) => c.startsWith("trace"))).toBe(false);
  });

  test("R-WATCH-CALLDATA a transaction of a young block the node does not know stalls like a fault", async () => {
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: RIGHT, secret: hexOf(8n) }, 1n, 0n);
    const { logs } = finalizing();
    const got = await poll(portOf(straight(6n, [shown, ...logs]), logPath(), "unknown"), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual([{ _tag: "j_secret", secret: SECRET_BYTES }]);
    expect(got.ok ? got.value?.height : got).toBe(1n as never);
  });

  test("R-WATCH-CALLDATA the earliest stalled tx sets the cut; a tx with no input has no trace", async () => {
    const at = logPath();
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: RIGHT, secret: hexOf(8n) }, 1n, 0n);
    const second = finalizing(txOf(2n, 1n));
    const third = finalizedOf(second.op, 3n, 1n, txOf(3n, 1n));
    const logs = [shown, advanced(2n, 0n, 1n), second.logs[1], advanced(3n, 0n, 2n), third];
    const got = await poll(portOf(straight(7n, logs), at), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual([{ _tag: "j_secret", secret: SECRET_BYTES }]);
    expect(got.ok ? got.value?.height : got).toBe(1n as never);
    expect(callsOf(at).some((c) => c.startsWith("trace"))).toBe(false);
  });

  test("R-WATCH-CALLDATA a start whose body the input hides is read from the call trace", async () => {
    const at = logPath();
    const opened = logOf("DisputeStarted", {
      sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: must(proofBodyHash(CLAUSED)),
      watchSeed: hexOf(2n), starterInitialArguments: "0x", starterCounterArguments: "0x",
      starterCounterProofCommitment: hexOf(3n), disputeTimeout: 5n, disputeStartTimestamp: 6n,
      leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    }, 2n, 0n);
    const tx = txOf(2n, 0n);
    const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
    const traces = new Map([[tx, [startInput(RIGHT, [startOp(CLAUSED)])]]]);
    const got = await poll(portOf(straight(6n, [opened]), at, -1n, new Map([[tx, hidden]]), traces), start(2n), LEFT);
    expect(got.ok ? got.value?.events[0] : got).toMatchObject({ _tag: "j_dispute", body: CLAUSED });
    expect(callsOf(at).filter((c) => c.startsWith("trace"))).toEqual([`trace ${tx.slice(-4)}`]);
  });

  test("R-WATCH-CALLDATA a tx the node cannot give in the first block read is the port's fault", async () => {
    const op = finalizeOp();
    const at1 = [logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 1n, 0n),
      finalizedOf(op, 1n, 1n)];
    expect(await poll(portOf(straight(6n, at1), logPath(), "input"), start(2n), LEFT)).toEqual(err(DOWN));
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
      ({ ...freshChain, starting: { start: asked, window: 40n, over: false, countered: undefined, ...starting } });
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
    const against = {
      nonce: 3n, proposerIsLeft: true, bodyHash: "0x01", window: 55n, over: false, answer: undefined,
      countered: undefined,
    };
    const told = (facts: ChainFacts) => windowsOf(LEFT, new Map([[peer(RIGHT), facts]]));
    expect(told({ ...freshChain, against })).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 55n }]));
    expect(told({ ...freshChain, against: { ...against, over: true } })).toEqual(ok([]));
  });

  test("R-DISPUTE-WATCH a start of the node's own that never got a window does not hide the dispute against it", () => {
    const asked = { peer: peer(RIGHT) } as Starting["start"];
    const against = {
      nonce: 3n, proposerIsLeft: true, bodyHash: "0x01", window: 55n, over: false, answer: undefined,
      countered: undefined,
    };
    const told = (starting: Partial<Starting>) => windowsOf(LEFT, new Map([[peer(RIGHT), {
      ...freshChain, against,
      starting: { start: asked, window: undefined, over: false, countered: undefined, ...starting },
    }]]));
    expect(told({})).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 55n }]));
    expect(told({ window: 40n, over: true })).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 55n }]));
    expect(told({ window: 40n })).toEqual(ok([{ to: LEFT, peer: RIGHT, timeout: 40n }]));
  });
});
