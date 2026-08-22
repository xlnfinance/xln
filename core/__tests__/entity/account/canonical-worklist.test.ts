import { describe, expect, test } from 'bun:test';

import { createCanonicalAccountWorklist } from '../../../entity/consensus/account/canonical-worklist';

const workMap = (accountIds: readonly string[]): Map<string, boolean> =>
  new Map(accountIds.map(accountId => [accountId, false]));

const drain = (worklist: ReturnType<typeof createCanonicalAccountWorklist>): string[] => {
  const result: string[] = [];
  while (true) {
    const work = worklist.take();
    if (work === undefined) return result;
    result.push(work.accountId);
  }
};

describe('canonical Entity Account worklist', () => {
  test('sorts the initial frontier once and suppresses duplicates', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['c', 'a', 'b', 'a']));
    expect(drain(worklist)).toEqual(['a', 'b', 'c']);
  });

  test('inserts discovered work into the unread canonical suffix', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    expect(worklist.take()).toEqual({ accountId: 'b', force: false });
    expect(worklist.add('a')).toBe(true);
    expect(worklist.add('c')).toBe(true);
    expect(worklist.add('d')).toBe(false);
    expect(drain(worklist)).toEqual(['a', 'c', 'd']);
  });

  test('drains one thousand Accounts in canonical byte order', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) =>
      `account-${String(999 - index).padStart(4, '0')}`,
    );
    const worklist = createCanonicalAccountWorklist(workMap(ids));
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

    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    const actual: string[] = [];
    while (true) {
      const next = worklist.take();
      if (next === undefined) break;
      actual.push(next.accountId);
      for (const accountId of discovered.get(next.accountId) ?? []) worklist.add(accountId);
    }
    expect(actual).toEqual(reference);
  });

  test('upgrades an unread Account to a forced Channel.ts flush', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    expect(worklist.add('d', true)).toBe(false);
    expect(worklist.take()).toEqual({ accountId: 'b', force: false });
    expect(worklist.take()).toEqual({ accountId: 'd', force: true });
  });
});
