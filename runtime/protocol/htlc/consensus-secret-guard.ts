import type { EntityTx } from '../../types';

const assertNoSecretFields = (value: unknown, stack: Set<unknown>): void => {
  if (!value || typeof value !== 'object') return;
  if (stack.has(value)) throw new Error('HTLC_PAYMENT_CONSENSUS_TX_CYCLE');
  stack.add(value);
  try {
    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) {
        if (key === 'secret') throw new Error('HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN');
        assertNoSecretFields(key, stack);
        assertNoSecretFields(entry, stack);
      }
      return;
    }
    if (value instanceof Set) {
      for (const entry of value.values()) assertNoSecretFields(entry, stack);
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'secret') throw new Error('HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('HTLC_PAYMENT_CONSENSUS_ACCESSOR_FORBIDDEN');
      }
      assertNoSecretFields(descriptor.value, stack);
    }
  } finally {
    stack.delete(value);
  }
};

const assertTxBatch = (value: unknown, stack: Set<unknown>): void => {
  if (!Array.isArray(value)) return;
  if (stack.has(value)) throw new Error('HTLC_PAYMENT_CONSENSUS_TX_CYCLE');
  stack.add(value);
  try {
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const tx = candidate as EntityTx;
      if (tx.type === 'htlcPayment') {
        assertNoSecretFields(tx.data, stack);
        continue;
      }
      if (tx.type === 'htlcOnionAdvance') {
        if (tx.data.advance.kind === 'revealAccepted') {
          const { secret, ...publicAdvance } = tx.data.advance;
          if (!/^0x[0-9a-f]{64}$/i.test(secret)) {
            throw new Error('HTLC_PAYMENT_SECRET_CONSENSUS_INVALID');
          }
          assertNoSecretFields({ ...tx.data, advance: publicAdvance }, stack);
          continue;
        }
        assertNoSecretFields(tx.data, stack);
        continue;
      }
      if (tx.type === 'entityCommand') {
        assertTxBatch(tx.data.txs, stack);
        continue;
      }
      if (tx.type === 'consensusOutput' || tx.type === 'reissueCertifiedOutput') {
        assertTxBatch(tx.data.entityTxs, stack);
        continue;
      }
      if (tx.type === 'propose' && tx.data.action?.type === 'entity_transaction') {
        assertTxBatch(tx.data.action.data.txs, stack);
      }
    }
  } finally {
    stack.delete(value);
  }
};

/**
 * The proposer alone knows the preimage before delivery. Consensus commits the
 * public hashlock and exact opaque ciphertext. The sole plaintext exception is
 * revealAccepted, whose reducer requires an exact Account ACK marker already
 * applied earlier in the Entity transition.
 */
export const assertNoConsensusVisibleHtlcPaymentSecrets = (
  txs: readonly EntityTx[],
): void => assertTxBatch(txs, new Set());
