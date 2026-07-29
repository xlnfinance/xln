import { cloneAccountState } from './state-clone';
import type { AccountReplica, Delta, SettlementDiff } from '../types';
import { createDefaultDelta } from './delta';
import { invalidateAccountMapCommitment } from './map-commitment';
import { getDefaultCreditLimit } from './utils';

const UINT256_MAX = (1n << 256n) - 1n;
const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;

const createSettlementDelta = (tokenId: number): Delta => {
  const creditLimit = getDefaultCreditLimit(tokenId);
  return createDefaultDelta(tokenId, { left: creditLimit, right: creditLimit });
};

const requireProjectedDelta = (account: AccountReplica, tokenId: number): Delta => {
  const existing = account.deltas.get(tokenId);
  if (existing) return existing;
  const created = createSettlementDelta(tokenId);
  account.deltas.set(tokenId, created);
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
  const projected = cloneAccountState(account);
  for (const diff of diffs) applyProjectedDiff(projected, diff);
  for (const tokenId of forgiveTokenIds) requireProjectedDelta(projected, tokenId);
  invalidateAccountMapCommitment(projected, 'deltas');
  return projected;
};
