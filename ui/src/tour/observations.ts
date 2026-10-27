import { create } from 'zustand';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { invoicePaid } from './outcomes';
import type { TourContext } from './steps';

/** Volatile observations of actual backup reads/exports, never a persisted completion flag. */
export const useTourObservations = create<Pick<TourContext, 'backup' | 'exported' | 'restored' | 'shareTokens' | 'governance' | 'invoice' | 'incoming' | 'outgoing' | 'takeover'>>(() => ({}));

/** Retain matching durable evidence even after the receipt notification is dismissed. */
export function observeTourPayment(event: PaymentTerminalEvent): void {
  const { invoice, restored } = useTourObservations.getState();
  if (invoicePaid(invoice, event)) useTourObservations.setState({ incoming: event });
  if (restored?.runtimeId === event.runtimeId && event.height > restored.height &&
    restored.entityIds.includes(String(event.data.entityId)) && event.name === 'HtlcFinalized' &&
    event.data.fromEntity === event.data.entityId && event.data.tokenId === 1 &&
    typeof event.data.hashlock === 'string' && /^0x[0-9a-f]{64}$/i.test(event.data.hashlock) &&
    /^\d+$/.test(String(event.data.amount)) && BigInt(String(event.data.amount)) >= 1_000_000n) {
    useTourObservations.setState({ outgoing: event });
  }
}
