import { describe, expect, test } from 'bun:test';

import {
  ENTITY_PROVIDER_ACTION_KIND,
  encodeCancelEntityProviderActionHankoPayload,
} from '../../../../hanko/onchain-domain';
import { watchtowerMinSequenceRevokingAll } from '../../../../watchtower/store/appointments';

const DOMAIN = {
  chainId: 8453,
  entityProviderAddress: '0x6666666666666666666666666666666666666666',
  boardEpoch: 11,
} as const;

describe('watchtower appointment fence (EntityProvider.setWatchtowerMinSequence)', () => {
  test('action kind 2 is cancellable on the shared entity action lane', () => {
    expect(ENTITY_PROVIDER_ACTION_KIND.watchtowerMinSequence).toBe(2);
    const cancelledActionHash = `0x${'ab'.repeat(32)}`;
    expect(() => encodeCancelEntityProviderActionHankoPayload(DOMAIN, {
      entityNumber: 42,
      actionNonce: 4,
      cancelledActionHash,
      cancelledActionKind: 2,
    })).not.toThrow();
    expect(() => encodeCancelEntityProviderActionHankoPayload(DOMAIN, {
      entityNumber: 42,
      actionNonce: 4,
      cancelledActionHash,
      cancelledActionKind: 3,
    })).toThrow('INVALID_HANKO_CANCELLED_ACTION_KIND:3');
  });

  test('revoking minimum is one above the highest stored appointment sequence', () => {
    expect(watchtowerMinSequenceRevokingAll([])).toBe(1n);
    expect(watchtowerMinSequenceRevokingAll([
      { lastResortPayload: { appointmentSequence: 4 } as never },
      { lastResortPayload: { appointmentSequence: 9 } as never },
      { lastResortPayload: undefined as never },
    ])).toBe(10n);
  });
});
