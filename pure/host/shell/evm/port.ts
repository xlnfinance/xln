// The chain port over a node's JSON-RPC: the five things the submit path asks of the chain (R-SIMULATE, R-DURABLE),
// each one read or one transaction. The port holds no state: what the chain says now is what it answers. It signs
// nothing but the transaction that carries a batch, with the key that also signs the batch's Hanko.
//
// A node's reply is text from outside: every field is checked before it is believed, and a reply that is not what the
// contract's ABI says is a fault the caller can read, never a thrown error.
import type { EntityId } from "../../../entity/model.ts";
import type { JAnswer, SkipFact } from "../../../j/batch/answer.ts";
import type { SealedBatch } from "../../../j/batch/sealed.ts";
import type { Cause, Simulation } from "../../../j/gas/simulate.ts";
import type { Treasury } from "../../../j/plan/funded.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { all, err, flatMap, map, mapErr, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Key } from "../link/link.ts";
import type { ChainPort, PortFault } from "../submit/chain.ts";
import {
  bad, BATCH_FAILED, debtOutstandingCall, DISPUTE_SKIPPED, entityNoncesCall, errorNamed, fourBytes, HANKO_PROCESSED,
  hexQuantity, oneWord, processBatchData, quantity, reservesCall, topicNumber, wide, wordsOf, type ReplyFault,
} from "./calls.ts";
import { rawTx } from "./tx.ts";

export type RpcFault = Tagged<"rpc", { reason: string }>;

/** One JSON-RPC call: the node's `result`, or why there is none. The http adapter is node/rpc.ts. */
export type Rpc = (method: string, params: readonly unknown[]) => Promise<Result<unknown, RpcFault>>;

export type PortConfig = Readonly<{
  /** The Depository's address. */
  depository: string;
  entity: EntityId;
  chainId: bigint;
  /** Signs the transaction; its address is the sender. */
  key: Key;
  /** The internal token ids whose reserve and debt the funded check reads. */
  tokens: readonly bigint[];
  /** No batch of ours landed in a block before this one: where a search of the logs starts. */
  from: bigint;
  /** A batch is answered only by a log this many blocks below the head (D9, R-WATCH-DEPTH); 0 on a local node. */
  depth: bigint;
}>;

export const portFault = (call: string, reason: string): PortFault => ({ _tag: "port", call, reason });

export type Fields = Readonly<Record<string, unknown>>;

export const fieldsOf = (raw: unknown): Result<Fields, ReplyFault> =>
  (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? ok(raw as Fields) : err(bad("not an object")));

export const isText = (v: unknown): v is string => typeof v === "string";

const textsOf = (raw: unknown): Result<readonly string[], ReplyFault> =>
  (Array.isArray(raw) && raw.every(isText) ? ok(raw) : err(bad("not a list of text")));

type Log = Readonly<{ address: string; topics: readonly string[]; data: string }>;
type Placed = Log & Readonly<{ transaction: string; block: bigint }>;

const logOf = (raw: unknown): Result<Log, ReplyFault> =>
  flatMap(fieldsOf(raw), (o) => flatMap(textsOf(o["topics"]), (topics) => {
    const { address, data } = o;
    return isText(address) && isText(data) ? ok({ address, topics, data }) : err(bad("a log without address or data"));
  }));

const placedOf = (raw: unknown): Result<Placed, ReplyFault> =>
  flatMap(logOf(raw), (log) => flatMap(fieldsOf(raw), (o) => flatMap(quantity(o["blockNumber"]), (block) => {
    const transaction = o["transactionHash"];
    return isText(transaction) ? ok({ ...log, transaction, block }) : err(bad("a log without its transaction"));
  })));

export const listOf = <T>(
  raw: unknown, read: (item: unknown) => Result<T, ReplyFault>,
): Result<readonly T[], ReplyFault> => (Array.isArray(raw) ? traverse(raw, read) : err(bad("not a list")));

