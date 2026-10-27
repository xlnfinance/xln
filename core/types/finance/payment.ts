import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../config/constants';
const PAYMENT_DELIVERY_MODES = ['direct', 'instant', 'async', 'trusted'] as const;

export type PaymentDeliveryMode = (typeof PAYMENT_DELIVERY_MODES)[number];

export const ASYNC_PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Planning uses the owning jurisdiction, never a fixed EVM block cadence. */
export function paymentExpiryBlocks(expiryMs: number, blockTimeMs: number | undefined): number {
  if (blockTimeMs === undefined || !Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) throw new Error('PAYMENT_BLOCK_TIME_INVALID');
  return Math.ceil(expiryMs / blockTimeMs);
}

export const paymentRevealHeightDeltaBlocks = (blockTimeMs: number | undefined): number =>
  paymentExpiryBlocks(HTLC_ENFORCEMENT_RESERVE_MS, blockTimeMs);
