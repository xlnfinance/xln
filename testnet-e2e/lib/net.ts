// Four Runtimes on the Host core (pure/host/host.ts) with an in-memory shell: the shell stamps `begin`, keeps each
// row it is asked to persist, reports it with `persisted`, puts each `send` on a link that loses nothing, and collects
// each `chain` action for the harness to turn into a J op. This file is the stand-in for the file and socket shell the
// transport thread has not written yet (gap `host-shell`).
import type { JHeight, JView } from "../../pure/account/clause/clock.ts";
import { emptyEntity, type EntityId, type EntityInput, type EntityReplica, type EntityState, type JAction, type Outbound } from "../../pure/entity/model.ts";
import { begin, heard, limits, persisted, receive, reopen, startHost, submit } from "../../pure/host/host.ts";
import type { Effect, Host } from "../../pure/host/model.ts";
import type { Row, Setup } from "../../pure/runtime/model.ts";
import { timestamp } from "../../pure/runtime/model.ts";
import { startRuntime } from "../../pure/runtime/tick.ts";
import { must } from "./chain.ts";

const BOUNDS = must(limits(32, 8), "host limits");

/** One node: its Host, the rows its disk holds, and the chain actions it has asked for, in order. */
type Node = { host: Host; disk: Row[]; asked: JAction[]; notices: string[] };

export class Net {
  private readonly nodes = new Map<EntityId, Node>();
  private link: Outbound[] = [];
  private ms = 1n;

  constructor(readonly setup: Setup, ids: readonly EntityId[]) {
    ids.forEach((id) => this.nodes.set(id, { host: startHost(startRuntime(setup, [emptyEntity(id)]), BOUNDS), disk: [], asked: [], notices: [] }));
  }

  private node(id: EntityId): Node {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  }

  /** The shell's loop for one node: begin a frame, make its row durable, let what it produced leave; until idle. */
  private run(id: EntityId): void {
    const n = this.node(id);
    for (let guard = 0; guard < 200; guard++) {
      const begun = must(begin(n.host, must(timestamp(this.ms++), "stamp")), "the Runtime halted at begin");
      n.host = begun.host;
      const row = begun.effects.find((e): e is Extract<Effect, { _tag: "persist" }> => e._tag === "persist");
      if (row === undefined) return;
      n.disk.push(row.row);
      const done = must(persisted(n.host), "the Runtime halted at persisted");
      n.host = done.host;
      this.leave(n, done.effects);
    }
    throw new Error(`node ${id} did not go idle in 200 frames`);
  }

  private leave(n: Node, effects: readonly Effect[]): void {
    effects.forEach((e) => {
      if (e._tag === "send") this.link.push(e.message);
      if (e._tag === "chain") n.asked.push(e.action);
    });
  }

  /** Hand `id` commands or timers and run its frames; what leaves joins the link. */
  tell(id: EntityId, ...inputs: readonly EntityInput[]): void {
    const n = this.node(id);
    n.host = inputs.reduce((host, input) => submit(host, { to: id, input }), n.host);
    this.run(id);
  }

  /** The link delivers each message once, oldest first, until nothing is on it. `lost` messages are dropped on the way. */
  settle(lost: (m: Outbound) => boolean = () => false): void {
    for (let guard = 0; guard < 400; guard++) {
      const next = this.link.shift();
      if (next === undefined) return;
      if (lost(next)) continue;
      const n = this.node(next.to);
      const got = receive(n.host, next);
      n.host = got.host;
      n.notices.push(...got.notices.map((x) => x._tag));
      this.run(next.to);
    }
    throw new Error("the link did not go quiet in 400 messages");
  }

  /** The J loop hands every node a new height: one frame of every Entity, then the link settles. */
  rise(height: JHeight, lost?: (m: Outbound) => boolean): void {
    [...this.nodes.keys()].forEach((id) => { const n = this.node(id); n.host = heard(n.host, height); this.run(id); });
    this.settle(lost);
  }

  /** A crash of one node: its Host comes back from its disk alone, and every committed output and action leaves again. */
  restart(id: EntityId): void {
    const n = this.node(id);
    const back = must(reopen(this.setup, [emptyEntity(id)], n.disk, BOUNDS), "the Runtime could not replay its WAL");
    n.host = back.host;
    n.asked = [];
    this.leave(n, back.effects);
  }

  entity(id: EntityId): EntityState {
    const e = this.node(id).host.runtime.entities.get(id);
    if (e === undefined) throw new Error(`no entity ${id}`);
    return e;
  }

  account(id: EntityId, peer: EntityId): EntityReplica {
    const a = this.entity(id).accounts.get(peer);
    if (a === undefined) throw new Error(`${id} has no Account with ${peer}`);
    return a;
  }

  rowsOf(id: EntityId): readonly Row[] { return this.node(id).disk; }
  askedBy(id: EntityId): readonly JAction[] { return this.node(id).asked; }
  noticesOf(id: EntityId): readonly string[] {
    return [...this.node(id).notices, ...this.node(id).disk.flatMap((r) => r.notices.map((x) => `${x._tag} ${JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? "bytes" : v)).slice(0, 260)}`))];
  }
  inFlight(): number { return this.link.length; }
  /** The J view of the Runtimes: they all hold the same one, since the J loop hands every node each height. */
  view(): JView { return [...this.nodes.values()][0]!.host.runtime.view; }
}
