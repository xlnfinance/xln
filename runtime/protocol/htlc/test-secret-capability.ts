import type { EntityTx } from '../../types';
import { hashHtlcSecret } from './utils';

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

const TEST_SECRET = Symbol('xln.runtime.htlc-test-secret');
type CapableHtlcPaymentTx = HtlcPaymentTx & { [TEST_SECRET]?: string };

const normalizeSecret = (value: unknown): string => {
  const secret = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error('HTLC_PAYMENT_SECRET_INVALID');
  return secret;
};

/**
 * Deterministic scenario/test ingress capability.
 *
 * The secret lives only on a process-local non-enumerable symbol. The returned payment
 * carries its public hashlock, so JSON, structuredClone, WS, frame and WAL
 * copies lose the capability and fail closed instead of recovering a preimage.
 */
export const withDeterministicHtlcTestSecret = (
  tx: HtlcPaymentTx,
  rawSecret: string,
): HtlcPaymentTx => {
  const secret = normalizeSecret(rawSecret);
  const hashlock = hashHtlcSecret(secret).toLowerCase();
  if (tx.data.hashlock !== undefined && String(tx.data.hashlock).trim().toLowerCase() !== hashlock) {
    throw new Error('HTLC_PAYMENT_SECRET_HASH_MISMATCH');
  }
  if (Object.prototype.hasOwnProperty.call(tx.data, 'secret')) {
    throw new Error('HTLC_PAYMENT_EXPLICIT_SECRET_FORBIDDEN');
  }
  const capable: HtlcPaymentTx = {
    type: 'htlcPayment',
    data: { ...tx.data, hashlock },
  };
  Object.defineProperty(capable, TEST_SECRET, { value: secret, enumerable: false });
  return capable;
};

/** @internal Read only by raw local admission; never serialize its result. */
export const getDeterministicHtlcTestSecret = (tx: HtlcPaymentTx): string | undefined =>
  (tx as CapableHtlcPaymentTx)[TEST_SECRET];

/** Preserve the local capability only across the runtime's private frame clone. */
export const copyDeterministicHtlcTestSecretCapability = (
  source: EntityTx,
  target: EntityTx,
): void => {
  if (source.type !== 'htlcPayment' || target.type !== 'htlcPayment') return;
  const secret = getDeterministicHtlcTestSecret(source);
  if (!secret) return;
  Object.defineProperty(target, TEST_SECRET, { value: secret, enumerable: false });
};
