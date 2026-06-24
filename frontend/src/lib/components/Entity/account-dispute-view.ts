import type { AccountMachine, EntityState } from '@xln/runtime/xln-api';
import { compareEntityAssetText } from './entity-asset-catalog';

export type DisputedAccountView = {
  counterpartyId: string;
  status: 'active' | 'finalized';
};

export type CrossJTargetDisputeRisk = {
  amount: bigint;
  tokenId: number;
};

export function buildDisputedAccountViews(accounts: Map<string, AccountMachine> | undefined): DisputedAccountView[] {
  if (!(accounts instanceof Map)) return [];
  const out: DisputedAccountView[] = [];
  for (const [counterpartyId, account] of accounts.entries()) {
    const activeDispute = account.activeDispute;
    const status = String(account.status || '');
    if (status !== 'disputed') continue;
    out.push({
      counterpartyId: String(counterpartyId),
      status: activeDispute ? 'active' : 'finalized',
    });
  }
  return out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return compareEntityAssetText(a.counterpartyId, b.counterpartyId);
  });
}

export function getCrossJTargetDisputeRiskForState(
  state: EntityState | null | undefined,
  counterpartyEntityId: string,
): CrossJTargetDisputeRisk | null {
  const account = state?.accounts?.get?.(counterpartyEntityId);
  if (!state || !account) return null;
  const self = String(state.entityId || '').toLowerCase();
  const counterparty = String(counterpartyEntityId || '').toLowerCase();
  let amount = 0n;
  let tokenId = 0;
  for (const route of state.crossJurisdictionSwaps?.values?.() || []) {
    if (
      String(route?.target?.counterpartyEntityId || '').toLowerCase() === self &&
      String(route?.target?.entityId || '').toLowerCase() === counterparty &&
      route?.targetPull?.pullId &&
      account.pulls?.has?.(route.targetPull.pullId)
    ) {
      amount += BigInt(route.target.amount || 0n);
      tokenId = Number(route.target.tokenId || tokenId);
    }
  }
  return amount > 0n ? { amount, tokenId } : null;
}

export function formatCrossJTargetDisputeRiskLabel(input: {
  risk: CrossJTargetDisputeRisk;
  resolveToken: (tokenId: number) => { symbol: string; decimals: number };
  formatTokenInputAmount: (amount: bigint, decimals: number) => string;
}): string {
  const token = input.resolveToken(input.risk.tokenId);
  const amount = input.formatTokenInputAmount(input.risk.amount, token.decimals) || '0';
  return `${amount} ${token.symbol}`;
}
