// The parties as nodes of the rewrite's own Host shell (pure/host/shell/node/daemon.ts): each has its WAL and journal on
// real files, its key, a chain port to the node over JSON-RPC, a listening port on loopback and a static table of the
// peers it has an Account with. They talk over real sockets, authenticated by the link (R-LINK-AUTH); the harness only
// tells a node what its party commands, hands each the J heights, waits until the nodes are quiet, and reads what each
// holds. The reads are snapshots, refreshed by every call that waits.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JView } from "../../pure/account/clause/clock.ts";
import { entityId, type EntityId, type EntityInput, type EntityReplica, type EntityState, type JAction, type Outbound } from "../../pure/entity/model.ts";
import { watchPort } from "../../pure/host/shell/evm/watch.ts";
import { startDaemon, type Config, type Daemon, type Look } from "../../pure/host/shell/node/daemon.ts";
import { httpRpc } from "../../pure/host/shell/node/rpc.ts";
import { listenTcp, type Listener } from "../../pure/host/shell/node/link/socket.ts";
import { keyOf, MAX_LINE, type Peer } from "../../pure/host/shell/link/link.ts";
import type { Turn } from "../../pure/host/shell/drive/drive.ts";
import { address, bytes32 } from "../../pure/j/log.ts";
import { hexToBytes } from "../../pure/kernel/encoding/bytes.ts";
import type { Row, Setup } from "../../pure/runtime/model.ts";
import { must, type Chain, type Party } from "./chain.ts";
import { rigOf } from "./seat.ts";

const LOCAL = "127.0.0.1";
const TICK_MS = 50;
const POLL_MS = 25;
const STABLE = 3;
const PATIENCE_MS = 60_000;
/** Blocks a J event waits under before the nodes act on it: the anvil node has no reorgs, one is enough to show the rule. */
const DEPTH = 1n;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
export const shown = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? "bytes" : v));
const eid = (p: Party): EntityId => must(entityId(p.id), `entity id of ${p.name}`);

/** A party and the parties it has an Account with: who it dials and answers. */
export type Member = Readonly<{ party: Party; peers: readonly Party[] }>;

type Slot = { readonly member: Member; readonly entity: EntityId; readonly dir: string; readonly from: bigint; port: number; daemon: Daemon };

export type Quiet = Readonly<{ pending?: boolean }>;

const KEEP = (): boolean => false;

export class Cluster {
  private readonly snaps = new Map<EntityId, Look>();
  private loss: (message: Outbound) => boolean = KEEP;

  private constructor(private readonly chain: Chain, private readonly setup: Setup, private readonly slots: ReadonlyMap<EntityId, Slot>) {}

  /** The nodes of `members`, started over fresh files under a new directory and connected to the peers each names. */
  static async open(chain: Chain, setup: Setup, members: readonly Member[]): Promise<Cluster> {
    const root = mkdtempSync(join(tmpdir(), "xln-e2e-nodes-"));
    const from = BigInt(await chain.provider.getBlockNumber());
    const listeners = await Promise.all(members.map(async () => must(await listenTcp(LOCAL, 0, MAX_LINE), "listen")));
    const slots = new Map(members.map((member, i): [EntityId, Slot] => [eid(member.party), {
      member, entity: eid(member.party), dir: join(root, member.party.name), from, port: listeners[i]!.port, daemon: undefined as unknown as Daemon,
    }]));
    const cluster = new Cluster(chain, setup, slots);
    await Promise.all(members.map(async (member, i) => { slots.get(eid(member.party))!.daemon = await cluster.launch(slots.get(eid(member.party))!, listeners[i]!); }));
    await cluster.connected();
    return cluster;
  }

  private slot(id: EntityId): Slot {
    const slot = this.slots.get(id);
    if (slot === undefined) throw new Error(`no node ${id}`);
    return slot;
  }

  private peerOf(party: Party): Peer {
    const slot = this.slot(eid(party));
    const key = must(keyOf(must(hexToBytes(party.key), "key bytes")), `${party.name}'s key`);
    return { runtime: key.runtime, entities: [slot.entity], endpoint: `${LOCAL}:${slot.port}` };
  }

  private async launch(slot: Slot, listener: Listener): Promise<Daemon> {
    const { party, peers } = slot.member;
    const rig = await rigOf(this.chain, party, slot.entity, this.setup, slot.dir, slot.from);
    const depository = must(address(this.chain.manifest.contracts.depository.address.toLowerCase()), "depository address");
    const watch = { port: watchPort(httpRpc(this.chain.rpc), depository), depository, depth: DEPTH, hosted: must(bytes32(slot.entity), "entity id") };
    const config: Config = { shell: rig.shell, boot: rig.boot, key: rig.key, table: peers.map((p) => this.peerOf(p)), tickMs: TICK_MS, nonce, lost: (m) => this.loss(m), watch };
    return must(await startDaemon(config, listener), `${party.name}'s node`);
  }

  private async refresh(): Promise<void> {
    await Promise.all([...this.slots].map(async ([id, slot]) => { this.snaps.set(id, await slot.daemon.look()); }));
  }

  /** Every node is linked to each of its peers. */
  private async connected(): Promise<void> {
    await this.until(() => [...this.slots].every(([id, slot]) => this.look(id).linked.length === slot.member.peers.length), "the links to come up");
  }

  private async until(done: () => boolean, what: string): Promise<void> {
    const end = Date.now() + PATIENCE_MS;
    for (;;) {
      await this.refresh();
      if (done()) return;
      if (Date.now() > end) throw new Error(`waited ${PATIENCE_MS} ms for ${what}`);
      await sleep(POLL_MS);
    }
  }

  private look(id: EntityId): Look {
    const look = this.snaps.get(id);
    if (look === undefined) throw new Error(`no look at ${id}`);
    return look;
  }

