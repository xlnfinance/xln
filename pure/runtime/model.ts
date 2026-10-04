// The Runtime, in the spec's words (Arrival spec/runtime/tick.scm, lessons R-X1, R-DURABLE): a Runtime hosts
// Entities and takes one input at a time from the Host. An input is applied to the Entity it names, which makes a WAL
// row (height, stamp, input, outputs); the row is committed once the Host has made it durable, and only then do its
// outputs leave. A crash loses what was not committed and what was believed sent; recovery replays the rows, each with
// its own stamp, and every output of every committed row is sent again (the peer drops a copy it already holds).
//
// A bad input from a peer is refused in place with a notice and never halts (R-X1). A Halt is a broken local
// invariant: the list is closed, and each case names the invariant.
import type { ClockParams, JHeight, JView } from "../account/clause/clock.ts";
import type { Anchor } from "../entity/signing/signing.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { EntityId, EntityInput, EntityState, JAction, Notice, Outbound, Reading } from "../entity/model.ts";

/** The Host's clock in milliseconds, as it stamps an input: it orders frames and decides no deadline (R-CLOCK). */
export type Timestamp = Brand<bigint, "Timestamp">;

export type BadTimestamp = Tagged<"bad_timestamp", { ms: bigint }>;

export const timestamp = (ms: bigint): Result<Timestamp, BadTimestamp> =>
  (ms >= 0n ? ok(ms as Timestamp) : err({ _tag: "bad_timestamp", ms }));

/**
 * What the Host hands the Runtime, with the time the Host saw it: the inputs of one Entity frame, or a new height of
 * the J chain, or a watcher delivery whose events and height commit together. The view only rises (R-DRIFT bounds
 * how far it lags the chain, which is the Host's to
 * watch); a rise is a frame of every Entity, so an Account that waited for it proposes.
 */
export type EntityBatch = Tagged<"entity", {
  at: Timestamp; to: EntityId; inputs: readonly EntityInput[];
  /** What the chain's registry held at the Runtime's view for the hashlocks the frame decides on. */
  registry?: readonly Reading[];
}>;

export type NewHeight = Tagged<"j_height", {
  at: Timestamp; height: JHeight;
  /** The same readings, taken at the new height, for the frame every Entity makes of it. */
  registry?: readonly Reading[];
}>;

/**
 * A watcher delivery: bounded Entity frames at the old view, then its height, durable as one record.
 * `registry` is what those frames decide on (R-REGISTRY-AT-VIEW). Absent only when the node does not decide on it.
 * A present list, including an empty one, means the gate is on. The block's second is not this field.
 */
export type Observation = Tagged<"j_observation", {
  at: Timestamp; to: EntityId; batches: readonly (readonly EntityInput[])[]; height: JHeight;
  registry?: readonly Reading[];
}>;

export type Input = EntityBatch | NewHeight | Observation;

export type RuntimeNotice = Notice | Tagged<"unknown_entity", { entity: EntityId }>;

/** One frame of the WAL. `stamp` is the frame's: the later of the Runtime's last stamp and the input's (never back). */
export type Row = Readonly<{
  height: bigint; stamp: Timestamp; input: Input; outputs: readonly Outbound[]; chain: readonly JAction[];
  notices: readonly RuntimeNotice[];
}>;

/**
 * What a Runtime is started with and keeps: the clock's parameters, its own view of the J chain, and the `anchor` its
 * Accounts sign under (the deployment and the proof terms). Each Account's own context, with its key, its epoch and its
 * first nonce, is read off the Entity's chain facts for it (R-FRAME-SIGNATURE-NAMES-ACCOUNT).
 */
export type Setup = Readonly<{
  clock: ClockParams; view: JView; anchor: Anchor;
  /**
   * The Entity decides to accept a lock, to forward one and to co-sign an expiry on the registry's reading at its view,
   * which the Host hands every frame (R-REGISTRY-AT-VIEW). Off, it decides as before. A node that may hold value turns
   * it on.
   */
  registry?: boolean;
}>;

/**
 * `entities` is the state after the staged row, if there is one. `wal` is what is durable. `sent` is how many rows of
 * the WAL have had their outputs flushed: belief, volatile, and zero again after a recovery.
 */
export type Runtime = Readonly<{
  setup: Setup;
  stamp: Timestamp;
  view: JView;
  entities: ReadonlyMap<EntityId, EntityState>;
  wal: readonly Row[];
  staged: Row | undefined;
  sent: number;
}>;

export type Halt =
  | Tagged<"frame_in_progress", { height: bigint }>
  | Tagged<"nothing_staged">
  | Tagged<"wal_gap", { expected: bigint; found: bigint }>
  | Tagged<"stamp_went_back", { height: bigint }>
  | Tagged<"replay_diverged", { height: bigint }>;
