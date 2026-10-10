import { describe, expect, test } from 'bun:test';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import { ethers } from 'ethers';
import { PersistentRadixValueMap } from '../../../protocol/state/persistent-radix-value-map';
import { ENTITY_ACCOUNT_VALUE_MAP_RADIX } from '../../../entity/state/persistent-account-map';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const valueHash = (value: string): string =>
  computeIntegrityDigest(new TextEncoder().encode(value));

// Account commitments use this production value radix, with each Account's
// committed digest as the leaf value; no separate commitment tree remains.
const options = {
  radix: ENTITY_ACCOUNT_VALUE_MAP_RADIX,
  ownKey: (key: string): string => key.toLowerCase(),
  keyBytes: (key: string): Uint8Array => ethers.getBytes(key),
  valueHash: (digest: string): string => digest,
  ownValue: (digest: string): string => digest,
};

describe('Entity Account commitment tree', () => {
  test('root is independent from insertion order', () => {
    const entries = [
      [entityId('11'), valueHash('first')],
      [entityId('22'), valueHash('second')],
      [entityId('33'), valueHash('third')],
    ] as const;
    const forward = entries.reduce(
      (tree, [key, value]) => tree.updated(key, value),
      PersistentRadixValueMap.empty(options),
    );
    const reverse = [...entries].reverse().reduce(
      (tree, [key, value]) => tree.updated(key, value),
      PersistentRadixValueMap.empty(options),
    );

    expect(forward.rootHash()).toBe(reverse.rootHash());
    expect(forward.size).toBe(3);
    expect(reverse.size).toBe(3);
    // Pinned from the retired flat builder over the same three leaves.
    expect(forward.rootHash()).toBe(
      '0x150f0bdc1fe98628809e2cfb1a3b779988ec853f5ca043f5852d290e8c4bf234',
    );
    expect(PersistentRadixValueMap.fromMap(entries, options).rootHash()).toBe(
      forward.rootHash(),
    );
  });

  test('persistent updates leave the certified base unchanged', () => {
    const key = entityId('44');
    const certified = PersistentRadixValueMap.empty(options).updated(key, valueHash('certified'));
    const candidate = certified.updated(key, valueHash('candidate'));

    expect(candidate.rootHash()).not.toBe(certified.rootHash());
    expect(candidate.size).toBe(1);
    expect(certified.size).toBe(1);
  });

  test('deletion collapses branches to the canonical remaining root', () => {
    const retainedKey = entityId('55');
    const deletedKey = entityId('56');
    const retainedValue = valueHash('retained');
    const singleton = PersistentRadixValueMap.empty(options).updated(retainedKey, retainedValue);
    const pair = singleton.updated(deletedKey, valueHash('deleted'));
    const deleted = pair.removed(deletedKey);

    expect(deleted.rootHash()).toBe(singleton.rootHash());
    expect(deleted.size).toBe(1);
  });
});