  /** What keeps the nodes from being quiet, or null: a fault, work at hand, a batch on the chain, a line on its way, a frame waiting. */
  private restless(options: Quiet, finalized: bigint): string | null {
    const looks = [...this.slots].map(([id, slot]) => ({ name: slot.member.party.name, look: this.look(id), id }));
    const faulted = looks.find(({ look }) => look.fatal !== undefined);
    if (faulted !== undefined) throw new Error(`${faulted.name}'s node ended on a fault: ${shown(faulted.look.fatal)}`);
    const working = looks.find(({ look }) => look.busy || look.station.host.queue.length > 0 || look.station.host.height !== undefined || look.station.host.runtime.staged !== undefined);
    if (working !== undefined) return `${working.name} has work (chain batch ${working.look.busy}, queue ${working.look.station.host.queue.length})`;
    const behind = looks.find(({ look }) => look.cursor === undefined || look.cursor < finalized || look.watchFault !== undefined);
    if (behind !== undefined) return `${behind.name}'s J loop is at ${behind.look.cursor}, the chain is final to ${finalized} (${behind.look.watchFault ?? "no fault"})`;
    const sent = looks.reduce((n, { look }) => n + look.counts.sent, 0);
    const heard = looks.reduce((n, { look }) => n + look.counts.heard, 0);
    if (sent !== heard) return `${sent - heard} lines are on their way`;
    const waiting = options.pending === true ? undefined : looks.find(({ id }) => [...(this.entity(id).accounts.values())].some((a) => a.pending !== undefined));
    return waiting === undefined ? null : `${waiting.name} has a frame waiting for its peer`;
  }

  /** Until no node has anything to do, no line is on its way and (unless `pending`) no frame waits, for three looks in a row. */
  async settle(options: Quiet = {}): Promise<void> {
    const end = Date.now() + PATIENCE_MS;
    for (let stable = 0; stable < STABLE;) {
      await this.refresh();
      const finalized = BigInt(await this.chain.provider.getBlockNumber()) - DEPTH;
      const why = this.restless(options, finalized);
      if (why !== null && Date.now() > end) throw new Error(`the nodes did not go quiet in ${PATIENCE_MS} ms: ${why}`);
      stable = why === null ? stable + 1 : 0;
      if (stable < STABLE) await sleep(POLL_MS);
    }
  }

  /** Hand `id` commands or timers, one after the other, each run until its Host has nothing queued. */
  async tell(id: EntityId, ...inputs: readonly EntityInput[]): Promise<void> {
    for (const input of inputs) must<Turn, unknown>(await this.slot(id).daemon.tell(input), `${this.slot(id).member.party.name}'s command`);
    await this.refresh();
  }

  /** The chain mines until the J height `height` is final (a block `depth` above it), and the nodes' J loops catch up. */
  async reach(height: bigint, options: Quiet = {}): Promise<void> {
    const head = BigInt(await this.chain.provider.getBlockNumber());
    const blocks = height + DEPTH - head;
    if (blocks > 0n) await this.chain.provider.send("anvil_mine", [`0x${blocks.toString(16)}`]);
    await this.settle(options);
  }

  /** While `work` runs, the messages `lost` says are lost on their way out. */
  async losing<T>(lost: (message: Outbound) => boolean, work: () => Promise<T>): Promise<T> {
    this.loss = lost;
    try { return await work(); } finally { this.loss = KEEP; }
  }

  /** A crash of one node: it stops, and comes back from its files alone on the same port; its peers dial or answer again. */
  async restart(id: EntityId): Promise<void> {
    const slot = this.slot(id);
    await slot.daemon.stop();
    slot.daemon = await this.launch(slot, must(await listenTcp(LOCAL, slot.port, MAX_LINE), "listen again"));
    await this.connected();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.daemon.stop()));
  }

  entity(id: EntityId): EntityState {
    const e = this.look(id).station.host.runtime.entities.get(id);
    if (e === undefined) throw new Error(`no entity ${id}`);
    return e;
  }

  account(id: EntityId, peer: EntityId): EntityReplica {
    const a = this.entity(id).accounts.get(peer);
    if (a === undefined) throw new Error(`${id} has no Account with ${peer}`);
    return a;
  }

  rowsOf(id: EntityId): readonly Row[] { return this.look(id).station.host.runtime.wal; }
  /** The chain actions of the committed rows, in order: what the node's Runtime has asked of the chain. */
  askedBy(id: EntityId): readonly JAction[] { return this.rowsOf(id).flatMap((r) => r.chain); }
  noticesOf(id: EntityId): readonly string[] {
    return [...this.look(id).notices.map((x) => x._tag), ...this.rowsOf(id).flatMap((r) => r.notices.map((x) => `${x._tag} ${shown(x).slice(0, 260)}`))];
  }
  /** The lines this node cut a connection for, most recent last. */
  refusedBy(id: EntityId): readonly string[] { return this.look(id).refused; }
  /** Where the node keeps its WAL and its journal. */
  dirOf(id: EntityId): string { return this.slot(id).dir; }
  /** Lines written and not yet heard. */
  inFlight(): number {
    const looks = [...this.slots.keys()].map((id) => this.look(id));
    return looks.reduce((n, l) => n + l.counts.sent, 0) - looks.reduce((n, l) => n + l.counts.heard, 0);
  }
  /** The J view of the Runtimes: they all hold the same one, since the J loop hands every node each height. */
  view(): JView { return this.look([...this.slots.keys()][0]!).station.host.runtime.view; }
  /** What each node's counters say, for a report. */
  counts(): ReadonlyMap<string, Look["counts"]> { return new Map([...this.slots].map(([id, slot]) => [slot.member.party.name, this.look(id).counts])); }
}
