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
import type { JHeight, JView } from "../account/clause/clock.ts";
import type { AccountFault, AccountState, Hold, HoldId, Leg, Side, TokenId } from "../account/model.ts";
import type { ProofBody } from "../chain/proof/proof.ts";
import type { Held } from "../account/state.ts";
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
  /** The newest head each peer signed that the Account committed, with its signature: what a dispute starts with. */
  proofs: ReadonlyMap<EntityId, PeerProof>;
  waiting: ReadonlyMap<EntityId, JView>;
  revealed: ReadonlyMap<EntityId, readonly string[]>;
  chain: ReadonlyMap<EntityId, ChainFacts>;
  paybook: Paybook;
}>;

/**
 * A peer's signature over the head the Account committed at `slot`: the proof of that state, enforceable on chain.
 * `author` is the side whose frame made the head, which the digest names (`proposerIsLeft` on the chain).
 */
export type PeerProof = Readonly<{ head: FrameHash; slot: number; author: Side; sig: string }>;

export const emptyEntity = (id: EntityId): EntityState =>
  ({
    id, accounts: new Map(), proofs: new Map(), waiting: new Map(), revealed: new Map(), chain: new Map(),
    paybook: new Map(),
  });

/**
 * What the Entity does about an HTLC that is, or will be, locked to it, by hashlock (one is open per hashlock in an
 * Account, R-ONE-LOCK-PER-HASH). `forward` waits for a lock from `from` and then locks on `to` with a shorter
 * deadline and `route`, the hops after `to` (a lock that came with a route makes the entry itself); `locked` is that
 * lock, queued, waiting for `to` to resolve or cancel; `pass` and `fail` are what `to` answered, to be passed on to
 * `from`; `receive` is a payment this Entity is the payee of, resolved on the lock of `from` when it is for the token
 * and amount that was asked.
 */
export type Entry =
  | Tagged<"forward", { from: EntityId; to: EntityId; route: readonly EntityId[] }>
  | Tagged<"locked", { from: EntityId; to: EntityId; token: TokenId; id: HoldId }>
  | Tagged<"pass", { from: EntityId; secret: Uint8Array }>
  | Tagged<"fail", { from: EntityId }>
  | Tagged<"receive", { from: EntityId; token: TokenId; amount: bigint; secret: Uint8Array }>;

export type Paybook = ReadonlyMap<string, Entry>;

/** Response windows in seconds, one per side, as the signed proofs of an Account carry them. */
export type Windows = Readonly<{ left: bigint; right: bigint }>;

/**
 * What an Entity knows of the chain for one Account, from what its Host reports and from its own frames (never derived
 * from an earlier proof): the epoch and the stored nonce the chain is at, how many frames have been co-signed since the
 * epoch began, the windows its signed proofs carry, whether a dispute the peer started is open against it, and whether
 * the node has co-signed a settlement or a collateral-to-reserve that has not landed yet (`frozen`, R-COSIGN-FREEZE).
 * `cosigned` counts the operations the node has co-signed on this Account, for good: the `cosigned`-th is the serial
 * its action carries, and the only one whose lapse ends a freeze. `held` is what the chain last said it holds for each
 * token (R-J-COLLATERAL), at most one row per token and at most as many tokens as a proof body carries: a token waits
 * there until a signed frame gives the Account a ledger for it. `starting` is a dispute the node itself asked for.
 */
export type ChainFacts = Readonly<{
  epoch: bigint; stored: bigint; frames: bigint; windows: Windows | undefined; against: Against | undefined;
  frozen: boolean; cosigned: bigint; held: ReadonlyMap<TokenId, Held>; starting: Starting | undefined;
}>;

/**
 * A dispute the peer started against this node in the epoch it is in (R-DISPUTE-WATCH): the proof it opened with
 * (`nonce`, `proposerIsLeft`, `bodyHash`), the end of its window and whether the chain's clock has passed it, and the
 * node's own answer: the counter it asked the chain for with the newest proof it holds.
 */
