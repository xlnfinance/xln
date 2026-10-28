import { expect, test } from 'bun:test';
import {
  buildPreparedCrossJurisdictionRoute,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j';
import { entity, getTestAccountForWrite, jref, makeJurisdiction, makeState } from '../../helpers/cross-j';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

const ids = {
  'source-user': entity('11'),
  'source-hub': entity('22'),
  'target-hub': entity('33'),
  'target-user': entity('44'),
};
const intent: CrossJurisdictionSwapRoute = {
  orderId: 'absolute-deadlines',
  makerEntityId: ids['source-user'],
  hubEntityId: ids['source-hub'],
  source: {
    jurisdiction: jref(makeJurisdiction('Source', 1, '11', '12')),
    entityId: ids['source-user'],
    counterpartyEntityId: ids['source-hub'],
    tokenId: 1,
    amount: 1000n,
  },
  target: {
    jurisdiction: jref(makeJurisdiction('Target', 2, '21', '22')),
    entityId: ids['target-hub'],
    counterpartyEntityId: ids['target-user'],
    tokenId: 2,
    amount: 1000n,
  },
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  status: 'intent',
  createdAt: 1000,
  updatedAt: 1000,
  expiresAt: 200_000,
};

test('admission rejects missing absolute deadline authority', () => {
  const { expiresAt, ...missing } = intent;
  expect(() => withCanonicalCrossJurisdictionRouteHash(missing)).toThrow();
  expect(() => buildPreparedCrossJurisdictionRoute(missing, { runtimeSeed: 'deadline-vector', now: 1000 })).toThrow();
});

test('admission rejects source deadline plus margin greater than target deadline', () => {
  const route = buildPreparedCrossJurisdictionRoute(intent, { runtimeSeed: 'deadline-vector', now: 1000 });
  route.targetPull!.deadline = route.sourcePull!.deadline + 232;
  expect(() => withCanonicalCrossJurisdictionRouteHash(route)).toThrow();
});

import { validatePreparedCrossJurisdictionRoute } from '../../../extensions/cross-j/prepared-route';
import { CROSS_J_LEG_MARGIN } from '../../../extensions/cross-j/deadlines';

for (const role of ['source-user', 'source-hub', 'target-hub', 'target-user'] as const) {
  test(`${role} rejects an insufficient signed deadline margin before Pull admission`, () => {
    const source = role.startsWith('source');
    const peer = source
      ? role === 'source-user'
        ? 'source-hub'
        : 'source-user'
      : role === 'target-user'
        ? 'target-hub'
        : 'target-user';
    const jurisdiction = source ? makeJurisdiction('Source', 1, '11', '12') : makeJurisdiction('Target', 2, '21', '22');
    const state = makeState(ids[role], `${role}-signer`, jurisdiction, ids[peer]);
    getTestAccountForWrite(state, ids[peer]).state.disputeConfig = intent.sourceDisputeConfig;
    const prepared = buildPreparedCrossJurisdictionRoute(intent, { runtimeSeed: 'deadline-vector', now: 1000 });
    expect(validatePreparedCrossJurisdictionRoute(state, prepared).targetPull?.deadline).toBe(200 + CROSS_J_LEG_MARGIN);
    if (!prepared.targetPull) throw new Error('test missing prepared Pull');
    prepared.targetPull.deadline -= 1;
    expect(() => validatePreparedCrossJurisdictionRoute(state, prepared)).toThrow('CROSS_J_DEADLINE_ORDER');
  });
}
