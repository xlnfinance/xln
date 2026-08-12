import type { AccountState, AccountTx } from '../../../../types/account';
import type { RebalanceFeePolicySnapshot } from '../../../../types/finance/rebalance';
import { TOKENS } from '../../../../config/constants';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxValidationRejected } from '../../apply-result';

type RebalancePolicyTx = Extract<AccountTx, { type: 'rebalance_policy' }>;

const sameTerms = (
  current: RebalanceFeePolicySnapshot,
  next: RebalancePolicyTx['data'],
): boolean =>
  current.baseFee === next.baseFee &&
  current.liquidityFeeBps === next.liquidityFeeBps &&
  current.gasFee === next.gasFee;

export const handleRebalancePolicy = (
  account: AccountState,
  tx: RebalancePolicyTx,
  byLeft: boolean,
  committedTimestamp: number,
): ApplyAccountTxResult => {
  const { tokenId, policyVersion, baseFee, liquidityFeeBps, gasFee } = tx.data;
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    return accountTxValidationRejected(`rebalance_policy: invalid tokenId ${tokenId}`, []);
  }
  if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
    return accountTxValidationRejected(`rebalance_policy: invalid policyVersion ${policyVersion}`, []);
  }
  if (typeof baseFee !== 'bigint' || typeof liquidityFeeBps !== 'bigint' || typeof gasFee !== 'bigint') {
    return accountTxValidationRejected(`rebalance_policy: invalid fee types for token ${tokenId}`, []);
  }
  if (!Number.isSafeInteger(committedTimestamp) || committedTimestamp <= 0) {
    return accountTxValidationRejected(
      `rebalance_policy: invalid committed timestamp ${committedTimestamp}`,
      [],
    );
  }
  if (baseFee < 0n || liquidityFeeBps < 0n || liquidityFeeBps > 10_000n || gasFee < 0n) {
    return accountTxValidationRejected(`rebalance_policy: invalid fee terms for token ${tokenId}`, []);
  }
  if (!account.deltas.has(tokenId)) {
    return accountTxValidationRejected(`rebalance_policy: no delta for token ${tokenId}`, []);
  }

  const side = byLeft ? 'left' : 'right';
  const current = account.rebalanceFeePolicies?.get(tokenId)?.[side];
  if (current && policyVersion < current.policyVersion) {
    return accountTxApplied([`rebalance_policy: stale v${policyVersion} ignored`]);
  }
  if (current && policyVersion === current.policyVersion) {
    if (!sameTerms(current, tx.data)) {
      return accountTxValidationRejected(
        `REBALANCE_POLICY_EQUIVOCATION: side=${side} token=${tokenId} version=${policyVersion}`,
        [],
      );
    }
    return accountTxApplied([`rebalance_policy: exact v${policyVersion} retry`]);
  }

  const next: RebalanceFeePolicySnapshot = {
    policyVersion,
    baseFee,
    liquidityFeeBps,
    gasFee,
    updatedAt: committedTimestamp,
  };
  const policies = account.rebalanceFeePolicies ?? new Map();
  policies.set(tokenId, { ...policies.get(tokenId), [side]: next });
  account.rebalanceFeePolicies = policies;
  return accountTxApplied([`rebalance_policy: ${side} published v${policyVersion} token=${tokenId}`]);
};
