// The J loop in memory, against anvil: fetch the blocks and the Depository's logs after the cursor, let the watcher core
// (pure/j/watch.ts: prepare, readings, advance) check and read them, answer its readings by block hash, hand the
// Runtimes the J events and then the height, and keep the cursor the delivery ended at. The transport thread's Host
// loop is the real one (gap `j-loop`); the cursor here lives in memory, so it never needs the "move it only after the
// j_height row is committed" rule.
import { jHeight } from "../../pure/account/clause/clock.ts";
import { entityId } from "../../pure/entity/model.ts";
import { address, bytes32, type Bytes32, type RawLog } from "../../pure/j/log.ts";
import { readingKey, type AccountAt } from "../../pure/j/observe.ts";
import { advance, finalizedAt, prepare, readings, watching, type Block, type Watch } from "../../pure/j/watch.ts";
import { accountKeyOf, must, type Chain, type Party } from "./chain.ts";
import type { Net } from "./net.ts";

const DEPTH = 1n;

const blockAt = async (chain: Chain, number: bigint): Promise<Block> => {
  const b = await chain.provider.getBlock(Number(number));
  if (b === null || b.hash === null) throw new Error(`the node has no block ${number}`);
  const parent = await chain.provider.getBlock(Number(number) - 1);
  if (parent === null || parent.hash === null) throw new Error(`the node has no block ${number - 1n}`);
  return { number, hash: must(bytes32(b.hash), "block hash"), parent: must(bytes32(parent.hash), "parent hash") };
};

export type Delivery = Readonly<{ events: readonly string[]; height: bigint }>;

export class JLoop {
  private constructor(private watch: Watch, private readonly chain: Chain, private readonly parties: readonly Party[]) {}

  /** Start at the block the chain is at: everything before it is final and already known to the harness. */
  static async at(chain: Chain, parties: readonly Party[]): Promise<JLoop> {
    const from = await blockAt(chain, BigInt(await chain.provider.getBlockNumber()));
    const depository = must(address(chain.manifest.contracts.depository.address.toLowerCase()), "depository address");
    return new JLoop(must(watching(depository, DEPTH, from), "watch"), chain, parties);
  }

  private async rawLogs(from: bigint, to: bigint): Promise<readonly RawLog[]> {
    if (to < from) return [];
    const logs = await this.chain.provider.getLogs({ address: this.chain.manifest.contracts.depository.address, fromBlock: from, toBlock: to });
    return logs.map((l) => ({
      block: BigInt(l.blockNumber), blockHash: must(bytes32(l.blockHash), "log block hash"), index: BigInt(l.index),
      address: must(address(l.address.toLowerCase()), "log address"), topics: l.topics.map((t) => must(bytes32(t.toLowerCase()), "topic")),
      data: l.data.toLowerCase(),
    }));
  }

  /** The chain's Account row at the end of a block, by block hash: the reading the watcher asks for. */
  private async accountAt(blockHash: Bytes32, left: Party, right: Party): Promise<AccountAt> {
    const d = this.chain.depository;
    const call = async (data: string): Promise<string> =>
      (await this.chain.provider.send("eth_call", [{ to: this.chain.manifest.contracts.depository.address, data }, { blockHash, requireCanonical: true }])) as string;
    const row = d.interface.decodeFunctionResult("_accounts", await call(d.interface.encodeFunctionData("_accounts", [accountKeyOf(left, right)])));
    const epoch = d.interface.decodeFunctionResult("ondeltaEpoch", await call(d.interface.encodeFunctionData("ondeltaEpoch", [left.id, right.id])));
    return { epoch: BigInt(epoch[0]), nonce: BigInt(row.nonce ?? row[0]) };
  }

  /**
   * One poll: deliver what is final to the Runtimes of `net`. Events first, then the height (R-HEIGHT-ORDER). Returns
   * the names of the J events delivered and the height the delivery ended at.
   */
  async poll(net: Net): Promise<Delivery> {
    const head = BigInt(await this.chain.provider.getBlockNumber());
    const to = finalizedAt(DEPTH, head);
    const blocks = await Promise.all(Array.from({ length: Number(to - this.watch.applied.number) }, (_, i) => blockAt(this.chain, this.watch.applied.number + 1n + BigInt(i))));
    const prepared = must(prepare(this.watch, { head, blocks, logs: await this.rawLogs(this.watch.applied.number + 1n, to) }), "the watcher refused the batch");
    const hosted = this.parties.map((p) => must(bytes32(p.id.toLowerCase()), "entity id"));
    const byId = new Map(this.parties.map((p) => [p.id.toLowerCase(), p]));
    const answers = new Map<string, AccountAt>(await Promise.all(readings(prepared, hosted).map(async (r): Promise<[string, AccountAt]> => {
      const [l, rr] = [byId.get(r.left), byId.get(r.right)];
      if (l === undefined || rr === undefined) throw new Error("a reading names an entity the harness does not know");
      return [readingKey(r), await this.accountAt(r.blockHash, l, rr)];
    })));
    const step = must(advance(this.watch, prepared, hosted, answers), "the watcher could not deliver");
    step.events.forEach(({ to: who, event }) => {
      const peer = must(entityId(event.peer), "peer id");
      net.tell(must(entityId(who), "entity id"), { ...event, peer });
    });
    net.settle();
    net.rise(must(jHeight(step.height), "height"));
    this.watch = step.watch;
    return { events: step.events.map(({ to: who, event }) => `${byId.get(who)?.name ?? who} ${event._tag}`), height: step.height };
  }
}
