import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEntityInputs } from '../entity/consensus/input-merge';
import type { EntityLeaderTimeoutVote, RoutedEntityInput } from '../types';

const entityId = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;

const inputFor = (suffix: string, signer = '1'): RoutedEntityInput => ({
  entityId: entityId(suffix),
  signerId: signer,
  entityTxs: [{
    type: 'profile-update',
    data: { name: `entity-${suffix}` },
  } as never],
});

const leaderVote = (voterId: string, signature: string): EntityLeaderTimeoutVote => ({
  entityId: entityId('9'),
  targetHeight: 4,
  previousFrameHash: `0x${'ab'.repeat(32)}`,
  fromView: 0,
  toView: 1,
  previousLeaderId: 'validator-a',
  nextLeaderId: 'validator-b',
  voterId,
  signature,
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

  test('orders distinct frame heights even when route metadata and claimed hash conflict', () => {
    const target = entityId('7');
    const frame = (height: number, hashByte: string) => ({
      height,
      txs: [],
      hash: `0x${hashByte.repeat(64)}`,
      newState: {},
      leader: { proposerSignerId: '1', view: 0 },
    }) as never;
    const older = { entityId: target, signerId: '2', from: 'z-route', proposedFrame: frame(9, '1') };
    const newer = { entityId: target, signerId: '2', from: 'a-route', proposedFrame: frame(10, '1') };

    expect(mergeEntityInputs([newer, older]).map(input => input.proposedFrame?.height)).toEqual([9, 10]);
    expect(mergeEntityInputs([older, newer]).map(input => input.proposedFrame?.height)).toEqual([9, 10]);
  });

  test('prefers a same-frame commit certificate over a proposal in either arrival order', () => {
    const target = entityId('8');
    const proposal = {
      entityId: target,
      signerId: '2',
      proposedFrame: {
        height: 11,
        txs: [],
        hash: `0x${'3'.repeat(64)}`,
        newState: {},
        leader: { proposerSignerId: '1', view: 0 },
        collectedSigs: new Map([['1', ['0xproposer']]]),
      } as never,
    };
    const certificate = {
      ...proposal,
      proposedFrame: {
        ...proposal.proposedFrame,
        collectedSigs: new Map([['1', ['0xproposer']], ['2', ['0xvalidator']]]),
        hankos: ['0xquorum-hanko'],
      } as never,
    };

    for (const inputs of [[proposal, certificate], [certificate, proposal]]) {
      const merged = mergeEntityInputs(inputs);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.proposedFrame?.hankos).toEqual(['0xquorum-hanko']);
    }
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

  test('preserves every distinct leader-timeout voter and deduplicates only the exact signed vote', () => {
    const target = entityId('9');
    const targetSigner = 'validator-b';
    const votes = [
      leaderVote('validator-a', '0xsig-a'),
      leaderVote('validator-b', '0xsig-b'),
      leaderVote('validator-c', '0xsig-c'),
    ];
    const toInput = (vote: EntityLeaderTimeoutVote): RoutedEntityInput => ({
      entityId: target,
      signerId: targetSigner,
      leaderTimeoutVote: vote,
    });

    const forward = mergeEntityInputs([...votes.map(toInput), toInput(structuredClone(votes[0]!))]);
    const reverse = mergeEntityInputs([...votes].reverse().map(toInput));

    expect(forward).toHaveLength(3);
    expect(reverse).toHaveLength(3);
    expect(forward.map(input => input.leaderTimeoutVote?.voterId)).toEqual([
      'validator-a',
      'validator-b',
      'validator-c',
    ]);
    expect(reverse.map(input => input.leaderTimeoutVote?.voterId)).toEqual(
      forward.map(input => input.leaderTimeoutVote?.voterId),
    );
  });

  test('rejects a same-body leader vote whose signed envelope is not an exact duplicate', () => {
    const target = entityId('9');
    const first = { entityId: target, signerId: 'validator-b', leaderTimeoutVote: leaderVote('validator-a', '0xsig-a') };
    const conflicting = {
      entityId: target,
      signerId: 'validator-b',
      leaderTimeoutVote: leaderVote('validator-a', '0xother-signature'),
    };

    expect(() => mergeEntityInputs([first, conflicting])).toThrow('ENTITY_LEADER_VOTE_EQUIVOCATION');
  });

  test('does not canonicalize a case-duplicate precommit signer out of a malformed envelope', () => {
    const target = entityId('a');
    const voter = '0xabcdef';
    const malformed = new Map<string, string[]>([
      [voter, ['0xsig']],
      [voter.toUpperCase(), ['0xsig']],
    ]);
    expect(() => mergeEntityInputs([
      { entityId: target, signerId: 'validator-a', hashPrecommits: new Map() },
      { entityId: target, signerId: 'validator-a', hashPrecommits: malformed },
    ])).toThrow('ENTITY_INPUT_PRECOMMIT_DUPLICATE_SIGNER');
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
