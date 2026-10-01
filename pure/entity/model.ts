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
import type { AccountReplica } from "../account/frame/account.ts";
import type { Msg, Outcome, Refused } from "../account/frame/frame.ts";
import type { JView } from "../account/clause/clock.ts";
import type { AccountFault, Hold, HoldId, Side, TokenId } from "../account/model.ts";
import type { AccountTx } from "../account/tx.ts";

/** A 32-byte id, `0x` and 64 lowercase hex digits: the text order of two ids is their numeric order, as the chain's. */
export type EntityId = Brand<string, "EntityId">;

export type BadEntityId = Tagged<"bad_entity_id", { text: string }>;

export const entityId = (text: string): Result<EntityId, BadEntityId> =>
  (/^0x[0-9a-f]{64}$/.test(text) ? ok(text as EntityId) : err({ _tag: "bad_entity_id", text }));

/** The Account of two Entities has the smaller id on its Left, as the contract's account key does. */
export const sideOf = (self: EntityId, peer: EntityId): Side => (self < peer ? "left" : "right");

/**
 * An Entity: the Accounts it holds, by the peer's id, and the Accounts that wait for their J view to move. A peer
 * refused a frame for a fault that can pass with its view of J (R-FRAME-REFUSAL): the txs are queued again, and the
 * Account proposes them once the Entity's view is above the one it had at the refusal, not before (retry pacing). A
 * row counts only while its Account's `attempt` is above zero: the head moving ends the wait.
 */
export type EntityState = Readonly<{
  id: EntityId; accounts: ReadonlyMap<EntityId, AccountReplica>; waiting: ReadonlyMap<EntityId, JView>;
}>;

export const emptyEntity = (id: EntityId): EntityState => ({ id, accounts: new Map(), waiting: new Map() });

// What a frame takes in.
export type Arrival = Tagged<"peer_message", { from: EntityId; msg: Msg<AccountTx> }>;

/** The Host's timer for `peer`'s Account ran out: its pending frame is sent again, so a lost frame cannot wedge it. */
export type Hook = Tagged<"resend_due", { peer: EntityId }>;

export type Command =
  | Tagged<"open_account", { peer: EntityId }>
  | Tagged<"set_credit", { peer: EntityId; token: TokenId; limit: bigint }>
  | Tagged<"pay", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"lock", { peer: EntityId; token: TokenId; hold: Hold }>
  | Tagged<"resolve", { peer: EntityId; token: TokenId; id: HoldId; secret: Uint8Array }>
  | Tagged<"cancel", { peer: EntityId; token: TokenId; id: HoldId }>
  | Tagged<"expire", { peer: EntityId; token: TokenId; id: HoldId }>;

export type EntityInput = Arrival | Hook | Command;

/** What leaves an Entity: an Account message for a peer. */
export type Outbound = Readonly<{ from: EntityId; to: EntityId; msg: Msg<AccountTx> }>;

export type EntityFault =
  | Tagged<"self_account">
  | Tagged<"account_exists", { peer: EntityId }>
  | Tagged<"no_account", { peer: EntityId }>
  | Tagged<"account_refused", { fault: AccountFault }>;

/** What the owner of an input is told when it did not take effect. */
export type Notice =
  | Tagged<"command_refused", { command: Command; fault: EntityFault }>
  | Tagged<"unknown_peer", { from: EntityId }>
  | Tagged<"message_refused", { from: EntityId; outcome: Outcome<AccountFault> }>
  | Tagged<"tx_refused", { peer: EntityId; refused: Refused<AccountTx, AccountFault> }>;
