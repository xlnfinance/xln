// The Host, in the spec's words (Arrival spec/transport/link.scm, decision D12, lessons R-DURABLE, R-X1): the Host is
// what stands between the link and a Runtime. It queues what arrives, hands the Runtime one frame at a time, and asks
// its shell to do two things: make a row durable (`persist`) and put a message on the link (`send`). A message leaves
// only from a committed row, so a `send` effect exists only after the shell has said its row is durable.
//
// The link may lose, repeat, reorder and misroute a message and let a stranger put one on it; it promises nothing. The
// Host believes nothing of it: a message for an Entity this Host does not host, or one over a sender's bound, is
// refused in place with a notice, and no peer message halts anything (R-X1). The queue is volatile: a crash loses it,
// and the link's loss and repeats are what the page already assumes.
import type { EntityId, EntityInput, Outbound } from "../entity/model.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import type { Row, Runtime } from "../runtime/model.ts";

/** What waits for a frame: an input for one Entity, from a peer or from the Host's own commands and timers. */
export type Item = Readonly<{ to: EntityId; input: EntityInput }>;

/** `perPeer` bounds the queued messages of one sender, `perFrame` the inputs one frame takes. Both mean loss. */
export type Limits = Readonly<{ perPeer: number; perFrame: number }>;

/** A message the Host turned away before it reached a frame. */
export type HostNotice =
  | Tagged<"misrouted", { to: EntityId; from: EntityId }>
  | Tagged<"queue_full", { from: EntityId }>;

/** What the Host asks of its shell. The shell reports a `persist` durable by calling `persisted`. */
export type Effect =
  | Tagged<"persist", { row: Row }>
  | Tagged<"send", { message: Outbound }>;

export type Host = Readonly<{ runtime: Runtime; limits: Limits; queue: readonly Item[] }>;

/** One step of the Host: where it is now and what its shell must do. */
export type Stepped = Readonly<{ host: Host; effects: readonly Effect[] }>;
