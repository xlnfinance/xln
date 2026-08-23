import { keccakBytesHash } from '../../../protocol/crypto/keccak-text';
import { normalizeEntityId } from '../../../protocol/identity/entity-id';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import type { EntityTx } from '../../../types/entity-tx';

export type EntityProposalReplayOracleEntry = Readonly<{
  entityId: string;
  entityHeight: number;
  txCount: number;
  txPrefixHash: string;
  frameHash: string;
}>;

const HASH = /^0x[0-9a-f]{64}$/;

export const entityProposalReplayOracleKey = (entityId: string, entityHeight: number): string =>
  `${normalizeEntityId(entityId)}:${entityHeight}`;

export const hashEntityProposalTxPrefix = (
  entityId: string,
  entityHeight: number,
  txs: readonly EntityTx[],
): string => keccakBytesHash(encodeCanonicalConsensusBytes([
  'xln.hlt.entity-proposal-prefix:binary',
  normalizeEntityId(entityId),
  entityHeight,
  txs,
]));

const validateEntityProposalReplayOracleEntry = (
  value: EntityProposalReplayOracleEntry,
): EntityProposalReplayOracleEntry => {
  const entityId = normalizeEntityId(value.entityId);
  if (!entityId || entityId !== value.entityId) throw new Error('HLT_ENTITY_PROPOSAL_ORACLE_ENTITY_INVALID');
  if (!Number.isSafeInteger(value.entityHeight) || value.entityHeight < 1) {
    throw new Error('HLT_ENTITY_PROPOSAL_ORACLE_HEIGHT_INVALID');
  }
  if (!Number.isSafeInteger(value.txCount) || value.txCount < 0) {
    throw new Error('HLT_ENTITY_PROPOSAL_ORACLE_TX_COUNT_INVALID');
  }
  if (!HASH.test(value.txPrefixHash)) throw new Error('HLT_ENTITY_PROPOSAL_ORACLE_TX_HASH_INVALID');
  if (!HASH.test(value.frameHash)) throw new Error('HLT_ENTITY_PROPOSAL_ORACLE_FRAME_HASH_INVALID');
  return { ...value, entityId };
};

export const buildEntityProposalReplayOracleMap = (
  entries: readonly EntityProposalReplayOracleEntry[],
): Map<string, EntityProposalReplayOracleEntry> => {
  const oracle = new Map<string, EntityProposalReplayOracleEntry>();
  for (const source of entries) {
    const entry = validateEntityProposalReplayOracleEntry(source);
    const key = entityProposalReplayOracleKey(entry.entityId, entry.entityHeight);
    if (oracle.has(key)) throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_DUPLICATE:${key}`);
    oracle.set(key, entry);
  }
  return oracle;
};

export const requireEntityProposalReplayOracleEntry = (
  oracle: ReadonlyMap<string, EntityProposalReplayOracleEntry>,
  entityId: string,
  entityHeight: number,
): EntityProposalReplayOracleEntry => {
  const key = entityProposalReplayOracleKey(entityId, entityHeight);
  const entry = oracle.get(key);
  if (!entry) throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_MISSING:${key}`);
  return entry;
};
