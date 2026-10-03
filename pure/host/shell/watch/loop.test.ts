// The J loop's poll over a port that is scripted, with a log of the calls it made (R-JLOOP): what is read, in what
// order, how much, and what a fault of the port or of the core does. The chain's events are the real Depository's ABI
// turned into logs (j/fixtures.ts).
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { freshChain } from "../../../entity/chain.ts";
import type { ChainFacts, EntityId, EntityInput, Starting } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import type { Bytes32, RawLog } from "../../../j/log.ts";
import { proofBodyHash } from "../../../chain/proof/proof.ts";
import type { Carried } from "../../../j/calldata/decode.ts";
import { watching, type Block, type Watch } from "../../../j/watch.ts";
import { bytesToHex } from "../../../kernel/encoding/bytes.ts";
import {
  argumentsOf, blockOf, CLAUSED, DEPOSITORY, DEPOSITORY_ABI, entityOf, finalizedOf, finalizeInput, finalizeOp, hexOf,
  logOf, must,
  multicalled, relayed, startInput, startOp, txOf,
} from "../../../j/fixtures.ts";
import { callsOf } from "../fixtures.ts";
import type { PortFault } from "../submit/chain.ts";
import { watchPort } from "../evm/watch.ts";
import type { Rpc, RpcFault } from "../evm/port.ts";
import {
  beginAt, FEW_TRIES, NO_CARRY, NO_STANDING, poll, resumeAt, windowsOf, type Carry, type Delivery, type Standing,
  type Traced, type WatchConfig, type WatchPort,
} from "./loop.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const DOWN: PortFault = { _tag: "port", call: "watch block", reason: "connection reset" };

type Chain = Readonly<{ head: bigint; blocks: (number: bigint) => Block; logs: readonly RawLog[] }>;

const straight = (head: bigint, logs: readonly RawLog[] = []): Chain =>
  ({ head, blocks: (number) => blockOf(number), logs });

const LOOP_DIR = join(tmpdir(), "loop-");

const logPath = (): string => join(mkdtempSync(LOOP_DIR), "calls.log");

const carriedAt = (data: Uint8Array): Carried => ({ data, route: "direct" });

/** A transaction whose input is a call of the Depository is one to it; any other input is a wrapper's. */
const carried = (data: Uint8Array): Carried => {
  const calls = ["processBatch", "watchtowerCounterDispute"];
  const selectors = calls.map((name) => DEPOSITORY_ABI.getFunction(name)?.selector);
  return { data, route: selectors.includes(bytesToHex(data.subarray(0, 4))) ? "direct" : "wrapper" };
};

const tracedOf = (found: readonly Uint8Array[] | "down" | "no_method" | undefined): Result<Traced, PortFault> => {
  if (found === "down") return err(DOWN);
  if (found === "no_method") return ok({ _tag: "no_method" });
  const calls = found?.map((data) => carriedAt(data));
  return ok(calls === undefined ? { _tag: "unreadable" } : { _tag: "calls", calls });
};

/** A port over `chain` that writes each call it gets to `log`; `broken` is the block, or the read, that fails. */
const portOf = (
  chain: Chain, log: string, broken: bigint | "logs" | "account" | "input" | "unknown" = -1n,
  inputs: ReadonlyMap<Bytes32, Uint8Array> = new Map(),
  traces: ReadonlyMap<Bytes32, readonly Uint8Array[] | "down" | "no_method"> = new Map(),
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
      return Promise.resolve(broken === "input" || found === undefined ? err(DOWN) : ok(carried(found)));
    },
    // A node with no call trace says so (`no_method`), one that cannot make one for the tx gives none (`unreadable`),
    // and one that is asked and fails is the port's fault.
    trace: (tx) => {
      appendFileSync(log, `trace ${tx.slice(-4)}\n`);
      return Promise.resolve(tracedOf(traces.get(tx)));
    },
    traced: () => Promise.resolve(ok("traces")),
  };
};

const advanced = (block: bigint, index: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index);

const start = (depth: bigint, from: Block = blockOf(0n)) => must(watching(DEPOSITORY, depth, from));

