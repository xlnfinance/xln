// What the runtime tests share: a Setup, Host stamps, and one whole tick (apply, commit, flush) for the tests that
// do not care about a crash in between. Only tests import this.
import { expect } from "bun:test";
import { heightOf } from "../account/fixtures.ts";
import { credit, entityOf, GOLD, judge, open, pay } from "../entity/fixtures.ts";
import { emptyEntity, type EntityId, type EntityInput, type JAction, type Outbound } from "../entity/model.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import type { Result } from "../kernel/core/result.ts";
import type { JView } from "../account/clause/clock.ts";
import type { Halt, Input, Runtime, Setup, Timestamp } from "./model.ts";
import { apply, commit, flush, recover, startRuntime } from "./tick.ts";

export { credit, entityOf, GOLD, open, pay };

export const setup: Setup = { clock: judge.clock, view: judge.view };

export const stamp = (ms: bigint): Timestamp => ms as Timestamp;

export const inputFor = (to: EntityId, at: bigint, ...inputs: readonly EntityInput[]): Input =>
  ({ _tag: "entity", at: stamp(at), to, inputs });

/** The Host saw the J chain reach `height`. */
export const heightAt = (at: bigint, height: bigint): Input =>
  ({ _tag: "j_height", at: stamp(at), height: heightOf(height) });

export const started = (...ids: readonly EntityId[]): Runtime => startRuntime(setup, ids.map(emptyEntity));

/** A Result the test needs to be a value: a Halt fails the test and names itself. */
export const unhalted = <T>(r: Result<T, Halt>): T =>
  unwrapOr(r, (halt) => expect.unreachable(`halted: ${halt._tag}`));

export type Ticked = Readonly<{ runtime: Runtime; leaving: readonly Outbound[]; chain: readonly JAction[] }>;

/** Apply, commit and flush: what the Host does when nothing goes wrong between the three. */
export const tick = (rt: Runtime, input: Input): Ticked => {
  const committed = unhalted(commit(unhalted(apply(rt, input))));
  return flush(committed);
};

const ALICE = entityOf(1);
const BOB = entityOf(2);

/**
 * Two Hosts, Alice's and Bob's, and the link between them: what has left a Runtime and not yet arrived. `chain` is
 * what the Hosts have been asked to send to the J chain, in the order they were asked.
 */
export type Cluster = Readonly<{
  hosts: ReadonlyMap<EntityId, Runtime>; inflight: readonly Outbound[]; chain: readonly JAction[]; clock: bigint;
}>;

const hostWith = (id: EntityId, view: JView): Runtime => startRuntime({ ...setup, view }, [emptyEntity(id)]);

/** Alice and Bob started, each Host seeing the J chain at its own view (the same one unless a test says otherwise). */
export const start = (alice: JView = judge.view, bob: JView = judge.view): Cluster =>
  ({
    hosts: new Map([[ALICE, hostWith(ALICE, alice)], [BOB, hostWith(BOB, bob)]]), inflight: [], chain: [], clock: 1n,
  });

export const hostOf = (c: Cluster, id: EntityId): Runtime => c.hosts.get(id) ?? expect.unreachable("no such host");

/** What a host's tick sent joins the link and the chain's queue, and the clock moves. */
const took = (c: Cluster, to: EntityId, ticked: Ticked): Cluster => ({
  hosts: new Map([...c.hosts, [to, ticked.runtime]]),
  inflight: [...c.inflight, ...ticked.leaving],
  chain: [...c.chain, ...ticked.chain],
  clock: c.clock + 1n,
});

/** One input into one host's Runtime; what leaves it joins the link. */
export const feed = (c: Cluster, to: EntityId, ...inputs: readonly EntityInput[]): Cluster =>
  took(c, to, tick(hostOf(c, to), inputFor(to, c.clock, ...inputs)));

/** The link delivers its oldest message; whatever the host sends back joins the link. */
export const deliver = (c: Cluster): Cluster => {
  const [next, ...rest] = c.inflight;
  return next === undefined
    ? c
    : feed({ ...c, inflight: rest }, next.to, { _tag: "peer_message", from: next.from, msg: next.msg });
};

/** The link delivers until nothing is in flight. */
export const settle = (c: Cluster): Cluster => (c.inflight.length === 0 ? c : settle(deliver(c)));

/** The Host saw the J chain reach `height`: the host `to` takes it as a frame. */
export const rise = (c: Cluster, to: EntityId, height: bigint): Cluster =>
  took(c, to, tick(hostOf(c, to), heightAt(c.clock, height)));

/** The Host of `id` crashed and came back: its WAL replayed, every output of every row sent again onto the link. */
export const restarted = (c: Cluster, id: EntityId): Cluster => {
  const before = hostOf(c, id);
  const back = flush(unhalted(recover(before.setup, [emptyEntity(id)], before.wal)));
  const hosts = new Map([...c.hosts, [id, back.runtime]]);
  return { ...c, hosts, inflight: [...c.inflight, ...back.leaving], chain: [...c.chain, ...back.chain] };
};
