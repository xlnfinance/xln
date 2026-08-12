import { cloneAccountReplica } from '../state/state-clone';
import type { AccountReplica, Delta, SettlementDiff } from '../../types/account';
import { createDefaultDelta } from '../state/delta';
import { invalidateAccountMapCommitment } from '../commitment/map-commitment';
import { getDefaultCreditLimit } from '../utils';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';

const createSettlementDelta = (tokenId: number): Delta => {
  const creditLimit = getDefaultCreditLimit(tokenId);
  return createDefaultDelta(tokenId, { left: creditLimit, right: creditLimit });
};

const requireProjectedDelta = (account: AccountReplica, tokenId: number): Delta => {
  const existing = account.state.deltas.get(tokenId);
  if (existing) return existing;
  const created = createSettlementDelta(tokenId);
  account.state.deltas.set(tokenId, created);
  return created;
};

const applyProjectedDiff = (account: AccountReplica, diff: SettlementDiff): void => {
  const delta = requireProjectedDelta(account, diff.tokenId);
  const collateral = delta.collateral + diff.collateralDiff;
  const ondelta = delta.ondelta + diff.ondeltaDiff;
  if (collateral < 0n || collateral > UINT256_MAX) {
    throw new Error(`SETTLEMENT_PROJECTED_COLLATERAL_RANGE:token=${diff.tokenId}`);
  }
  if (ondelta < INT256_MIN || ondelta > INT256_MAX) {
    throw new Error(`SETTLEMENT_PROJECTED_ONDELTA_RANGE:token=${diff.tokenId}`);
  }
  delta.collateral = collateral;
  delta.ondelta = ondelta;
};

/** Exact Account projection produced by Account._settleDiffs before its event. */
export const projectAccountAfterSettlement = (
  account: AccountReplica,
  diffs: readonly SettlementDiff[],
  forgiveTokenIds: readonly number[],
): AccountReplica => {
  const projected = cloneAccountReplica(account);
  for (const diff of diffs) applyProjectedDiff(projected, diff);
  for (const tokenId of forgiveTokenIds) requireProjectedDelta(projected, tokenId);
  invalidateAccountMapCommitment(projected.state, 'deltas');
  return projected;
};
