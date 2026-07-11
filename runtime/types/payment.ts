export const PAYMENT_DELIVERY_MODES = ['instant', 'async', 'trusted'] as const;

export type PaymentDeliveryMode = (typeof PAYMENT_DELIVERY_MODES)[number];

export const ASYNC_PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Five-second blocks are the conservative EVM-mainnet planning baseline. The
// timestamp remains the primary wall-clock expiry; the height guard prevents a
// stale async lock from surviving indefinitely on a chain whose clock stalls.
export const ASYNC_PAYMENT_EXPIRY_BLOCKS = Math.ceil(ASYNC_PAYMENT_EXPIRY_MS / 5_000);
