import { describe, expect, test } from 'bun:test';

import { applyEntityTx } from '../../../entity/tx/apply';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import { getEntityCollectionValueForWrite } from '../../../entity/state/persistent-collection-map';
import { createEmptyEnv } from '../../../runtime';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute as buildPreparedCrossJurisdictionRouteCanonical,
  cloneCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
} from '../../../extensions/cross-j/index';
import {
  addReplica,
  addr,
  entity,
  jref,
  makeJurisdiction,
  makeState,
} from '../../helpers/cross-j';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;

const withFixtureDisputeConfig = (
  route: Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>,
): CrossJurisdictionSwapRoute => ({
  ...route,
  sourceDisputeConfig: TEST_DISPUTE_CONFIG,
  targetDisputeConfig: TEST_DISPUTE_CONFIG,
} as CrossJurisdictionSwapRoute);

describe('crossPullClose sealed Patricia leaf', () => {
  test('target close forks a frozen route instead of assigning in place', async () => {
    const env = createEmptyEnv('cross-pull-close-sealed-leaf');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const targetHubSigner = addr('86');
    const targetState = makeState(targetHub, targetHubSigner, base, targetUser);
    addReplica(env, targetState, targetHubSigner);

    const fillRatio = 32_768;
    const prepared = buildPreparedCrossJurisdictionRouteCanonical(
      withFixtureDisputeConfig({
        orderId: 'cross-pull-close-sealed-leaf',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'partially_filled',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      }),
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, route);
    const reveal = buildCrossJurisdictionPullReveal(route, fillRatio, privateSeed);
    const proof = buildCrossJurisdictionCloseProof(route, reveal.binary);
    route.sourceCloseProof = proof;
    targetState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));

    const candidate = createEntityFrameCandidateState(targetState);
    const sealed = candidate.crossJurisdictionSwaps?.get(route.orderId);
    if (!sealed) throw new Error('TEST_SEALED_ROUTE_MISSING');
    expect(Object.isFrozen(sealed)).toBe(true);

    const result = await applyEntityTx(env, targetState, {
      type: 'crossPullClose',
      data: {
        counterpartyEntityId: targetUser,
        pullId: route.targetPull!.pullId,
        binary: reveal.binary,
        proof,
        route: cloneCrossJurisdictionRoute(route),
        description: 'sealed-leaf target close',
      },
    });

    expect(result.skippedError).toBeUndefined();
    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    const written = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(written?.status).toBe('clearing');
    expect(written?.sourceCloseProof?.fillRatio).toBe(fillRatio);
    expect(Object.isFrozen(written)).toBe(false);
  });

  test('getForWrite re-forks a frozen leaf that a prior set stuffed into the overlay', async () => {
    const env = createEmptyEnv('cross-pull-close-frozen-overlay');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const targetHubSigner = addr('86');
    const targetState = makeState(targetHub, targetHubSigner, base, targetUser);
    addReplica(env, targetState, targetHubSigner);

    const prepared = buildPreparedCrossJurisdictionRouteCanonical(
      withFixtureDisputeConfig({
        orderId: 'frozen-overlay-leaf',
        makerEntityId: entity('81'),
        hubEntityId: entity('82'),
        source: {
          jurisdiction: jref(makeJurisdiction('Ethereum', 1, '11', '12')),
          entityId: entity('81'),
          counterpartyEntityId: entity('82'),
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 900n,
        },
        status: 'partially_filled',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      }),
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    targetState.crossJurisdictionSwaps?.set(prepared.orderId, cloneCrossJurisdictionRoute(prepared));
    const candidate = createEntityFrameCandidateState(targetState);
    const sealed = candidate.crossJurisdictionSwaps?.get(prepared.orderId);
    if (!sealed) throw new Error('TEST_SEALED_ROUTE_MISSING');
    const originalStatus = sealed.status;
    candidate.crossJurisdictionSwaps?.set(prepared.orderId, sealed);
    const writable = getEntityCollectionValueForWrite(
      candidate.crossJurisdictionSwaps!,
      prepared.orderId,
    );
    if (!writable) throw new Error('TEST_WRITABLE_ROUTE_MISSING');
    expect(Object.isFrozen(writable)).toBe(false);
    writable.status = 'clearing';
    expect(candidate.crossJurisdictionSwaps?.get(prepared.orderId)?.status).toBe('clearing');
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(sealed.status).toBe(originalStatus);
  });
});
