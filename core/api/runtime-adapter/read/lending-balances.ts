import { lendingExitAmount } from '../../../protocol/dispute/lending-covenant';
import type { StorageAccountDoc } from '../../../storage/types';

/** Signed claim value from the left party's perspective at the committed
 * Account clock (or its observed dispute clock). This is neither cash nor
 * payment capacity. Early cooperative savings cancellation may waive interest.
 * Both bank and customer read the same claims with opposite signs; no peer is
 * presumed to run a bank HTTP endpoint. Aggregate before compacting details.
 */
export function accountLendingBalances(account: StorageAccountDoc): Map<number, bigint> {
  const timestamp = account.activeDispute?.disputeStartTimestamp ?? account.currentFrame.timestamp;
  const totals = new Map<number, bigint>();
  for (const claim of account.state.subcontracts?.values() ?? []) {
    if (!('kind' in claim)) continue;
    const amount = lendingExitAmount(claim, timestamp);
    totals.set(claim.tokenId, (totals.get(claim.tokenId) ?? 0n) + (claim.creditorIsLeft ? amount : -amount));
  }
  return totals;
}
