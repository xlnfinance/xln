import { describe, expect, test } from 'bun:test';

import type { HtlcRoute } from '../../../../types/account';
import {
  failedForwardHtlcRouteClosure,
  isDisputeReadyHtlcRoute,
  isFinalRecipientHtlcRoute,
  isForwardingHtlcRoute,
  isSecretAckPendingHtlcRoute,
} from '../../../../entity/htlc/route-views';

const base = (): HtlcRoute => ({
  hashlock: `0x${'11'.repeat(32)}`,
  createdTimestamp: 100,
});

describe('FinTS HTLC route views', () => {
  test('requires both linked endpoints for forwarding', () => {
    const route = { ...base(), inboundEntity: 'alice', inboundLockId: 'in' };
    expect(isForwardingHtlcRoute(route)).toBe(false);
    Object.assign(route, { outboundEntity: 'bob', outboundLockId: 'out' });
    expect(isForwardingHtlcRoute(route)).toBe(true);
  });

  test('distinguishes final recipient without adding stored status', () => {
    const route = { ...base(), inboundEntity: 'alice', inboundLockId: 'in' };
    expect(isFinalRecipientHtlcRoute(route)).toBe(true);
    Object.assign(route, { outboundEntity: 'bob', outboundLockId: 'out' });
    expect(isFinalRecipientHtlcRoute(route)).toBe(false);
  });

  test('requires the complete secret-ack tuple and deadline', () => {
    const route: HtlcRoute = {
      ...base(),
      inboundEntity: 'alice',
      inboundLockId: 'in',
      secret: `0x${'22'.repeat(32)}`,
      secretAckPending: true,
      secretAckStartedAt: 120,
      secretAckDeadlineAt: 150,
    };
    expect(isSecretAckPendingHtlcRoute(route)).toBe(true);
    expect(isDisputeReadyHtlcRoute(route, 149)).toBe(false);
    expect(isDisputeReadyHtlcRoute(route, 150)).toBe(true);
  });

  test('projects only the transitive route closure reachable by this worklist', () => {
    const route = (
      hashlock: string,
      outboundEntity: string,
      inboundEntity: string,
    ): HtlcRoute => ({
      hashlock,
      outboundEntity,
      outboundLockId: `out-${hashlock}`,
      inboundEntity,
      inboundLockId: `in-${hashlock}`,
      createdTimestamp: 100,
    });
    const routes = new Map<string, HtlcRoute>([
      ['0x02', route('0x02', 'middle', 'upstream')],
      ['0x01', route('0x01', 'downstream', 'middle')],
      ['0x03', route('0x03', 'unrelated', 'other')],
    ]);
    expect(failedForwardHtlcRouteClosure(routes, ['DOWNSTREAM'])).toEqual([
      {
        hashlock: '0x01',
        outboundAccountId: 'downstream',
        outboundLockId: 'out-0x01',
        inboundAccountId: 'middle',
        inboundLockId: 'in-0x01',
      },
      {
        hashlock: '0x02',
        outboundAccountId: 'middle',
        outboundLockId: 'out-0x02',
        inboundAccountId: 'upstream',
        inboundLockId: 'in-0x02',
      },
    ]);
  });
});
