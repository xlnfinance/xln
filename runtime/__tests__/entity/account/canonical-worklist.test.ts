import { describe, expect, test } from 'bun:test';

import { createCanonicalAccountWorklist } from '../../../entity/consensus/account/canonical-worklist';

const drain = (worklist: ReturnType<typeof createCanonicalAccountWorklist>): string[] => {
  const result: string[] = [];
  while (true) {
    const accountId = worklist.take();
    if (accountId === undefined) return result;
    result.push(accountId);
  }
};

describe('canonical Entity Account worklist', () => {
  test('sorts the initial frontier once and suppresses duplicates', () => {
    const worklist = createCanonicalAccountWorklist(['c', 'a', 'b', 'a']);
    expect(drain(worklist)).toEqual(['a', 'b', 'c']);
  });

  test('inserts discovered work into the unread canonical suffix', () => {
    const worklist = createCanonicalAccountWorklist(['b', 'd']);
    expect(worklist.take()).toBe('b');
    expect(worklist.add('a')).toBe(true);
    expect(worklist.add('c')).toBe(true);
    expect(worklist.add('d')).toBe(false);
    expect(drain(worklist)).toEqual(['a', 'c', 'd']);
  });

  test('drains one thousand Accounts in canonical byte order', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) =>
      `account-${String(999 - index).padStart(4, '0')}`,
    );
    const worklist = createCanonicalAccountWorklist(ids);
    expect(drain(worklist)).toEqual([...ids].sort());
  });

  test('matches the former repeated-sort order when work is discovered mid-drain', () => {
    const discovered = new Map<string, readonly string[]>([
      ['b', ['a', 'f']],
      ['a', ['c']],
      ['d', ['aa', 'e']],
    ]);
    const referenceSet = new Set(['b', 'd']);
    const referenceDone = new Set<string>();
    const reference: string[] = [];
    while (true) {
      const next = [...referenceSet]
        .filter(accountId => !referenceDone.has(accountId))
        .sort()[0];
      if (next === undefined) break;
      referenceDone.add(next);
      reference.push(next);
      for (const accountId of discovered.get(next) ?? []) referenceSet.add(accountId);
    }

    const worklist = createCanonicalAccountWorklist(['b', 'd']);
    const actual: string[] = [];
    while (true) {
      const next = worklist.take();
      if (next === undefined) break;
      actual.push(next);
      for (const accountId of discovered.get(next) ?? []) worklist.add(accountId);
    }
    expect(actual).toEqual(reference);
  });
});
