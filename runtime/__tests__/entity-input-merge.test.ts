import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEntityInputs } from '../entity/consensus/input-merge';
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

  test('orders an older commit before a newer proposal regardless of route metadata', () => {
    const target = entityId('7');
    const frame = (height: number, hashByte: string) => ({
      height,
      txs: [],
      hash: `0x${hashByte.repeat(64)}`,
      newState: {},
      leader: { proposerSignerId: '1', view: 0 },
    }) as never;
    const older = { entityId: target, signerId: '2', from: 'z-route', proposedFrame: frame(9, '1') };
    const newer = { entityId: target, signerId: '2', from: 'a-route', proposedFrame: frame(10, '2') };

    expect(mergeEntityInputs([newer, older]).map(input => input.proposedFrame?.height)).toEqual([9, 10]);
    expect(mergeEntityInputs([older, newer]).map(input => input.proposedFrame?.height)).toEqual([9, 10]);
  });

  test('runs one canonical scheduled wake before txs that can replace its due hooks', () => {
    const wake = {
      type: 'scheduledWake',
      data: { version: 1, proposerSignerId: '1', dueAt: 100, jobs: [{ kind: 'hook', id: 'due', dueAt: 100 }] },
    } as never;
    const accountInput = { type: 'accountInput', data: {} } as never;
    const target = entityId('4');

    const merged = mergeEntityInputs([
      { entityId: target, signerId: '1', entityTxs: [accountInput] },
      { entityId: target, signerId: '1', entityTxs: [wake] },
      { entityId: target, signerId: '1', entityTxs: [wake] },
    ]);

    expect(merged[0]?.entityTxs?.map(tx => tx.type)).toEqual(['scheduledWake', 'accountInput']);
  });

  test('rejects conflicting scheduled wake payloads for one entity frame', () => {
    const target = entityId('5');
    const wake = (dueAt: number) => ({
      type: 'scheduledWake',
      data: { version: 1, proposerSignerId: '1', dueAt, jobs: [{ kind: 'hook', id: 'due', dueAt }] },
    } as never);

    expect(() => mergeEntityInputs([
      { entityId: target, signerId: '1', entityTxs: [wake(100)] },
      { entityId: target, signerId: '1', entityTxs: [wake(200)] },
    ])).toThrow('SCHEDULED_WAKE_CONFLICTING_INPUTS');
  });

  test('uses structured logging without direct console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/entity/consensus/input-merge.ts'), 'utf8');

    expect(source).toContain("createStructuredLogger('entity.input.merge')");
    expect(source).toContain("entityInputMergeLog.warn('frame.conflict'");
    expect(source).toContain("entityInputMergeLog.debug('precommits.merge'");
    expect(source).toContain("entityInputMergeLog.debug('duplicates.deduped'");
    expect(source).not.toContain('console.');
  });
});
