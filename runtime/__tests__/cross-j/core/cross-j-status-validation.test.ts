import { describe, expect, test } from 'bun:test';

import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionPullBinding,
  cloneCrossJurisdictionRoute,
} from '../../../extensions/cross-j';
import { CROSS_JURISDICTION_SWAP_STATUSES } from '../../../types/hash-coverage/cross-j-nested';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

const route = (status: CrossJurisdictionSwapRoute['status']): CrossJurisdictionSwapRoute => ({
  orderId: 'order-status',
  makerEntityId: `0x${'11'.repeat(32)}`,
  hubEntityId: `0x${'22'.repeat(32)}`,
  source: {
    jurisdiction: 'source',
    entityId: `0x${'11'.repeat(32)}`,
    counterpartyEntityId: `0x${'22'.repeat(32)}`,
    tokenId: 1,
    amount: 10n,
  },
  target: {
    jurisdiction: 'target',
    entityId: `0x${'33'.repeat(32)}`,
    counterpartyEntityId: `0x${'44'.repeat(32)}`,
    tokenId: 2,
    amount: 20n,
  },
  sourceDisputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
  targetDisputeConfig: { leftResponseSeconds: 1, rightResponseSeconds: 1 },
  status,
  createdAt: 1,
  updatedAt: 2,
});

describe('cross-j lifecycle status validation', () => {
  test('clones every canonical swap status and rejects unknown tags without copying', () => {
    for (const status of CROSS_JURISDICTION_SWAP_STATUSES) {
      expect(cloneCrossJurisdictionRoute(route(status)).status).toBe(status);
    }
    const malformed = { ...route('resting'), status: 'claimed' };
    expect(() => cloneCrossJurisdictionRoute(malformed as CrossJurisdictionSwapRoute))
      .toThrow('CROSS_J_ROUTE_STATUS_INVALID:claimed');
    expect(malformed.status).toBe('claimed');
  });

  test('missing required route status is rejected instead of defaulting to intent', () => {
    const missing = { ...route('resting') } as CrossJurisdictionSwapRoute;
    delete (missing as { status?: string }).status;
    expect(() => cloneCrossJurisdictionRoute(missing)).toThrow('CROSS_J_ROUTE_STATUS_INVALID:undefined');
  });

  test('book admission and pull binding reject unknown statuses without mutation', () => {
    const admission = {
      orderId: 'book-1',
      routeHash: `0x${'55'.repeat(32)}`,
      sourceEntityId: `0x${'11'.repeat(32)}`,
      bookOwnerEntityId: `0x${'22'.repeat(32)}`,
      status: 'queued',
      route: route('resting'),
      updatedAt: 3,
    };
    expect(() => cloneCrossJurisdictionBookAdmission(admission as never))
      .toThrow('CROSS_J_BOOK_STATUS_INVALID:queued');
    expect(admission.status).toBe('queued');

    const binding = {
      orderId: 'order-status',
      routeHash: `0x${'55'.repeat(32)}`,
      leg: 'source' as const,
      status: 'claimed',
    };
    expect(() => cloneCrossJurisdictionPullBinding(binding as never))
      .toThrow('CROSS_J_ROUTE_STATUS_INVALID:claimed');
    expect(binding.status).toBe('claimed');
  });
});
