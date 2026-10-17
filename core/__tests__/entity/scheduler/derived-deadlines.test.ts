import { describe, expect, test } from 'bun:test';
import {
  collectDerivedDeadlines,
  earliestDerivedDeadline,
} from '../../../entity/scheduler/derived-deadlines';

const id = (byte: string): string => `0x${byte.repeat(64)}`;

const lock = (lockId: string, timelock: bigint | number) => ({
  lockId,
  hashlock: id('4'),
  tokenId: 1,
  amount: 10n,
  timelock,
  revealBeforeHeight: 10,
});

const pendingAck = (hashlock: string, inboundEntity: string, deadline: number, startedAt = deadline - 500) => ({
  hashlock,
  tokenId: 1,
  amount: 10n,
  inboundEntity,
  inboundLockId: `lock:${hashlock}`,
  createdTimestamp: 1,
  secret: id('5'),
  secretAckPending: true,
  secretAckStartedAt: startedAt,
  secretAckDeadlineAt: deadline,
});

// The same fixture as the Rust `htlc_deadlines_*` tests in
// rscore/crates/batch/src/resident_consensus.rs: both sides must drain
// deadlines in (triggerAt, id) order with ties broken by the id text.
const state = () =>
  ({
    entityId: id('1'),
    timestamp: 1_000,
    accounts: new Map([
      [
        id('a'),
        {
          mempool: [],
          state: {
            locks: new Map([
              ['lock-b', lock('lock-b', 200n)],
              ['lock-z', lock('lock-z', 100n)],
              ['lock-huge', lock('lock-huge', 2n ** 60n)],
            ]),
          },
        },
      ],
      [
        id('b'),
        {
          mempool: [],
          state: {
            locks: new Map([
              ['lock-a', lock('lock-a', 200n)],
              ['lock-zero', lock('lock-zero', 0n)],
            ]),
          },
        },
      ],
    ]),
    paybook: {
      feesEarned: 0n,
      entries: new Map([
        [id('7'), pendingAck(id('7'), id('b'), 200)],
        [id('8'), { ...pendingAck(id('8'), id('b'), 150), secretAckPending: false }],
        [id('9'), pendingAck(id('9'), id('a'), 300)],
      ]),
    },
  }) as any;

describe('derived per-payment deadlines', () => {
  test('orders by triggerAt then id across accounts and paybook entries', () => {
    expect(collectDerivedDeadlines(state()).map((deadline) => [deadline.triggerAt, deadline.id])).toEqual([
      [100, 'htlc-timeout:lock-z'],
      [200, `htlc-secret-ack:${id('7')}`],
      [200, 'htlc-timeout:lock-a'],
      [200, 'htlc-timeout:lock-b'],
      [300, `htlc-secret-ack:${id('9')}`],
    ]);
  });

  test('deadline-1 is not due, deadline and deadline+1 are', () => {
    const ids = (now: number) => collectDerivedDeadlines(state(), now).map((deadline) => deadline.id);
    expect(ids(99)).toEqual([]);
    expect(ids(100)).toEqual(['htlc-timeout:lock-z']);
    expect(ids(199)).toEqual(['htlc-timeout:lock-z']);
    expect(ids(200)).toHaveLength(4);
    expect(ids(201)).toHaveLength(4);
  });

  test('carries the hook-shaped data the scheduler drains by', () => {
    const [timeout, ack] = collectDerivedDeadlines(state(), 200);
    expect(timeout).toEqual({
      id: 'htlc-timeout:lock-z',
      triggerAt: 100,
      type: 'htlc_timeout',
      data: { accountId: id('a'), lockId: 'lock-z' },
    });
    expect(ack).toEqual({
      id: `htlc-secret-ack:${id('7')}`,
      triggerAt: 200,
      type: 'htlc_secret_ack_timeout',
      data: { hashlock: id('7'), counterpartyEntityId: id('b') },
    });
  });

  test('frozen-account-htlc-deadline-does-not-rewake', () => {
    // A frozen Account has no htlc_resolve consumer (tx-effects suppresses the
    // returned AccountTx), so a past timelock there must not keep re-arming
    // the derived wake. Its secret-ACK waits have no dispute-start consumer either.
    const base = state();
    base.accounts.get(id('a')).status = 'dispute_preparing';
    base.accounts.get(id('b')).status = 'disputed';
    expect(collectDerivedDeadlines(base, 1_000)).toEqual([]);
    expect(earliestDerivedDeadline(base)).toBeNull();
    base.paybook.entries.clear();
    expect(earliestDerivedDeadline(base)).toBeNull();
    // Returning to active (or an unset status) re-exposes the lock deadlines.
    base.accounts.get(id('a')).status = 'active';
    delete base.accounts.get(id('b')).status;
    expect(collectDerivedDeadlines(base, 1_000).map(deadline => deadline.id)).toEqual([
      'htlc-timeout:lock-z',
      'htlc-timeout:lock-a',
      'htlc-timeout:lock-b',
    ]);
    expect(earliestDerivedDeadline(base)).toBe(100);
  });

  test('overdue loans join the same derived set and only while active', () => {
    // Mirrors the Rust `lending_overdue_*` fixtures: only `active` loans whose
    // committed `dueAt` has passed produce a settlement deadline, ordered with
    // every other derived deadline by (triggerAt, id).
    const base = state();
    const loan = (loanId: string, dueAt: number, status: string) =>
      [loanId, { loanId, positionId: 'lend-1111111111111111', dueAt, status }] as const;
    base.lending = {
      savings: new Map(),
      loans: new Map([
        loan('loan-b', 150, 'active'),
        loan('loan-a', 150, 'active'),
        loan('loan-repaid', 50, 'repaid'),
        loan('loan-opening', 60, 'opening'),
      ]),
    };
    expect(collectDerivedDeadlines(base, 1_000).map((deadline) => deadline.id)).toEqual([
      'htlc-timeout:lock-z',
      'lending-overdue:loan-a',
      'lending-overdue:loan-b',
      `htlc-secret-ack:${id('7')}`,
      'htlc-timeout:lock-a',
      'htlc-timeout:lock-b',
      `htlc-secret-ack:${id('9')}`,
    ]);
    expect(collectDerivedDeadlines(base, 149).map((deadline) => deadline.id)).toEqual([
      'htlc-timeout:lock-z',
    ]);
    expect(collectDerivedDeadlines(base, 150)[1]).toEqual({
      id: 'lending-overdue:loan-a',
      triggerAt: 150,
      type: 'lending_overdue',
      data: { loanId: 'loan-a' },
    });
    base.accounts.clear();
    base.paybook.entries.clear();
    expect(earliestDerivedDeadline(base)).toBe(150);
    base.lending.loans.get('loan-a').status = 'defaulted';
    base.lending.loans.get('loan-b').status = 'defaulted';
    expect(earliestDerivedDeadline(base)).toBeNull();
    expect(collectDerivedDeadlines(base, 1_000)).toEqual([]);
  });

  test('earliest deadline drives the idle wake and ignores unusable timelocks', () => {
    const base = state();
    expect(earliestDerivedDeadline(base)).toBe(100);
    base.accounts.get(id('a')).state.locks.delete('lock-z');
    expect(earliestDerivedDeadline(base)).toBe(200);
    base.accounts.clear();
    expect(earliestDerivedDeadline(base)).toBeNull();
    base.paybook.entries.clear();
    expect(earliestDerivedDeadline(base)).toBeNull();
  });
});
