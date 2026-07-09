import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEntityInputs } from '../entity-input-merge';
import type { RoutedEntityInput } from '../types';

const entityId = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;

const inputFor = (suffix: string, signer = '1'): RoutedEntityInput => ({
  entityId: entityId(suffix),
  signerId: signer,
  entityTxs: [{
    type: 'profile-update',
    data: { name: `entity-${suffix}` },
  } as never],
});

describe('mergeEntityInputs', () => {
  test('returns entity inputs in canonical order independent of arrival order', () => {
    const left = inputFor('1');
    const right = inputFor('2');
    const mergedForward = mergeEntityInputs([left, right]);
    const mergedReverse = mergeEntityInputs([right, left]);

    expect(mergedForward.map((input) => input.entityId)).toEqual([entityId('1'), entityId('2')]);
    expect(mergedReverse.map((input) => input.entityId)).toEqual([entityId('1'), entityId('2')]);
  });

  test('keeps duplicate merge behavior while canonicalizing output order', () => {
    const duplicateA = {
      ...inputFor('2'),
      entityTxs: [{ type: 'profile-update', data: { name: 'a' } } as never],
    };
    const duplicateB = {
      ...inputFor('2'),
      entityTxs: [{ type: 'profile-update', data: { name: 'b' } } as never],
    };

    const merged = mergeEntityInputs([inputFor('3'), duplicateA, inputFor('1'), duplicateB]);

    expect(merged.map((input) => input.entityId)).toEqual([entityId('1'), entityId('2'), entityId('3')]);
    expect(merged[1]?.entityTxs?.map((tx) => (tx.data as { name: string }).name)).toEqual(['a', 'b']);
  });

  test('uses structured logging without direct console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/entity-input-merge.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('entity.input.merge')");
    expect(source).toContain("entityInputMergeLog.warn('frame.conflict'");
    expect(source).toContain("entityInputMergeLog.debug('precommits.merge'");
    expect(source).toContain("entityInputMergeLog.debug('duplicates.deduped'");
    expect(source).not.toContain('console.');
  });
});
