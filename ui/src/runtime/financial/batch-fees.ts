import type { JFeeQuote } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapter } from '@xln/core/api/runtime-adapter/types';

/** Payer approval is committed before the wallet can ask for a replacement. */
export async function requestBatchSpeedUp(options: {
  adapter: Pick<RuntimeAdapter, 'control'>;
  entityId: string;
  signerId: string;
  quote: JFeeQuote;
  confirm: (message: string) => boolean;
  rebroadcast: (gasBumpBps: number) => Promise<unknown>;
}): Promise<boolean> {
  const { adapter, entityId, signerId, quote, confirm, rebroadcast } = options;
  if (
    !confirm(
      `Authorize an absolute ceiling of ${quote.ceilingWei} wei/gas for both max fee and priority fee on this transaction?`,
    )
  )
    return false;
  await adapter.control({
    type: 'authorize-evm-fees',
    entityId,
    signerId,
    attemptId: quote.attemptId,
    transactionHash: quote.transactionHash,
    ceilingWei: quote.ceilingWei,
  });
  await rebroadcast(1250);
  return true;
}
