// The signed gas budget (J5, R-SIMULATE): what a batch may spend, and what the chain asks of the transaction.
//
// The Depository runs a soft batch's ops in a self-call that gets exactly the signed budget, and reverts without taking
// the nonce unless the transaction carries `budget * 64 / 63 + BATCH_POST_CALL_RESERVE` on top of the outer Hanko check
// (the prelude, paid before the budget). So the signer sizes the budget from the gas of that self-call alone, adds a
// margin, and never signs one whose whole requirement is above the chain's transaction gas cap.
import { MIN_GAS_BUDGET } from "../batch/sealed.ts";

/** `Depository.BATCH_POST_CALL_RESERVE`: kept outside the signed budget so the self-call is handed all of it. */
export const POST_CALL_RESERVE = 30_000n;

/** The margin on the measured self-call gas, in percent. A named choice (decisions-pending), not a contract number. */
export const MARGIN_PERCENT = 10n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The gas a transaction must carry for a batch of this budget, or it reverts `BatchGasStarved` and spends no nonce. */
export const requirement = (prelude: bigint, budget: bigint): bigint =>
  prelude + ceilDiv(budget * 64n, 63n) + POST_CALL_RESERVE;

/** The budget to sign for a self-call that measured `applyGas`: that gas plus the margin, never below the minimum. */
export const budgetFor = (applyGas: bigint): bigint => {
  const sized = applyGas + (applyGas * MARGIN_PERCENT) / 100n;
  return sized < MIN_GAS_BUDGET ? MIN_GAS_BUDGET : sized;
};

/** Whether a transaction for this budget fits the chain's transaction gas cap. */
export const fitsCap = (cap: bigint, prelude: bigint, budget: bigint): boolean => requirement(prelude, budget) <= cap;

/** The largest budget whose requirement still fits the cap: the budget a probe simulation is run at. */
export const maxBudget = (cap: bigint, prelude: bigint): bigint => {
  const room = cap - prelude - POST_CALL_RESERVE;
  return room > 0n ? (room * 63n) / 64n : 0n;
};