export type Against = Readonly<{
  nonce: bigint; proposerIsLeft: boolean; bodyHash: string; window: bigint; over: boolean; answer: Answer | undefined;
}>;

/**
 * The counter the node asked for, whether the chain registered it (only a registered counter is finalized with), and
 * whether the Host dropped it because it would revert, after which it is not asked again.
 */
export type Answer = Readonly<{ counter: DisputeCounter; registered: boolean; lapsed: boolean }>;

/**
 * A dispute the node asked the chain to open (R-DISPUTE-START, R-DISPUTE-FINALIZE): what it asked with, the end of the
 * window the chain gave it once it is open (`window`, in the chain's own seconds, as the chain logged it), and whether
 * the chain's clock has passed that end (`over`). Once over, the node asks to finalize it with what it started with,
 * and keeps asking until the chain says the dispute is over.
 */
export type Starting =
  Readonly<{ start: DisputeStart; window: bigint | undefined; over: boolean; countered: boolean }>;

// What a frame takes in. `sig` is the sender's signature over the head the message commits to
// (R-SIGNED-HEADS-ON-THE-WIRE): a frame's, or the ack's.
export type PeerMessage = Tagged<"peer_message", { from: EntityId; msg: Msg<AccountTx>; sig?: string }>;

/**
 * What the Host saw on the J chain about the Account with `peer`. A repeat or an older report changes nothing, so the
 * Host may deliver an event again: `j_epoch` is the chain moving the Account's epoch on (a settlement, a withdrawal
 * or a finished dispute landed), with the nonce it stores now; `j_dispute` is a dispute started in `epoch` by `by`,
 * whose start carried `nonce` and whose window ends at the chain's second `timeout` (`proposerIsLeft` and `bodyHash`
 * name the proof it opened with); `j_countered` is a counter the chain registered for the dispute, with the proof it
 * named (a registered counter is not the end of the dispute: the finalize is); `j_window_over` is the chain's
 * clock having passed that end for a dispute this node started or answers (R-DISPUTE-FINALIZE); `j_dispute_over` is
 * that dispute finalized, which pays the Account out; `j_start_lapsed` is the Host telling that the start this node
 * asked for (the one of that `nonce`) was dropped from its draft because it would revert and so will never open a
 * dispute (R-DISPUTE-LAPSED); `j_counter_lapsed` is the same for the counter this node asked for (the one of that
 * `nonce`), which the chain would revert for good, so the node stops asking for it; `j_op_lapsed` is a co-signed
 * settlement or withdrawal that can no longer land (its batch reverted, its signatures ran out), named by the serial
 * its action carried: a report of an operation that is not the one out (a repeat, or an older one) changes nothing;
 * `j_collateral` is what the chain holds for one token of the Account now (R-J-COLLATERAL): a state, not a change, so
 * a repeat is a no-op.
 */
export type JEvent =
  | Tagged<"j_epoch", { peer: EntityId; epoch: bigint; stored: bigint }>
  | Tagged<
    "j_dispute",
    {
      peer: EntityId; epoch: bigint; by: Side; nonce: bigint; timeout: bigint; proposerIsLeft: boolean;
      bodyHash: string;
    }
  >
  | Tagged<"j_countered", { peer: EntityId; nonce: bigint; proposerIsLeft: boolean; bodyHash: string }>
  | Tagged<"j_window_over", { peer: EntityId }>
  | Tagged<"j_dispute_over", { peer: EntityId }>
  | Tagged<"j_start_lapsed", { peer: EntityId; nonce: bigint }>
  | Tagged<"j_counter_lapsed", { peer: EntityId; nonce: bigint }>
  | Tagged<"j_collateral", { peer: EntityId; token: TokenId; collateral: bigint; ondelta: bigint }>
  | Tagged<"j_op_lapsed", { peer: EntityId; serial: bigint }>;

/** What a peer asks the node to co-sign: a withdrawal of collateral as a shortcut (C2R) or as a settlement. */
export type CosignOp =
  | Tagged<"c2r", { token: TokenId; amount: bigint }>
  | Tagged<"settle", { token: TokenId; amount: bigint }>;

