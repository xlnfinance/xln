// The watcher's port against a node that is scripted: what it asks for each of its four reads, the calldata checked
// against the deployed Depository's ABI as an independent library encodes it, and what it makes of every kind of
// answer, including the ones a node should not give (R-JLOOP). The node writes what it was asked to a log file.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import { DEPOSITORY, DEPOSITORY_ABI, entityOf, hashOf, hexOf, txOf } from "../../../j/fixtures.ts";
import { blockOf } from "../../../j/fixtures.ts";
import type { Rpc, RpcFault } from "./port.ts";
import { watchPort } from "./watch.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const KEY = `${LEFT}${RIGHT.slice(2)}`;
const ADDRESS = DEPOSITORY;

const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const words = (...ns: readonly bigint[]): string => `0x${ns.map(word).join("")}`;
const down: Result<never, RpcFault> = err({ _tag: "rpc", reason: "connection refused" });

type Node = Readonly<Record<string, (params: readonly unknown[]) => Result<unknown, RpcFault>>>;

const logPath = (): string => join(mkdtempSync(join(tmpdir(), "watch-")), "asked.log");

const rpcOf = (node: Node, log: string): Rpc => (method, params) => {
  appendFileSync(log, `${method} ${JSON.stringify(params)}\n`);
  const answer = node[method];
  return Promise.resolve(answer === undefined ? err({ _tag: "rpc", reason: `no ${method}` }) : answer(params));
};

const portOf = (node: Node, log: string = logPath()) => watchPort(rpcOf(node, log), ADDRESS);

const askedOf = (log: string): readonly string[] => readFileSync(log, "utf8").split("\n").filter((l) => l !== "");

const rawLog = (block: bigint, index: bigint, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: ADDRESS.toUpperCase().replace("0X", "0x"), topics: [hexOf(7n), hexOf(8n)], data: "0xABCD",
  blockNumber: `0x${block.toString(16)}`, blockHash: hashOf(block), logIndex: `0x${index.toString(16)}`,
  transactionHash: txOf(block, index).toUpperCase().replace("0X", "0x"), ...extra,
});

