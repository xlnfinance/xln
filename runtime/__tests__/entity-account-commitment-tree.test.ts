import { describe, expect, test } from 'bun:test';
import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { buildRadixMerkle } from '../protocol/state/radix-merkle';
import { ethers } from 'ethers';
import {
  buildEntityAccountCommitment,
  deleteEntityAccountCommitment,
  EMPTY_ENTITY_ACCOUNT_COMMITMENT,
  entityAccountCommitmentRoot,
  putEntityAccountCommitment,
} from '../entity/consensus/account/commitment-tree';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const valueHash = (value: string): string =>
  computeIntegrityDigest(new TextEncoder().encode(value));

describe('Entity Account commitment tree', () => {
  test('root is independent from insertion order', () => {
    const entries = [
      [entityId('11'), valueHash('first')],
      [entityId('22'), valueHash('second')],
      [entityId('33'), valueHash('third')],
    ] as const;
    const forward = entries.reduce(
      (tree, [key, value]) => putEntityAccountCommitment(tree, key, value),
      EMPTY_ENTITY_ACCOUNT_COMMITMENT,
    );
    const reverse = [...entries].reverse().reduce(
      (tree, [key, value]) => putEntityAccountCommitment(tree, key, value),
      EMPTY_ENTITY_ACCOUNT_COMMITMENT,
    );

    expect(entityAccountCommitmentRoot(forward)).toBe(
      entityAccountCommitmentRoot(reverse),
    );
    expect(forward.leafCount).toBe(3);
    expect(reverse.leafCount).toBe(3);
    expect(entityAccountCommitmentRoot(forward)).toBe(
      buildRadixMerkle(
        entries.map(([key, value]) => ({
          key: ethers.getBytes(key),
          value: ethers.getBytes(value),
        })),
        { radix: 16 },
      ).root,
    );
    expect(entityAccountCommitmentRoot(buildEntityAccountCommitment(entries))).toBe(
      entityAccountCommitmentRoot(forward),
    );
  });

  test('persistent updates leave the certified base unchanged', () => {
    const key = entityId('44');
    const certified = putEntityAccountCommitment(
      EMPTY_ENTITY_ACCOUNT_COMMITMENT,
      key,
      valueHash('certified'),
    );
    const candidate = putEntityAccountCommitment(
      certified,
      key,
      valueHash('candidate'),
    );

    expect(entityAccountCommitmentRoot(candidate)).not.toBe(
      entityAccountCommitmentRoot(certified),
    );
    expect(candidate.leafCount).toBe(1);
    expect(certified.leafCount).toBe(1);
  });

  test('deletion collapses branches to the canonical remaining root', () => {
    const retainedKey = entityId('55');
    const deletedKey = entityId('56');
    const retainedValue = valueHash('retained');
    const singleton = putEntityAccountCommitment(
      EMPTY_ENTITY_ACCOUNT_COMMITMENT,
      retainedKey,
      retainedValue,
    );
    const pair = putEntityAccountCommitment(
      singleton,
      deletedKey,
      valueHash('deleted'),
    );
    const deleted = deleteEntityAccountCommitment(pair, deletedKey);

    expect(entityAccountCommitmentRoot(deleted)).toBe(
      entityAccountCommitmentRoot(singleton),
    );
    expect(deleted.leafCount).toBe(1);
  });
});
