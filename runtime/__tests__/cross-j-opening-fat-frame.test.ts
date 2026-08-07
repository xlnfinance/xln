import { describe, expect, test } from 'bun:test';

import { handlePullLock } from '../account/tx/handlers/pull';
import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionRoute,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j';
import { createEmptyEnv } from '../runtime';
import { selectMatchedCrossJAccountInputPairs } from '../runtime/entity-routing';
import type { AccountTx } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RoutedEntityInput } from '../runtime/types';
import {
  addReplica,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  secret,
} from './helpers/cross-j';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const sourceUser = entityId('a1');
const sourceHub = entityId('a2');
const targetHub = entityId('a3');
const targetUser = entityId('a4');
const sourceSigner = addr('b1');
const targetSigner = addr('b2');

const buildRoute = (
  orderId: string,
  routeHash: string,
  fullHash: string,
  partialRoot: string,
): CrossJurisdictionSwapRoute => ({
  orderId,
  routeHash,
  makerEntityId: sourceUser,
  hubEntityId: sourceHub,
  sourceSignerId: sourceSigner,
  targetSignerId: targetSigner,
  source: {
    jurisdiction: 'stack:1:source',
    entityId: sourceUser,
    counterpartyEntityId: sourceHub,
    tokenId: 1,
    amount: 10n,
  },
  target: {
    jurisdiction: 'stack:2:target',
    entityId: targetHub,
    counterpartyEntityId: targetUser,
    tokenId: 2,
    amount: 20n,
  },
  sourcePull: {
    pullId: `${orderId}-source`,
    tokenId: 1,
    amount: 10n,
    signedAmount: -10n,
    fullHash,
    partialRoot,
  },
  targetPull: {
    pullId: `${orderId}-target`,
    tokenId: 2,
    amount: 20n,
    signedAmount: -20n,
    fullHash,
    partialRoot,
  },
  status: 'intent',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 20_000,
});

const pullLockTx = (
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
): Extract<AccountTx, { type: 'cross_pull_lock' }> => {
  const pull = leg === 'source' ? route.sourcePull! : route.targetPull!;
  const { signedAmount, ...proof } = pull;
  return {
    type: 'cross_pull_lock',
    data: {
      ...proof,
      amount: signedAmount,
      crossJurisdiction: { orderId: route.orderId, routeHash: route.routeHash!, leg },
      crossJurisdictionRoute: cloneCrossJurisdictionRoute(route),
    },
  };
};

/** Source legs require a sibling swap_offer or admission marks the candidate invalid. */
const swapOfferTx = (
  route: CrossJurisdictionSwapRoute,
): Extract<AccountTx, { type: 'swap_offer' }> => ({
  type: 'swap_offer',
  data: {
    offerId: route.orderId,
    giveTokenId: route.source.tokenId,
    giveAmount: route.source.amount,
    wantTokenId: route.target.tokenId,
    wantAmount: route.target.amount,
    crossJurisdiction: cloneCrossJurisdictionRoute(route),
  },
});

/**
 * Mirrored dual-pull fat frame for two orders:
 * - left carries source(A) + target(B)
 * - right carries target(A) + source(B)
 * No order is both source and target on the same leg (that would duplicate
 * admission keys). This is the MM bootstrap shape at size 1+1.
 */
const mirroredFatFrameInputs = (
  routeAsSourceOnLeft: CrossJurisdictionSwapRoute,
  routeAsSourceOnRight: CrossJurisdictionSwapRoute,
): [RoutedEntityInput, RoutedEntityInput] => {
  const frame = { height: 1, timestamp: 1_000 };
  const left: RoutedEntityInput = {
    runtimeId: addr('c1'),
    entityId: sourceUser,
    signerId: sourceSigner,
    sourceRuntimeFrame: frame,
    entityTxs: [{
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: sourceHub,
        toEntityId: sourceUser,
        domain: { chainId: 1, depositoryAddress: addr('d1') },
        proposal: {
          frame: {
            height: 1,
            timestamp: 1,
            jHeight: 0,
            accountTxs: [
              pullLockTx(routeAsSourceOnLeft, 'source'),
              swapOfferTx(routeAsSourceOnLeft),
              pullLockTx(routeAsSourceOnRight, 'target'),
            ],
            prevFrameHash: 'genesis',
            accountStateRoot: secret('11'),
            stateHash: secret('12'),
            deltas: [],
            byLeft: sourceHub < sourceUser,
          },
        },
      },
    }],
  };
  const right: RoutedEntityInput = {
    runtimeId: addr('c1'),
    entityId: targetUser,
    signerId: targetSigner,
    sourceRuntimeFrame: frame,
    entityTxs: [{
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: targetHub,
        toEntityId: targetUser,
        domain: { chainId: 2, depositoryAddress: addr('d2') },
        proposal: {
          frame: {
            height: 1,
            timestamp: 1,
            jHeight: 0,
            accountTxs: [
              pullLockTx(routeAsSourceOnLeft, 'target'),
              pullLockTx(routeAsSourceOnRight, 'source'),
              swapOfferTx(routeAsSourceOnRight),
            ],
            prevFrameHash: 'genesis',
            accountStateRoot: secret('21'),
            stateHash: secret('22'),
            deltas: [],
            byLeft: targetHub < targetUser,
          },
        },
      },
    }],
  };
  return [left, right];
};

