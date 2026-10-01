// The Runtime, in the spec's words (Arrival spec/runtime/tick.scm, lessons R-X1, R-DURABLE): a Runtime hosts
// Entities and takes one input at a time from the Host. An input is applied to the Entity it names, which makes a WAL
// row (height, stamp, input, outputs); the row is committed once the Host has made it durable, and only then do its
// outputs leave. A crash loses what was not committed and what was believed sent; recovery replays the rows, each with
// its own stamp, and every output of every committed row is sent again (the peer drops a copy it already holds).
//
// A bad input from a peer is refused in place with a notice and never halts (R-X1). A Halt is a broken local
// invariant: the list is closed, and each case names the invariant.
import type { ClockParams, JHeight, JView } from "../account/clause/clock.ts";
import type { SigningContext } from "../account/proof/signing.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { EntityId, EntityInput, EntityState, Notice, Outbound } from "../entity/model.ts";

/** The Host's clock in milliseconds, as it stamps an input: it orders frames and decides no deadline (R-CLOCK). */
export type Timestamp = Brand<bigint, "Timestamp">;

export type BadTimestamp = Tagged<"bad_timestamp", { ms: bigint }>;

export const timestamp = (ms: bigint): Result<Timestamp, BadTimestamp> =>
  (ms >= 0n ? ok(ms as Timestamp) : err({ _tag: "bad_timestamp", ms }));

/**
 * What the Host hands the Runtime, with the time the Host saw it: the inputs of one Entity frame, or a new height of
 * the J chain. The Runtime's view of J only rises (R-DRIFT bounds how far it lags the chain, which is the Host's to
 * watch); a rise is a frame of every Entity, so an Account that waited for it proposes.
 */
export type EntityBatch = Tagged<"entity", { at: Timestamp; to: EntityId; inputs: readonly EntityInput[] }>;

export type NewHeight = Tagged<"j_height", { at: Timestamp; height: JHeight }>;

export type Input = EntityBatch | NewHeight;

export type RuntimeNotice = Notice | Tagged<"unknown_entity", { entity: EntityId }>;

/** One frame of the WAL. `stamp` is the frame's: the later of the Runtime's last stamp and the input's (never back). */
export type Row = Readonly<{
  height: bigint; stamp: Timestamp; input: Input; outputs: readonly Outbound[]; notices: readonly RuntimeNotice[];
}>;

/**
 * What a Runtime is started with and keeps: the clock's parameters and its own view of the J chain. `signing` is ONE
 * interim SigningContext for every Account of every Entity this Runtime hosts. R-FRAME-SIGNATURE-NAMES-ACCOUNT needs
 * one per Account and per epoch (chain, depository, both entity ids, epoch, first nonce = stored + 2 from the chain);
 * until the cut supplies them, two Accounts of one Entity sign frames under the same key and epoch.
 */
export type Setup = Readonly<{ clock: ClockParams; view: JView; signing: SigningContext }>;

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
