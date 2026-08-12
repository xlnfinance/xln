import { cloneAccountReplica } from '../state/state-clone';
import type { AccountReplica, Delta, SettlementDiff } from '../../types/account';
import { invalidateAccountMapCommitment } from '../commitment/map-commitment';
import { getDefaultCreditLimit } from '../utils';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import { assertSettlementTokenId } from '../../protocol/settlement/operations';
import { ensureDelta } from '../tx/delta-utils';

export const ensureSettlementDelta = (account: AccountReplica, tokenId: number): Delta => {
  assertSettlementTokenId(tokenId, 'delta');
  const existing = account.state.deltas.get(tokenId);
  if (existing) return existing;
  const creditLimit = getDefaultCreditLimit(tokenId);
  const created = ensureDelta(account.state, tokenId);
  created.leftCreditLimit = creditLimit;
  created.rightCreditLimit = creditLimit;
  return created;
};

const applyProjectedDiff = (account: AccountReplica, diff: SettlementDiff): void => {
  const delta = ensureSettlementDelta(account, diff.tokenId);
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
  for (const tokenId of forgiveTokenIds) ensureSettlementDelta(projected, tokenId);
  invalidateAccountMapCommitment(projected.state, 'deltas');
  return projected;
};
