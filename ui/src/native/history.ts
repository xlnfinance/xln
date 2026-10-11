import type { RuntimeActivityEvent } from '@xln/core/api/public/runtime-module';
import { requireAdapter } from '../runtime/adapter';
import { formatMoney } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { walletMovements } from '../runtime/financial/movement-projection';
import { USER_ACTIVITY_TYPES } from '../runtime/financial/movements';
import type { WalletView } from '../runtime/views';

type Page = { events: RuntimeActivityEvent[]; nextBeforeHeight: number | null; availability: 'complete' | 'partial' };
/** History is read on demand with the canonical cursor, never scanned during settlement. */
export async function walletHistory(wallet: WalletView, before: unknown) {
  if (before !== null && (!Number.isSafeInteger(before) || Number(before) <= 0))
    throw new Error('Invalid history cursor.');
  const page = await requireAdapter().read<Page>('activity', {
    entityId: wallet.entityId,
    types: USER_ACTIVITY_TYPES,
    limit: 200,
    scanLimit: 1000,
    ...(before === null ? {} : { beforeHeight: Number(before) }),
  });
  return {
    nextBeforeHeight: page.nextBeforeHeight,
    availability: page.availability,
    items: walletMovements(
      page.events,
      wallet.entityId,
      wallet.accounts.map(account => account.counterpartyId),
    ).map(item => ({
      id: item.id,
      title: item.title,
      state: item.state,
      tone: item.tone,
      height: item.height,
      detail: item.detail,
      hash: item.hash,
      direction: item.direction,
      amount:
        item.amount !== null && item.tokenId !== null
          ? `${formatMoney(item.amount, getTokenMeta(item.tokenId).decimals, getTokenMeta(item.tokenId).decimals)} ${getTokenMeta(item.tokenId).symbol}`
          : '',
    })),
  };
}

export async function walletOrders(wallet: WalletView, accountId: unknown, cursor: unknown) {
  if (typeof accountId !== 'string' || !wallet.accounts.some(account => account.counterpartyId === accountId))
    throw new Error('Choose a connected account.');
  if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new Error('Invalid order cursor.');
  const page = await requireAdapter().read<import('@xln/core/api/runtime-adapter/types').RuntimeAdapterSwapHistoryPage>(
    `entity/${wallet.entityId}/account/${accountId}/swap-history`,
    { limit: 25, ...(cursor === null ? {} : { cursor }) },
  );
  const amount = (value: bigint | null, tokenId: number): string => {
    if (value === null) return 'Not recorded';
    const meta = getTokenMeta(tokenId);
    return `${formatMoney(value, meta.decimals, meta.decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')} ${meta.symbol}`;
  };
  return {
    nextCursor: page.nextCursor ?? null,
    items: page.items.map(order => ({
      id: order.offerId,
      pair: `${getTokenMeta(order.giveTokenId).symbol} → ${getTokenMeta(order.wantTokenId).symbol}`,
      state: order.closed ? 'Closed' : order.cancelRequested ? 'Cancellation requested' : 'Open',
      requested: `${amount(order.originalGiveAmount, order.giveTokenId)} → ${amount(order.originalWantAmount, order.wantTokenId)}`,
      fills: order.resolves.map((fill, index) => ({
        id: `${fill.height}:${index}`,
        height: fill.height,
        gave: amount(fill.executionGiveAmount, order.giveTokenId),
        received: amount(fill.executionWantAmount, order.wantTokenId),
        fee: fill.feeTokenId === null ? 'Not recorded' : amount(fill.feeAmount, fill.feeTokenId),
        comment: fill.comment ?? '',
      })),
    })),
  };
}