export type CosignAsk = Tagged<"cosign_ask", { from: EntityId; op: CosignOp }>;

export type Arrival = PeerMessage | JEvent | CosignAsk;

/** The Host's timer for `peer`'s Account ran out: its pending frame is sent again, so a lost frame cannot wedge it. */
export type Hook = Tagged<"resend_due", { peer: EntityId }>;

/**
 * A command that becomes a tx of the Account's next frame. The swap commands (R-ENTITY-SWAP-COMMANDS) are a quote
 * (`offer`, its maker always this node), the taker's fill (the first one accepts the quote), the maker's withdrawal
 * (`retract`) and `lapse`, which anyone may ask once the offer is past due.
 */
export type AccountCommand =
  | Tagged<"set_credit", { peer: EntityId; token: TokenId; limit: bigint }>
  | Tagged<"pay", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"lock", { peer: EntityId; token: TokenId; hold: Hold; route?: readonly EntityId[] }>
  | Tagged<"resolve", { peer: EntityId; token: TokenId; id: HoldId; secret: Uint8Array }>
  | Tagged<"cancel", { peer: EntityId; token: TokenId; id: HoldId }>
  | Tagged<"expire", { peer: EntityId; token: TokenId; id: HoldId }>
  | Tagged<"offer", { peer: EntityId; id: HoldId; give: Leg; want: Leg; deadline: JHeight }>
  | Tagged<"fill", { peer: EntityId; id: HoldId; ratio: number }>
  | Tagged<"retract", { peer: EntityId; id: HoldId }>
  | Tagged<"lapse", { peer: EntityId; id: HoldId }>;

/**
 * A command that is about the chain, not the Account's frames. `fund` is the one that names no peer: the node's own
 * tokens move from the wallet that holds them into its reserve in the Depository, and the reserve is what a `deposit`
 * then moves to an Account's collateral. The approval that lets the Depository pull the tokens is the wallet's, not
 * the Entity's.
 */
export type ChainCommand =
  | Tagged<"fund", { token: TokenId; amount: bigint }>
  | Tagged<"deposit", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"set_windows", { peer: EntityId; windows: Windows }>
  | Tagged<"withdraw", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"dispute", { peer: EntityId }>;

/** What an Entity is told about a payment that passes through it, before the lock for it arrives. */
export type PaybookCommand =
  | Tagged<"forward", { hashlock: string; from: EntityId; to: EntityId }>
  | Tagged<"expect", { hashlock: string; from: EntityId; token: TokenId; amount: bigint; secret: Uint8Array }>;

export type Command = Tagged<"open_account", { peer: EntityId }> | AccountCommand | ChainCommand | PaybookCommand;

export type EntityInput = Arrival | Hook | Command;

/**
 * What leaves an Entity: an Account message for a peer. A frame and an ack commit their sender to a head: `attest` is
 * that head, for the Host to sign before the message goes (the Entity holds no key); `sig` is the signature the Host
 * put on it, and the only part of the two that crosses the link.
 */
export type Outbound = Readonly<{
  from: EntityId; to: EntityId; msg: Msg<AccountTx>; attest?: FrameHash; sig?: string;
}>;

/** What a PeerMessage carries of an Outbound: the sender, the message and the signature the sender put on it. */
export const heardOf = (o: Outbound): PeerMessage =>
  ({ _tag: "peer_message", from: o.from, msg: o.msg, ...(o.sig === undefined ? {} : { sig: o.sig }) });

/**
 * What an Entity asks of the J chain: data the Host turns into a batch (the bytes are the chain layer's). A `reveal` is
 * a payee showing a secret on chain because its resolve is still unacked when the clause's deadline comes near
 * (R-HTLC-CLOCK c); `revealed` on the Entity keeps a hashlock asked once for as long as its hold is open.
 */
