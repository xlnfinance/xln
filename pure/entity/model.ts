// The Entity, in the spec's words (Arrival spec/entity/frame.scm, lessons R-E1, R-E4): an Entity owns one Account per
// peer, and one frame of it folds what arrived in a fixed order of phases over one view of every Account:
//
//   1. arrivals   what peers sent: Account messages, applied first whatever order they came in (R-E1)
//   2. hooks      what the Host's timers say: an Account's pending frame is due to be sent again
//   3. commands   what the Entity was told to do: open an Account, set credit, pay
//   4. proposals  each Account with queued txs and no pending frame proposes: the Accounts a command touched first, in
//                 first-touch order, then the rest by id (R-E4)
//
// A refusal is a value (`Notice`) the owner of the input is told, never a halt (R-X1, R-NOTICE).
import { err, ok, type Result } from "../kernel/core/result.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { FrameHash, Msg, Outcome, Refused, Replica } from "../account/frame/frame.ts";
import type { JView } from "../account/clause/clock.ts";
import type { AccountFault, AccountState, Hold, HoldId, Side, TokenId } from "../account/model.ts";
import type { AccountTx } from "../account/tx.ts";

/** A 32-byte id, `0x` and 64 lowercase hex digits: the text order of two ids is their numeric order, as the chain's. */
export type EntityId = Brand<string, "EntityId">;

export type BadEntityId = Tagged<"bad_entity_id", { text: string }>;

export const entityId = (text: string): Result<EntityId, BadEntityId> =>
  (/^0x[0-9a-f]{64}$/.test(text) ? ok(text as EntityId) : err({ _tag: "bad_entity_id", text }));

/** The Account of two Entities has the smaller id on its Left, as the contract's account key does. */
export const sideOf = (self: EntityId, peer: EntityId): Side => (self < peer ? "left" : "right");

/** What a frame of an Account can be refused for: the Account's own faults, and that the node's signature is out. */
export type PeerFault = AccountFault | Tagged<"frozen">;

/** One side of an Account as the Entity holds it. */
export type EntityReplica = Replica<AccountTx, AccountState, PeerFault>;

/**
 * An Entity: the Accounts it holds, by the peer's id; the Accounts that wait for their J view to move; and the
 * hashlocks it has asked the chain to reveal. A peer refused a frame for a fault that can pass with its view of J
 * (R-FRAME-REFUSAL): the txs are queued again, and the Account proposes them once the Entity's view is above the one it
 * had at the refusal, not before (retry pacing). A row counts only while its Account's `attempt` is above zero: the
 * head moving ends the wait.
 */
export type EntityState = Readonly<{
  id: EntityId;
  accounts: ReadonlyMap<EntityId, EntityReplica>;
  waiting: ReadonlyMap<EntityId, JView>;
  revealed: ReadonlyMap<EntityId, readonly string[]>;
  chain: ReadonlyMap<EntityId, ChainFacts>;
}>;

export const emptyEntity = (id: EntityId): EntityState =>
  ({ id, accounts: new Map(), waiting: new Map(), revealed: new Map(), chain: new Map() });

/** Response windows in seconds, one per side, as the signed proofs of an Account carry them. */
export type Windows = Readonly<{ left: bigint; right: bigint }>;

/**
 * What an Entity knows of the chain for one Account, from what its Host reports and from its own frames (never derived
 * from an earlier proof): the epoch and the stored nonce the chain is at, how many frames have been co-signed since the
 * epoch began, the windows its signed proofs carry, whether a dispute the peer started is open against it, and whether
 * the node has co-signed a settlement or a collateral-to-reserve that has not landed yet (`frozen`, R-COSIGN-FREEZE).
 * `cosigned` counts the operations the node has co-signed on this Account, for good: the `cosigned`-th is the serial
 * its action carries, and the only one whose lapse ends a freeze.
 */
export type ChainFacts = Readonly<{
  epoch: bigint; stored: bigint; frames: bigint; windows: Windows | undefined; disputed: boolean; frozen: boolean;
  cosigned: bigint;
}>;

// What a frame takes in.
export type PeerMessage = Tagged<"peer_message", { from: EntityId; msg: Msg<AccountTx> }>;

/**
 * What the Host saw on the J chain about the Account with `peer`. A repeat or an older report changes nothing, so the
 * Host may deliver an event again: `j_epoch` is the chain moving the Account's epoch on (a settlement, a withdrawal
 * or a finished dispute landed), with the nonce it stores now; `j_dispute` is a dispute started in `epoch` by `by`;
 * `j_dispute_over` is that dispute countered or finalized; `j_op_lapsed` is a co-signed settlement or withdrawal
 * that can no longer land (its batch reverted, its signatures ran out), named by the serial its action carried: a
 * report of an operation that is not the one out (a repeat, or an older one) changes nothing.
 */