const admissionEnv = () => {
  const env = createEmptyEnv('cross-j-fat-frame-l1');
  env.state.timestamp = 1_000;
  const sourceJ = makeJurisdiction('Source', 1, '11', '12');
  const targetJ = makeJurisdiction('Target', 2, '21', '22');
  addReplica(env, makeState(sourceUser, sourceSigner, sourceJ, sourceHub), sourceSigner);
  addReplica(env, makeState(targetUser, targetSigner, targetJ, targetHub), targetSigner);
  return env;
};

describe('cross-j fat-frame opening admission', () => {
  test('rejects opposing orders that share hashladder material in one cohort', () => {
    const sharedFullHash = secret('aa');
    const routeA = buildRoute('order-a', secret('r1'), sharedFullHash, secret('p1'));
    const routeB = buildRoute('order-b', secret('r2'), sharedFullHash, secret('p2'));
    const selection = selectMatchedCrossJAccountInputPairs(
      admissionEnv(),
      mirroredFatFrameInputs(routeA, routeB),
    );
    expect(selection.pairs).toEqual([]);
    expect(selection.rejectedLegs.length).toBeGreaterThan(0);
    expect(selection.rejectedLegs.some(leg =>
      leg.detail.some(detail => detail.includes('opening-shared-hash-material')))).toBe(true);
  });

  test('rejects opposing orders that share partialRoot in one cohort', () => {
    const sharedPartial = secret('pp');
    const routeA = buildRoute('order-a', secret('r1'), secret('f1'), sharedPartial);
    const routeB = buildRoute('order-b', secret('r2'), secret('f2'), sharedPartial);
    const selection = selectMatchedCrossJAccountInputPairs(
      admissionEnv(),
      mirroredFatFrameInputs(routeA, routeB),
    );
    expect(selection.pairs).toEqual([]);
    expect(selection.rejectedLegs.some(leg =>
      leg.detail.some(detail => detail.includes('opening-shared-hash-material') && detail.includes('partialRoot')))).toBe(true);
  });

  test('distinct hashladders reach per-order auth (not shared-hash rejection)', () => {
    const routeA = buildRoute('order-a', secret('r1'), secret('f1'), secret('p1'));
    const routeB = buildRoute('order-b', secret('r2'), secret('f2'), secret('p2'));
    const selection = selectMatchedCrossJAccountInputPairs(
      admissionEnv(),
      mirroredFatFrameInputs(routeA, routeB),
    );
    expect(selection.pairs).toEqual([]);
    const details = selection.rejectedLegs.flatMap(leg => leg.detail);
    expect(details.some(detail => detail.includes('opening-shared-hash-material'))).toBe(false);
    expect(details.some(detail => detail.includes('opening-authorization-absent'))).toBe(true);
  });

  test('rejects a cohort that reuses a hashladder already live on another Entity', () => {
    const env = admissionEnv();
    const liveRoot = secret('zz');
    const sourceState = env.state.eReplicas.get(`${sourceUser}:${sourceSigner}`)?.state;
    const account = sourceState?.accounts.get(sourceHub);
    if (!sourceState || !account) throw new Error('admission fixture missing source account');
    account.state.pulls = new Map([[
      'prior-order-source',
      {
        pullId: 'prior-order-source',
        tokenId: 1,
        amount: -10n,
        claimedRatio: 0,
        claimedAmount: 0n,
        fullHash: secret('yy'),
        partialRoot: liveRoot,
        crossJurisdiction: {
          orderId: 'prior-order',
          routeHash: secret('r0'),
          leg: 'source',
          status: 'resting',
        },
        createdHeight: 1,
        createdTimestamp: 1_000,
      },
    ]]);
    const routeA = buildRoute('order-a', secret('r1'), secret('f1'), liveRoot);
    const routeB = buildRoute('order-b', secret('r2'), secret('f2'), secret('p2'));
    const selection = selectMatchedCrossJAccountInputPairs(
      env,
      mirroredFatFrameInputs(routeA, routeB),
    );
    expect(selection.pairs).toEqual([]);
    expect(selection.rejectedLegs.some(leg =>
      leg.detail.some(detail => detail.includes('opening-shared-hash-material')))).toBe(true);
  });
});

