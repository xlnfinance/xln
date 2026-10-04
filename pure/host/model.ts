// The Host, in the spec's words (Arrival spec/transport/link.scm, decision D12, lessons R-DURABLE, R-X1): the Host is
// what stands between the link and a Runtime. It queues what arrives, hands the Runtime one frame at a time, and asks
// its shell to do two things: make a row durable (`persist`) and put a message on the link (`send`). A message leaves
// only from a committed row, so a `send` effect exists only after the shell has said its row is durable.
//
// The link may lose, repeat, reorder and misroute a message and let a stranger put one on it; it promises nothing. The
// Host believes nothing of its content: a message for an Entity this Host does not host, or one over a sender's bound,
// is refused in place with a notice, and no peer message halts anything (R-X1). One thing is not the Host's to check:
// `from` is the link-authenticated peer, a precondition the transport shell delivers (spec decision Q-T-5: the link
// authenticates its peer, the content authenticates itself). Without it a forged ack naming a real frame's hash would
// advance an Account head the peer never made durable (R-LINK-AUTH). The queue is volatile: a crash loses it,
// and the link's loss and repeats are what the page already assumes.
import type { JHeight } from "../account/clause/clock.ts";
import type { EntityId, EntityInput, JAction, Outbound } from "../entity/model.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import type { Row, Runtime } from "../runtime/model.ts";

/** What waits for a frame: an input for one Entity, from a peer or from the Host's own commands and timers. */
export type Item = Readonly<{ to: EntityId; input: EntityInput }>;

/** `perPeer` bounds the queued messages of one sender, `perFrame` the inputs one frame takes. Both mean loss. */
export type Limits = Readonly<{ perPeer: number; perFrame: number }>;

/**
 * A message the Host turned away before it reached a frame, and a transaction the J loop cannot read: `watch_stalled`
 * names the transaction the node's provider fails, whose finalize the J loop holds back (every other event is told),
 * once when the stall begins; past its retries the loop tells it unread (R-WATCH-CALLDATA). `no_call_trace` says the
 * provider of a node that may hold value does not trace calls (a probe or a transaction's trace answered no method),
 * so its Entity forwards no lock: once for each time the node goes blind. `registry_unread` says a reading of the
 * chain's registry the Entity needed was not had (the node failed it or no longer serves that block), so the decision
 * it rests on is refused or waits (R-REGISTRY-AT-VIEW): once for each hashlock and reason.
 */
export type HostNotice =
  | Tagged<"misrouted", { to: EntityId; from: EntityId }>
  | Tagged<"queue_full", { from: EntityId }>
  | Tagged<"watch_stalled", { tx: string; reason: string }>
  | Tagged<"no_call_trace", { why: string }>
  | Tagged<"registry_unread", { hashlock: string; reason: string }>;

/** Which chain action of which committed row an effect came from: the WAL height and the place in the row's `chain`. */
export type RowId = Readonly<{ height: bigint; index: number }>;

/**
 * What the Host asks of its shell. The shell reports a `persist` durable by calling `persisted`. A `send` puts a
 * message on the link and a `chain` hands an action to the J batch builder; both leave only from a committed row. A
 * `chain` carries the identity of that row's action, which a crash and a reopen leave unchanged: a shell that is asked
 * the same action twice knows it is one action and not two (R-DURABLE, a deposit that is not made twice).
 */
export type Effect =
  | Tagged<"persist", { row: Row }>
  | Tagged<"send", { message: Outbound }>
  | Tagged<"chain", { action: JAction; row: RowId }>;

/**
 * `height` is the highest J height the J loop has handed over and no frame has taken yet, above the Runtime's view.
 * Heights only rise, so one waiting height stands for all that came before it, and it goes into the next frame ahead of
 * the queue. The J loop hands a height over only after the J events of its delivery are in the WAL, and keeps its
 * cursor until a committed `j_height` row holds the height: the Host does not keep a waiting height across a crash.
 */
export type Host = Readonly<{
  runtime: Runtime; limits: Limits; queue: readonly Item[]; height: JHeight | undefined;
}>;

/** One step of the Host: where it is now and what its shell must do. */
export type Stepped = Readonly<{ host: Host; effects: readonly Effect[] }>;