export type JAction =
  | Tagged<"fund", { token: TokenId; amount: bigint }>
  | Tagged<"reveal", { peer: EntityId; token: TokenId; id: HoldId; hashlock: string; secret: Uint8Array }>
  | Tagged<"deposit", { peer: EntityId; token: TokenId; amount: bigint }>
  | Tagged<"dispute_start", DisputeStart>
  | Tagged<"dispute_finalize", DisputeFinalize>
  | Tagged<"counter", DisputeCounter>
  | Tagged<"c2r", { peer: EntityId; serial: bigint; token: TokenId; amount: bigint }>
  | Tagged<"settle", { peer: EntityId; serial: bigint; token: TokenId; amount: bigint; folds: readonly Fold[] }>;

/**
 * A dispute the node starts with the peer's signature over the newest committed head: the proof body of that state,
 * the nonce and epoch the head was signed at, and who authored it. The chain's dispute start is made from exactly this.
 */
export type DisputeStart = Readonly<{
  peer: EntityId; nonce: bigint; epoch: bigint; proposerIsLeft: boolean; body: ProofBody; sig: string;
}>;

/**
 * A counter to the peer's dispute with the newest proof the node holds: the dispute it answers (`initial`: its nonce
 * and the hash of the body it opened with), the proof (`nonce`, author, body, the peer's signature over it) and the
 * head of the frame that proof was signed over.
 */
export type DisputeCounter = Readonly<{
  peer: EntityId; nonce: bigint; head: FrameHash; proposerIsLeft: boolean; body: ProofBody; sig: string;
  initial: Readonly<{ nonce: bigint; bodyHash: string }>;
}>;

/**
 * A dispute the node finalizes after its window. One it started and nobody countered is finalized with the state it
 * started from: the chain settles on the opening proof. One it answered is finalized with its registered counter's
 * proof (`nonce`, `proposerIsLeft`, `body` are the counter's), naming the dispute it answers in `initial`
 * (R-DISPUTE-WATCH).
 * `startedByLeft` is whether the side that started the dispute is the Account's Left.
 */
export type DisputeFinalize = Readonly<{
  peer: EntityId; nonce: bigint; proposerIsLeft: boolean; body: ProofBody; startedByLeft: boolean;
  initial: Readonly<{ nonce: bigint; bodyHash: string }> | undefined;
}>;

/** The offdelta of a token that a settlement folds into its ondelta, so that the epoch advance cannot erase it. */
export type Fold = Readonly<{ token: TokenId; offdelta: bigint }>;

export type EntityFault =
  | Tagged<"self_account">
  | Tagged<"account_exists", { peer: EntityId }>
  | Tagged<"no_account", { peer: EntityId }>
  | Tagged<"account_refused", { fault: PeerFault }>
  | Tagged<"bad_fund", { amount: bigint }>
  | Tagged<"deposit_before_cosign">
  | Tagged<"bad_windows", { windows: Windows }>
  | Tagged<"windows_shorten", { current: Windows }>
  | Tagged<"already_cosigned">
  | Tagged<"frame_in_flight">
  | Tagged<"unfolded_c2r", { folds: readonly Fold[] }>
  | Tagged<"entry_exists", { hashlock: string }>
  | Tagged<"no_proof", { why: "none" | "unsignable" }>
  | Tagged<"dispute_pending">
  | Tagged<"account_disputed">;

/** What the owner of an input is told when it did not take effect. */
export type Notice =
  | Tagged<"command_refused", { command: Command; fault: EntityFault }>
  | Tagged<"unknown_peer", { from: EntityId }>
  | Tagged<"holding_dropped", { peer: EntityId; token: TokenId }>
  | Tagged<"offdelta_rebased", { peer: EntityId; token: TokenId; epoch: bigint; offdelta: bigint }>
  | Tagged<"cosign_refused", { from: EntityId; op: CosignOp; fault: EntityFault }>
  | Tagged<"message_refused", { from: EntityId; outcome: Outcome<PeerFault> }>
  | Tagged<"message_unsigned", { from: EntityId; head: FrameHash; why: "missing" | "wrong" }>
  | Tagged<"tx_refused", { peer: EntityId; refused: Refused<AccountTx, PeerFault> }>;
