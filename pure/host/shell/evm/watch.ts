// The chain as the J loop reads it, over a node's JSON-RPC: the head, a block by number, the Depository's logs in a
// range and an Account's row at the end of a block named by its hash (EIP-1898 with `requireCanonical`, so a block
// that is not on the chain is the node's error, never a reading; R-WATCH-TELL). Nothing here is believed before it is
// checked: a block that is not the one asked for, a log of another contract or outside the range, a reply that is not
// words of the ABI, is a fault the caller reads, never a thrown error.
import { accountKey } from "../../../chain/proof/deployment.ts";
import { address, bytes32, type Address, type Bytes32, type RawLog } from "../../../j/log.ts";
import type { Carried } from "../../../j/calldata/decode.ts";
import type { AccountAt } from "../../../j/observe.ts";
import type { Block } from "../../../j/watch.ts";
import { A } from "../../../kernel/encoding/abi.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { all, err, flatMap, map, mapErr, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { PortFault } from "../submit/chain.ts";
import type { Probe, Traced, WatchPort } from "../watch/loop.ts";
import { bad, hexQuantity, oneWord, quantity, withArguments, wordsOf, type ReplyFault } from "./calls.ts";
import { fieldsOf, isText, listOf, portFault, readsOf, type Fields, type Rpc } from "./port.ts";

const hash32 = (value: unknown): Result<Bytes32, ReplyFault> =>
  (isText(value) ? mapErr(bytes32(value.toLowerCase()), () => bad("not a 32-byte hash")) : err(bad("not a hash")));

const blockOf = (asked: bigint) => (raw: unknown): Result<Block, ReplyFault> =>
  flatMap(fieldsOf(raw), (o) => flatMap(quantity(o["number"]), (number) =>
    (number !== asked ? err(bad(`block ${number}, not ${asked}`)) : map(
      all({ hash: hash32(o["hash"]), parent: hash32(o["parentHash"]), timestamp: quantity(o["timestamp"]) }),
      ({ hash, parent, timestamp }): Block => ({ number, hash, parent, timestamp }),
    ))));

const textsOf = (raw: unknown): Result<readonly Bytes32[], ReplyFault> =>
  (Array.isArray(raw) ? listOf(raw, hash32) : err(bad("topics are not a list")));

const logFields = (o: Fields) => all({
  block: quantity(o["blockNumber"]), blockHash: hash32(o["blockHash"]), index: quantity(o["logIndex"]),
  tx: hash32(o["transactionHash"]),
  topics: textsOf(o["topics"]),
  address: isText(o["address"])
    ? mapErr(address(o["address"].toLowerCase()), () => bad("not an address"))
    : err(bad("no address")),
  data: isText(o["data"]) ? ok(o["data"].toLowerCase()) : err(bad("no data")),
});

const rawLogOf = (raw: unknown): Result<RawLog, ReplyFault> =>
  flatMap(fieldsOf(raw), (o) => map(logFields(o), (log): RawLog => log));

/**
 * The `input` of a transaction as bytes, with how its call reached the Depository (a transaction to it is `direct`,
 * any other, a creation too, is a `wrapper`'s). A transaction the node does not know (it answers null:
 * pruned, or not yet indexed by this backend) is `undefined`, an answer the loop decides on by its age.
 */
const inputOf = (depository: Address) => (raw: unknown): Result<Carried | undefined, ReplyFault> =>
  raw === null ? ok(undefined) : flatMap(fieldsOf(raw), (o) => {
    const input = o["input"];
    const bytes = isText(input) ? hexToBytes(input.toLowerCase()) : undefined;
    const to = o["to"];
    const route = isText(to) && to.toLowerCase() === depository ? "direct" : "wrapper";
    return bytes?.ok === true ? ok({ data: bytes.value, route }) : err(bad("a transaction without input"));
  });

/**
 * The calls of a trace come from the EVM, not from a number chosen here: a transaction holds as many frames as its gas
 * pays for, so none is capped, and a call stack is at most 1024 deep, so a trace deeper than that is no trace of the
 * EVM's. It is walked a level at a time, never recursively.
 */
const MOST_DEPTH = 1025;

type Level = Readonly<{ next: readonly unknown[]; seen: readonly (readonly Fields[])[] }>;

