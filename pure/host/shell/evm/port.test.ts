// The chain port against a node that is scripted: what it asks of the node for each of the five things the submit path
// needs, and what it makes of every kind of answer, including the ones a node should not give. The node writes what it
// was asked to a log file, so the order and the parameters of the calls are read from it and nothing here mutates.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessBatchCall, SealedBatch } from "../../../j/batch/sealed.ts";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { entityOf } from "../../fixtures.ts";
import { keyOf } from "../link/link.ts";
import {
  BATCH_FAILED, DISPUTE_SKIPPED, HANKO_PROCESSED, processBatchData, topicNumber,
} from "./calls.ts";
import { chainPort, type PortConfig, type Rpc, type RpcFault } from "./port.ts";
import { rawTx } from "./tx.ts";

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEY = unwrapOr(keyOf(SECRET), () => expect.unreachable("key"));
const ENTITY = entityOf(1);
const DEPOSITORY = "0xED34A147a0a480B0B006A4266E8bA0d6e995000C";
const CONFIG: PortConfig =
  { depository: DEPOSITORY, entity: ENTITY, chainId: 11155111n, key: KEY, tokens: [1n, 7n], from: 100n };
const DIGEST = `0x${"ab".repeat(32)}`;
const BATCH = { digest: DIGEST, nonce: 5n } as never as SealedBatch;
const CALL: ProcessBatchCall = { entityId: ENTITY, encodedBatch: "0x1234", hankoData: "0xabcd", nonce: 5n };

// Selectors of the Depository's views, as an independent library hashes them (not as calls.ts builds them).
const RESERVES = "0xacd6f208";
const DEBT_OUTSTANDING = "0x9e8de819";

const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const words = (...ns: readonly bigint[]): string => `0x${ns.map(word).join("")}`;
const down: Result<never, RpcFault> = err({ _tag: "rpc", reason: "connection refused" });

/** A node: what it answers to a method (given its parameters), and the file where it writes what it was asked. */
type Node = Readonly<Record<string, (params: readonly unknown[]) => Result<unknown, RpcFault>>>;

const logOf = (): string => join(mkdtempSync(join(tmpdir(), "port-")), "asked.log");

const rpcOf = (node: Node, log: string): Rpc => (method, params) => {
  appendFileSync(log, `${method} ${JSON.stringify(params)}\n`);
  const answer = node[method];
  return Promise.resolve(answer === undefined ? err({ _tag: "rpc", reason: `no ${method}` }) : answer(params));
};

const portOf = (node: Node, log: string = logOf()) => chainPort(rpcOf(node, log), CONFIG);

const askedOf = (log: string): readonly string[] =>
  readFileSync(log, "utf8").split("\n").filter((line) => line !== "");

const logAt = (block: bigint, tx: string, topics: readonly string[], data = "0x"): unknown =>
  ({ address: DEPOSITORY.toLowerCase(), topics, data, blockNumber: `0x${block.toString(16)}`, transactionHash: tx });

describe("host/shell/evm the port reads the chain's state as the contract holds it", () => {
  test("R-DURABLE the Entity's stored nonce is one word of entityNonces(entity)", async () => {
    const log = logOf();
    const port = portOf({ eth_call: () => ok(words(41n)) }, log);
    expect(await port.nonce()).toEqual(ok(41n));
    const [asked] = askedOf(log);
    expect(asked).toContain(`"to":"${DEPOSITORY}"`);
    expect(asked).toContain(ENTITY.slice(2));
    expect(asked).toContain('"latest"');
    expect(asked).toContain("0xedcc1b04");
  });

  test("R-SIMULATE the treasury holds each token's reserve and the whole debt of its three limbs", async () => {
    const answers = (params: readonly unknown[]) => {
      const { data } = params[0] as { data: string };
      const token = BigInt(`0x${data.slice(-64)}`);
      if (data.slice(0, 10) === RESERVES) return ok(words(token * 100n));
      return data.slice(0, 10) === DEBT_OUTSTANDING
        ? ok(words(0n, 1n, token))
        : err({ _tag: "rpc", reason: "no such call" } as const);
    };
    const treasury = await portOf({ eth_call: answers }).treasury();
    expect(treasury).toEqual(ok(new Map([
      [1n, { reserve: 100n, debt: (1n << 256n) + 1n }],
      [7n, { reserve: 700n, debt: (1n << 256n) + 7n }],
    ])));
  });

  test("a word of the wrong size, or text that is not hex, is a fault the port names, not a throw", async () => {
    expect(await portOf({ eth_call: () => ok("0x12") }).nonce()).toMatchObject({ ok: false, error: { call: "nonce" } });
    expect(await portOf({ eth_call: () => ok(words(1n, 2n)) }).nonce()).toMatchObject({ ok: false });
    expect(await portOf({ eth_call: () => ok(42) }).nonce()).toMatchObject({ ok: false });
    expect(await portOf({ eth_call: () => down }).nonce())
      .toEqual(err({ _tag: "port", call: "nonce", reason: "connection refused" }));
  });
});


