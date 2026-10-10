import { buildCanonicalProofBatches } from '../../protocol/dispute/proof-builder';
import { BLOCKCHAIN } from '../../config/constants';
import type { AccountState, AccountTx } from '../../types/account';

/** Admission charge for the pinned stock proof program, not eth_estimateGas.
 * Reserve cold full-width debt writes for EVERY token, regardless of current
 * collateral. The 3M base reserves the contract-permitted 64 KiB starter
 * argument commitment, intrinsic gas and Hanko/dispatch. Charge actual canonical
 * clause splits (including uint256 allowance splits), and calldata/transformer work for every live condition. Financial
 * resolution cannot rely on today's warm slots, reserves or zero-fill branch.
 * Unknown custom programs have no established bound and cannot admit new work.
 */
const ACCOUNT_DISPUTE_GAS_BUDGET = BLOCKCHAIN.PROCESS_BATCH_GAS_LIMIT;
export const disputeGasCharge = (tokens: number, conditions: number, clauses: number): number =>
  3_000_000 + 200_000 * tokens + 10_000 * conditions + (50_000 + 4_000 * tokens) * clauses;

export const accountDisputeGasCharge = (
  state: AccountState,
  additionalTokens = 0,
  additionalConditions = 0,
): number => {
  if ((state.subcontracts?.size ?? 0) > 0) return Number.MAX_SAFE_INTEGER;
  let swaps = 0;
  for (const offer of state.swapOffers.values()) if (!offer.crossJurisdiction) swaps++;
  return disputeGasCharge(
    state.deltas.size + additionalTokens,
    state.locks.size + swaps + (state.pulls?.size ?? 0) + additionalConditions,
    buildCanonicalProofBatches({ state }).length + additionalConditions,
  );
};

/** Chain observations and exits remain executable for previously signed states.
 * The exception never admits another lock, offer, payment or borrowing request.
 * A resolved obligation may not increase the prepaid stock-program footprint.
 */
export const disputeGasAdmissionError = (before: number, after: number, tx: AccountTx): string | undefined => {
  if (after <= ACCOUNT_DISPUTE_GAS_BUDGET || tx.type === 'j_event_claim') return undefined;
  // Re-adding an existing row is idempotent; a genuinely new row raises the
  // charge. Unknown custom programs use a sentinel, not a comparable charge.
  if (tx.type === 'add_delta' && after === before && after < Number.MAX_SAFE_INTEGER) return undefined;
  const resolving =
    tx.type === 'htlc_resolve' ||
    tx.type === 'swap_resolve' ||
    tx.type === 'swap_cancel_request' ||
    tx.type === 'cross_pull_close' ||
    tx.type === 'settle_transition' ||
    tx.type === 'lending_repay' ||
    tx.type === 'lending_close_request' ||
    tx.type === 'lending_close_payout';
  if (resolving && after <= before) return undefined;
  return `ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:${after}/${ACCOUNT_DISPUTE_GAS_BUDGET}`;
};

/** Cross-j opening work already belongs to a paired Entity cohort. Keep it
 * queued until other obligations resolve; dropping one leg loses the cohort.
 * No over-budget candidate is signed while waiting.
 */
export const disputeGasOpeningDeferred = (tx: AccountTx, message: string): boolean =>
  (tx.type === 'cross_pull_lock' || (tx.type === 'swap_offer' && !!tx.data.crossJurisdiction)) &&
  message.startsWith('ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:');
