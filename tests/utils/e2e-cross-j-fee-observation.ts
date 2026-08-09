/**
 * Frame fee txs and requestedRebalanceFeeState.feePaidUpfront are two views of
 * the same prepaid rebalance fee. They must agree when both are present; adding
 * unequal observations invents a fee, while magnitude-only dedupe could hide
 * two distinct equal fees. Incoherent E2E evidence therefore fails loud.
 */
export const transferFeeAmount = (frameFee: bigint, rebalanceFeeDelta: bigint): bigint => {
  if (frameFee < 0n) throw new Error(`TRANSFER_FRAME_FEE_NEGATIVE:${frameFee}`);
  if (rebalanceFeeDelta < 0n) throw new Error(`TRANSFER_REBALANCE_FEE_NEGATIVE:${rebalanceFeeDelta}`);
  if (frameFee > 0n && rebalanceFeeDelta > 0n && frameFee !== rebalanceFeeDelta) {
    throw new Error(`TRANSFER_FEE_OBSERVATION_MISMATCH:${frameFee}:${rebalanceFeeDelta}`);
  }
  return frameFee > 0n ? frameFee : rebalanceFeeDelta;
};
