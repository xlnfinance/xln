import type { EntityTx } from '../../types/entity-tx';
import { keccak256 } from 'ethers';
import { encodeCanonicalConsensusValue } from '../serialization/canonical-consensus-value';
import { hashHtlcSecret } from './utils';

type HtlcPaymentTx = Extract<EntityTx, { type: 'htlcPayment' }>;

const testSecretsByPayment = new Map<string, string>();

const paymentKey = (tx: HtlcPaymentTx): string =>
  keccak256(new TextEncoder().encode(encodeCanonicalConsensusValue(tx)));

const normalizeSecret = (value: unknown): string => {
  const secret = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error('HTLC_PAYMENT_SECRET_INVALID');
  return secret;
};

/**
 * Deterministic scenario/test ingress capability.
 *
 * The secret lives only in a process-local test registry keyed by the exact canonical
 * payment. Clones retain no hidden fields and protocol bytes contain only the hashlock.
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
  const payment: HtlcPaymentTx = {
    type: 'htlcPayment',
    data: { ...tx.data, hashlock },
  };
  testSecretsByPayment.set(paymentKey(payment), secret);
  return payment;
};

/** @internal Read only by raw local admission; never serialize its result. */
export const getDeterministicHtlcTestSecret = (tx: HtlcPaymentTx): string | undefined =>
  testSecretsByPayment.get(paymentKey(tx));
