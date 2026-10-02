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
import { all, err, flatMap, map, mapErr, ok, type Result } from "../../../kernel/core/result.ts";
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
  topics: textsOf(o["topics"]),
  address: isText(o["address"])
    ? mapErr(address(o["address"].toLowerCase()), () => bad("not an address"))
    : err(bad("no address")),
  data: isText(o["data"]) ? ok(o["data"].toLowerCase()) : err(bad("no data")),
});

const rawLogOf = (raw: unknown): Result<RawLog, ReplyFault> =>
  flatMap(fieldsOf(raw), (o) => map(logFields(o), (log): RawLog => log));

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
