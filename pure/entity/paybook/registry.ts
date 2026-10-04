// The registry at the view (R-REGISTRY-AT-VIEW): the chain pays a clause from `DeltaTransformer.hashToTimestamp`, the
// second a secret was first shown at, whoever showed it and by whatever door (DeltaTransformer.sol 289-299: paid iff
// the value is not 0 and not after the second the lock's body signs). The Entity decides on that value, read by the
// Host at the J block the frame decides at, and compares it with the lock's second exactly as the contract does: never
// with heights. A frame is handed the readings it needs and no others (`wantsOf`), so the Entity stays pure and a
// replay decides what the first run did.
import type { JHeight, JView } from "../../account/clause/clock.ts";
import type { HoldId, TokenId } from "../../account/model.ts";
import { ledgerOf } from "../../account/state.ts";
import type { AccountTx } from "../../account/tx.ts";
import type { EntityId, EntityInput, EntityState, Reading } from "../model.ts";

/** The readings of one frame, by hashlock, and the second a lock's deadline height is signed as. */
export type Registry = Readonly<{
  seconds: ReadonlyMap<string, bigint>;
  secondsOf: (deadline: JHeight) => bigint;
}>;

/**
 * What the registry showed at the frame's own view. A reading of another block says nothing of this one: a secret shown
 * between the two would be missed, so it is not a reading here.
 */
export const registryOf = (
  readings: readonly Reading[], view: JView, secondsOf: Registry["secondsOf"],
): Registry => ({
  seconds: new Map(
    readings.filter((r) => r.at === view).map((r): readonly [string, bigint] => [r.hashlock, r.seconds])),
  secondsOf,
});

/** The contract's rule: a clause is paid iff a secret was shown, and not after the second the lock signs. */
export const paid = (shown: bigint, signed: bigint): boolean => shown !== 0n && shown <= signed;

/** The hashlock of an open hold of `peer`'s Account, by the token and id an expiry names. */
const holdsOf = (state: EntityState, peer: EntityId, token: TokenId, id: HoldId): readonly string[] => {
  const account = state.accounts.get(peer);
  const found = account === undefined ? undefined : ledgerOf(account.state, token).holds.find((h) => h.id === id);
  return found === undefined ? [] : [found.hashlock];
};

/** The hashlocks a list of an Account's txs decide on: the lock's own, and the hold an expiry names. */
export const txsDecide = (state: EntityState, peer: EntityId, txs: readonly AccountTx[]): readonly string[] =>
  txs.flatMap((tx) => {
    if (tx._tag === "lock") return [tx.hold.hashlock];
    return tx._tag === "expire" ? holdsOf(state, peer, tx.token, tx.id) : [];
  });

/** The hashlocks the inputs of a frame decide on: the locks and expiries of a peer's frame, and of a command. */
const inputsDecide = (state: EntityState, inputs: readonly EntityInput[]): readonly string[] =>
  inputs.flatMap((input) => {
    switch (input._tag) {
      case "peer_message":
        return input.msg._tag === "frame" ? txsDecide(state, input.from, input.msg.frame.txs) : [];
      case "lock":
        return [input.hold.hashlock];
      case "forward":
        return [input.hashlock];
      case "expire":
        return holdsOf(state, input.peer, input.token, input.id);
      default:
        return [];
    }
  });

/**
 * The hashlocks a frame may decide on, which the Host reads at the frame's view before it begins: the locks, expiries
 * and forwards in its inputs, those queued on any Account (they are judged again when the Account proposes), and the
 * forwards that wait for their lock. A set the frame's own work bounds, not the secrets strangers show.
 */
export const wantsOf = (state: EntityState, inputs: readonly EntityInput[]): readonly string[] => {
  const queued = [...state.accounts].flatMap(([peer, r]) => txsDecide(state, peer, r.mempool));
  const forwards = [...state.paybook].flatMap(([hashlock, entry]) => (entry._tag === "forward" ? [hashlock] : []));
  return [...new Set([...inputsDecide(state, inputs), ...queued, ...forwards])].toSorted();
};
