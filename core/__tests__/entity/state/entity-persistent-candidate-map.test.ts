import { describe, expect, test } from 'bun:test';

import {
  EntityCandidateMap,
  getEntityCandidateValueForWrite,
} from '../../../entity/state/candidate-map';

describe('Entity persistent candidate map', () => {
  test('rejection leaves a shared certified root untouched', () => {
    const shared = new Map([
      ['alice', { balance: 10n }],
      ['bob', { balance: 20n }],
    ]);
    const proposer = new EntityCandidateMap(shared, value => ({ ...value }), false);

    getEntityCandidateValueForWrite(proposer, 'alice')!.balance = 99n;

    expect(shared.get('alice')?.balance).toBe(10n);
    expect(proposer.get('alice')?.balance).toBe(99n);
    expect(proposer.stats()).toEqual({ base: 2, changed: 1, deleted: 0 });
  });

  test('commit path-copies dirty branches and preserves the previous root', () => {
    const shared = new EntityCandidateMap(
      new Map([
        ['alice', { balance: 10n }],
        ['bob', { balance: 20n }],
      ]),
      value => ({ ...value }),
      false,
    );
    shared.commit();
    const proposer = new EntityCandidateMap(shared, value => ({ ...value }), false);
    getEntityCandidateValueForWrite(proposer, 'alice')!.balance = 99n;
    const committed = proposer.commit();

    expect(shared.get('alice')?.balance).toBe(10n);
    expect(committed.get('alice')?.balance).toBe(99n);
    expect(committed.get('bob')).toBe(shared.get('bob'));
  });

  test('a candidate over an uncommitted candidate captures only its visible dirty root', () => {
    const base = new Map([['alice', { balance: 10n }]]);
    const first = new EntityCandidateMap(base, value => ({ ...value }), false);
    getEntityCandidateValueForWrite(first, 'alice')!.balance = 20n;
    const second = new EntityCandidateMap(first, value => ({ ...value }), false);
    getEntityCandidateValueForWrite(second, 'alice')!.balance = 30n;
    second.commit();

    expect(base.get('alice')?.balance).toBe(10n);
    expect(first.get('alice')?.balance).toBe(20n);
    expect(second.get('alice')?.balance).toBe(30n);
  });

  test('someKey observes additions and deletions without flattening the candidate', () => {
    const candidate = new EntityCandidateMap(
      new Map([['same:1/2', 1], ['cross:1/2', 2]]),
      value => value,
    );
    expect(candidate.someKey(key => key.startsWith('cross:'))).toBe(true);
    candidate.delete('cross:1/2');
    expect(candidate.someKey(key => key.startsWith('cross:'))).toBe(false);
    candidate.set('cross:2/3', 3);
    expect(candidate.someKey(key => key.startsWith('cross:'))).toBe(true);
    candidate.clear();
    expect(candidate.someKey(key => key.startsWith('cross:'))).toBe(false);
  });
});
