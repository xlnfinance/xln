import { useEffect, useMemo } from 'react';
import type { JFeeQuote } from '@xln/core/api/public/runtime-module';
import { useAdapterRead, type ReadState } from '../runtime/hooks';
import { asTokenDecimals } from '@xln/core/account/tx/units';
import { formatAmount } from '../runtime/format';

export function useBatchFeeQuote(entityId: string, enabled: boolean): ReadState<JFeeQuote> {
  const query = useMemo(() => ({ entityId }), [entityId]);
  const read = useAdapterRead<JFeeQuote>(enabled ? 'j-fee' : null, query);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      read.refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [enabled, read.refresh]);
  return read;
}

export function BatchFeeWarning({ read }: { read: ReadState<JFeeQuote> }) {
  const now = Date.now();
  if (read.error) return <p role="alert">Fee estimate unavailable: {read.error}</p>;
  if (!read.data) return null;
  const quote = read.data;
  const fee = (value: string) => formatAmount(BigInt(value), asTokenDecimals(9), 9);
  const seconds = quote.deadline === null ? null : Math.max(0, Math.ceil((quote.deadline - now) / 1000));
  return (
    <p role="alert" data-testid="batch-fee-warning">
      {seconds === null ? 'Pending EVM transaction. ' : `Dispute response deadline: ${seconds}s left. `}
      Max fee {fee(quote.currentMaxFeeWei)} → suggested {fee(quote.suggestedMaxFeeWei)} gwei; priority{' '}
      {fee(quote.currentPriorityFeeWei)} → {fee(quote.suggestedPriorityFeeWei)} gwei. Speed up keeps the same nonce and
      call.
    </p>
  );
}
