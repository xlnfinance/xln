import type { EntityInput, EntityTx } from '../../types';
import { compareStableText } from '../../protocol/serialization';

const NESTED_PROTOCOL_TXS = new Set<EntityTx['type']>([
  'entityCommand',
  'consensusOutput',
  'reissueCertifiedOutput',
  'scheduledWake',
]);

export const getCertifiedOutputNestedTxs = (
  tx: EntityTx,
): readonly EntityTx[] | null => {
  if (tx.type !== 'consensusOutput') return null;
  const nested = tx.data.entityTxs;
  if (!Array.isArray(nested) || nested.length === 0) {
    throw new Error('CONSENSUS_OUTPUT_ENTITY_TXS_MISSING');
  }
  if (nested.some((candidate) => NESTED_PROTOCOL_TXS.has(candidate.type))) {
    throw new Error('CONSENSUS_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN');
  }
  return nested;
};

export const getEffectiveEntityInputTxs = (
  input: Pick<EntityInput, 'entityTxs'>,
): EntityTx[] => (input.entityTxs ?? []).flatMap((tx) =>
  getCertifiedOutputNestedTxs(tx) ?? [tx]);

/**
 * A target consumption frontier is contiguous per source/target/lane. Network
 * batching may combine independently certified outputs in any arrival order,
 * so reorder only the slots from the same frontier before applying them.
 */
export const orderCertifiedOutputsBySequence = (txs: readonly EntityTx[]): EntityTx[] => {
  const result = [...txs];
  const positionsByLane = new Map<string, number[]>();
  result.forEach((tx, index) => {
    if (tx.type !== 'consensusOutput') return;
    const origin = tx.data.origin;
    const key = `${origin.sourceEntityId.toLowerCase()}:` +
      `${tx.data.targetEntityId.toLowerCase()}:${origin.lane}`;
    const positions = positionsByLane.get(key) ?? [];
    positions.push(index);
    positionsByLane.set(key, positions);
  });
  for (const positions of positionsByLane.values()) {
    if (positions.length < 2) continue;
    const ordered = positions.map(position => result[position]!).sort((left, right) => {
      if (left.type !== 'consensusOutput' || right.type !== 'consensusOutput') return 0;
      const leftOrigin = left.data.origin;
      const rightOrigin = right.data.origin;
      return (leftOrigin.sequence < rightOrigin.sequence ? -1 : leftOrigin.sequence > rightOrigin.sequence ? 1 : 0) ||
        leftOrigin.height - rightOrigin.height ||
        leftOrigin.outputIndex - rightOrigin.outputIndex ||
        compareStableText(leftOrigin.semanticHash, rightOrigin.semanticHash);
    });
    positions.forEach((position, index) => { result[position] = ordered[index]!; });
  }
  return result;
};

export const isReliableCertifiedPayloadTx = (tx: EntityTx): boolean =>
  tx.type === 'j_event' || (
    tx.type === 'accountInput' &&
    (tx.data.kind === 'ack' || tx.data.kind === 'frame_ack' || tx.data.kind === 'board_reseal')
  );

export const assertReliableCertifiedPayloadIsAtomic = (
  txs: readonly EntityTx[],
): void => {
  if (txs.some(isReliableCertifiedPayloadTx) && txs.length !== 1) {
    throw new Error('CONSENSUS_OUTPUT_RELIABLE_PAYLOAD_MUST_BE_ATOMIC');
  }
};
