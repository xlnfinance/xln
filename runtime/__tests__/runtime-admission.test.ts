import { describe, expect, test } from 'bun:test';

import { runtimeInputRequiresOutboxCapacity } from '../machine/admission';
import type { RoutedEntityInput } from '../types';

const input = (type: string): RoutedEntityInput => ({
  entityId: `0x${'11'.repeat(32)}`,
  signerId: `0x${'22'.repeat(20)}`,
  entityTxs: [{ type, data: {} } as never],
});

describe('runtime outbox admission', () => {
  test('keeps consensus progress and security jobs live at outbox capacity', () => {
    for (const type of [
      'scheduledWake',
      'accountInput',
      'j_event',
      'prepareDispute',
      'disputeStart',
      'disputeFinalize',
      'j_broadcast',
    ]) {
      expect(runtimeInputRequiresOutboxCapacity([input(type)])).toBe(false);
    }
  });

  test('backpressures new local financial commands but not already remote ingress', () => {
    expect(runtimeInputRequiresOutboxCapacity([input('directPayment')])).toBe(true);
    expect(runtimeInputRequiresOutboxCapacity([{ ...input('directPayment'), from: `0x${'33'.repeat(20)}` }])).toBe(false);
  });
});
