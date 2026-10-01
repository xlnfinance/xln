// What the Host does with an Entity's chain action before the J batch builder sees it: a JAction is the Entity's ask in
// its own words (a peer, a token, an amount), and the builder queues a JOp, the Depository's own words (a token id, the
// entities of a funding, the canonical transformer). The Host's `chain` effect leaves a committed row only
// (R-DURABLE), so the op made here is made from a row that is already the WAL's.
//
// Two actions are the Host's to make from what the Entity says and the chain's addresses. The others hold signed
// material the Entity does not keep (a counter needs the proof body and its signature, a C2R or a settlement the
// counterparty's Hanko), so the Host that holds the signatures makes those; here they are named, never guessed.
import type { EntityId, JAction } from "../entity/model.ts";
import type { JOp } from "../j/op/ops.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import { bytesToHex } from "../kernel/encoding/bytes.ts";

/** What the chain says that an Entity's action does not: the one transformer a reveal may name (Depository `E2`). */
export type ChainWorld = Readonly<{ transformer: string }>;

export type OpFault = Tagged<"needs_signature", { action: JAction["_tag"] }>;

/**
 * The op for an Entity's action. The Entity's token is the Depository's internal token id (the Account layer and the
 * chain count tokens the same way), and a deposit funds the Account of `self` with `peer` out of `self`'s own reserve.
 */
export const opOf = (self: EntityId, action: JAction, world: ChainWorld): Result<JOp, OpFault> => {
  switch (action._tag) {
    case "deposit":
      return ok({
        _tag: "reserve_to_collateral",
        funding: {
          tokenId: action.token,
          receivingEntity: self,
          pairs: [{ entity: action.peer, amount: action.amount }],
        },
      });
    case "reveal":
      return ok({
        _tag: "reveal_secret",
        reveal: { transformer: world.transformer, secret: bytesToHex(action.secret) },
      });
    case "counter":
    case "c2r":
    case "settle":
      return err({ _tag: "needs_signature", action: action._tag });
  }
};
