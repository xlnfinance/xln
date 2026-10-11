import type { EntityState } from '../entity/types';
import type { AccountTxTarget } from '../entity/tx/handlers/account/orderbook/queue';
import { accountLendingRisk } from '../account/validation/lending-risk';
import { lendingCovenantHash, lendingMaximumAmount, renewDemandSavings } from '../protocol/dispute/lending-covenant';
import { demandSavingsClaim } from './state';
import { lendingTermsKey } from './policy';

const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** Derive both wakeup and admission from the same Account-owned claim. No
 * persisted rate queue/checkpoint, no history scan, and no renewal above risk.
 * Withdrawal and existing in-flight work have priority over new rate coverage. */
export const demandSavingsRenewals = (state: EntityState): Array<AccountTxTarget & { triggerAt: number }> => {
  const work: Array<AccountTxTarget & { triggerAt: number }> = [];
  const accounts = new Set<string>();
  const queued = new Set(
    [...(state.lending?.savings.values() ?? [])]
      .filter(position => position.status === 'queued')
      .map(position => position.lenderEntityId + ':' + position.tokenId),
  );
  for (const position of state.lending?.savings.values() ?? []) {
    if (
      position.termId !== 'demand' ||
      position.status !== 'open' ||
      accounts.has(position.lenderEntityId) ||
      queued.has(position.lenderEntityId + ':' + position.tokenId)
    )
      continue;
    const accountId = position.lenderEntityId;
    const account = state.accounts.get(accountId);
    if (!account) throw new Error(`LENDING_DEMAND_ACCOUNT_MISSING:${position.positionId}`);
    if (account.status !== 'active' || account.pendingFrame || account.mempool.length > 0) continue;
    const claim = demandSavingsClaim(position, account.state);
    const terms = state.lending?.terms?.get(
      lendingTermsKey({ ...account.state.domain, tokenId: position.tokenId, termId: 'demand' }),
    );
    if (!terms || terms.expiresAt <= state.timestamp) continue;
    const triggerAt =
      claim.interestBps !== terms.savingsInterestBps
        ? Math.max(state.timestamp, claim.accruedAt + 1)
        : claim.openedAt + claim.termMs - RENEW_BEFORE_MS;
    if (triggerAt >= terms.expiresAt) continue;
    const renewed = renewDemandSavings(claim, terms.savingsInterestBps, Math.max(triggerAt, state.timestamp));
    if (!renewed.ok) continue;
    const risk = accountLendingRisk(account).get(position.tokenId);
    if (!risk) throw new Error('LENDING_DEMAND_RISK_MISSING');
    const capacity = claim.creditorIsLeft ? risk.rightCouponCapacity : risk.leftCouponCapacity;
    const extra = lendingMaximumAmount(renewed.claim) - lendingMaximumAmount(claim);
    if (extra > 0n && extra > capacity) continue;
    // A future renewal must not hide another position already due on this
    // Account. Only actual admission consumes its one-proposal slot.
    if (triggerAt <= state.timestamp) accounts.add(accountId);
    work.push({
      accountId,
      triggerAt,
      tx: {
        type: 'lending_rate',
        data: {
          positionId: position.positionId,
          hubEntityId: state.entityId,
          lenderEntityId: accountId,
          tokenId: position.tokenId,
          claimHash: lendingCovenantHash(claim),
          interestBps: terms.savingsInterestBps,
        },
      },
    });
  }
  return work;
};
