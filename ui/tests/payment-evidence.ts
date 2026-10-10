import type { Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter, RuntimeAdapterFrameReceiptResponse } from '../../core/api/runtime-adapter/types';

/** The embedded receipt monitor reads these same persisted activity journals. */
export async function readCommittedPayment(page: Page, entityId: string, fromHeight: number) {
  return page.evaluate(async ({ owner, from }) => {
    const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null } }).__xln?.adapter();
    if (!adapter) throw new Error('Embedded payment receipts unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
    if (frame.height - from >= 500) throw new Error('Payment fixture exceeds receipt range');
    const page = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
      entityId: owner, fromHeight: from, toHeight: frame.height, limit: 500,
      eventNames: ['HtlcInitiated', 'HtlcFinalized'],
    });
    if (page.toHeight !== frame.height) throw new Error('Payment receipt range is incomplete');
    const logs = page.receipts.flatMap(receipt => receipt.logs);
    const owned = logs.filter(log => (log.entityId ?? log.data?.['entityId']) === owner);
    const started = owned.filter(log => log.message === 'HtlcInitiated');
    const finalized = owned.filter(log => log.message === 'HtlcFinalized');
    if (started.length !== 1 || finalized.length !== 1)
      throw new Error(`Expected one started/finalized payment: ${started.length}/${finalized.length}`);
    const data = started[0]?.data;
    const terminal = finalized[0]?.data;
    if (!data || !terminal || typeof data['hashlock'] !== 'string' || terminal['hashlock'] !== data['hashlock'])
      throw new Error('Payment terminal hash does not match its initiation');
    for (const key of ['amount', 'senderAmount', 'fee']) {
      if (typeof data[key] !== 'string' || !/^\d+$/.test(data[key])) throw new Error(`Invalid committed payment ${key}`);
    }
    return { amount: String(data['amount']), senderAmount: String(data['senderAmount']), fee: String(data['fee']), hashlock: data['hashlock'] };
  }, { owner: entityId, from: fromHeight });
}

/** Read the committed primary Account, independently of rounded screen text. */
export async function readUsdcAccount(page: Page, entityId: string) {
  return page.evaluate(async owner => {
    const debug = (window as Window & {
      __xln?: { adapter: () => RuntimeAdapter | null; xln: () => Promise<XLNModule> };
    }).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Payment diagnostics unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
    const account = frame.activeEntity?.accounts.items[0];
    if (!account || frame.activeEntityId !== owner) throw new Error('Payment Account unavailable');
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('Payment USDC lane unavailable');
    const xln = await debug.xln();
    const derived = xln.deriveDelta(delta, owner === account.state.leftEntity);
    return {
      owned: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      root: account.currentFrame.accountStateRoot,
      height: account.currentHeight,
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
    };
  }, entityId);
}
