import { describe, expect, test } from 'bun:test';

import {
  assertCompleteHltAuthorityEvidence,
  buildHltAuthorityEvidence,
} from '../../../scripts/operations/hlt/replay/authority-evidence';
import type { PersistedFrameJournal } from '../../../storage/types';
import type { EntityTx } from '../../../types/entity-tx';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const owner = entityId('11');

const journal = (entityTxs: EntityTx[] = []): PersistedFrameJournal => ({
  height: 41,
  timestamp: 1_700_000_000_000,
  replicaMetaDigest: `0x${'04'.repeat(32)}`,
  postStateHash: `0x${'05'.repeat(32)}`,
  runtimeStateHash: `0x${'06'.repeat(32)}`,
  runtimeInput: {
    runtimeTxs: [],
    entityInputs: entityTxs.length === 0 ? [] : [{
      entityId: owner,
      signerId: '1',
      entityTxs,
    }],
  },
  runtimeOutputCount: 2,
  runtimeOutputsDigest: `0x${'07'.repeat(32)}`,
  entityContexts: new Map(),
  logs: [],
});

describe('HLT Rust Runtime authority evidence', () => {
  test('binds canonical Runtime roots and ordered effects without an eager Account-history oracle', () => {
    const evidence = buildHltAuthorityEvidence([journal()]);
    expect(() => assertCompleteHltAuthorityEvidence(evidence)).not.toThrow();
    expect(Object.hasOwn(evidence, 'economicOperations')).toBe(false);
    expect(evidence.expectations.runtimeFrames[0]?.runtimeStateHash).toBe(`0x${'06'.repeat(32)}`);
    expect(evidence.expectations.effects[0]).toEqual({
      runtimeHeight: 41,
      outputCount: 2,
      orderedOutputDigest: `0x${'07'.repeat(32)}`,
    });
  });

  test('rejects disabled lending from the canonical Runtime WAL input', () => {
    const lending: EntityTx = {
      type: 'lendingRepay',
      data: {
        hubEntityId: owner,
        loanId: 'loan-1',
        tokenId: 1,
        amount: 1n,
      },
    };
    expect(() => buildHltAuthorityEvidence([journal([lending])]))
      .toThrow('HLT_AUTHORITY_FEATURE_POLICY_ENTITY_TX_FORBIDDEN:lendingRepay');
  });
});
