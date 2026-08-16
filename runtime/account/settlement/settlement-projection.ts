/**
 * Pure post-settlement Delta projection.
 *
 * Solidity settlement changes only collateral/ondelta rows. Building another
 * Account candidate here would nest transitions and duplicate ownership. The
 * proof builder already walks every Delta to create its flat contract array,
 * so it receives only these O(changed-token) replacements.
 */
import type { AccountReplica, Delta, SettlementDiff } from '../../types/account';
import { getDefaultCreditLimit } from '../utils';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import { assertSettlementTokenId } from '../../protocol/settlement/operations';
import { assertAccountDeltaCapacity, createDefaultDelta } from '../state/delta';

export const createSettlementDeltaValue = (account: AccountReplica, tokenId: number): Delta => {
  assertSettlementTokenId(tokenId, 'delta');
  const existing = account.state.deltas.get(tokenId);
  if (existing) return { ...existing };
  const created = createDefaultDelta(tokenId);
  const creditLimit = getDefaultCreditLimit(tokenId);
  created.leftCreditLimit = creditLimit;
  created.rightCreditLimit = creditLimit;
  return created;
};

export const projectSettlementDeltaOverrides = (
  account: AccountReplica,
  diffs: readonly SettlementDiff[],
  forgiveTokenIds: readonly number[],
): ReadonlyMap<number, Delta> => {
  const projected = new Map<number, Delta>();
  const getProjected = (tokenId: number): Delta => {
    const current = projected.get(tokenId);
    if (current) return current;
    if (!account.state.deltas.has(tokenId)) {
      const projectedNewRows = [...projected.keys()]
        .filter(projectedTokenId => !account.state.deltas.has(projectedTokenId)).length;
      assertAccountDeltaCapacity(account.state.deltas.size + projectedNewRows + 1, 'insert');
    }
    const created = createSettlementDeltaValue(account, tokenId);
    projected.set(tokenId, created);
    return created;
  };
  for (const diff of diffs) {
    const delta = getProjected(diff.tokenId);
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
  }
  for (const tokenId of forgiveTokenIds) getProjected(tokenId);
  return projected;
};
