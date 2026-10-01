// A group of ops as the Depository's `Batch`: each op joins the list of its kind, in the order it was queued. The
// contract fixes the order the lists run in; within a list the order is the planner's, which keeps age order.
import { emptyBatch, type Batch } from "../../chain/batch/batch.ts";
import { match } from "../../kernel/core/tagged.ts";
import type { JOp } from "./ops.ts";

const joined = (batch: Batch, op: JOp): Batch => match(op, {
  deposit: ({ leg }) => ({ ...batch, externalTokenToReserve: [...batch.externalTokenToReserve, leg] }),
  reserve_to_reserve: ({ transfer }) => ({ ...batch, reserveToReserve: [...batch.reserveToReserve, transfer] }),
  reserve_to_collateral: ({ funding }) => ({ ...batch, reserveToCollateral: [...batch.reserveToCollateral, funding] }),
  collateral_to_reserve: ({ withdrawal }) =>
    ({ ...batch, collateralToReserve: [...batch.collateralToReserve, withdrawal] }),
  settle: ({ settlement }) => ({ ...batch, settlements: [...batch.settlements, settlement] }),
  reserve_to_external: ({ withdrawal }) =>
    ({ ...batch, reserveToExternalToken: [...batch.reserveToExternalToken, withdrawal] }),
  dispute_start: ({ start }) => ({ ...batch, disputeStarts: [...batch.disputeStarts, start] }),
  dispute_counter: ({ counter }) => ({ ...batch, counterDisputes: [...batch.counterDisputes, counter] }),
  dispute_finalize: ({ finalization }) =>
    ({ ...batch, disputeFinalizations: [...batch.disputeFinalizations, finalization] }),
  reveal_secret: ({ reveal }) => ({ ...batch, revealSecrets: [...batch.revealSecrets, reveal] }),
});

/** The batch these ops make, with the gas budget the signer sets from its own simulation (J5). */
export const assemble = (gasBudget: bigint, ops: readonly JOp[]): Batch =>
  ops.reduce(joined, emptyBatch(gasBudget));
