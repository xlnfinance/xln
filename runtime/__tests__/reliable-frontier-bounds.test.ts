import { describe, expect, test } from 'bun:test';

import { advanceReliableFrontier } from '../machine/reliable-frontier';
import type { ReliableDeliveryIdentity } from '../types';

const entityId = `0x${'71'.repeat(32)}`;
const signerId = `0x${'72'.repeat(20)}`;
const bodyDigest = `0x${'73'.repeat(32)}`;
const evidenceDigest = `0x${'74'.repeat(32)}`;

const identityAt = (height: number): ReliableDeliveryIdentity => ({
  kind: 'entity-frame',
  entityId,
  signerId,
  laneKey: JSON.stringify({ kind: 'entity-frame', entityId, signerId }),
  height,
  frameHash: `0x${height.toString(16).padStart(64, '0')}`,
  logicalKey: JSON.stringify({ kind: 'entity-frame', entityId, height }),
  evidenceVersion: 1,
  evidenceKind: 'entity-certificate',
  evidenceDigest,
  bodyDigest,
});

describe('bounded reliable terminal frontiers', () => {
  test('100k sequential terminal points retain one frontier for one active lane', () => {
    const ledgers = new Map<string, ReliableDeliveryIdentity>();
    const laneKey = identityAt(1).laneKey;

    for (let height = 1; height <= 100_000; height += 1) {
      const incoming = identityAt(height);
      const next = advanceReliableFrontier(ledgers.get(laneKey), incoming);
      ledgers.set(laneKey, next.identity);
    }

    expect(ledgers.size).toBe(1);
    expect(ledgers.get(laneKey)?.height).toBe(100_000);
    expect(JSON.stringify([...ledgers]).length).toBeLessThan(1_000);
  });
});
