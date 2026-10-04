// The watcher's port against a node that is scripted: what it asks for each of its four reads, the calldata checked
// against the deployed Depository's ABI as an independent library encodes it, and what it makes of every kind of
// answer, including the ones a node should not give (R-JLOOP). The node writes what it was asked to a log file.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../../../kernel/core/result.ts";
import {
  DEPLOYED, DEPOSITORY, DEPOSITORY_ABI, entityOf, hashOf, hexOf, TRANSFORMER, txOf,
} from "../../../j/fixtures.ts";
import { blockOf } from "../../../j/fixtures.ts";
import type { Rpc, RpcFault } from "./port.ts";
import { registryRead, watchPort } from "./watch.ts";
import { Interface } from "ethers";
import {
  DeltaTransformer__factory,
} from "../../../../contracts/typechain-types/factories/DeltaTransformer.sol/DeltaTransformer__factory.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const KEY = `${LEFT}${RIGHT.slice(2)}`;
const ADDRESS = DEPOSITORY;

const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const words = (...ns: readonly bigint[]): string => `0x${ns.map(word).join("")}`;
const FRAME = { type: "CALL", from: "0x00000000000000000000000000000000000000bb", to: ADDRESS, input: "0x" };
const NO_METHOD = { _tag: "no_method" } as const;
const down: Result<never, RpcFault> = err({ _tag: "rpc", reason: "connection refused" });

type Node = Readonly<Record<string, (params: readonly unknown[]) => Result<unknown, RpcFault>>>;

const logPath = (): string => join(mkdtempSync(join(tmpdir(), "watch-")), "asked.log");

const rpcOf = (node: Node, log: string): Rpc => (method, params) => {
  appendFileSync(log, `${method} ${JSON.stringify(params)}\n`);
  const answer = node[method];
  return Promise.resolve(answer === undefined ? err({ _tag: "rpc", reason: `no ${method}` }) : answer(params));
};

const portOf = (node: Node, log: string = logPath()) => watchPort(rpcOf(node, log), DEPLOYED);

const TX = `0x${"ab".repeat(32)}`;

const refusal = (reason: string): Result<never, RpcFault> => err({ _tag: "rpc", reason });

