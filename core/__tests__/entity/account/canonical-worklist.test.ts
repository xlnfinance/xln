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
  test('retains first-touch order and suppresses duplicates', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['c', 'a', 'b', 'a']));
    expect(drain(worklist)).toEqual(['c', 'a', 'b']);
  });

  test('appends discovered work after the unread accepted frontier', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    expect(worklist.take()).toEqual({ accountId: 'b', force: false });
    expect(worklist.add('a')).toBe(true);
    expect(worklist.add('c')).toBe(true);
    expect(worklist.add('d')).toBe(false);
    expect(drain(worklist)).toEqual(['d', 'a', 'c']);
  });

  test('drains one thousand Accounts in accepted order', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) =>
      `account-${String(999 - index).padStart(4, '0')}`,
    );
    const worklist = createCanonicalAccountWorklist(workMap(ids));
    expect(drain(worklist)).toEqual(ids);
  });

  test('keeps append order when work is discovered mid-drain', () => {
    const discovered = new Map<string, readonly string[]>([
      ['b', ['a', 'f']],
      ['a', ['c']],
      ['d', ['aa', 'e']],
    ]);
    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    const actual: string[] = [];
    while (true) {
      const next = worklist.take();
      if (next === undefined) break;
      actual.push(next.accountId);
      for (const accountId of discovered.get(next.accountId) ?? []) worklist.add(accountId);
    }
    expect(actual).toEqual(['b', 'd', 'a', 'f', 'aa', 'e', 'c']);
  });

  test('upgrades an unread Account to a forced Channel.ts flush', () => {
    const worklist = createCanonicalAccountWorklist(workMap(['b', 'd']));
    expect(worklist.add('d', true)).toBe(false);
    expect(worklist.take()).toEqual({ accountId: 'b', force: false });
    expect(worklist.take()).toEqual({ accountId: 'd', force: true });
  });
});
