// What the Host does with an Entity's chain action before the J batch builder sees it: a JAction is the Entity's ask in
// its own words (a peer, a token, an amount), and the builder queues a JOp, the Depository's own words (a token id, the
// entities of a funding, the canonical transformer). The Host's `chain` effect leaves a committed row only
// (R-DURABLE), so the op made here is made from a row that is already the WAL's.
//
// Four actions are the Host's to make from what the Entity says and the chain's addresses; a dispute start is one of
// them since the Entity keeps its peer's signature over the committed head (R-SIGNED-HEADS-ON-THE-WIRE) and says the
// proof body, nonce, epoch and author with it. The others hold signed material the Entity does not keep (a counter
// needs the starter's proof, a C2R or a settlement the counterparty's Hanko); here they are named, never guessed.
import type { EntityId, JAction } from "../entity/model.ts";
import type { JOp } from "../j/op/ops.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import { err, ok, type Result } from "../kernel/core/result.ts";
import { proofBodyHash } from "../chain/proof/proof.ts";
import { bytesToHex } from "../kernel/encoding/bytes.ts";

/** A token as the Depository knows it from outside: the contract that holds it, and which token of that contract. */
export type ExternalToken = Readonly<{ contractAddress: string; externalTokenId: bigint; tokenType: bigint }>;

/**
 * What the chain says that an Entity's action does not: the one transformer a reveal may name (Depository `E2`), and
 * the external token behind each internal token id that a `fund` may name.
 */
export type ChainWorld = Readonly<{ transformer: string; tokens: ReadonlyMap<bigint, ExternalToken> }>;

const NO_COMMITMENT = `0x${"00".repeat(32)}`;

export type OpFault =
  | Tagged<"needs_signature", { action: JAction["_tag"] }>
  | Tagged<"unknown_token", { token: bigint }>
  | Tagged<"unhashable_proof">;

/**
 * The op for an Entity's action. The Entity's token is the Depository's internal token id (the Account layer and the
 * chain count tokens the same way), and a deposit funds the Account of `self` with `peer` out of `self`'s own reserve.
 */
export const opOf = (self: EntityId, action: JAction, world: ChainWorld): Result<JOp, OpFault> => {
  switch (action._tag) {
    case "fund": {
      const external = world.tokens.get(action.token);
      return external === undefined
        ? err({ _tag: "unknown_token", token: action.token })
        : ok({
          _tag: "deposit",
          leg: { entity: self, ...external, internalTokenId: action.token, amount: action.amount },
        });
    }
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
    case "dispute_start": {
      const hashed = proofBodyHash(action.body);
      return hashed.ok
        ? ok({
          _tag: "dispute_start",
          start: {
            counterentity: action.peer, nonce: action.nonce, ondeltaEpoch: action.epoch,
            proposerIsLeft: action.proposerIsLeft, proofbodyHash: hashed.value, initialProofbody: action.body,
            watchSeed: action.body.watchSeed, sig: action.sig, starterInitialArguments: "0x",
            starterCounterArguments: "0x", starterCounterProofCommitment: NO_COMMITMENT,
          },
        })
        : err({ _tag: "unhashable_proof" });
    }
    case "counter":
    case "c2r":
    case "settle":
      return err({ _tag: "needs_signature", action: action._tag });
  }
};