/** The probe of block 0x20, whose transactions are `txs`, with the node's answer to the trace; traceCall is a lure. */
const probed = (trace: Result<unknown, RpcFault>, log: string = logPath(), txs: readonly string[] = [TX]) =>
  portOf({
    eth_getBlockByNumber: () => ok({ transactions: txs }), debug_traceTransaction: () => trace,
    debug_traceCall: () => ok({ type: "CALL", from: "0x00" }),
  }, log).traced(0x20n);

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
    const both = `["${ADDRESS}","${TRANSFORMER}"]`;
    expect(askedOf(log)).toEqual([`eth_getLogs [{"address":${both},"fromBlock":"0x3","toBlock":"0x4"}]`]);
    const theirs = await portOf({ eth_getLogs: () => ok([rawLog(3n, 0n, { address: TRANSFORMER })]) }).logs(3n, 4n);
    expect(theirs.ok ? theirs.value.map((l) => l.address) : theirs).toEqual([TRANSFORMER]);
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

  /** A node that answers no range of more than `most` blocks, as a hosted provider refuses a reply of too many logs. */
  const capped = (most: bigint): Node => ({
    eth_getLogs: ([filter]) => {
      const { fromBlock, toBlock } = filter as { fromBlock: string; toBlock: string };
      const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
      return to - from + 1n > most ? refusal("query returned more than 10000 results")
        : ok(Array.from({ length: Number(to - from) + 1 }, (_, i) => rawLog(from + BigInt(i), 0n)));
    },
  });

  test("R-WATCH-STALL a range the node will not answer is asked as halves down to one block, in order", async () => {
    const log = logPath();
    const got = await portOf(capped(2n), log).logs(10n, 17n);
    expect(got.ok ? got.value.map((l) => l.block) : got).toEqual([10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n]);
    const asked = askedOf(log).map((l) => /"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/.exec(l)?.slice(1, 3));
    expect(asked.map((r) => r?.map((x) => Number(x)))).toEqual([
      [10, 17], [10, 13], [10, 11], [12, 13], [14, 17], [14, 15], [16, 17],
    ]);
    const single = await portOf(capped(1n)).logs(10n, 13n);
    expect(single.ok ? single.value.map((l) => l.block) : single).toEqual([10n, 11n, 12n, 13n]);
  });

  test("R-WATCH-STALL a block the node will not answer alone is the poll's fault, one call per halving", async () => {
    const log = logPath();
    const got = await portOf(capped(0n), log).logs(0n, 63n);
    expect(got).toMatchObject({ ok: false, error: { call: "watch logs" } });
    expect(askedOf(log)).toHaveLength(7);
    const down7 = logPath();
    expect(await portOf({ eth_getLogs: () => down }, down7).logs(5n, 5n)).toMatchObject({ ok: false });
    expect(askedOf(down7)).toHaveLength(1);
  });

  test("R-WATCH-STALL a failed tail discards a successful head half of the log range", async () => {
    const log = logPath();
    const node: Node = {
      eth_getLogs: ([filter]) => {
        const { fromBlock, toBlock } = filter as { fromBlock: string; toBlock: string };
        const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
        if (from === 10n && to === 11n) return ok([rawLog(10n, 0n), rawLog(11n, 0n)]);
        return refusal("tail unavailable");
      },
    };
    const got = await portOf(node, log).logs(10n, 13n);
    expect(got).toMatchObject({ ok: false, error: { call: "watch logs", reason: "tail unavailable" } });
    const ranges = askedOf(log).map((line) =>
      /"fromBlock":"(0x[0-9a-f]+)","toBlock":"(0x[0-9a-f]+)"/.exec(line)?.slice(1, 3));
    expect(ranges).toEqual([["0xa", "0xd"], ["0xa", "0xb"], ["0xc", "0xd"], ["0xc", "0xc"]]);
  });

  test("R-WATCH-CALLDATA a transaction is asked for by hash and its input comes back as bytes", async () => {
    const log = logPath();
    const found = { hash: txOf(3n, 1n), input: "0xDEADbeef", to: ADDRESS };
    expect(await portOf({ eth_getTransactionByHash: () => ok(found) }, log).input(txOf(3n, 1n)))
      .toEqual(ok({ data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef), route: "direct" }));
    expect(askedOf(log)).toEqual([`eth_getTransactionByHash ["${txOf(3n, 1n)}"]`]);
    const asked = (reply: unknown) => portOf({ eth_getTransactionByHash: () => ok(reply) }).input(txOf(3n, 1n));
    expect(await asked(null)).toEqual({ ok: true, value: undefined });
    const elsewhere = await asked({ ...found, to: "0x00000000000000000000000000000000000000aa" });
    expect(elsewhere).toEqual(ok({ data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef), route: "wrapper" }));
    expect(await asked({ ...found, to: null })).toMatchObject({ ok: true, value: { route: "wrapper" } });
    expect(await asked({ ...found, to: ADDRESS.toUpperCase().replace("0X", "0x") }))
      .toMatchObject({ ok: true, value: { route: "direct" } });
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
    expect(traced).toEqual(ok({
      _tag: "calls",
      calls: [
        { data: Uint8Array.of(0xca, 0xfe, 0x02), route: "direct" },
        { data: Uint8Array.of(0xca, 0xfe, 0x01), route: "direct" },
      ],
    }));
    expect(askedOf(log)).toEqual([`debug_traceTransaction ["${txOf(3n, 1n)}",{"tracer":"callTracer"}]`]);
  });

  test("R-WATCH-CALLDATA a node with no call trace says so; any other fault of the node is a fault", async () => {
    const refuses = (reason: string) => portOf({ debug_traceTransaction: () => err({ _tag: "rpc", reason }) });
    const none = "the method debug_traceTransaction does not exist/is not available";
    expect(await refuses(none).trace(txOf(3n, 1n))).toEqual(ok(NO_METHOD));
    expect(await refuses("Method not found").trace(txOf(3n, 1n))).toEqual(ok(NO_METHOD));
    expect(await refuses("Unsupported method").trace(txOf(3n, 1n))).toEqual(ok(NO_METHOD));
    expect(await refuses("oops (JSON-RPC code -32601)").trace(txOf(3n, 1n))).toEqual(ok(NO_METHOD));
    expect(await refuses("transaction not found").trace(txOf(3n, 1n)))
      .toEqual(err({ _tag: "port", call: "watch trace", reason: "transaction not found" }));
    expect(await portOf({ debug_traceTransaction: () => down }).trace(txOf(3n, 1n)))
      .toEqual(err({ _tag: "port", call: "watch trace", reason: "connection refused" }));
  });

  test("R-WATCH-CALLDATA the probe traces the first tx of the block asked: only a call tree is a trace", async () => {
    const log = logPath();
    expect(await probed(ok({ ...FRAME, from: "0x01", to: "0x02" }), log)).toEqual(ok("traces"));
    expect(askedOf(log)).toEqual([
      `eth_getBlockByNumber ["0x20",false]`, `debug_traceTransaction ["${TX}",{"tracer":"callTracer"}]`,
    ]);
    expect(await probed(ok(FRAME))).toEqual(ok("traces"));
    const STRUCT = { gas: 1, failed: false, returnValue: "", structLogs: [] };
    const nots = [null, "0x", {}, STRUCT, { from: "0x01" }, { type: "x", from: "y" }, { type: "CALL", from: "0x01" },
      { type: "CALL", from: "y", to: "0x02" }, { type: "CALL", from: "0x01", to: "z" }, [FRAME]];
    const answers = await Promise.all(nots.map((a) => probed(ok(a))));
    answers.forEach((got) => expect(got).toEqual(ok("none")));
    expect(await probed(ok({ type: "CREATE", from: "0x01" }))).toEqual(ok("traces"));
  });

  test("R-WATCH-CALLDATA the probe: a missing method is none whatever the client, another error a fault", async () => {
    const missing = [
      "the method debug_traceTransaction does not exist/is not available (JSON-RPC code -32601)",
      "the method debug_traceTransaction does not exist/is not available",
      "Method not found (JSON-RPC code -32601)", "Unsupported method",
      "The method 'debug_traceTransaction' is found but the namespace 'debug' is disabled for http://127.0.0.1:8545/. "
      + "Consider adding the namespace 'debug' to JsonRpc.AdditionalRpcUrls (JSON-RPC code -32600)",
      "The method 'debug_traceTransaction' is found in namespace 'debug' for http://x/' but is disabled for "
      + "http://x/. (JSON-RPC code -32600)",
    ];
    const none = await Promise.all(missing.map((reason) => probed(refusal(reason))));
    none.forEach((got) => expect(got).toEqual(ok("none")));
    const faults = ["Invalid request (JSON-RPC code -32600)", "connection refused", "execution timeout"];
    const failed = await Promise.all(faults.map((reason) => probed(refusal(reason))));
    failed.forEach((got) => expect(got).toMatchObject({ ok: false, error: { call: "watch trace probe" } }));
  });

  test("R-WATCH-CALLDATA the probe of a block with no tx knows nothing and falls back to no traceCall", async () => {
    const log = logPath();
    expect(await probed(ok(FRAME), log, [])).toEqual(ok("no_transaction"));
    expect(askedOf(log)).toEqual([`eth_getBlockByNumber ["0x20",false]`]);
  });

  test("R-WATCH-CALLDATA a trace that is no tree of calls is no trace; only a missing method says none", async () => {
    const asked = (reply: unknown) => portOf({ debug_traceTransaction: () => ok(reply) }).trace(txOf(3n, 1n));
    const refuses = (reason: string) => portOf({ debug_traceTransaction: () => err({ _tag: "rpc", reason }) });
    const replies = [null, "0x", { to: ADDRESS, input: "0x12", calls: "none" }, { to: ADDRESS }];
    const answers = await Promise.all(replies.map(asked));
    answers.forEach((got) => expect(got).toEqual(ok({ _tag: "unreadable" })));
    const method = "the method debug_traceTransaction does not exist/is not available";
    const missing = [
      method, "Method not found", "Unsupported method", "method not supported", "(JSON-RPC code -32601)",
      "The method 'debug_traceTransaction' is found but the namespace 'debug' is disabled for http://127.0.0.1:8545/.",
      "The method 'debug_traceTransaction' is found in namespace 'debug' for http://x/' but is disabled for http://x/.",
    ];
    const gone = await Promise.all(missing.map((reason) => refuses(reason).trace(txOf(3n, 1n))));
    gone.forEach((got) => expect(got).toEqual(ok(NO_METHOD)));
    const clears = ["response size exceeded", "execution timeout", "request timed out", "the call timed out",
      "context deadline exceeded", "service is not available", "missing trie node",
      "unsupported block range", "unsupported media type", "Invalid request (JSON-RPC code -32600)",
      "required historical state unavailable (reexec=128)", "trace limit reached"];
    const faults = await Promise.all(clears.map((reason) => refuses(reason).trace(txOf(3n, 1n))));
    faults.forEach((got) => expect(got).toMatchObject({ ok: false, error: { _tag: "port", call: "watch trace" } }));
  });

  test("R-WATCH-CALLDATA a trace is read at any depth or size the EVM allows, the finalize last", async () => {
    const asked = (reply: unknown) => portOf({ debug_traceTransaction: () => ok(reply) }).trace(txOf(3n, 1n));
    const finalize = { to: ADDRESS, input: "0xCAFE01" };
    const around = (below: unknown): unknown => ({ to: "0x00", input: "0x", calls: [below] });
    const deep = (levels: number) => Array.from({ length: levels }).reduce<unknown>(around, finalize);
    const wide = (calls: number) => ({
      to: "0x00", input: "0x", calls: [...Array.from({ length: calls }, () => ({ to: "0x00", input: "0x" })), finalize],
    });
    const read = ok({
      _tag: "calls" as const, calls: [{ data: Uint8Array.of(0xca, 0xfe, 0x01), route: "direct" as const }],
    });
    const answers = await Promise.all([deep(65), deep(1000), deep(1024), wide(5000), wide(100_000)].map(asked));
    answers.forEach((got) => expect(got).toEqual(read));
    expect(await asked(deep(1025))).toEqual(ok({ _tag: "unreadable" }));
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

  test("R-WATCH-WINDOW a state the node no longer serves is pruned; any other error is a fault", async () => {
    const node = (reason: string, which: "epoch" | "row"): Node => ({
      eth_call: (params) => {
        const selector = DEPOSITORY_ABI.getFunction("ondeltaEpoch")?.selector ?? "?";
        const isEpoch = (params[0] as { data: string }).data.startsWith(selector);
        return isEpoch === (which === "epoch") ? refusal(reason) : ok(isEpoch ? words(3n) : words(9n));
      },
    });
    const read = (reason: string, which: "epoch" | "row") =>
      portOf(node(reason, which)).accountAt(hashOf(6n), LEFT, RIGHT);
    const pruned = [
      "missing trie node 1f2e (path ) state 0x1f2e is not available (JSON-RPC code -32000)",
      `historical state ${hashOf(6n).slice(2)} is not available (JSON-RPC code -32000)`,
      "missing trie node 1f2e (path 0a) <nil> (JSON-RPC code -32000)",
      "old data not available due to pruning (JSON-RPC code -32000)",
      `No state available for block 100000 (${hashOf(6n)}) (JSON-RPC code -32002)`,
      "state at block #100000 is pruned (JSON-RPC code -32000)",
    ];
    const gone = await Promise.all(pruned.flatMap((reason) => [read(reason, "row"), read(reason, "epoch")]));
    gone.forEach((got) => expect(got).toEqual(ok("pruned")));
    const faults = [
      "header for hash not found", "header not found", "hash is not currently canonical", "block not found: 0x186a0",
      `hash ${hashOf(6n)} is not currently canonical`, "block 100000 is not executed (last executed: 99000)",
      `${hashOf(6n)} block is not canonical`, `block not found: hash ${hashOf(6n)}`, "Invalid input", "Internal error",
      "not supported", "state histories haven't been fully indexed yet", "state histories are not available",
      `state ${hashOf(6n)} is not available`, "connection refused", "execution timeout",
    ].map((reason) => `${reason} (JSON-RPC code -32000)`);
    const failed = await Promise.all(faults.flatMap((reason) => [read(reason, "row"), read(reason, "epoch")]));
    failed.forEach((got) => expect(got).toMatchObject({ ok: false, error: { _tag: "port", call: "account at" } }));
  });

  test("R-WATCH-WINDOW a node that answers null for a state it lacks is a fault, never a zero Account", async () => {
    const got = await portOf({ eth_call: () => ok(null) }).accountAt(hashOf(6n), LEFT, RIGHT);
    expect(got).toMatchObject({ ok: false, error: { _tag: "port", call: "account at" } });
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

  const REGISTRY_ABI = new Interface(DeltaTransformer__factory.abi);
  const HASHLOCK = hexOf(0xabcn);

  const registryOf = (node: Node, log: string = logPath()) => registryRead(rpcOf(node, log), DEPLOYED);

  test("R-REGISTRY-AT-VIEW the registry is read by the contract's selector, at the view", async () => {
    const log = logPath();
    const got = await registryOf({ eth_call: () => ok(words(1_800_000_123n)) }, log)(HASHLOCK, 0x2an);
    expect(got).toEqual(ok(1_800_000_123n));
    const [asked] = askedOf(log);
    const [method, params] = [asked?.split(" ")[0], JSON.parse(asked?.slice((asked?.indexOf(" ") ?? 0) + 1) ?? "null")];
    expect(method).toBe("eth_call");
    const call = REGISTRY_ABI.encodeFunctionData("hashToTimestamp", [HASHLOCK]);
    expect(params).toEqual([{ to: TRANSFORMER, data: call }, "0x2a"]);
    expect(call.slice(0, 10)).toBe(REGISTRY_ABI.getFunction("hashToTimestamp")?.selector ?? "?");
  });

  test("R-REGISTRY-AT-VIEW a hashlock never shown reads 0, and a reply that is not one word is a fault", async () => {
    expect(await registryOf({ eth_call: () => ok(words(0n)) })(HASHLOCK, 5n)).toEqual(ok(0n));
    const faults = [ok("0x"), ok(words(1n, 2n)), ok(null), ok("0xzz"), ok(7)];
    const got = await Promise.all(faults.map((reply) => registryOf({ eth_call: () => reply })(HASHLOCK, 5n)));
    got.forEach((one) => expect(one).toMatchObject({ ok: false, error: { _tag: "port", call: "registry" } }));
    const unlocked = await registryOf({ eth_call: () => down })("0x12", 5n);
    expect(unlocked).toMatchObject({ ok: false, error: { call: "registry" } });
  });

  test("R-REGISTRY-AT-VIEW a block the node no longer serves is pruned; any other error is a fault", async () => {
    const pruned = [
      "missing trie node 1f2e (path ) state 0x1f2e is not available (JSON-RPC code -32000)",
      "old data not available due to pruning (JSON-RPC code -32000)",
      "No state available for block 100000 (JSON-RPC code -32002)",
      "state at block #100000 is pruned (JSON-RPC code -32000)",
    ];
    const readWith = (reason: string) => registryOf({ eth_call: () => refusal(reason) })(HASHLOCK, 5n);
    const gone = await Promise.all(pruned.map(readWith));
    gone.forEach((got) => expect(got).toEqual(ok("pruned")));
    const faults = ["header not found", "connection refused", "execution timeout", "block not found: 0x5"];
    const failed = await Promise.all(faults.map(readWith));
    failed.forEach((got) => expect(got).toMatchObject({ ok: false, error: { _tag: "port", call: "registry" } }));
  });
});