describe("host/shell/evm/watch the J loop's reads of the chain", () => {
  test("R-JLOOP the head is the node's block number", async () => {
    expect(await portOf({ eth_blockNumber: () => ok("0x1f") }).head()).toEqual(ok(31n));
    expect(await portOf({ eth_blockNumber: () => ok("31") }).head())
      .toMatchObject({ ok: false, error: { call: "watch head" } });
  });

  test("R-JLOOP a block is asked for by number, refused when it is another's or its hashes are no hashes", async () => {
    const log = logPath();
    const fine = { number: "0x5", hash: hashOf(5n), parentHash: hashOf(4n), timestamp: "0x32" };
    expect(await portOf({ eth_getBlockByNumber: () => ok(fine) }, log).block(5n)).toEqual(ok(blockOf(5n)));
    expect(askedOf(log)).toEqual([`eth_getBlockByNumber ["0x5",false]`]);
    const asked = (reply: unknown) => portOf({ eth_getBlockByNumber: () => ok(reply) }).block(5n);
    expect(await asked({ ...fine, number: "0x6" })).toMatchObject({ ok: false, error: { call: "watch block" } });
    expect(await asked({ ...fine, hash: "0x12" })).toMatchObject({ ok: false });
    expect(await asked({ ...fine, parentHash: 7 })).toMatchObject({ ok: false });
    expect(await asked({ ...fine, timestamp: undefined })).toMatchObject({ ok: false });
    expect(await asked(null)).toMatchObject({ ok: false });
    expect(await portOf({ eth_getBlockByNumber: () => down }).block(5n))
      .toEqual(err({ _tag: "port", call: "watch block", reason: "connection refused" }));
  });

  test("R-JLOOP the Depository's logs in a range come back whole, lowercase, and only those asked for", async () => {
    const log = logPath();
    const got = await portOf({ eth_getLogs: () => ok([rawLog(3n, 0n), rawLog(4n, 2n)]) }, log).logs(3n, 4n);
    expect(got.ok ? got.value.map((l) => [l.block, l.index, l.blockHash, l.address, l.data, l.tx]) : got).toEqual([
      [3n, 0n, hashOf(3n), ADDRESS, "0xabcd", txOf(3n, 0n)], [4n, 2n, hashOf(4n), ADDRESS, "0xabcd", txOf(4n, 2n)],
    ]);
    expect(got.ok ? got.value[0]?.topics : got).toEqual([hexOf(7n), hexOf(8n)] as never);
    expect(askedOf(log)).toEqual([`eth_getLogs [{"address":"${ADDRESS}","fromBlock":"0x3","toBlock":"0x4"}]`]);
    const asked = (...logs: readonly unknown[]) => portOf({ eth_getLogs: () => ok(logs) }).logs(3n, 4n);
    expect(await asked(rawLog(3n, 0n, { address: `0x${"11".repeat(20)}` }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(2n, 0n))).toMatchObject({ ok: false });
    expect(await asked(rawLog(5n, 0n))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { topics: "no" }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { topics: [7] }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { data: 12 }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { blockHash: "0x1" }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { logIndex: "1" }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { transactionHash: "0x1" }))).toMatchObject({ ok: false });
    expect(await asked(rawLog(3n, 0n, { transactionHash: undefined }))).toMatchObject({ ok: false });
    expect(await portOf({ eth_getLogs: () => ok("nothing") }).logs(3n, 4n)).toMatchObject({ ok: false });
    expect(await portOf({ eth_getLogs: () => down }).logs(3n, 4n))
      .toMatchObject({ ok: false, error: { call: "watch logs" } });
  });

  test("R-WATCH-CALLDATA a transaction is asked for by hash and its input comes back as bytes", async () => {
    const log = logPath();
    const found = { hash: txOf(3n, 1n), input: "0xDEADbeef", to: ADDRESS };
    expect(await portOf({ eth_getTransactionByHash: () => ok(found) }, log).input(txOf(3n, 1n)))
      .toEqual(ok(Uint8Array.of(0xde, 0xad, 0xbe, 0xef)));
    expect(askedOf(log)).toEqual([`eth_getTransactionByHash ["${txOf(3n, 1n)}"]`]);
    const asked = (reply: unknown) => portOf({ eth_getTransactionByHash: () => ok(reply) }).input(txOf(3n, 1n));
    expect(await asked(null)).toEqual({ ok: true, value: undefined });
    expect(await asked({ ...found, input: 12 })).toMatchObject({ ok: false });
    expect(await asked({ ...found, input: "0xabc" })).toMatchObject({ ok: false });
    expect(await portOf({ eth_getTransactionByHash: () => down }).input(txOf(3n, 1n)))
      .toEqual(err({ _tag: "port", call: "watch tx", reason: "connection refused" }));
  });

  test("R-WATCH-CALLDATA a call trace is the inputs of the calls made to the Depository, nested or not", async () => {
    const log = logPath();
    const call = (to: string, input: string, calls?: readonly unknown[]) => ({ type: "CALL", to, input, calls });
    const other = "0x00000000000000000000000000000000000000aa";
    const tree = call(other, "0x1111", [
      call(other, "0x2222", [call(ADDRESS, "0xCAFE01")]),
      call(ADDRESS.toUpperCase().replace("0X", "0x"), "0xCAFE02", []),
    ]);
    const traced = await portOf({ debug_traceTransaction: () => ok(tree) }, log).trace(txOf(3n, 1n));
    expect(traced).toEqual(ok([Uint8Array.of(0xca, 0xfe, 0x01), Uint8Array.of(0xca, 0xfe, 0x02)]));
    expect(askedOf(log)).toEqual([`debug_traceTransaction ["${txOf(3n, 1n)}",{"tracer":"callTracer"}]`]);
  });

  test("R-WATCH-CALLDATA a node with no call trace says so; any other fault of the node is a fault", async () => {
    const refuses = (reason: string) => portOf({ debug_traceTransaction: () => err({ _tag: "rpc", reason }) });
    const none = "the method debug_traceTransaction does not exist/is not available";
    expect(await refuses(none).trace(txOf(3n, 1n))).toEqual(ok(undefined));
    expect(await refuses("Method not found").trace(txOf(3n, 1n))).toEqual(ok(undefined));
    expect(await refuses("transaction not found").trace(txOf(3n, 1n)))
      .toEqual(err({ _tag: "port", call: "watch trace", reason: "transaction not found" }));
    expect(await portOf({ debug_traceTransaction: () => down }).trace(txOf(3n, 1n)))
      .toEqual(err({ _tag: "port", call: "watch trace", reason: "connection refused" }));
  });

  test("R-WATCH-CALLDATA a call trace that is not a tree of calls, or too big to read, is a fault", async () => {
    const asked = (reply: unknown) => portOf({ debug_traceTransaction: () => ok(reply) }).trace(txOf(3n, 1n));
    const missing = { to: ADDRESS };
    const deeper = (below: unknown): unknown => ({ to: "0x00", input: "0x", calls: [below] });
    const deep = Array.from({ length: 70 }).reduce<unknown>(deeper, {});
    const wide = { to: "0x00", input: "0x", calls: Array.from({ length: 4097 }, () => ({ to: "0x00", input: "0x" })) };
    const replies = [null, "0x", { to: ADDRESS, input: "0x12", calls: "none" }, missing, deep, wide];
    const answers = await Promise.all(replies.map(asked));
    answers.forEach((got) => expect(got).toMatchObject({ ok: false, error: { call: "watch trace" } }));
  });

  test("R-WATCH-TELL an Account is read at the end of a block named by its hash: row nonce and epoch", async () => {
    const log = logPath();
    const node: Node = {
      eth_call: (params) => {
        const { data } = params[0] as { data: string };
        return ok(
          data.slice(0, 10) === DEPOSITORY_ABI.getFunction("ondeltaEpoch")?.selector ? words(3n) : words(9n, 1n, 2n),
        );
      },
    };
    expect(await portOf(node, log).accountAt(hashOf(6n), LEFT, RIGHT)).toEqual(ok({ epoch: 3n, nonce: 9n }));
    const block = { blockHash: hashOf(6n), requireCanonical: true };
    const calls = askedOf(log)
      .map((line) => JSON.parse(line.slice("eth_call ".length)) as [{ to: string; data: string }, unknown]);
    expect(calls.map(([call]) => call.data)).toEqual([
      DEPOSITORY_ABI.encodeFunctionData("_accounts", [KEY]),
      DEPOSITORY_ABI.encodeFunctionData("ondeltaEpoch", [LEFT, RIGHT]),
    ]);
    expect(calls.map(([call]) => call.to)).toEqual([ADDRESS, ADDRESS]);
    expect(calls.map(([, at]) => at)).toEqual([block, block]);
  });

  test("R-WATCH-TELL an empty row, an epoch that is not one word, or a node that fails is a named fault", async () => {
    const reply = (row: string, epoch: string): Node => ({
      eth_call: (params) => ok(
        (params[0] as { data: string }).data.startsWith(DEPOSITORY_ABI.getFunction("ondeltaEpoch")?.selector ?? "?")
          ? epoch
          : row,
      ),
    });
    const read = (node: Node) => portOf(node).accountAt(hashOf(6n), LEFT, RIGHT);
    expect(await read(reply("0x", words(3n)))).toMatchObject({ ok: false, error: { call: "account at" } });
    expect(await read(reply(words(9n), words(3n, 4n)))).toMatchObject({ ok: false, error: { call: "account at" } });
    expect(await read(reply(words(9n), "0x12"))).toMatchObject({ ok: false });
    const selector = DEPOSITORY_ABI.getFunction("ondeltaEpoch")?.selector ?? "?";
    const failing = (which: "epoch" | "row"): Node => ({
      eth_call: (params) => {
        const isEpoch = (params[0] as { data: string }).data.startsWith(selector);
        return isEpoch === (which === "epoch") ? down : ok(isEpoch ? words(3n) : words(9n));
      },
    });
    const fault = err({ _tag: "port", call: "account at", reason: "connection refused" } as const);
    expect(await read(failing("row"))).toEqual(fault);
    expect(await read(failing("epoch"))).toEqual(fault);
    expect(await portOf({ eth_call: () => ok(words(9n)) }).accountAt(hashOf(6n), LEFT, "0x12" as never))
      .toMatchObject({ ok: false });
  });
});
