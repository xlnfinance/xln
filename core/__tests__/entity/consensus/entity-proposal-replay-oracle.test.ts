import { describe, expect, test } from 'bun:test';

import {
  buildEntityProposalReplayOracleMap,
  entityProposalReplayOracleKey,
  hashEntityProposalTxPrefix,
  requireEntityProposalReplayOracleEntry,
  type EntityProposalReplayOracleEntry,
} from '../../../entity/consensus/proposal/replay-oracle';
import type { EntityTx } from '../../../types/entity-tx';

const entityA = `0x${'11'.repeat(32)}`;
const entityB = `0x${'22'.repeat(32)}`;
const hashA = `0x${'aa'.repeat(32)}`;

const entry = (entityId: string, entityHeight: number): EntityProposalReplayOracleEntry => ({
  entityId,
  entityHeight,
  txCount: 0,
  txPrefixHash: hashEntityProposalTxPrefix(entityId, entityHeight, []),
  frameHash: hashA,
});

describe('HLT certified Entity proposal replay oracle', () => {
  test('accepts an explicit zero-entry oracle', () => {
    expect(buildEntityProposalReplayOracleMap([]).size).toBe(0);
  });

  test('indexes multiple Entity heights without conflating them', () => {
    const entries = [entry(entityA, 7), entry(entityA, 8), entry(entityB, 7)];
    const oracle = buildEntityProposalReplayOracleMap(entries);
    expect(oracle.size).toBe(3);
    expect(requireEntityProposalReplayOracleEntry(oracle, entityA, 8).entityHeight).toBe(8);
    expect(oracle.has(entityProposalReplayOracleKey(entityB, 7))).toBe(true);
  });

  test('rejects duplicate certified boundaries', () => {
    expect(() => buildEntityProposalReplayOracleMap([entry(entityA, 7), entry(entityA, 7)]))
      .toThrow('HLT_ENTITY_PROPOSAL_ORACLE_DUPLICATE');
  });

  test('fails fast on missing boundaries and changed tx prefixes', () => {
    const oracle = buildEntityProposalReplayOracleMap([entry(entityA, 7)]);
    expect(() => requireEntityProposalReplayOracleEntry(oracle, entityA, 8))
      .toThrow('HLT_ENTITY_PROPOSAL_ORACLE_MISSING');
    const tx = { type: 'flush' } as unknown as EntityTx;
    expect(hashEntityProposalTxPrefix(entityA, 7, [tx])).not.toBe(entry(entityA, 7).txPrefixHash);
  });
});
