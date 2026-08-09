import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';
import { ethers } from 'ethers';

import { applyEntityTx } from '../entity/tx/apply';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../extensions/cross-j/index';
import { validateCrossJurisdictionLocalBinding } from '../entity/tx/cross-jurisdiction-helpers';
import { createEmptyEnv } from '../runtime';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import {
  addr,
  entity,
  installJurisdictions,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  partialBinary,
  secret,
} from './helpers/cross-j';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;

const buildRoute = (
  orderId: string,
  seed: string,
  eth = makeJurisdiction('Ethereum', 1, '11', '12'),
  tron = makeJurisdiction('Tron', 2, '21', '22'),
): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRoute({
    orderId,
    makerEntityId: entity('01'),
    hubEntityId: entity('02'),
    sourceDisputeConfig: TEST_DISPUTE_CONFIG,
    targetDisputeConfig: TEST_DISPUTE_CONFIG,
    source: {
      jurisdiction: jref(eth),
      entityId: entity('01'),
      counterpartyEntityId: entity('02'),
      tokenId: 1,
      amount: 1_000_000_000_000_000_000n,
    },
    target: {
      jurisdiction: jref(tron),
      entityId: entity('03'),
      counterpartyEntityId: entity('04'),
      tokenId: 1,
      amount: 900_000_000_000_000_000n,
    },
    status: 'intent',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 61_000,
}, { runtimeSeed: seed, now: 1_000 });

describe('cross-jurisdiction security invariants', () => {
  test('route preparation rejects missing signed response clocks without defaults', () => {
    const route = buildRoute('cross-clock-required', 'cross-clock-required');
    const { sourceDisputeConfig: _source, ...withoutSourceClock } = route;
    expect(() => buildPreparedCrossJurisdictionRoute(
      withoutSourceClock as CrossJurisdictionSwapRoute,
      { runtimeSeed: 'cross-clock-required', now: 1_000 },
    )).toThrow('ACCOUNT_DISPUTE_CONFIG_INVALID');
  });

  test('local binding rejects display-name stack ref collision with wrong local stack', () => {
    const env = createEmptyEnv('cross-local-stack-name-collision');
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const wrongLocal = {
      ...makeJurisdiction('Wrong Local', 9, '99', '98'),
      name: jref(eth),
    };
    installJurisdictions(env, eth, wrongLocal);
    const route = buildRoute('cross-local-stack-name-collision', 'cross-local-stack-name-collision', eth);
    const state = makeState(route.source.entityId, addr('31'), wrongLocal, route.source.counterpartyEntityId);

    const error = validateCrossJurisdictionLocalBinding(env, state, route);

    expect(error).toContain('does not match local jurisdiction');
  });

  test('source clear fails if account offer route hash diverges from entity route', async () => {
    const env = createEmptyEnv('cross-clear-route-mismatch');
    env.state.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('01');
    const sourceHub = entity('02');
    const state = makeState(sourceHub, addr('32'), eth, sourceUser);
    const route = {
      ...buildRoute('cross-clear-route-mismatch', 'cross-clear-route-mismatch'),
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      filledSourceAmount: 500_000_000_000_000_000n,
      filledTargetAmount: 450_000_000_000_000_000n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 1,
      crossJurisdiction: { ...route, routeHash: secret('ff') },
    });

    await expect(applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    })).rejects.toThrow('CROSS_J_ROUTE_HASH_MISMATCH');
  });

  test('source clear throws on corrupted committed route without pull commitments', async () => {
    const env = createEmptyEnv('cross-clear-corrupt-route');
    env.state.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('01');
    const sourceHub = entity('02');
    const state = makeState(sourceHub, addr('33'), eth, sourceUser);
    const route = {
      ...buildRoute('cross-clear-corrupt-route', 'cross-clear-corrupt-route'),
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      filledSourceAmount: 500_000_000_000_000_000n,
      filledTargetAmount: 450_000_000_000_000_000n,
    } as any;
    delete route.sourcePull;
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    await expect(applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    })).rejects.toThrow('CROSS_J_CLEAR_CORRUPT_ROUTE');
  });

  test('target-side prepareDispute drafts through exact hanko preflight when optional pull arguments are unavailable', async () => {
    const env = createEmptyEnv('cross-target-dispute-needs-source-args');
    env.state.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const tron = makeJurisdiction('Tron', 2, '21', '22');
    const route = buildRoute('cross-target-dispute-needs-source-args', 'cross-target-dispute-needs-source-args');
    const state = makeState(route.target.counterpartyEntityId, addr('41'), tron, route.target.entityId);
    const account = state.accounts.get(route.target.entityId)!;
    account.state.pulls ??= new Map();
    account.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 1,
      createdTimestamp: 1_000,
    });
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = await applyEntityTx(env, state, {
      type: 'prepareDispute',
      data: { counterpartyEntityId: route.target.entityId },
    });

    expect(result.newState.jBatchState?.batch.disputeStarts).toHaveLength(0);
    expect(readEntityFrameEventMessages(result.newState).at(-1)).toContain('Missing counterparty dispute hanko');
  });

  test('target-side prepareDispute preserves pull arguments through normal hanko preflight', async () => {
    const env = createEmptyEnv('cross-target-dispute-with-source-args');
    env.state.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const tron = makeJurisdiction('Tron', 2, '21', '22');
    const route = buildRoute('cross-target-dispute-with-source-args', 'cross-target-dispute-with-source-args');
    const state = makeState(route.target.counterpartyEntityId, addr('42'), tron, route.target.entityId);
    const account = state.accounts.get(route.target.entityId)!;
    account.state.pulls ??= new Map();
    account.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 1,
      createdTimestamp: 1_000,
    });
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const pullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      [{ fillRatios: [], secrets: [] }],
    );
    const starterInitialArguments = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[pullArgs]]);

    const result = await applyEntityTx(env, state, {
      type: 'prepareDispute',
      data: { counterpartyEntityId: route.target.entityId, starterInitialArguments },
    });

    expect(readEntityFrameEventMessages(result.newState).at(-1)).toContain('Missing counterparty dispute hanko');
  });

  test('hub rejects a pulls-attached prepare arriving outside the proposer lane', async () => {
    // The certified user lane may carry prepareCrossJurisdictionSwap, but a
    // route with pulls attached is proposer-only material: accepting it would
    // lock hub-collateral pulls whose ladder secrets the hub runtime never
    // derived. The rejection is soft (mesh survives an attacker replaying it),
    // stores nothing, and emits no register outputs.
    const env = createEmptyEnv('cross-user-lane-injection');
    env.state.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 2, '21', '22');
    installJurisdictions(env, eth, tron);
    const route = buildRoute('cross-user-lane-injection', 'cross-user-lane-injection');
    const state = makeState(route.source.counterpartyEntityId, addr('55'), eth, route.source.entityId);

    const result = await applyEntityTx(env, state, {
      type: 'prepareCrossJurisdictionSwap',
      data: { route },
    });

    expect(result.newState.crossJurisdictionSwaps?.has(route.orderId) ?? false).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEventMessages(result.newState).at(-1)).toContain('proposer lane');
  });
});
