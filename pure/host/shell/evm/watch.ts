// The chain as the J loop reads it, over a node's JSON-RPC: the head, a block by number, the Depository's logs in a
// range and an Account's row at the end of a block named by its hash (EIP-1898 with `requireCanonical`, so a block
// that is not on the chain is the node's error, never a reading; R-WATCH-TELL). Nothing here is believed before it is
// checked: a block that is not the one asked for, a log of another contract or outside the range, a reply that is not
// words of the ABI, is a fault the caller reads, never a thrown error.
import { accountKey } from "../../../chain/proof/deployment.ts";
import { address, bytes32, type Address, type Bytes32, type RawLog } from "../../../j/log.ts";
import type { AccountAt } from "../../../j/observe.ts";
import type { Block } from "../../../j/watch.ts";
import { A } from "../../../kernel/encoding/abi.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { all, err, flatMap, map, mapErr, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { PortFault } from "../submit/chain.ts";
import type { WatchPort } from "../watch/loop.ts";
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
 * The `input` of a transaction: the calldata of the call, as bytes. A transaction the node does not know (it answers
 * null: pruned, or not yet indexed by this backend) is `undefined`, an answer the loop decides on by its age.
 */
const inputOf = (raw: unknown): Result<Uint8Array | undefined, ReplyFault> =>
  raw === null ? ok(undefined) : flatMap(fieldsOf(raw), (o) => {
    const input = o["input"];
    const bytes = isText(input) ? hexToBytes(input.toLowerCase()) : undefined;
    return bytes?.ok === true ? ok(bytes.value) : err(bad("a transaction without input"));
  });

/** The most calls, and the deepest nesting, of a trace the port reads: a bigger one is a fault, never a part. */
const MOST_CALLS = 4096;
const MOST_DEPTH = 64;

/** A call of a `callTracer` trace is `{ to, input, calls? }`: it and everything below it, in the order walked. */
const nodesOf = (raw: unknown, depth: number): Result<readonly Fields[], ReplyFault> =>
  (depth > MOST_DEPTH
    ? err(bad("a call trace too deep to read"))
    : flatMap(fieldsOf(raw), (node) => {
      const { calls } = node;
      if (calls === undefined) return ok([node]);
      return Array.isArray(calls)
        ? map(traverse(calls, (call) => nodesOf(call, depth + 1)), (below) => [node, ...below.flat()])
        : err(bad("the calls of a call are not a list"));
    }));

/** The input of each call of the trace whose target is the Depository. A trace too big to read is a fault. */
const callsOf = (depository: Address) => (raw: unknown): Result<readonly Uint8Array[], ReplyFault> =>
  flatMap(nodesOf(raw, 0), (nodes) =>
    (nodes.length > MOST_CALLS
      ? err(bad("a call trace too big to read"))
      : traverse(nodes.filter((n) => isText(n["to"]) && n["to"].toLowerCase() === depository), (n) => {
        const bytes = isText(n["input"]) ? hexToBytes(n["input"].toLowerCase()) : undefined;
        return bytes?.ok === true ? ok(bytes.value) : err(bad("a call of the trace without input"));
      })));

/** What a node says of a method it does not run: the one answer that is no fault of the call (the port says none). */
const NO_METHOD =
  /\bmethod\b.*\b(not found|does not exist|not available|not supported)\b|does not exist\/is not available/i;

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
    input: (tx) => reads.read("watch tx", "eth_getTransactionByHash", [tx], inputOf),
    trace: async (tx) => {
      const traced = await reads.read("watch trace", "debug_traceTransaction", [tx, { tracer: "callTracer" }],
        callsOf(depository));
      return traced.ok || !NO_METHOD.test(traced.error.reason) ? traced : ok(undefined);
    },
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