const simulated = (calls: unknown) => ok([{ number: "0x1", calls }]);
const call = (patch: Record<string, unknown>) =>
  ({ returnData: "0x", logs: [], gasUsed: "0x5208", status: "0x1", ...patch });

describe("host/shell/evm a batch is simulated at the head, and one that does not fully apply is refused", () => {
  const outcome = async (calls: unknown) =>
    portOf({ eth_simulateV1: () => simulated(calls) }).simulate(CALL, 1_000_000n);

  test("R-SIMULATE a call that succeeds with no refusal event has room: the gas it used", async () => {
    expect(await outcome([call({ gasUsed: "0x3e8" })])).toEqual(ok({ _tag: "ok", applyGas: 1_000n }));
  });

  test("R-SIMULATE a call that reverts is a revert, with the node's own reason", async () => {
    const reverted = call({ status: "0x0", error: { code: -3200, message: "execution failed" } });
    expect(await outcome([reverted])).toEqual(ok({ _tag: "reverts", reason: "execution failed" }));
  });

  test("R-SIMULATE BatchFailed and DisputeOpSkipped refuse the batch though the call succeeded", async () => {
    const failed = { address: DEPOSITORY.toLowerCase(), topics: [BATCH_FAILED], data: "0x" };
    const skipped = { address: DEPOSITORY, topics: [DISPUTE_SKIPPED], data: "0x" };
    expect(await outcome([call({ logs: [failed] })])).toEqual(ok({ _tag: "reverts", reason: "BatchFailed" }));
    expect(await outcome([call({ logs: [skipped] })])).toEqual(ok({ _tag: "reverts", reason: "DisputeOpSkipped" }));
    const foreign = { address: "0x1111111111111111111111111111111111111111", topics: [BATCH_FAILED], data: "0x" };
    expect(await outcome([call({ logs: [foreign] })])).toEqual(ok({ _tag: "ok", applyGas: 21_000n }));
  });

  test("R-SIMULATE the call is made from the key's address at the head, with the gas limit it is given", async () => {
    const log = logOf();
    await portOf({ eth_simulateV1: () => simulated([call({})]) }, log).simulate(CALL, 1_000_000n);
    const [asked] = askedOf(log);
    expect(asked).toContain(`"from":"${KEY.runtime}"`);
    expect(asked).toContain('"gas":"0xf4240"');
    expect(asked).toContain('"validation":false');
    expect(asked).toContain('"latest"');
  });

  test("R-SIMULATE a simulation with no call, or a node that is down, is a fault and never a revert", async () => {
    expect(await outcome([])).toMatchObject({ ok: false, error: { call: "simulate" } });
    expect(await portOf({ eth_simulateV1: () => ok([]) }).simulate(CALL, 1n)).toMatchObject({ ok: false });
    expect(await portOf({ eth_simulateV1: () => ok("nope") }).simulate(CALL, 1n)).toMatchObject({ ok: false });
    expect(await portOf({ eth_simulateV1: () => down }).simulate(CALL, 1n)).toMatchObject({ ok: false });
  });
});

