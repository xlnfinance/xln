import { create } from 'zustand';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { invoicePaid } from './outcomes';
import type { TourContext } from './steps';

/** Volatile observations of actual backup reads/exports, never a persisted completion flag. */
export const useTourObservations = create<Pick<TourContext, 'backup' | 'exported' | 'restored' | 'shareTokens' | 'governance' | 'invoice' | 'incoming' | 'outgoing' | 'initiations' | 'takeover'>>(() => ({}));

/** Retain matching durable evidence even after the receipt notification is dismissed. */
export function observeTourPayment(event: PaymentTerminalEvent | NonNullable<TourContext['initiations']>[number]): void {
  const { invoice } = useTourObservations.getState();
  if (event.name !== 'HtlcInitiated' && invoicePaid(invoice, event)) useTourObservations.setState({ incoming: event });
  if (event.name === 'HtlcInitiated') {
    useTourObservations.setState(state => ({ initiations: [...(state.initiations ?? []), event] }));
  } else if (event.name === 'HtlcFinalized') {
    useTourObservations.setState({ outgoing: event });
  }
}