describe('cross-j pull hash material durability', () => {
  test('handlePullLock rejects a later order that reuses fullHash or partialRoot', async () => {
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const account = makeAccount(sourceUser, sourceHub, sourceJ);
    // Seed a live pull from a prior frame — the durable guard must catch
    // collisions that the single-cohort admission gate cannot see.
    account.state.pulls = new Map([[
      'order-a-source',
      {
        pullId: 'order-a-source',
        tokenId: 1,
        amount: -10n,
        claimedRatio: 0,
        claimedAmount: 0n,
        fullHash: secret('aa'),
        partialRoot: secret('bb'),
        crossJurisdiction: {
          orderId: 'order-a',
          routeHash: secret('r1'),
          leg: 'source',
          status: 'resting',
        },
        createdHeight: 1,
        createdTimestamp: 1_000,
      },
    ]]);

    const targetJ = makeJurisdiction('Target', 2, '21', '22');
    const collidingRoute = withCanonicalCrossJurisdictionRouteHash({
      ...buildRoute('order-b', secret('r2'), secret('aa'), secret('cc')),
      routeHash: undefined,
      status: 'resting',
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 10n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 20n,
      },
      sourcePull: {
        pullId: 'order-b-source',
        tokenId: 1,
        amount: 10n,
        signedAmount: -10n,
        fullHash: secret('aa'),
        partialRoot: secret('cc'),
      },
      targetPull: {
        pullId: 'order-b-target',
        tokenId: 2,
        amount: 20n,
        signedAmount: -20n,
        fullHash: secret('aa'),
        partialRoot: secret('cc'),
      },
    });
    const collideFull: Extract<AccountTx, { type: 'cross_pull_lock' }> = {
      type: 'cross_pull_lock',
      data: {
        pullId: collidingRoute.sourcePull!.pullId,
        tokenId: collidingRoute.sourcePull!.tokenId,
        amount: collidingRoute.sourcePull!.signedAmount,
        fullHash: collidingRoute.sourcePull!.fullHash,
        partialRoot: collidingRoute.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(collidingRoute, 'source'),
        crossJurisdictionRoute: collidingRoute,
      },
    };
    const fullCollision = await handlePullLock(account.state, collideFull, true, 1, 1_000);
    expect(fullCollision.success).toBe(false);
    expect(fullCollision.error).toContain('hash material collides');

    const collidePartialRoute = withCanonicalCrossJurisdictionRouteHash({
      ...collidingRoute,
      orderId: 'order-c',
      routeHash: undefined,
      sourcePull: {
        pullId: 'order-c-source',
        tokenId: 1,
        amount: 10n,
        signedAmount: -10n,
        fullHash: secret('dd'),
        partialRoot: secret('bb'),
      },
      targetPull: {
        ...collidingRoute.targetPull!,
        pullId: 'order-c-target',
        fullHash: secret('dd'),
        partialRoot: secret('bb'),
      },
    });
    const collidePartial: Extract<AccountTx, { type: 'cross_pull_lock' }> = {
      type: 'cross_pull_lock',
      data: {
        pullId: collidePartialRoute.sourcePull!.pullId,
        tokenId: collidePartialRoute.sourcePull!.tokenId,
        amount: collidePartialRoute.sourcePull!.signedAmount,
        fullHash: collidePartialRoute.sourcePull!.fullHash,
        partialRoot: collidePartialRoute.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(collidePartialRoute, 'source'),
        crossJurisdictionRoute: collidePartialRoute,
      },
    };
    const partialCollision = await handlePullLock(account.state, collidePartial, true, 1, 1_000);
    expect(partialCollision.success).toBe(false);
    expect(partialCollision.error).toContain('hash material collides');
  });
});
