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
const state = () => ({
  entityId: id('1'),
  timestamp: 1_000,
  accounts: new Map([
    [id('a'), { state: { locks: new Map([
      ['lock-b', lock('lock-b', 200n)],
      ['lock-z', lock('lock-z', 100n)],
      ['lock-huge', lock('lock-huge', 2n ** 60n)],
    ]) } }],
    [id('b'), { state: { locks: new Map([
      ['lock-a', lock('lock-a', 200n)],
      ['lock-zero', lock('lock-zero', 0n)],
    ]) } }],
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

  test('earliest deadline drives the idle wake and ignores unusable timelocks', () => {
    const base = state();
    expect(earliestDerivedDeadline(base)).toBe(100);
    base.accounts.get(id('a')).state.locks.delete('lock-z');
    expect(earliestDerivedDeadline(base)).toBe(200);
    base.accounts.clear();
    expect(earliestDerivedDeadline(base)).toBe(200);
    base.paybook.entries.clear();
    expect(earliestDerivedDeadline(base)).toBeNull();
  });
});