describe("host/shell/evm the send is one signed transaction at the sender's next nonce, above the base fee", () => {
  const node: Node = {
    eth_getTransactionCount: () => ok("0x3"),
    eth_getBlockByNumber: () => ok({ baseFeePerGas: "0x64" }),
    eth_maxPriorityFeePerGas: () => ok("0x5"),
    eth_sendRawTransaction: () => ok(`0x${"00".repeat(32)}`),
  };

  test("R-DURABLE the raw transaction calls processBatch, signed by the key, at nonce 3 and 2 base + tip", async () => {
    const log = logOf();
    expect(await portOf(node, log).send(CALL, 5_000_000n)).toEqual(ok(undefined));
    const sent = askedOf(log).find((line) => line.startsWith("eth_sendRawTransaction"))
      ?? expect.unreachable("no send");
    const data = unwrapOr(processBatchData(CALL), () => expect.unreachable("calldata"));
    expect(data.slice(0, 10)).toBe("0x28d4bf9e");
    const counted = askedOf(log).find((line) => line.startsWith("eth_getTransactionCount")) ?? "";
    expect(counted).toContain('"pending"');
    const expected = rawTx({
      chainId: 11155111n, nonce: 3n, tip: 5n, maxFee: 205n, gas: 5_000_000n, to: DEPOSITORY, data,
    }, SECRET);
    expect(sent).toBe(`eth_sendRawTransaction ${JSON.stringify([unwrapOr(expected, () => expect.unreachable("tx"))])}`);
  });

  test("a node that refuses the transaction, or a reply that is no fee, is a fault the submit path reads", async () => {
    const refusing: Node = { ...node, eth_sendRawTransaction: () => err({ _tag: "rpc", reason: "nonce too low" }) };
    expect(await portOf(refusing).send(CALL, 1n))
      .toEqual(err({ _tag: "port", call: "send", reason: "nonce too low" }));
    const nofee: Node = { ...node, eth_getBlockByNumber: () => ok({ number: "0x1" }) };
    expect(await portOf(nofee).send(CALL, 1n)).toMatchObject({ ok: false, error: { call: "send fee" } });
  });
});

describe("host/shell/evm what became of a batch is read from the Depository's logs", () => {
  const TX = `0x${"11".repeat(32)}`;
  const OTHER_TX = `0x${"22".repeat(32)}`;
  const COUNTER = `0x${"cd".repeat(32)}`;
  const skip = (tx: string, reason: bigint) => logAt(7n, tx, [DISPUTE_SKIPPED, ENTITY, COUNTER], words(1n, reason, 9n));

  const logsFor = (topic0: string, found: readonly unknown[]): Node["eth_getLogs"] => (params) => {
    const { topics } = params[0] as { topics: readonly string[] };
    return ok(topics[0] === topic0 ? found : []);
  };

  test("R-DURABLE a batch whose HankoBatchProcessed is on the chain has landed, with its own skips", async () => {
    const landed = logAt(7n, TX, [HANKO_PROCESSED, ENTITY, DIGEST], words(5n));
    const log = logOf();
    const getLogs: Node["eth_getLogs"] = (params) => {
      const { topics } = params[0] as { topics: readonly string[] };
      if (topics[0] === HANKO_PROCESSED) return ok([landed]);
      return topics[0] === DISPUTE_SKIPPED ? ok([skip(TX, 3n), skip(OTHER_TX, 4n)]) : ok([]);
    };
    expect(await portOf({ eth_getLogs: getLogs }, log).answer(BATCH)).toEqual(ok({
      _tag: "landed", nonce: 5n, batchHash: DIGEST, skipped: [{ op: 1, counterentity: COUNTER, reason: 3, nonce: 9n }],
    }));
    const [first] = askedOf(log);
    expect(first).toContain(`"fromBlock":"0x64"`);
    expect(first).toContain(`"toBlock":"latest"`);
    expect(first).toContain(DIGEST);
    expect(askedOf(log)[1]).toContain('"fromBlock":"0x7","toBlock":"0x7"');
  });

  test("R-J5 a BatchFailed at the batch's nonce is a failure, with the selector of the revert", async () => {
    const failed = logAt(8n, TX, [BATCH_FAILED, ENTITY, topicNumber(5n)], `0x${"aabbccdd"}${"00".repeat(28)}`);
    expect(await portOf({ eth_getLogs: logsFor(BATCH_FAILED, [failed]) }).answer(BATCH))
      .toEqual(ok({ _tag: "failed", nonce: 5n, reason: "0xaabbccdd" }));
  });

  test("a batch the chain has said nothing about has no answer yet", async () => {
    expect(await portOf({ eth_getLogs: () => ok([]) }).answer(BATCH)).toEqual(ok(undefined));
  });

  test("a node that is down, or logs that are not logs, are faults and not answers", async () => {
    expect(await portOf({ eth_getLogs: () => down }).answer(BATCH))
      .toEqual(err({ _tag: "port", call: "answer", reason: "connection refused" }));
    expect(await portOf({ eth_getLogs: () => ok("none") }).answer(BATCH)).toMatchObject({ ok: false });
    expect(await portOf({ eth_getLogs: () => ok([{ topics: "x" }]) }).answer(BATCH)).toMatchObject({ ok: false });
    const noData = logAt(8n, TX, [BATCH_FAILED, ENTITY, topicNumber(5n)], "0x12");
    expect(await portOf({ eth_getLogs: logsFor(BATCH_FAILED, [noData]) }).answer(BATCH)).toMatchObject({ ok: false });
  });
});
