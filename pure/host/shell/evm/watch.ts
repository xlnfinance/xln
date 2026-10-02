// The chain as the J loop reads it, over a node's JSON-RPC: the head, a block by number, the Depository's logs in a
// range and an Account's row at the end of a block named by its hash (EIP-1898 with `requireCanonical`, so a block
// that is not on the chain is the node's error, never a reading; R-WATCH-TELL). Nothing here is believed before it is
// checked: a block that is not the one asked for, a log of another contract or outside the range, a reply that is not
// words of the ABI, is a fault the caller reads, never a thrown error.
import { accountKey } from "../../../chain/proof/deployment.ts";
import { address, bytes32, type Address, type Bytes32, type Deployed, type RawLog } from "../../../j/log.ts";
import type { Carried } from "../../../j/calldata/decode.ts";
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
 * What a node says of a trace it does not give: the method is missing (JSON-RPC code -32601, or text saying it is
 * unsupported or not available) or the provider refuses or cuts the trace (too big for its limits). Neither is a fault
 * of the call that a retry would clear, so the port says there is no trace.
 */
const NO_METHOD = new RegExp(
  "-32601|\\bunsupported\\b|\\bmethod\\b.*\\b(not found|does not exist|not available|not supported)\\b|is not available"
  + "|\\b(response|result|trace)\\b.*\\b(too (big|large)|exceed|limit)|\\btracing\\b.*\\b(disabled|not enabled)",
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

export const watchPort = (rpc: Rpc, deployed: Deployed): WatchPort => {
  const { depository, transformer } = deployed;
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
      const filter = { address: [depository, transformer], fromBlock: hexQuantity(from), toBlock: hexQuantity(to) };
      const asked = (log: RawLog): boolean =>
        (log.address === depository || log.address === transformer) && log.block >= from && log.block <= to;
      return reads.read("watch logs", "eth_getLogs", [filter], (raw) => flatMap(listOf(raw, rawLogOf), (found) =>
        (found.every(asked)
          ? ok(found)
          : err(bad("a log that is not the one asked for")))));
    },
    input: (tx) => reads.read("watch tx", "eth_getTransactionByHash", [tx], inputOf(depository)),
    // A fault of the node (it is down, it errs) may clear and stalls the delivery; a node with no call trace, or a
    // trace the transaction itself makes unreadable (too big, too deep, not a tree), never clears: no trace, and the
    // finalize is told unread, so one counterparty's transaction cannot blind the watcher.
    trace: async (tx) => {
      const asked = await reads.ask("watch trace", "debug_traceTransaction", [tx, { tracer: "callTracer" }]);
      if (!asked.ok) return NO_METHOD.test(asked.error.reason) ? ok(undefined) : asked;
      const calls = callsOf(depository)(asked.value);
      return ok(calls.ok ? calls.value : undefined);
    },
    // The probe traces a call of the Depository at the head (`debug_traceCall`, of the same namespace and tracer as the
    // trace of a transaction, and needing no transaction: on a fork a transaction of the fork's past is the upstream's
    // to trace). A node that runs it answers with the frame, one that does not says the method is missing, and any
    // other answer is the node's fault.
    traced: async () => {
      const call = { to: depository, data: "0x" };
      const asked = await reads.ask("watch trace probe", "debug_traceCall", [call, "latest", { tracer: "callTracer" }]);
      if (asked.ok) return ok(true);
      return NO_METHOD.test(asked.error.reason) ? ok(false) : asked;
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