/** What the simulation said of the one call: its status, gas used, logs, why it failed, and what it returned. */
type Ran = Readonly<{ status: bigint; gas: bigint; logs: readonly Log[]; why: string; data: string }>;

const failureOf = (o: Fields): string => {
  const message = fieldsOf(o["error"]);
  return message.ok && isText(message.value["message"]) ? message.value["message"] : "the transaction reverted";
};

const ranOf = (raw: unknown): Result<Ran, ReplyFault> => {
  const calls = flatMap(listOf(raw, fieldsOf), ([block]) =>
    (block === undefined ? err(bad("no block")) : listOf(block["calls"], fieldsOf)));
  return flatMap(calls, ([call]) => {
    if (call === undefined) return err(bad("no call"));
    return flatMap(quantity(call["status"]), (status) => flatMap(quantity(call["gasUsed"]), (gas) =>
      map(listOf(call["logs"], logOf), (logs) => ({
        status, gas, logs, why: failureOf(call), data: isText(call["returnData"]) ? call["returnData"] : "0x",
      }))));
  });
};

const REFUSED: ReadonlyMap<string, string> =
  new Map([[BATCH_FAILED, "BatchFailed"], [DISPUTE_SKIPPED, "DisputeOpSkipped"]]);

/**
 * What the chain said of why the batch did not apply, as far as the Host can read it: the error a reverted call
 * returned (its first four bytes), the error a failed batch reports, and each dispute op the batch skipped. A reply it
 * cannot read adds no cause, so a cause is never guessed.
 */
const causesOf = (ran: Ran, depository: string): readonly Cause[] => {
  const ours = ran.logs.filter((log) => log.address.toLowerCase() === depository.toLowerCase());
  const failed = ours.filter((log) => log.topics[0] === BATCH_FAILED).flatMap((log): Cause[] => {
    const named = fourBytes(log.data);
    return named.ok ? [{ _tag: "error", name: errorNamed(named.value) }] : [];
  });
  const skipped = ours.filter((log) => log.topics[0] === DISPUTE_SKIPPED).flatMap((log): Cause[] => {
    const fact = skipOf(log);
    return fact.ok ? [{ _tag: "skipped", op: fact.value.op, reason: fact.value.reason }] : [];
  });
  const reverted: Cause[] = ran.status === 1n || !/^0x[0-9a-fA-F]{8}/.test(ran.data)
    ? []
    : [{ _tag: "error", name: errorNamed(ran.data.slice(0, 10)) }];
  return [...reverted, ...failed, ...skipped];
};

/** A batch that does not fully apply is refused, whatever the transaction's own status says (the harness's rule). */
const outcomeOf = (ran: Ran, depository: string): Simulation["outcome"] => {
  const refusals = ran.logs
    .filter((log) => log.address.toLowerCase() === depository.toLowerCase())
    .flatMap((log) => REFUSED.get(log.topics[0] ?? "") ?? []);
  return ran.status === 1n && refusals.length === 0
    ? { _tag: "ok", applyGas: ran.gas }
    : { _tag: "reverts", reason: refusals.join(", ") || ran.why, causes: causesOf(ran, depository) };
};

/** The words of a `DisputeOpSkipped` data: op, reason and the nonce of the proof. */
const skipOf = (log: Log): Result<SkipFact, ReplyFault> =>
  flatMap(wordsOf(log.data), ([op, reason, nonce]) => {
    const counter = log.topics[2];
    return op === undefined || reason === undefined || nonce === undefined || counter === undefined
      ? err(bad("a skip without its fields"))
      : ok({ op: Number(op), counterentity: counter, reason: Number(reason), nonce });
  });

type Reply<T> = Result<T, ReplyFault>;

