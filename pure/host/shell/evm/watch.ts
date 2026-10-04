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
import type { PortFault, RegistryRead } from "../submit/chain.ts";
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
 * (`Method not found`, `the method debug_traceTransaction does not exist/is not available` of geth, Erigon and
 * Nethermind, `Unsupported method`, `method not supported`), and Nethermind's answer when the namespace is off, code
 * -32600 with `The method 'debug_traceTransaction' is found but the namespace 'debug' is disabled for <url>` or `... is
 * found in namespace 'debug' for <url>' but is disabled for <endpoint>` (JsonRpcService.cs): a method the endpoint will
 * not run is a missing method. A bare -32600 is not (an invalid request may clear). Nothing else is taken for it: an
 * error that merely says something is not available, too big or timed out may clear, and is the node's fault for the
 * retry budget to bound (a trace the node never gives costs its tries, then the finalize is told unread).
 */
const NO_METHOD = new RegExp(
  [
    "-32601", "\\bmethod not found\\b", "\\bthe method \\S+ does not exist\\b", "\\bunsupported method\\b",
    "\\bmethod not supported\\b", "\\bthe method '[^']*' is found\\b[\\s\\S]*\\bis disabled for\\b",
  ].join("|"),
  "i",
);

/**
 * What a node says of the state of a block it no longer serves, as each client words it: geth's `historical state ...
 * is not available` and the older `missing trie node` (Nethermind says the second too), Erigon's `old data not
 * available due to pruning`, Nethermind's `No state available for block`, Reth's `state at block #N is pruned`. A
 * block the node does not know (`header not found`, `block not found`, `is not currently canonical`) is another
 * thing, a block off the chain, and is a fault of the read, as is any other error, and a reply that is no value.
 */
const PRUNED = new RegExp([
  "\\bmissing trie node\\b", "\\bhistorical state \\S+ is not available\\b",
  "\\bold data not available due to pruning\\b", "\\bNo state available for block\\b",
  "\\bstate at block #\\d+ is pruned\\b",
].join("|"), "i");

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

const CALLS = ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"];
const KINDS = [...CALLS, "CREATE", "CREATE2", "SELFDESTRUCT"];

