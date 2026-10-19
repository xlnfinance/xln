import { create } from 'zustand';
import type { RuntimeAdapter, RuntimeAdapterFrameReceiptResponse } from '@xln/core/api/runtime-adapter/types';

export type TutorialTrade = {
  runtimeId: string;
  entityId: string;
  counterpartyId: string;
  offerId: string;
  fromHeight: number;
};

/** Volatile exercise identity, never wallet state or a persisted completion oracle. */
export const useTutorialTrade = create<{
  pending: TutorialTrade | null;
  setPending: (pending: TutorialTrade | null) => void;
}>(set => ({ pending: null, setPending: pending => set({ pending }) }));

const positive = (amount: unknown): boolean =>
  (typeof amount === 'bigint' || typeof amount === 'string') && /^\d+$/.test(String(amount)) && BigInt(amount) > 0n;

export const tutorialTradeFilled = (trade: TutorialTrade, page: RuntimeAdapterFrameReceiptResponse): boolean =>
  page.receipts.some(
    receipt =>
      receipt.height >= trade.fromHeight &&
      receipt.height <= page.toHeight &&
      receipt.logs.some(
        log =>
          log.message === 'SwapFilled' &&
          log.data?.entityId === trade.entityId &&
          log.data.counterpartyId === trade.counterpartyId &&
          log.data.offerId === trade.offerId &&
          positive(log.data.executionGiveAmount) &&
          positive(log.data.executionWantAmount),
      ),
  );

/** Read only new committed Runtime receipts for this submitted order, including coalesced frame notifications. */
export function createTutorialTradeReader(trade: TutorialTrade) {
  let nextHeight = trade.fromHeight;
  let filled = false;
  let tail: Promise<unknown> = Promise.resolve();
  const read = async (adapter: Pick<RuntimeAdapter, 'read' | 'runtimeId'>, height: number): Promise<boolean> => {
    if (adapter.runtimeId !== trade.runtimeId) throw new Error('TUTORIAL_TRADE_RUNTIME_MISMATCH');
    while (!filled && nextHeight <= height) {
      const page = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
        fromHeight: nextHeight,
        toHeight: height,
        limit: 500,
        entityId: trade.entityId,
        eventNames: ['SwapFilled'],
      });
      if (page.fromHeight !== nextHeight || page.toHeight < nextHeight || page.toHeight > height) {
        throw new Error('TUTORIAL_TRADE_RECEIPT_RANGE_INVALID');
      }
      filled = tutorialTradeFilled(trade, page);
      nextHeight = page.toHeight + 1;
    }
    return filled;
  };
  return (adapter: Pick<RuntimeAdapter, 'read' | 'runtimeId'>, height: number): Promise<boolean> => {
    const next = tail.then(() => read(adapter, height));
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