/** What the port asks of the node, and how each kind of answer is read: every fault names the call that met it. */
export type Reads = Readonly<{
  ask: (call: string, method: string, params: readonly unknown[]) => Promise<Result<unknown, PortFault>>;
  read: <T>(
    call: string, method: string, params: readonly unknown[], parse: (raw: unknown) => Reply<T>,
  ) => Promise<Result<T, PortFault>>;
  view: <T>(call: string, data: Reply<string>, parse: (raw: unknown) => Reply<T>) => Promise<Result<T, PortFault>>;
  logs: (
    call: string, topics: readonly string[], from: bigint, to: bigint,
  ) => Promise<Result<readonly Placed[], PortFault>>;
}>;

export const readsOf = (rpc: Rpc, cfg: Pick<PortConfig, "depository">): Reads => {
  const ask: Reads["ask"] = async (call, method, params) =>
    mapErr(await rpc(method, params), (fault) => portFault(call, fault.reason));
  const read: Reads["read"] = async (call, method, params, parse) => {
    const got = await ask(call, method, params);
    return got.ok ? mapErr(parse(got.value), (fault) => portFault(call, fault.why)) : got;
  };
  const view: Reads["view"] = (call, data, parse) =>
    (data.ok
      ? read(call, "eth_call", [{ to: cfg.depository, data: data.value }, "latest"], parse)
      : Promise.resolve(err(portFault(call, data.error.why))));
  const logs: Reads["logs"] = (call, topics, from, to) => {
    const filter = { address: cfg.depository, fromBlock: hexQuantity(from), toBlock: hexQuantity(to), topics };
    const asked = (log: Placed): boolean =>
      log.address.toLowerCase() === cfg.depository.toLowerCase()
      && log.block >= from && log.block <= to
      && topics.every((topic, i) => log.topics[i]?.toLowerCase() === topic.toLowerCase());
    return read(call, "eth_getLogs", [filter], (raw) =>
      flatMap(listOf(raw, placedOf), (found) =>
        (found.every(asked) ? ok(found) : err(bad("a log that is not the one asked for")))));
  };
  return { ask, read, view, logs };
};

const treasuryOf = (reads: Reads, cfg: PortConfig): ChainPort["treasury"] => async () => {
  const heldOf = async (token: bigint) => {
    const reserve = await reads.view("reserves", reservesCall(cfg.entity, token), oneWord);
    const debt = await reads.view("debts", debtOutstandingCall(cfg.entity, token), wide);
    return flatMap(reserve, (r) => map(debt, (d) => [token, { reserve: r, debt: d }] as const));
  };
  const held = await Promise.all(cfg.tokens.map(heldOf));
  return map(traverse(held, (h) => h), (entries): Treasury => new Map(entries));
};

const simulateOf = (reads: Reads, cfg: PortConfig): ChainPort["simulate"] => async (call, gasLimit) => {
  const data = processBatchData(call);
  if (!data.ok) return err(portFault("simulate", data.error.why));
  const request = { from: cfg.key.runtime, to: cfg.depository, gas: hexQuantity(gasLimit), data: data.value };
  const ran = await reads.read("simulate", "eth_simulateV1",
    [{ blockStateCalls: [{ calls: [request] }], validation: false }, "latest"], ranOf);
  return map(ran, (r) => outcomeOf(r, cfg.depository));
};

const sendOf = (reads: Reads, cfg: PortConfig): ChainPort["send"] => async (call, gasLimit) => {
  const data = processBatchData(call);
  if (!data.ok) return err(portFault("send", data.error.why));
  const sender = cfg.key.runtime;
  const fees = all({
    nonce: await reads.read("send nonce", "eth_getTransactionCount", [sender, "pending"], quantity),
    base: await reads.read("send fee", "eth_getBlockByNumber", ["latest", false], (raw) =>
      flatMap(fieldsOf(raw), (block) => quantity(block["baseFeePerGas"]))),
    tip: await reads.read("send tip", "eth_maxPriorityFeePerGas", [], quantity),
  });
  if (!fees.ok) return fees;
  const { nonce, base, tip } = fees.value;
  const raw = rawTx({
    chainId: cfg.chainId, nonce, tip, maxFee: 2n * base + tip, gas: gasLimit, to: cfg.depository, data: data.value,
  }, cfg.key.secret);
  if (!raw.ok) return err(portFault("send", raw.error._tag));
  const sent = await reads.ask("send", "eth_sendRawTransaction", [raw.value]);
  if (!sent.ok) return sent;
  return isText(sent.value) ? ok(sent.value) : err(portFault("send", "the node returned no transaction hash"));
};

