import type { EntityTx } from '@xln/core/api/public/runtime-module';

/**
 * Whether `tx` opens an Account with `counterpartyId`, looking through the
 * wrappers admission adds before a tx reaches the Entity mempool or a frame:
 * a signed `entityCommand` and a collective `entity_transaction` proposal.
 */
export const entityTxOpensAccount = (tx: EntityTx, counterpartyId: string): boolean => {
  if (tx.type === 'openAccount') return String(tx.data.targetEntityId).toLowerCase() === counterpartyId.toLowerCase();
  if (tx.type === 'entityCommand') return tx.data.txs.some(inner => entityTxOpensAccount(inner, counterpartyId));
  if (tx.type === 'propose' && tx.data.action.type === 'entity_transaction') {
    return tx.data.action.data.txs.some(inner => entityTxOpensAccount(inner, counterpartyId));
  }
  return false;
};
