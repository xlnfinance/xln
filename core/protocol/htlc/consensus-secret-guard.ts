import type { EntityTx } from '../../types/entity-tx';

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
 * public hashlock and exact opaque ciphertext. Plaintext first enters the
 * bilateral Account transaction authored by the final recipient.
 */
export const assertNoConsensusVisibleHtlcPaymentSecrets = (
  txs: readonly EntityTx[],
): void => assertTxBatch(txs, new Set());
