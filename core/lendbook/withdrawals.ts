import type { EntityState } from '../entity/types';
import type { AccountTxTarget } from '../entity/tx/handlers/account/orderbook/queue';
import type { LendingSavings } from '../types/finance/lending';
import { getAccountOutCapacity, lendingPositionCloseAmount } from './state';

const dueAt = (position: LendingSavings): number => Math.min(position.createdAt + position.termMs, position.updatedAt);

const order = (position: LendingSavings): number => {
  if (position.closeOrder === undefined) throw new Error(`LENDING_WITHDRAWAL_ORDER_MISSING:${position.positionId}`);
  return position.closeOrder;
};

/** Run after all inbound Accounts and Entity books, before outbound proposals.
 * One payout per idle Account avoids reserving capacity twice. Another Account's
 * collateral is never fungible with this one; a blocked lane retains its debt
 * and priority without stopping independently payable Accounts. In-flight work
 * lives only in the existing Account envelope, never in a second durable queue.
 */
export const collectLendingWithdrawals = (state: EntityState): AccountTxTarget[] => {
  const pending = [...(state.lending?.savings.values() ?? [])].filter(position => position.status === 'queued');
  pending.sort((a, b) => dueAt(a) - dueAt(b) || order(a) - order(b));
  const seen = new Set<string>();
  const lanes = new Set<string>();
  const outputs: AccountTxTarget[] = [];
  for (const position of pending) {
    const accountId = position.lenderEntityId;
    const lane = `${accountId}:${position.tokenId}`;
    if (seen.has(accountId) || lanes.has(lane)) continue;
    lanes.add(lane);
    const account = state.accounts.get(accountId);
    if (!account) throw new Error(`LENDING_WITHDRAWAL_ACCOUNT_MISSING:${position.positionId}`);
    if (account.status !== 'active' || account.pendingFrame || account.mempool.length > 0) continue;
    const amount = lendingPositionCloseAmount(position, state.timestamp);
    if (getAccountOutCapacity(account.state, state.entityId, position.tokenId) < amount) continue;
    seen.add(accountId);
    outputs.push({
      accountId,
      tx: {
        type: 'lending_close_payout',
        data: {
          positionId: position.positionId,
          hubEntityId: state.entityId,
          lenderEntityId: accountId,
          tokenId: position.tokenId,
          amount,
        },
      },
    });
  }
  return outputs;
};