/** The calls under each of these frames, all of them, or why the frames are not a tree of calls. */
const below = (frames: readonly Fields[]): Result<readonly unknown[], ReplyFault> =>
  map(traverse(frames, (frame) => {
    const { calls } = frame;
    if (calls === undefined) return ok([]);
    return Array.isArray(calls) ? ok(calls as readonly unknown[]) : err(bad("the calls of a call are not a list"));
  }), (lists) => lists.flat());

const deeper = (walk: Result<Level, ReplyFault>): Result<Level, ReplyFault> =>
  flatMap(walk, ({ next, seen }) => flatMap(traverse(next, fieldsOf), (frames) =>
    map(below(frames), (calls): Level => ({ next: calls, seen: [...seen, frames] }))));

/** Every frame of a `callTracer` trace, whatever its size, and none for a tree deeper than the EVM goes. */
const framesOf = (raw: unknown): Result<readonly Fields[], ReplyFault> => {
  const start: Result<Level, ReplyFault> = ok({ next: [raw], seen: [] });
  const walked = Array.from({ length: MOST_DEPTH }).reduce<Result<Level, ReplyFault>>(deeper, start);
  return flatMap(walked, ({ next, seen }) =>
    (next.length > 0 ? err(bad("a call trace deeper than the EVM goes")) : ok(seen.flat())));
};

/** The input of each call of the trace whose target is the Depository, each one `direct`. */
const callsOf = (depository: Address) => (raw: unknown): Result<readonly Carried[], ReplyFault> =>
  flatMap(framesOf(raw), (frames) => {
    const ours = frames.filter((n) => isText(n["to"]) && n["to"].toLowerCase() === depository);
    return traverse(ours, (n): Result<Carried, ReplyFault> => {
      const bytes = isText(n["input"]) ? hexToBytes(n["input"].toLowerCase()) : undefined;
      return bytes?.ok === true
        ? ok({ data: bytes.value, route: "direct" })
        : err(bad("a call of the trace without input"));
    });
  });

/**
 * What a node says when it has no such method: JSON-RPC code -32601, or the texts of the clients that give none
 * (`Method not found`, geth's `the method debug_traceTransaction does not exist/is not available`, `Unsupported
 * method`, `method not supported`). Nothing else is taken for it: an error that merely says something is not available,
 * too big or timed out may clear, and is the node's fault for the retry budget to bound (a trace the node never gives
 * costs its tries, then the finalize is told unread).
 */
const NO_METHOD = new RegExp(
  [
    "-32601", "\\bmethod not found\\b", "\\bthe method \\S+ does not exist\\b", "\\bunsupported method\\b",
    "\\bmethod not supported\\b",
  ].join("|"),
  "i",
);

/** `_accounts(bytes)` and `ondeltaEpoch(bytes32,bytes32)`: the two reads the watcher's `reading` is made of. */
const accountCalls = (left: Bytes32, right: Bytes32): Result<Readonly<{ row: string; epoch: string }>, ReplyFault> =>
  flatMap(mapErr(accountKey(left, right), () => bad("not an account key")), (key) =>
    all({
      row: withArguments("_accounts(bytes)", [A.bytes(key)]),
      epoch: withArguments("ondeltaEpoch(bytes32,bytes32)", [A.b32(left), A.b32(right)]),
    }));

/** The first word of the row `_accounts` returns is its `nonce`. */
const nonceOf = (raw: unknown): Result<bigint, ReplyFault> =>
  flatMap(wordsOf(raw), ([nonce]) => (nonce === undefined ? err(bad("an empty Account row")) : ok(nonce)));

const TRACER = { tracer: "callTracer" };

type Reads = ReturnType<typeof readsOf>;

/** The blocks at the head that the probe looks through for a transaction to trace. */
const PROBE_BLOCKS = 16n;

/** The first transaction of the newest of `left` blocks, from block `at` down, that holds one, if any does. */
const txFrom = async (
  reads: Reads, at: bigint, left: bigint,
): Promise<Result<Bytes32 | undefined, PortFault>> => {
  if (left === 0n || at < 0n) return ok(undefined);
  const block = await reads.read("watch trace probe", "eth_getBlockByNumber", [hexQuantity(at), false], (raw) =>
    flatMap(fieldsOf(raw), (o) => (Array.isArray(o["transactions"]) ? listOf(o["transactions"], hash32) : ok([]))));
  if (!block.ok) return block;
  return block.value[0] === undefined ? txFrom(reads, at - 1n, left - 1n) : ok(block.value[0]);
};