export type JEvent =
  | Tagged<"j_epoch", { peer: EntityId; epoch: bigint; stored: bigint }>
  | Tagged<"j_dispute", { peer: EntityId; epoch: bigint; by: Side }>
  | Tagged<"j_dispute_over", { peer: EntityId }>
  | Tagged<"j_op_lapsed", { peer: EntityId; serial: bigint }>;

/** What a peer asks the node to co-sign: a withdrawal of collateral as a shortcut (C2R) or as a settlement. */
export type CosignOp =
  | Tagged<"c2r", { token: TokenId; amount: bigint }>
  | Tagged<"settle", { token: TokenId; amount: bigint }>;

export type CosignAsk = Tagged<"cosign_ask", { from: EntityId; op: CosignOp }>;

export type Arrival = PeerMessage | JEvent | CosignAsk;

/** The Host's timer for `peer`'s Account ran out: its pending frame is sent again, so a lost frame cannot wedge it. */
export type Hook = Tagged<"resend_due", { peer: EntityId }>;

/** A command that becomes a tx of the Account's next frame. */
export type AccountCommand =
  | Tagged<"set_credit", { peer: EntityId; token: TokenId; limit: bigint }>
  | Tagged<"pay", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"lock", { peer: EntityId; token: TokenId; hold: Hold }>
  | Tagged<"resolve", { peer: EntityId; token: TokenId; id: HoldId; secret: Uint8Array }>
  | Tagged<"cancel", { peer: EntityId; token: TokenId; id: HoldId }>
  | Tagged<"expire", { peer: EntityId; token: TokenId; id: HoldId }>;

/** A command that is about the chain, not the Account's frames. */
export type ChainCommand =
  | Tagged<"deposit", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"set_windows", { peer: EntityId; windows: Windows }>
  | Tagged<"withdraw", { peer: EntityId; token: TokenId; amount: bigint }>;

export type Command = Tagged<"open_account", { peer: EntityId }> | AccountCommand | ChainCommand;

export type EntityInput = Arrival | Hook | Command;

/** What leaves an Entity: an Account message for a peer. */
export type Outbound = Readonly<{ from: EntityId; to: EntityId; msg: Msg<AccountTx> }>;

/**
 * What an Entity asks of the J chain: data the Host turns into a batch (the bytes are the chain layer's). A `reveal` is
 * a payee showing a secret on chain because its resolve is still unacked when the clause's deadline comes near
 * (R-HTLC-CLOCK c); `revealed` on the Entity keeps a hashlock asked once for as long as its hold is open.
 */
export type JAction =
  | Tagged<"reveal", { peer: EntityId; token: TokenId; id: HoldId; hashlock: string; secret: Uint8Array }>
  | Tagged<"deposit", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"counter", { peer: EntityId; nonce: bigint; head: FrameHash }>
  | Tagged<"c2r", { peer: EntityId; serial: bigint; token: TokenId; amount: bigint }>
  | Tagged<"settle", { peer: EntityId; serial: bigint; token: TokenId; amount: bigint; folds: readonly Fold[] }>;

/** The offdelta of a token that a settlement folds into its ondelta, so that the epoch advance cannot erase it. */
export type Fold = Readonly<{ token: TokenId; offdelta: bigint }>;

export type EntityFault =
  | Tagged<"self_account">
  | Tagged<"account_exists", { peer: EntityId }>
  | Tagged<"no_account", { peer: EntityId }>
  | Tagged<"account_refused", { fault: PeerFault }>
  | Tagged<"deposit_before_cosign">
  | Tagged<"bad_windows", { windows: Windows }>
  | Tagged<"windows_shorten", { current: Windows }>
  | Tagged<"already_cosigned">
  | Tagged<"frame_in_flight">
  | Tagged<"unfolded_c2r", { folds: readonly Fold[] }>;

/** What the owner of an input is told when it did not take effect. */
export type Notice =
  | Tagged<"command_refused", { command: Command; fault: EntityFault }>
  | Tagged<"unknown_peer", { from: EntityId }>
  | Tagged<"cosign_refused", { from: EntityId; op: CosignOp; fault: EntityFault }>
  | Tagged<"message_refused", { from: EntityId; outcome: Outcome<PeerFault> }>
  | Tagged<"tx_refused", { peer: EntityId; refused: Refused<AccountTx, PeerFault> }>;
