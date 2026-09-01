import { describe, expect, test } from 'bun:test';

import {
  EntityCollectionCandidateMap,
  PersistentEntityCollectionMap,
  ensureEntityCollectionCandidate,
} from '../../../entity/state/persistent-collection-map';
import { hexToBytes } from '../../../support/bytes/hex-bytes';

describe('persistent Entity collection radix', () => {
  test('path-copies one dirty value and preserves the certified root', () => {
    const base = PersistentEntityCollectionMap.from(new Map([
      ['aa', { amount: 1n }],
      ['ab', { amount: 2n }],
      ['ff', { amount: 3n }],
    ]));
    const root = base.rootHash();
    const candidate = new EntityCollectionCandidateMap(base, value => ({ ...value }));
    candidate.getForWrite('ab')!.amount = 9n;
    const committed = candidate.sealCandidate();

    expect(base.rootHash()).toBe(root);
    expect(base.get('ab')?.amount).toBe(2n);
    expect(committed.get('ab')?.amount).toBe(9n);
    expect(committed.rootHash()).not.toBe(root);
  });

  test('rejection is allocation-only and never mutates the committed value', () => {
    const base = PersistentEntityCollectionMap.from(new Map([['lock', { done: false }]]));
    const candidate = new EntityCollectionCandidateMap(base, value => ({ ...value }));
    candidate.getForWrite('lock')!.done = true;
    expect(base.get('lock')?.done).toBeFalse();
  });

  test('rejects a leaf that cannot map to one bounded LevelDB record', () => {
    const candidate = new EntityCollectionCandidateMap(
      PersistentEntityCollectionMap.empty<{ payload: string }>(),
      value => ({ ...value }),
    );
    candidate.set('oversized', { payload: 'x'.repeat(10_000) });
    expect(() => candidate.rootHash()).toThrow('ENTITY_COLLECTION_LEAF_TOO_LARGE');
  });

  test('ensureEntityCollectionCandidate creates a writable overlay for a missing collection', () => {
    const candidate = ensureEntityCollectionCandidate<{ amount: bigint }>(
      undefined,
      value => ({ ...value }),
    );
    candidate.set('aa', { amount: 1n });
    expect(candidate.getForWrite('aa')?.amount).toBe(1n);
    expect(() => ensureEntityCollectionCandidate(
      PersistentEntityCollectionMap.empty<{ amount: bigint }>(),
      value => ({ ...value }),
    )).toThrow('ENTITY_COLLECTION_WRITE_OUTSIDE_CANDIDATE');
  });

  test('paybook key codec uses the raw 32-byte hashlock', () => {
    const hashlock = `0x${'ab'.repeat(32)}`;
    const paybook = PersistentEntityCollectionMap.from(
      new Map([[hashlock, { amount: 1n }]]),
      'paybookHashlock',
    );
    const leaf = [...paybook.nodeRecords()].find(record => record.kind === 'leaf');
    expect(leaf?.keyBytes).toEqual(hexToBytes(hashlock));
    expect(() => PersistentEntityCollectionMap.from(
      new Map([[hashlock.toUpperCase(), { amount: 1n }]]),
      'paybookHashlock',
    )).toThrow('PAYBOOK_HASHLOCK_KEY_INVALID');
  });
});
