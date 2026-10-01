// A batch the Entity has decided to sign: its ops, the bytes the Depository decodes and the digest the Hanko signs.
//
// F1: a signed batch is final at its nonce. `processBatch` is permissionless and a signed batch never expires, so
// whoever holds it can land it later; the sealed batch is the record of exactly what was shown, and a replacement for
// it is always sealed at a fresh nonce.
import { encodeBatch } from "../../chain/batch/batch.ts";
import type { Deployment } from "../../chain/proof/deployment.ts";
import { batchHash } from "../../chain/proof/payload.ts";
import type { AbiFault } from "../../kernel/encoding/abi.ts";
import { err, flatMap, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { assemble } from "../op/assemble.ts";
import { MAX_ENCODED_BYTES } from "../op/limits.ts";
import type { JOp } from "../op/ops.ts";

/** `DepositoryBounds.MIN_BATCH_GAS_BUDGET`: a smaller signed budget is E10 before the Hanko is read. */
export const MIN_GAS_BUDGET = 500_000n;

/** `Types.JS_SAFE_NONCE_MAX`: a larger batch nonce is E10. */
export const MAX_NONCE = 9_007_199_254_740_991n;

export type SealedBatch = Readonly<{
  entity: string; nonce: bigint; gasBudget: bigint; ops: readonly JOp[]; encoded: string; digest: string;
}>;

export type SealFault =
  | AbiFault
  | Tagged<"budget_below_minimum", { gasBudget: bigint; min: bigint }>
  | Tagged<"nonce_beyond_limit", { nonce: bigint; max: bigint }>
  | Tagged<"batch_too_large", { bytes: number; max: number }>;

export type Sealing = Readonly<{ deployment: Deployment; entity: string; nonce: bigint; gasBudget: bigint }>;

const inBounds = (s: Sealing): Result<Sealing, SealFault> => {
  if (s.gasBudget < MIN_GAS_BUDGET) {
    return err({ _tag: "budget_below_minimum", gasBudget: s.gasBudget, min: MIN_GAS_BUDGET });
  }
  return s.nonce > MAX_NONCE ? err({ _tag: "nonce_beyond_limit", nonce: s.nonce, max: MAX_NONCE }) : ok(s);
};

const byteLength = (hex: string): number => (hex.length - 2) / 2;

/** The batch these ops make, encoded and hashed as the Depository will: the digest is what the Entity's Hanko signs. */
export const sealBatch = (s: Sealing, ops: readonly JOp[]): Result<SealedBatch, SealFault> =>
  flatMap(inBounds(s), () => flatMap(encodeBatch(assemble(s.gasBudget, ops)), (encoded) => {
    if (byteLength(encoded) > MAX_ENCODED_BYTES) {
      return err<SealFault>({ _tag: "batch_too_large", bytes: byteLength(encoded), max: MAX_ENCODED_BYTES });
    }
    return flatMap(batchHash(s.deployment, s.entity, encoded, s.nonce), (digest) =>
      ok({ entity: s.entity, nonce: s.nonce, gasBudget: s.gasBudget, ops, encoded, digest }));
  }));

/** The arguments of `Depository.processBatch(entityId, encodedBatch, hankoData, nonce)`. */
export type ProcessBatchCall = Readonly<{ entityId: string; encodedBatch: string; hankoData: string; nonce: bigint }>;

export const processBatchCall = (batch: SealedBatch, hankoData: string): ProcessBatchCall =>
  ({ entityId: batch.entity, encodedBatch: batch.encoded, hankoData, nonce: batch.nonce });
