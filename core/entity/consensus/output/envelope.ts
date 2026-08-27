import type { EntityInput } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';

const NESTED_PROTOCOL_TXS = new Set<EntityTx['type']>([
  // AccountInput is routed raw after source Entity + Runtime WAL commit. It
  // must never regain an outer Runtime output envelope.
  'accountInput',
  'entityCommand',
  'runtimeOutput',
  'scheduledWake',
]);

const getRuntimeOutputNestedTxs = (
  tx: EntityTx,
): readonly EntityTx[] | null => {
  if (tx.type !== 'runtimeOutput') return null;
  const nested = tx.data.entityTxs;
  if (!Array.isArray(nested) || nested.length === 0) throw new Error('RUNTIME_OUTPUT_ENTITY_TXS_MISSING');
  if (nested.some(candidate => NESTED_PROTOCOL_TXS.has(candidate.type))) {
    throw new Error('RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN');
  }
  return nested;
};

export const getEffectiveEntityInputTxs = (
  input: Pick<EntityInput, 'entityTxs'>,
): EntityTx[] => (input.entityTxs ?? []).flatMap((tx) =>
  getRuntimeOutputNestedTxs(tx) ?? [tx]);

export const getAccountOnlyEntityTx = (
  txs: readonly EntityTx[] | undefined,
): Extract<EntityTx, { type: 'accountInput' }> | null => {
  const accountTxs = (txs ?? []).filter(
    (tx): tx is Extract<EntityTx, { type: 'accountInput' }> => tx.type === 'accountInput',
  );
  if (accountTxs.length === 0) return null;
  if (accountTxs.length !== 1 || txs?.length !== 1) {
    throw new Error('ACCOUNT_OUTPUT_MUST_BE_ONE_RAW_ACCOUNT_INPUT');
  }
  return accountTxs[0]!;
};
