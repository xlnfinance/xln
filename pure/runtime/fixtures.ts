// What the runtime tests share: a Setup, Host stamps, and one whole tick (apply, commit, flush) for the tests that
// do not care about a crash in between. Only tests import this.
import { expect } from "bun:test";
import { credit, entityOf, GOLD, judge, open, pay } from "../entity/fixtures.ts";
import { emptyEntity, type EntityId, type EntityInput, type Outbound } from "../entity/model.ts";
import { signing } from "../account/fixtures.ts";
import { unwrapOr } from "../kernel/core/result.ts";
import type { Result } from "../kernel/core/result.ts";
import type { Halt, Input, Runtime, Setup, Timestamp } from "./model.ts";
import { apply, commit, flush, startRuntime } from "./tick.ts";

export { credit, entityOf, GOLD, open, pay };

export const setup: Setup = { clock: judge.clock, view: judge.view, signing };

export const stamp = (ms: bigint): Timestamp => ms as Timestamp;

export const inputFor = (to: EntityId, at: bigint, ...inputs: readonly EntityInput[]): Input =>
  ({ at: stamp(at), to, inputs });

export const started = (...ids: readonly EntityId[]): Runtime => startRuntime(setup, ids.map(emptyEntity));

/** A Result the test needs to be a value: a Halt fails the test and names itself. */
export const unhalted = <T>(r: Result<T, Halt>): T =>
  unwrapOr(r, (halt) => expect.unreachable(`halted: ${halt._tag}`));

export type Ticked = Readonly<{ runtime: Runtime; leaving: readonly Outbound[] }>;

/** Apply, commit and flush: what the Host does when nothing goes wrong between the three. */
export const tick = (rt: Runtime, input: Input): Ticked => {
  const committed = unhalted(commit(unhalted(apply(rt, input))));
  return flush(committed);
};