const skipsOf = async (
  reads: Reads, cfg: PortConfig, landed: Placed,
): Promise<Result<readonly SkipFact[], PortFault>> => {
  const found = await reads.logs("skips", [DISPUTE_SKIPPED, cfg.entity], landed.block, landed.block);
  return flatMap(found, (all) => mapErr(
    traverse(all.filter((log) => log.transaction === landed.transaction), skipOf),
    (fault) => portFault("skips", fault.why),
  ));
};

type Mined = Readonly<{ status: bigint; block: bigint }>;

const minedOf = (raw: unknown): Result<Mined | undefined, ReplyFault> =>
  (raw === null
    ? ok(undefined)
    : flatMap(fieldsOf(raw), (fields) => flatMap(quantity(fields["status"]), (status) =>
      map(quantity(fields["blockNumber"]), (block) => ({ status, block })))));

/**
 * A mined transaction that reverted as a whole emitted neither event, and the entity nonce was not spent.
 * The same sealed batch can still land. No receipt, one above the depth, or a successful one, is not this.
 */
const wholeRevert = async (
  reads: Reads, batch: SealedBatch, tx: string | undefined, settled: bigint,
): Promise<Result<JAnswer | undefined, PortFault>> => {
  if (tx === undefined) return ok(undefined);
  const mined = await reads.read("answer receipt", "eth_getTransactionReceipt", [tx], minedOf);
  if (!mined.ok) return mined;
  const receipt = mined.value;
  if (receipt === undefined || receipt.block > settled || receipt.status !== 0n) return ok(undefined);
  return ok({ _tag: "reverted", nonce: batch.nonce });
};

const answerOf = (reads: Reads, cfg: PortConfig): ChainPort["answer"] => async (batch, tx) => {
  const head = await reads.read("answer head", "eth_blockNumber", [], quantity);
  if (!head.ok) return head;
  const settled = head.value - cfg.depth;
  if (settled < cfg.from) return ok(undefined);
  const ours = [HANKO_PROCESSED, cfg.entity, batch.digest.toLowerCase()];
  const landed = await reads.logs("answer", ours, cfg.from, settled);
  if (!landed.ok) return landed;
  const [first] = landed.value;
  if (first !== undefined) {
    return map(await skipsOf(reads, cfg, first), (skipped): JAnswer =>
      ({ _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped }));
  }
  const failed = await reads.logs("answer", [BATCH_FAILED, cfg.entity, topicNumber(batch.nonce)], cfg.from, settled);
  if (!failed.ok) return failed;
  const [refusal] = failed.value;
  if (refusal === undefined) return wholeRevert(reads, batch, tx, settled);
  return map(mapErr(fourBytes(refusal.data), (fault) => portFault("answer", fault.why)), (reason): JAnswer =>
    ({ _tag: "failed", nonce: batch.nonce, reason }));
};

export const chainPort = (rpc: Rpc, cfg: PortConfig): ChainPort => {
  const reads = readsOf(rpc, cfg);
  return {
    nonce: () => reads.view("nonce", entityNoncesCall(cfg.entity), oneWord),
    treasury: treasuryOf(reads, cfg),
    simulate: simulateOf(reads, cfg),
    send: sendOf(reads, cfg),
    answer: answerOf(reads, cfg),
  };
};