const recentTx = async (reads: Reads): Promise<Result<Bytes32 | undefined, PortFault>> => {
  const head = await reads.read("watch trace probe", "eth_blockNumber", [], quantity);
  return head.ok ? txFrom(reads, head.value, PROBE_BLOCKS) : head;
};

/**
 * What the node's call trace says of a transaction. A fault of the node (it is down, it errs, it is too busy or the
 * trace too big for it) may clear and holds back the transaction's Account, which the Host's patience bounds; a trace
 * the transaction itself makes unreadable (too deep, not a tree) never clears: no trace, and a finalize is told unread,
 * so one counterparty's transaction cannot blind the watcher; and a node with no such method says so, which a node
 * that may hold value does not go on without.
 */
const traceOf = (reads: Reads, depository: Address) =>
  async (tx: Bytes32): Promise<Result<Traced, PortFault>> => {
    const asked = await reads.ask("watch trace", "debug_traceTransaction", [tx, TRACER]);
    if (!asked.ok) return NO_METHOD.test(asked.error.reason) ? ok({ _tag: "no_method" }) : asked;
    const calls = callsOf(depository)(asked.value);
    return ok(calls.ok ? { _tag: "calls", calls: calls.value } : { _tag: "unreadable" });
  };

/** The top frame of a `callTracer` trace: a node that traces with another tracer, or not at all, answers otherwise. */
const isFrame = (raw: unknown): boolean => {
  const fields = fieldsOf(raw);
  return fields.ok && isText(fields.value["type"]) && isText(fields.value["from"]);
};

/**
 * The probe traces a transaction a recent block holds, with the tracer the trace of a finalize is read with: a node
 * that runs it answers with the tree of calls, one that does not says the method is missing or answers with something
 * else (any other error is the node's fault). On a fork the transaction must be one mined after the fork point, which
 * the head's own blocks hold. With no transaction in them nothing is known yet: there is no call that stands for one.
 */
const probeOf = (reads: Reads) => async (): Promise<Result<Probe, PortFault>> => {
  const found = await recentTx(reads);
  if (!found.ok) return found;
  if (found.value === undefined) return ok("no_transaction");
  const asked = await reads.ask("watch trace probe", "debug_traceTransaction", [found.value, TRACER]);
  if (asked.ok) return ok(isFrame(asked.value) ? "traces" : "none");
  return NO_METHOD.test(asked.error.reason) ? ok("none") : asked;
};

export const watchPort = (rpc: Rpc, depository: Address): WatchPort => {
  const reads = readsOf(rpc, { depository });
  const at = (block: Bytes32) => (data: string) =>
    reads.read(
      "account at", "eth_call", [{ to: depository, data }, { blockHash: block, requireCanonical: true }],
      (raw) => ok(raw),
    );
  return {
    head: () => reads.read("watch head", "eth_blockNumber", [], quantity),
    block: (number) => reads.read("watch block", "eth_getBlockByNumber", [hexQuantity(number), false], blockOf(number)),
    logs: (from, to) => {
      const filter = { address: depository, fromBlock: hexQuantity(from), toBlock: hexQuantity(to) };
      return reads.read("watch logs", "eth_getLogs", [filter], (raw) => flatMap(listOf(raw, rawLogOf), (found) =>
        (found.every((log) => log.address === depository && log.block >= from && log.block <= to)
          ? ok(found)
          : err(bad("a log that is not the one asked for")))));
    },
    input: (tx) => reads.read("watch tx", "eth_getTransactionByHash", [tx], inputOf(depository)),
    trace: traceOf(reads, depository),
    traced: probeOf(reads),
    accountAt: async (block, left, right): Promise<Result<AccountAt, PortFault>> => {
      const calls = accountCalls(left, right);
      if (!calls.ok) return err(portFault("account at", calls.error.why));
      const [row, epoch] = await Promise.all([at(block)(calls.value.row), at(block)(calls.value.epoch)]);
      if (!row.ok) return row;
      if (!epoch.ok) return epoch;
      const read = all({ nonce: nonceOf(row.value), epoch: oneWord(epoch.value) });
      return mapErr(read, (fault) => portFault("account at", fault.why));
    },
  };
};
