// What the Host tests share: Hosts over fresh Runtimes, and a shell that never fails. Only tests import this.
import { expect } from "bun:test";
import { entityOf, started, stamp, unhalted } from "../runtime/fixtures.ts";
import { TEST_SIG } from "../entity/fixtures.ts";
import type { EntityId, EntityInput, JAction, Outbound } from "../entity/model.ts";
import type { Input } from "../runtime/model.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import { begin, limits, persisted, receive, startHost, submit } from "./host.ts";
import type { Effect, Host } from "./model.ts";

export { entityOf, stamp, unhalted };

export const BOUNDS = unwrapOr(limits(3, 2), () => expect.unreachable("limits"));

export const hostFor = (...ids: readonly EntityId[]): Host => startHost(started(...ids), BOUNDS);

export const sentIn = (effects: readonly Effect[]): readonly Outbound[] =>
  effects.flatMap((effect) => (effect._tag === "send" ? [effect.message] : []));

/** A message as the link carries it once the shell has signed it: one that names a head gets the tests' signature. */
export const onTheLink = (o: Outbound): Outbound => (o.attest === undefined ? o : { ...o, sig: TEST_SIG });

export const chainIn = (effects: readonly Effect[]): readonly JAction[] =>
  effects.flatMap((effect) => (effect._tag === "chain" ? [effect.action] : []));

/** The Entity inputs a Runtime input carries: none for a J height. */
export const inputsOf = (input: Input): readonly EntityInput[] => (input._tag === "entity" ? input.inputs : []);

export type Turn = Readonly<{ host: Host; sent: readonly Outbound[] }>;

/** A shell whose disk never fails: begin a frame, make its row durable at once, and report what left. */
export const turn = (host: Host, at: bigint): Turn => {
  const begun = unhalted(begin(host, stamp(at)));
  const done = begun.effects.some((effect) => effect._tag === "persist") ? unhalted(persisted(begun.host)) : begun;
  return { host: done.host, sent: sentIn(done.effects) };
};

export type Pair = Readonly<{ hosts: ReadonlyMap<EntityId, Host>; link: readonly Outbound[]; clock: bigint }>;

export const meet = (...ids: readonly EntityId[]): Pair =>
  ({ hosts: new Map(ids.map((id) => [id, hostFor(id)])), link: [], clock: 1n });

export const hostOf = (p: Pair, id: EntityId): Host => p.hosts.get(id) ?? expect.unreachable("no such Host");

/** One frame at `id`'s Host, with what was queued for it already and `inputs`; what leaves joins the link. */
export const tell = (p: Pair, id: EntityId, ...inputs: readonly EntityInput[]): Pair => {
  const told = inputs.reduce((host, input) => submit(host, { to: id, input }), hostOf(p, id));
  const done = turn(told, p.clock);
  return { hosts: new Map([...p.hosts, [id, done.host]]), link: [...p.link, ...done.sent], clock: p.clock + 1n };
};

/** A link that delivers every message once, in order: the oldest is received and its Host takes a frame. */
export const settle = (p: Pair): Pair => {
  const [next, ...rest] = p.link;
  if (next === undefined) return p;
  const received = receive(hostOf(p, next.to), onTheLink(next)).host;
  const done = turn(received, p.clock);
  const link = [...rest, ...done.sent];
  return settle({ hosts: new Map([...p.hosts, [next.to, done.host]]), link, clock: p.clock + 1n });
};