/** The first transaction of block `at`, if it holds one. */
const txFrom = async (reads: Reads, at: bigint): Promise<Result<Bytes32 | undefined, PortFault>> => {
  const block = await reads.read("watch trace probe", "eth_getBlockByNumber", [hexQuantity(at), false], (raw) =>
    flatMap(fieldsOf(raw), (o) => (Array.isArray(o["transactions"]) ? listOf(o["transactions"], hash32) : ok([]))));
  return map(block, (hashes) => hashes[0]);
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


const isHex = (value: unknown): boolean => isText(value) && /^0x([0-9a-fA-F]{2})+$/.test(value);

/**
 * The top frame of a `callTracer` trace: a call kind, the caller's address and, for the kinds that call, the callee's.
 * A node that traces with another tracer, or not at all, answers otherwise, and a frame made up of any two texts is
 * none.
 */
const isFrame = (raw: unknown): boolean => {
  const fields = fieldsOf(raw);
  if (!fields.ok) return false;
  const { type, from, to } = fields.value;
  const kind = isText(type) ? type.toUpperCase() : "";
  return KINDS.includes(kind) && isHex(from) && (!CALLS.includes(kind) || isHex(to));
};

/**
 * The probe traces the first transaction of block `at` with the tracer the trace of a finalize is read with: a node
 * that runs it answers with the tree of calls, one that does not says the method is missing or answers with something
 * else (any other error is the node's fault). A block with no transaction tells nothing, and no `debug_traceCall`
 * stands in for it: the caller asks again at the next block.
 */
const probeOf = (reads: Reads) => async (at: bigint): Promise<Result<Probe, PortFault>> => {
  const found = await txFrom(reads, at);
  if (!found.ok) return found;
  if (found.value === undefined) return ok("no_transaction");
  const asked = await reads.ask("watch trace probe", "debug_traceTransaction", [found.value, TRACER]);
  if (asked.ok) return ok(isFrame(asked.value) ? "traces" : "none");
  return NO_METHOD.test(asked.error.reason) ? ok("none") : asked;
};

const askLogs = (
  reads: Reads, deployed: Deployed, from: bigint, to: bigint,
): Promise<Result<readonly RawLog[], PortFault>> => {
  const { depository, transformer } = deployed;
  const filter = { address: [depository, transformer], fromBlock: hexQuantity(from), toBlock: hexQuantity(to) };
  const asked = (log: RawLog): boolean =>
    (log.address === depository || log.address === transformer) && log.block >= from && log.block <= to;
  return reads.read("watch logs", "eth_getLogs", [filter], (raw) => flatMap(listOf(raw, rawLogOf), (found) =>
    (found.every(asked)
      ? ok(found)
      : err(bad("a log that is not the one asked for")))));
};

/**
 * The logs of a range. A range the node will not answer (more logs than it returns, a span it refuses) is asked again
 * as its two halves, down to one block: anyone can put thousands of reveals in a few blocks, and a range asked whole
 * at every tick would wedge the watcher for good. A block that fails even alone is the poll's fault, so a dead node
 * costs one call per halving and not one per block.
 */
const logsOf = async (
  reads: Reads, deployed: Deployed, from: bigint, to: bigint,
): Promise<Result<readonly RawLog[], PortFault>> => {
  const whole = await askLogs(reads, deployed, from, to);
  if (whole.ok || from >= to) return whole;
  const middle = from + (to - from) / 2n;
  const head = await logsOf(reads, deployed, from, middle);
  if (!head.ok) return head;
  const tail = await logsOf(reads, deployed, middle + 1n, to);
  return tail.ok ? ok([...head.value, ...tail.value]) : tail;
};

/**
 * The transformer's registry, `hashToTimestamp(hashlock)`, in the state of block `at`: the second a secret was first
 * shown at, 0 if none was (R-REGISTRY-AT-VIEW). The block is named by its number, the view the Entity decides at, which
 * lies `depth` blocks under the head. A node that no longer serves that state says so, and that is an answer about the
 * past (`pruned`); anything else it says, or a reply that is not one word, is the port's fault.
 */
export const registryRead = (rpc: Rpc, deployed: Deployed): RegistryRead => {
  const { depository, transformer } = deployed;
  const reads = readsOf(rpc, { depository });
  return async (hashlock, at) => {
    const key = bytes32(hashlock);
    const data = key.ok ? withArguments("hashToTimestamp(bytes32)", [A.b32(key.value)]) : err(bad("not a hashlock"));
    if (!data.ok) return err(portFault("registry", data.error.why));
    const call = { to: transformer, data: data.value };
    const got = await reads.read("registry", "eth_call", [call, hexQuantity(at)], oneWord);
    return !got.ok && PRUNED.test(got.error.reason) ? ok("pruned") : got;
  };
};

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
    logs: (from, to) => logsOf(reads, deployed, from, to),
    input: (tx) => reads.read("watch tx", "eth_getTransactionByHash", [tx], inputOf(depository)),
    trace: traceOf(reads, depository),
    traced: probeOf(reads),
    accountAt: async (block, left, right): Promise<Result<AccountAt | "pruned", PortFault>> => {
      const calls = accountCalls(left, right);
      if (!calls.ok) return err(portFault("account at", calls.error.why));
      const [row, epoch] = await Promise.all([at(block)(calls.value.row), at(block)(calls.value.epoch)]);
      const gone = [row, epoch].some((r) => !r.ok && PRUNED.test(r.error.reason));
      if (gone) return ok("pruned");
      if (!row.ok) return row;
      if (!epoch.ok) return epoch;
      const read = all({ nonce: nonceOf(row.value), epoch: oneWord(epoch.value) });
      return mapErr(read, (fault) => portFault("account at", fault.why));
    },
  };
};