const peer = (id: typeof RIGHT): EntityId => unwrapOr(entityId(id), () => expect.unreachable("peer"));

const OTHER = entityOf(0x53n);
const HIDDEN = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);

const tagsOf = (events: readonly EntityInput[]): readonly string[] => events.map((e) => e._tag);

const shownAt = (block: bigint, hashlock = 7n, secret = 8n) =>
  logOf("SecretRevealed", { hashlock: hexOf(hashlock), revealer: RIGHT, secret: hexOf(secret) }, block, 0n);

const otherAdvanced = (block: bigint, index: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: OTHER, ondeltaEpoch: epoch }, block, index);

/** The heads `first` to `last`, one poll each. */
const upTo = (first: bigint, last: bigint): readonly bigint[] =>
  Array.from({ length: Number(last - first) + 1 }, (_, i) => first + BigInt(i));

describe("host/shell/watch the J loop's poll", () => {
  /** Where the loop is between polls: its cursor, what the Host carries, what it told, and the last delivery. */
  type Polled = Readonly<{ watch: Watch; carry: Carry; told: readonly EntityInput[]; last: Delivery | undefined }>;
  const FRESH: Polled = { watch: start(2n), carry: NO_CARRY, told: [], last: undefined };

  /** One poll from what the last left, the way the daemon carries the cursor and the Host's carry. */
  const stepped = async (port: WatchPort, at: Polled, stand: Standing): Promise<Polled> => {
    const got = await poll(port, at.watch, LEFT, [], at.carry, stand);
    if (!got.ok) return expect.unreachable(`poll: ${got.error._tag}`);
    const { value } = got;
    return value === undefined
      ? at
      : { watch: value.watch, carry: value.carry, told: [...at.told, ...value.events], last: value };
  };

  /** One poll at each of `heads` in turn (a port per head), each from what the last left. */
  const along = async (
    at: (head: bigint) => WatchPort, heads: readonly bigint[], from: Polled = FRESH, stand: Standing = NO_STANDING,
  ): Promise<Polled> => {
    const [head, ...rest] = heads;
    return head === undefined ? from : along(at, rest, await stepped(at(head), from, stand), stand);
  };

  const BEHIND: EntityInput = { _tag: "j_behind", peer: peer(RIGHT), from: 2n };
  const BEHIND_OVER: EntityInput = { _tag: "j_behind_over", peer: peer(RIGHT) };
  const countOf = (at: string, call: string) => callsOf(at).filter((c) => c === call).length;

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
  const SECRET_TOLD: EntityInput = { _tag: "j_secret", secret: SECRET_BYTES };

  /** A finalize at block 2 that shows a secret, in the transaction `tx`, after an epoch advance of the same block. */
  const finalizing = (tx = txOf(2n, 1n)) => {
    const op = finalizeOp({ otherArguments: argumentsOf([hexOf(8n)]) });
    return { op, tx, logs: [advanced(2n, 0n, 1n), finalizedOf(op, 2n, 1n, tx)] as const };
  };
  const EPOCH: EntityInput = { _tag: "j_epoch", peer: peer(RIGHT), epoch: 1n, stored: 5n, finalBodyHash: hexOf(5n) };
  const OVER: EntityInput = { _tag: "j_dispute_over", peer: peer(RIGHT) };
  const TOLD: readonly EntityInput[] = [SECRET_TOLD, EPOCH, OVER];

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
    const traces = new Map<Bytes32, "no_method">([[tx, "no_method"]]);
    const port = portOf(straight(6n, logs), logPath(), -1n, new Map([[tx, HIDDEN]]), traces);
    const got = await poll(port, start(2n), LEFT);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(got.ok ? got.value?.events : got).toEqual([EPOCH, OVER, unread]);
    expect(got.ok ? got.value?.untraceable : got).toBe(true);
    const plain = await poll(portOf(straight(6n, logs), logPath(), -1n, new Map([[tx, HIDDEN]])), start(2n), LEFT);
    expect(plain.ok ? plain.value?.untraceable : plain).toBe(false);
  });

  test("R-WATCH-STALL a stalled tx holds back its own Account only: secrets and other Accounts go on", async () => {
    const { tx, logs } = finalizing();
    const chain = [shownAt(1n), ...logs, otherAdvanced(3n, 1n, 1n), advanced(3n, 2n, 2n), shownAt(4n, 9n, 10n)];
    const traces = new Map<Bytes32, "down">([[tx, "down"]]);
    const port = portOf(straight(8n, chain), logPath(), -1n, new Map([[tx, HIDDEN]]), traces);
    const got = await stepped(port, FRESH, NO_STANDING);
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 10 : 0));
    const other: EntityInput = { _tag: "j_epoch", peer: peer(OTHER), epoch: 1n, stored: 5n };
    expect(got.told).toEqual([BEHIND, SECRET_TOLD, other, { _tag: "j_secret", secret: bytes }]);
    expect(got.last?.height).toBe(6n as never);
    expect(got.carry.held.map((e) => e._tag)).toEqual(["epoch_advanced", "dispute_finalized", "epoch_advanced"]);
    expect([...got.carry.failing.keys()]).toEqual([tx]);
  });

  test("R-WATCH-STALL the held events follow the tx once it is given: secrets first", async () => {
    const { op, tx, logs } = finalizing();
    const inputs = new Map([[tx, finalizeInput(RIGHT, [op])]]);
    const settled = logOf("AccountSettled", {
      settled: [[LEFT, RIGHT, [[1n, 900n, 1000n, 100n, [0n, 100n]]], 0n]],
    }, 3n, 0n);
    const chain = [...logs, settled, otherAdvanced(3n, 1n, 1n)];
    const flaky = (head: bigint) => portOf(straight(head, chain), logPath(), head < 8n ? "input" : -1n, inputs);
    const other: EntityInput = { _tag: "j_epoch", peer: peer(OTHER), epoch: 1n, stored: 5n };
    const held = await along(flaky, upTo(6n, 7n));
    expect(held.told).toEqual([BEHIND, other]);
    expect(held.carry.held).toHaveLength(3);
    const given = await along(flaky, [8n], held);
    const tags = ["j_secret", "j_epoch", "j_dispute_over", "j_collateral", "j_behind_over"];
    expect(tagsOf(given.told.slice(2))).toEqual(tags);
    expect(given.told.slice(2, 5)).toEqual([...TOLD]);
    expect(given.carry).toEqual(NO_CARRY);
  });

  test("R-WATCH-CALLDATA a trace the provider cannot give, or no trace at all, never blinds the watcher", async () => {
    const node = (reply: Result<unknown, RpcFault>): Rpc => (method) =>
      Promise.resolve(method === "debug_traceTransaction" ? reply : err({ _tag: "rpc", reason: `no ${method}` }));
    const refuse = (reason: string): Result<unknown, RpcFault> => err({ _tag: "rpc", reason });
    const replies: ReadonlyArray<Result<unknown, RpcFault>> = [
      ok("0x"), ok({ to: DEPOSITORY, input: "0x12", calls: "none" }),
      refuse("Unsupported method (JSON-RPC code -32000)"), refuse("nope (JSON-RPC code -32601)"),
    ];
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 10 : 0));
    const secret: EntityInput = { _tag: "j_secret", secret: bytes };
    await Promise.all(replies.map(async (reply) => {
      const later = logOf("SecretRevealed", { hashlock: hexOf(9n), revealer: RIGHT, secret: hexOf(10n) }, 3n, 0n);
      const { tx, logs } = finalizing();
      const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
      const base = portOf(straight(6n, [...logs, later]), logPath(), -1n, new Map([[tx, hidden]]));
      const got = await poll({ ...base, trace: watchPort(node(reply), DEPOSITORY).trace }, start(2n), LEFT);
      const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
      expect(got.ok ? got.value?.events : got).toEqual([EPOCH, OVER, unread, secret]);
      expect(got.ok ? got.value?.height : got).toBe(4n as never);
    }));
  });

  test("R-WATCH-CALLDATA a finalize in a trace of any size the EVM allows is read, its secrets told", async () => {
    const { op, tx, logs } = finalizing();
    const finalize = { to: DEPOSITORY, input: bytesToHex(finalizeInput(RIGHT, [op])) };
    const around = (below: unknown): unknown => ({ to: "0x00", input: "0x", calls: [below] });
    const deep = (levels: number) => Array.from({ length: levels }).reduce<unknown>(around, finalize);
    const wide = (calls: number) => ({
      to: "0x00", input: "0x", calls: [...Array.from({ length: calls }, () => ({ to: "0x00", input: "0x" })), finalize],
    });
    const hidden = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4);
    await Promise.all([deep(65), deep(1000), wide(5000)].map(async (tree) => {
      const node: Rpc = (method) =>
        Promise.resolve(method === "debug_traceTransaction" ? ok(tree) : err({ _tag: "rpc", reason: "no" }));
      const base = portOf(straight(6n, logs), logPath(), -1n, new Map([[tx, hidden]]));
      const got = await poll({ ...base, trace: watchPort(node, DEPOSITORY).trace }, start(2n), LEFT);
      expect(got.ok ? got.value?.events : got).toEqual(TOLD);
    }));
  });

  test("R-WATCH-STALL an input the node cannot give holds its Account from the finalize's advance on", async () => {
    const { logs } = finalizing();
    const early = await stepped(portOf(straight(6n, [shownAt(1n), ...logs]), logPath()), FRESH, NO_STANDING);
    expect(early.told).toEqual([BEHIND, SECRET_TOLD]);
    const first = await stepped(portOf(straight(6n, logs.slice(0, 1)), logPath(), "input"), FRESH, NO_STANDING);
    expect(tagsOf(first.told)).toEqual(["j_epoch"]);
  });

  test("R-WATCH-CALLDATA an old tx the node does not know costs tries as a fault does, then it is unread", async () => {
    const at = logPath();
    const { tx, logs } = finalizing();
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    const heads = upTo(400n, 400n + BigInt(FEW_TRIES) - 1n);
    const polled = await along((head) => portOf(straight(head, logs), at, "unknown"), heads);
    expect(polled.told).toEqual([BEHIND, EPOCH, OVER, unread, BEHIND_OVER]);
    expect(callsOf(at).some((c) => c.startsWith("trace"))).toBe(false);
  });

  test("R-WATCH-CALLDATA a transaction of a young block the node does not know holds like a fault", async () => {
    const { logs } = finalizing();
    const got = await stepped(portOf(straight(6n, [shownAt(1n), ...logs]), logPath(), "unknown"), FRESH, NO_STANDING);
    expect(got.told).toEqual([BEHIND, SECRET_TOLD]);
    expect(got.last?.height).toBe(4n as never);
  });

  test("R-WATCH-CALLDATA two stalled txs of one Account hold from the earlier; none has a trace", async () => {
    const at = logPath();
    const second = finalizing(txOf(2n, 1n));
    const third = finalizedOf(second.op, 3n, 1n, txOf(3n, 1n));
    const logs = [shownAt(1n), advanced(2n, 0n, 1n), second.logs[1], advanced(3n, 0n, 2n), third];
    const got = await stepped(portOf(straight(7n, logs), at), FRESH, NO_STANDING);
    expect(got.told).toEqual([BEHIND, SECRET_TOLD]);
    expect(got.carry.held).toHaveLength(4);
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

  test("R-WATCH-CALLDATA an input the node cannot give is the port's fault: nothing is delivered", async () => {
    const op = finalizeOp();
    const at1 = [logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: 1n }, 1n, 0n),
      finalizedOf(op, 1n, 1n)];
    const tx = txOf(1n, 1n);
    const got = await poll(portOf(straight(6n, at1), logPath(), "input"), start(2n), LEFT);
    const told: EntityInput = { _tag: "j_behind", peer: peer(RIGHT), from: 1n };
    const stall = { tx, fault: DOWN, tries: 1 };
    expect(got).toMatchObject({ ok: true, value: { events: [told], height: 4n, stalls: [stall] } });
  });

  test("R-WATCH-STALL a tx the node fails is tried once per head block, not once per poll", async () => {
    const at = logPath();
    const { tx, logs } = finalizing();
    const port = portOf(straight(1_000n, logs), at, "input");
    const first = await stepped(port, FRESH, NO_STANDING);
    const catching = await stepped(port, await stepped(port, first, NO_STANDING), NO_STANDING);
    expect(countOf(at, `input ${tx.slice(-4)}`)).toBe(1);
    expect(catching.carry.failing.get(tx)?.tries).toBe(1);
    const next = await stepped(portOf(straight(1_001n, logs), at, "input"), catching, NO_STANDING);
    expect(countOf(at, `input ${tx.slice(-4)}`)).toBe(2);
    expect(next.carry.failing.get(tx)).toMatchObject({ tries: 2, head: 1_001n });
  });

  test("R-WATCH-STALL a trace asked at a head and refused is not asked again at that head", async () => {
    const at = logPath();
    const { tx, logs } = finalizing();
    const down = new Map<Bytes32, "down">([[tx, "down"]]);
    const port = portOf(straight(1_000n, logs), at, -1n, new Map([[tx, HIDDEN]]), down);
    const first = await stepped(port, FRESH, NO_STANDING);
    const caught = await stepped(port, await stepped(port, first, NO_STANDING), NO_STANDING);
    expect(countOf(at, `trace ${tx.slice(-4)}`)).toBe(1);
    expect(countOf(at, `input ${tx.slice(-4)}`)).toBe(1);
    expect(caught.carry.failing.get(tx)).toMatchObject({ tries: 1, head: 1_000n });
  });

  test("R-WATCH-STALL with no lock on it a tx the node fails gets FEW_TRIES blocks, then is unread", async () => {
    const { tx, logs } = finalizing();
    const at = (head: bigint) => portOf(straight(head, logs), logPath(), "input");
    const tries = await along(at, upTo(6n, 6n + BigInt(FEW_TRIES) - 2n));
    expect(tries.told).toEqual([BEHIND]);
    expect(tries.carry.failing.get(tx)?.tries).toBe(FEW_TRIES - 1);
    const spent = await along(at, [6n + BigInt(FEW_TRIES) - 1n], tries);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(spent.told.slice(1)).toEqual([EPOCH, OVER, unread, BEHIND_OVER]);
    expect(spent.carry.failing.size).toBe(0);
  });

  test("R-WATCH-STALL a tx the node fails with a forward on it is waited on until lastHeard passes", async () => {
    const { tx, logs } = finalizing();
    const at = (head: bigint) => portOf(straight(head, logs), logPath(), "input");
    const stand: Standing = { ...NO_STANDING, lastHeard: new Map([[RIGHT, 20n]]) };
    const waiting = await along(at, upTo(6n, 22n), FRESH, stand);
    expect(waiting.told).toEqual([BEHIND]);
    expect(waiting.carry.failing.get(tx)?.tries).toBe(17);
    const spent = await along(at, [23n], waiting, stand);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(spent.told.slice(1)).toEqual([EPOCH, OVER, unread, BEHIND_OVER]);
    const other: Standing = { ...NO_STANDING, lastHeard: new Map([[OTHER, 100n]]) };
    const unrelated = await along(at, upTo(6n, 8n), FRESH, other);
    expect(unrelated.told.slice(1)).toEqual([EPOCH, OVER, unread, BEHIND_OVER]);
  });

  test("R-WATCH-STALL the Entity is told an Account is behind once, and over only from the view it is at", async () => {
    const { tx, logs } = finalizing();
    const at = (head: bigint) => portOf(straight(head, logs), logPath(), "input");
    const knows: Standing = { ...NO_STANDING, behind: new Set([RIGHT]), view: 100n };
    const restarted = await along(at, upTo(6n, 8n), FRESH, knows);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(restarted.told).toEqual([EPOCH, OVER, unread]);
    const caught = await along(at, upTo(6n, 8n), FRESH, { ...knows, view: 0n });
    expect(caught.told).toEqual([EPOCH, OVER, unread, BEHIND_OVER]);
  });

  test("R-WATCH-STALL a restart begins before the earliest block the Entity was told is held back", () => {
    const behind = (from: bigint): ChainFacts => ({ ...freshChain, behind: from });
    const chain = new Map<EntityId, ChainFacts>([
      [peer(RIGHT), behind(5n)], [peer(OTHER), behind(8n)], [peer(entityOf(0x70n)), freshChain],
    ]);
    expect(resumeAt(20n, chain)).toBe(4n);
    expect(resumeAt(3n, chain)).toBe(3n);
    expect(resumeAt(20n, new Map())).toBe(20n);
  });

  /** A finalize at block 2 whose tx the node never gives, and one at block 3 whose tx it gives (tx index 5 there). */
  const behindAStall = () => {
    const stuck = finalizing(txOf(2n, 1n));
    const fine = finalizing(txOf(3n, 5n));
    const logs = [...stuck.logs, advanced(3n, 0n, 2n), finalizedOf(fine.op, 3n, 5n, fine.tx)];
    return { logs, fine, stuck };
  };

  test("R-WATCH-CALLDATA a tx read behind a stalled one is read once, not once a head", async () => {
    const at = logPath();
    const { logs, fine, stuck } = behindAStall();
    const inputs = new Map([[fine.tx, finalizeInput(RIGHT, [fine.op])]]);
    const polled = await along((head) => portOf(straight(head, logs), at, -1n, inputs), upTo(8n, 9n));
    expect(polled.carry.failing.get(stuck.tx)?.tries).toBe(2);
    expect(countOf(at, `input ${fine.tx.slice(-4)}`)).toBe(1);
    expect(countOf(at, `input ${stuck.tx.slice(-4)}`)).toBe(2);
    expect([...polled.carry.reads.keys()]).toEqual([fine.tx]);
  });

  test("R-WATCH-CALLDATA a trace asked and answered is not asked again while the tx waits behind a stall", async () => {
    const at = logPath();
    const { logs, fine, stuck } = behindAStall();
    const hidden = new Map([[fine.tx, HIDDEN]]);
    const stand: Standing = { ...NO_STANDING, lastHeard: new Map([[RIGHT, 50n]]) };
    const polled = await along((head) => portOf(straight(head, logs), at, -1n, hidden), upTo(8n, 11n), FRESH, stand);
    expect(polled.carry.failing.has(stuck.tx)).toBe(true);
    expect(countOf(at, `trace ${fine.tx.slice(-4)}`)).toBe(1);
    expect(polled.carry.reads.get(fine.tx)?.traced).toBe(true);
  });

  test("R-WATCH-CALLDATA what the Host keeps of a tx ends with its delivery: nothing is kept past it", async () => {
    const { tx, op, logs } = finalizing();
    const inputs = new Map([[tx, finalizeInput(RIGHT, [op])]]);
    const got = await poll(portOf(straight(6n, logs), logPath(), -1n, inputs), start(2n), LEFT);
    expect(got.ok ? got.value?.events : got).toEqual(TOLD);
    expect(got.ok ? got.value?.carry : got).toEqual(NO_CARRY);
  });

  test("R-WATCH-CALLDATA a trace the node keeps failing for a tx costs it tries too, then it is unread", async () => {
    const { tx, logs } = finalizing();
    const hidden = new Map([[tx, HIDDEN]]);
    const down = new Map<Bytes32, "down">([[tx, "down"]]);
    const at = (head: bigint) => portOf(straight(head, logs), logPath(), -1n, hidden, down);
    const tried = await along(at, upTo(6n, 7n));
    expect(tried.carry.failing.get(tx)).toMatchObject({ tries: 2, fault: DOWN });
    const spent = await along(at, [8n], tried);
    const unread: EntityInput = { _tag: "j_finalize_unread", peer: peer(RIGHT), tx };
    expect(spent.told.slice(1)).toEqual([EPOCH, OVER, unread, BEHIND_OVER]);
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
      port: portOf(straight(9n), logPath()), depository: DEPOSITORY, depth: 3n, hosted: LEFT, value: false,
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
