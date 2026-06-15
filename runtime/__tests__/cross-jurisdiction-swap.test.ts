import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyEntityTx } from '../entity-tx/apply';
import { processAccountTx } from '../account-tx/apply';
import { handlePullCancel } from '../account-tx/handlers/pull';
import { processOrderbookCancels } from '../entity-tx/handlers/account';
import { applyEntityInput } from '../entity-consensus';
import {
  createEmptyEnv,
  submitCrossJurisdictionSwap,
} from '../runtime';
import { hashHtlcSecret } from '../htlc-utils';
import type { AccountTx, EntityInput, EntityReplica, JurisdictionEvent } from '../types';
import { generateLazyEntityId } from '../entity-factory';
import { createDefaultDelta } from '../validation-utils';
import { cloneEntityState } from '../state-helpers';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity-tx/handlers/account-cross-j-followups';
import {
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  deriveCrossJurisdictionRouteHash,
  isCrossJurisdictionRouteTransitionAllowed,
  withCanonicalCrossJurisdictionRouteHash,
  cloneCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
} from '../cross-jurisdiction-orderbook';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs, deriveCanonicalCrossJurisdictionMarketForLegs } from '../cross-jurisdiction-market';
import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account-utils';
import { normalizeEntitySwapTradingPairs } from '../runtime-swap-pairs';
import { verifyHashLadderBinary } from '../hashladder';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook/types';
import { buildAccountProofBody, createDisputeProofHashWithNonce, setDeltaTransformerAddress } from '../proof-builder';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../dispute-arguments';
import { signEntityHashes } from '../hanko/signing';
import {
  addReplica,
  addr,
  entity,
  installJurisdictions,
  jref,
  makeAccount,
  makeJurisdiction,
  makeState,
  partialBinary,
  registerTestSigner,
  secret,
  signJEventObservation,
} from './helpers/cross-j';

describe('cross-jurisdiction hashledger swap', () => {
  test('hashlockPayment creates a direct hashlock-only account lock', async () => {
    const env = createEmptyEnv('cross-hashlock-payment');
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('01');
    const hub = entity('02');
    const signer = addr('31');
    const state = makeState(user, signer, eth, hub);
    const hashlock = hashHtlcSecret(secret('44'));

    const result = await applyEntityTx(env, state, {
      type: 'hashlockPayment',
      data: {
        targetEntityId: hub,
        tokenId: 1,
        amount: 25n,
        hashlock,
        lockId: `0x${'55'.repeat(32)}`,
        timelock: 130_000n,
        revealBeforeHeight: 50,
      },
    });

    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps?.[0]?.tx.type).toBe('htlc_lock');
    expect((result.mempoolOps?.[0]?.tx as any).data.envelope).toBeUndefined();
    expect(result.newState.htlcRoutes.get(hashlock)?.outboundLockId).toBe(`0x${'55'.repeat(32)}`);
    expect(result.newState.lockBook.get(`0x${'55'.repeat(32)}`)?.direction).toBe('outgoing');
  });

  test('submitCrossJurisdictionSwap queues hub prepare, then prepare builds symmetric pull commitments', async () => {
    const env = createEmptyEnv('cross-submit');
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    env.activeJurisdiction = eth.name;
    env.jReplicas.set(eth.name, {
      name: eth.name,
      chainId: eth.chainId,
      rpcs: [eth.address],
      depositoryAddress: eth.depositoryAddress,
      entityProviderAddress: eth.entityProviderAddress,
      blockTimeMs: eth.blockTimeMs,
      defaultDisputeDelayBlocks: 5,
    } as any);
    env.jReplicas.set(base.name, {
      name: base.name,
      chainId: base.chainId,
      rpcs: [base.address],
      depositoryAddress: base.depositoryAddress,
      entityProviderAddress: base.entityProviderAddress,
      blockTimeMs: 200,
      defaultDisputeDelayBlocks: 7,
    } as any);

    const sourceUser = entity('01');
    const sourceHub = entity('02');
    const targetHub = entity('03');
    const targetUser = entity('04');
    const sourceUserSigner = addr('31');
    const sourceHubSigner = addr('32');
    const targetHubSigner = addr('33');
    const targetUserSigner = addr('34');
    addReplica(env, makeState(sourceUser, sourceUserSigner, eth, sourceHub), sourceUserSigner);
    addReplica(env, makeState(sourceHub, sourceHubSigner, eth, sourceUser), sourceHubSigner);
    addReplica(env, makeState(targetHub, targetHubSigner, base, targetUser), targetHubSigner);
    addReplica(env, makeState(targetUser, targetUserSigner, base, targetHub), targetUserSigner);

    const result = await submitCrossJurisdictionSwap(env, {
      orderId: 'cross-test-1',
      sourceUserEntityId: sourceUser,
      sourceHubEntityId: sourceHub,
      targetHubEntityId: targetHub,
      targetUserEntityId: targetUser,
      sourceTokenId: 1,
      sourceAmount: 100n,
      targetTokenId: 1,
      targetAmount: 90n,
      sourceUserSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetUserSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
    });

    const queued = env.runtimeMempool?.entityInputs ?? [];
    expect(result.hashlock).toBeUndefined();
    expect(result.secret).toBeUndefined();
    expect(result.route.routeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.route.source.jurisdiction).toBe(jref(eth));
    expect(result.route.target.jurisdiction).toBe(jref(base));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.entityId).toBe(sourceUser);
    expect(queued[0]?.entityTxs?.[0]?.type).toBe('requestCrossJurisdictionSwap');

    const sourceUserState = (env.eReplicas.get(`${sourceUser}:${sourceUserSigner}`) as EntityReplica).state;
    const requested = await applyEntityTx(env, sourceUserState, queued[0]!.entityTxs![0]!);
    expect(requested.outputs).toHaveLength(1);
    expect(requested.outputs[0]?.entityId).toBe(sourceHub);
    expect(requested.outputs[0]?.entityTxs?.[0]?.type).toBe('prepareCrossJurisdictionSwap');
    const sourceHubState = (env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica).state;
    const prepared = await applyEntityTx(env, sourceHubState, requested.outputs[0]!.entityTxs![0]!);
      expect(prepared.outputs).toHaveLength(2);
      const targetHubOutput = prepared.outputs.find(output => output.entityId === targetHub);
      const targetUserOutput = prepared.outputs.find(output => output.entityId === targetUser);
      const sourceUserOutput = prepared.outputs.find(output => output.entityId === sourceUser);
      expect(targetHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap', 'pullLock']);
      expect(targetUserOutput?.entityTxs?.[0]?.type).toBe('registerCrossJurisdictionSwap');
      expect(sourceUserOutput).toBeUndefined();
      const preparedRoute = (targetHubOutput?.entityTxs?.[0]?.data as any).route;
      expect(preparedRoute.routeHash).toBe(result.route.routeHash);
      expect(deriveCrossJurisdictionRouteHash(preparedRoute)).toBe(preparedRoute.routeHash);
      expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
      expect(preparedRoute.sourcePull.partialRoot).toBe(preparedRoute.targetPull.partialRoot);
      expect((targetHubOutput?.entityTxs?.[1]?.data as any).crossJurisdiction).toMatchObject({
        orderId: preparedRoute.orderId,
        routeHash: preparedRoute.routeHash,
        leg: 'target',
      });
      expect(preparedRoute.targetPull.revealedUntilTimestamp - preparedRoute.sourcePull.revealedUntilTimestamp)
        .toBeGreaterThanOrEqual(5_000 + CROSS_J_TARGET_REVEAL_SAFETY_MS);
    });

  test('request rejects route jurisdiction labels that are not bound to the local entity', async () => {
    const env = createEmptyEnv('cross-route-jurisdiction-canonical');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const actualSourceJurisdiction = makeJurisdiction('Arrakis (Shared Anvil)', 31337, '11', '12');
    const targetJurisdiction = makeJurisdiction('Tron', 31338, '21', '22');
    const sourceUser = entity('a1');
    const sourceHub = entity('a2');
    const targetHub = entity('a3');
    const targetUser = entity('a4');
    const sourceSigner = addr('a5');
    const targetSigner = addr('a6');
    const sourceState = makeState(sourceUser, sourceSigner, actualSourceJurisdiction, sourceHub);
    const targetState = makeState(targetUser, targetSigner, targetJurisdiction, targetHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, targetState, targetSigner);
    const staleRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-route-jurisdiction-canonical',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: 'Testnet', entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 2, amount: 1_000n },
      target: { jurisdiction: 'LocalAnvil2', entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'intent',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    });

    const result = await applyEntityTx(env, sourceState, {
      type: 'requestCrossJurisdictionSwap',
      data: { route: staleRoute },
    });

    expect(result.outputs).toHaveLength(0);
    expect(result.newState.messages.at(-1)).toContain('route jurisdiction must be stack ref');
  });

  test('prepared cross-j route keeps immutable routeHash through alias-named source commit and clear', async () => {
    const env = createEmptyEnv('cross-prepared-routehash-immutable');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceHubJurisdiction = makeJurisdiction('Arrakis (Shared Anvil)', 31337, '11', '12');
    const sourceUserAliasJurisdiction = makeJurisdiction('Testnet', 31337, '11', '12');
    const targetJurisdiction = makeJurisdiction('Tron', 31338, '21', '22');
    for (const jurisdiction of [sourceHubJurisdiction, sourceUserAliasJurisdiction, targetJurisdiction]) {
      env.jReplicas.set(jurisdiction.name, {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        rpcs: [jurisdiction.address],
        depositoryAddress: jurisdiction.depositoryAddress,
        entityProviderAddress: jurisdiction.entityProviderAddress,
        blockTimeMs: jurisdiction.blockTimeMs,
        defaultDisputeDelayBlocks: 5,
      } as any);
    }
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const sourceHubState = makeState(sourceHub, addr('ae'), sourceHubJurisdiction, sourceUser);
    const sourceUserState = makeState(sourceUser, addr('af'), sourceUserAliasJurisdiction, sourceHub);
    const targetHubState = makeState(targetHub, addr('b0'), targetJurisdiction, targetUser);
    const targetUserState = makeState(targetUser, addr('b1'), targetJurisdiction, targetHub);
    addReplica(env, sourceHubState, addr('ae'));
    addReplica(env, sourceUserState, addr('af'));
    addReplica(env, targetHubState, addr('b0'));
    addReplica(env, targetUserState, addr('b1'));
    const staleIntent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-prepared-routehash-immutable',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(sourceUserAliasJurisdiction), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 2, amount: 1_000n },
      target: { jurisdiction: jref(targetJurisdiction), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'intent',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    });

    const preparedResult = await applyEntityTx(env, sourceHubState, {
      type: 'prepareCrossJurisdictionSwap',
      data: { route: staleIntent },
    });
      const targetHubOutput = preparedResult.outputs.find(output => output.entityId === targetHub);
      const preparedRoute = (targetHubOutput?.entityTxs?.find(tx => tx.type === 'registerCrossJurisdictionSwap')?.data as any)?.route;
      expect(preparedRoute.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
      expect(preparedRoute.routeHash).toBe(staleIntent.routeHash);
      expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
      const targetPullData = (targetHubOutput?.entityTxs?.find(tx => tx.type === 'pullLock')?.data as any);
      const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
        preparedRoute,
        'target',
        {
          type: 'pull_lock',
          data: {
            pullId: targetPullData.pullId,
            tokenId: targetPullData.tokenId,
            amount: targetPullData.amount,
            revealedUntilTimestamp: targetPullData.revealedUntilTimestamp,
            fullHash: targetPullData.fullHash,
            partialRoot: targetPullData.partialRoot,
            crossJurisdiction: targetPullData.crossJurisdiction,
          },
        },
        targetHub,
        targetUser,
        env.timestamp,
      );
      const sourceCommitRoute = {
        ...preparedRoute,
        status: 'target_locked' as const,
        targetReceipt,
      };

      sourceUserState.crossJurisdictionSwaps?.set(staleIntent.orderId, staleIntent);
      const commitResult = await applyEntityTx(env, sourceUserState, {
        type: 'commitCrossJurisdictionSwap',
        data: { route: sourceCommitRoute, targetReceipt },
      });
    const placeSwapOfferTx = commitResult.outputs
      .flatMap(output => output.entityTxs ?? [])
      .find(tx => tx.type === 'placeSwapOffer') as any;
      expect(placeSwapOfferTx?.data.crossJurisdiction.routeHash).toBe(preparedRoute.routeHash);
      expect(placeSwapOfferTx?.data.crossJurisdiction.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
      expect(placeSwapOfferTx?.data.crossJurisdiction.sourcePull.fullHash).toBe(preparedRoute.sourcePull.fullHash);
      expect(placeSwapOfferTx?.data.crossJurisdiction.targetReceipt).toEqual(targetReceipt);

      const clearingHubState = preparedResult.newState;
      const clearingRoute = {
        ...sourceCommitRoute,
        status: 'clear_requested' as const,
      fillSeq: 1,
      cumulativeFillRatio: 65_535,
      claimedRatio: 65_535,
      filledSourceAmount: BigInt(preparedRoute.source.amount),
      filledTargetAmount: BigInt(preparedRoute.target.amount),
      sourceClaimed: BigInt(preparedRoute.source.amount),
      targetClaimed: BigInt(preparedRoute.target.amount),
      clearingPolicy: 'cancel_and_clear' as const,
    };
    clearingHubState.crossJurisdictionSwaps?.set(clearingRoute.orderId, clearingRoute);
    const sourceAccount = clearingHubState.accounts.get(sourceUser)!;
    sourceAccount.pulls = new Map([[clearingRoute.sourcePull.pullId, {
      pullId: clearingRoute.sourcePull.pullId,
      tokenId: clearingRoute.sourcePull.tokenId,
      amount: clearingRoute.sourcePull.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: clearingRoute.sourcePull.revealedUntilTimestamp,
      fullHash: clearingRoute.sourcePull.fullHash,
      partialRoot: clearingRoute.sourcePull.partialRoot,
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);

    const clearResult = await applyEntityTx(env, clearingHubState, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: clearingRoute.orderId, cancelRemainder: true },
    });
    const resolveTx = clearResult.mempoolOps?.find(op => op.tx.type === 'pull_resolve')?.tx as any;
    expect(resolveTx?.data.pullId).toBe(clearingRoute.sourcePull.pullId);
    expect(() => verifyHashLadderBinary({
      fullHash: clearingRoute.sourcePull.fullHash,
      partialRoot: clearingRoute.sourcePull.partialRoot,
    }, resolveTx.data.binary)).not.toThrow();
  });

  test('cross-j clear request can advance directly to source claimed after committed pull resolve', () => {
    expect(isCrossJurisdictionRouteTransitionAllowed('clear_requested', 'source_claimed')).toBe(true);
    expect(isCrossJurisdictionRouteTransitionAllowed('clear_requested', 'settled')).toBe(false);
  });

  test('source hub committed pull resolve relays hash-ladder binary to target user', () => {
    const env = createEmptyEnv('cross-source-hub-relay');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a1');
    const sourceHub = entity('a2');
    const targetHub = entity('a3');
    const targetUser = entity('a4');
    const sourceHubState = makeState(sourceHub, addr('a5'), eth, sourceUser);
    const targetUserSigner = addr('a6');
    addReplica(env, makeState(targetUser, targetUserSigner, base, targetHub), targetUserSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-hub-relay',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-source-hub-relay-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const filledRoute = {
      ...route,
      status: 'clear_requested' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0,
      filledSourceAmount: (BigInt(route.source.amount) * 0x8000n) / 65_535n,
      filledTargetAmount: (BigInt(route.target.amount) * 0x8000n) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    sourceHubState.crossJurisdictionSwaps?.set(filledRoute.orderId, filledRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-source-hub-relay-seed', filledRoute);
    const binary = buildCrossJurisdictionPullReveal(filledRoute, 0x8000, privateSeed).binary;
    const outputs: any[] = [];

    const handled = applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, {
      type: 'pull_resolve',
      data: {
        pullId: filledRoute.sourcePull!.pullId,
        binary,
      },
    }, outputs);

    expect(handled).toBe(true);
    expect(sourceHubState.crossJurisdictionSwaps?.get(filledRoute.orderId)?.status).toBe('source_claimed');
    expect(outputs.some(output =>
      output.entityId === targetUser &&
      output.entityTxs?.some((tx: any) =>
        tx.type === 'resolvePull' &&
        tx.data.counterpartyEntityId === targetHub &&
        tx.data.pullId === filledRoute.targetPull!.pullId &&
        tx.data.binary === binary,
      ),
    )).toBe(true);
    const targetOutput = outputs.find(output => output.entityId === targetUser);
    expect(targetOutput?.entityTxs?.map((tx: any) => tx.type)).toEqual(['resolvePull', 'cancelPull']);
    expect((targetOutput?.entityTxs?.[1] as any)?.data.pullId).toBe(filledRoute.targetPull!.pullId);
  });

  test('committed pull resolve rejects stale cross-j claim ratios', () => {
    const env = createEmptyEnv('cross-source-stale-claim');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a7');
    const sourceHub = entity('a8');
    const targetHub = entity('a9');
    const targetUser = entity('b0');
    const sourceHubState = makeState(sourceHub, addr('b1'), eth, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-stale-claim',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-source-stale-claim-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const filledRoute = {
      ...route,
      status: 'clear_requested' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0x8000,
      filledSourceAmount: (BigInt(route.source.amount) * 0x8000n) / 65_535n,
      filledTargetAmount: (BigInt(route.target.amount) * 0x8000n) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    sourceHubState.crossJurisdictionSwaps?.set(filledRoute.orderId, filledRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-source-stale-claim-seed', filledRoute);
    const staleBinary = buildCrossJurisdictionPullReveal(filledRoute, 0x4000, privateSeed).binary;

    expect(() => applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, {
      type: 'pull_resolve',
      data: {
        pullId: filledRoute.sourcePull!.pullId,
        binary: staleBinary,
      },
    }, [])).toThrow('CROSS_J_CLAIM_PROGRESS_INVALID');
  });

  test('source user committed pull resolve mirrors source-claimed status locally', () => {
    const env = createEmptyEnv('cross-source-user-mirror');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const sourceUserState = makeState(sourceUser, addr('ae'), eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-user-mirror',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-source-user-mirror-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const filledRoute = {
      ...route,
      status: 'clear_requested' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0,
      filledSourceAmount: (BigInt(route.source.amount) * 0x8000n) / 65_535n,
      filledTargetAmount: (BigInt(route.target.amount) * 0x8000n) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    sourceUserState.crossJurisdictionSwaps?.set(filledRoute.orderId, filledRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-source-user-mirror-seed', filledRoute);
    const binary = buildCrossJurisdictionPullReveal(filledRoute, 0x8000, privateSeed).binary;
    const outputs: any[] = [];

    const handled = applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceUserState, sourceHub, {
      type: 'pull_resolve',
      data: {
        pullId: filledRoute.sourcePull!.pullId,
        binary,
      },
    }, outputs);

    const mirroredRoute = sourceUserState.crossJurisdictionSwaps?.get(filledRoute.orderId);
    expect(handled).toBe(true);
    expect(mirroredRoute?.status).toBe('source_claimed');
    expect(mirroredRoute?.claimedRatio).toBe(0x8000);
    expect(outputs).toHaveLength(0);
  });

  test('source pull resolve backfills fill progress when fill ack mirror is delayed', () => {
    const env = createEmptyEnv('cross-source-delayed-fill-ack');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const sourceUserState = makeState(sourceUser, addr('ae'), eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-delayed-fill-ack',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-source-delayed-fill-ack-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const clearingRoute = {
      ...route,
      status: 'clear_requested' as const,
      fillSeq: 0,
      cumulativeFillRatio: 0,
      claimedRatio: 0,
      clearingPolicy: 'full_fill' as const,
    };
    sourceUserState.crossJurisdictionSwaps?.set(clearingRoute.orderId, clearingRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-source-delayed-fill-ack-seed', clearingRoute);
    const binary = buildCrossJurisdictionPullReveal(clearingRoute, 0x8000, privateSeed).binary;

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceUserState, sourceHub, {
      type: 'pull_resolve',
      data: {
        pullId: clearingRoute.sourcePull!.pullId,
        binary,
      },
    }, [])).toBe(true);

    const updated = sourceUserState.crossJurisdictionSwaps?.get(clearingRoute.orderId);
    expect(updated?.status).toBe('source_claimed');
    expect(updated?.fillSeq).toBe(1);
    expect(updated?.cumulativeFillRatio).toBe(0x8000);
    expect(updated?.claimedRatio).toBe(0x8000);
  });

  test('target pull settle routes canonical book removal even when owner is remote', () => {
    const env = createEmptyEnv('cross-target-remote-book-owner');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const targetUserState = makeState(targetUser, addr('ae'), base, targetHub);
    addReplica(env, makeState(sourceHub, addr('af'), eth, sourceUser), addr('af'));
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-remote-book-owner',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-target-remote-book-owner-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const targetRoute = {
      ...route,
      status: 'source_claimed' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0x8000,
    };
    targetUserState.crossJurisdictionSwaps?.set(targetRoute.orderId, targetRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-target-remote-book-owner-seed', targetRoute);
    const binary = buildCrossJurisdictionPullReveal(targetRoute, 0x8000, privateSeed).binary;
    const outputs: any[] = [];

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, targetUserState, targetHub, {
      type: 'pull_resolve',
      data: {
        pullId: targetRoute.targetPull!.pullId,
        binary,
      },
    }, outputs)).toBe(true);
    expect(targetUserState.crossJurisdictionSwaps?.get(targetRoute.orderId)?.status).toBe('settled');
    expect(outputs.some(output =>
      output.entityId === sourceHub &&
      output.entityTxs?.some(tx =>
        tx.type === 'removeCrossJurisdictionBookOrder' &&
        (tx.data as any).route?.orderId === targetRoute.orderId,
      ),
    )).toBe(true);
  });

  test('target pull settle backfills fill progress when fill ack mirror is delayed', () => {
    const env = createEmptyEnv('cross-target-delayed-fill-ack');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const targetUserState = makeState(targetUser, addr('ae'), base, targetHub);
    addReplica(env, makeState(sourceHub, addr('af'), eth, sourceUser), addr('af'));
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-delayed-fill-ack',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-target-delayed-fill-ack-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const targetRoute = {
      ...route,
      status: 'source_claimed' as const,
      fillSeq: 0,
      cumulativeFillRatio: 0,
      claimedRatio: 0,
    };
    targetUserState.crossJurisdictionSwaps?.set(targetRoute.orderId, targetRoute);
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-target-delayed-fill-ack-seed', targetRoute);
    const binary = buildCrossJurisdictionPullReveal(targetRoute, 0x8000, privateSeed).binary;
    const outputs: any[] = [];

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, targetUserState, targetHub, {
      type: 'pull_resolve',
      data: {
        pullId: targetRoute.targetPull!.pullId,
        binary,
      },
    }, outputs)).toBe(true);

    const updated = targetUserState.crossJurisdictionSwaps?.get(targetRoute.orderId);
    expect(updated?.status).toBe('settled');
    expect(updated?.fillSeq).toBe(1);
    expect(updated?.cumulativeFillRatio).toBe(0x8000);
    expect(updated?.claimedRatio).toBe(0x8000);
  });

  test('cross-j route clones and storage projection keep only public route fields', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(sourceHub, addr('b5'), eth, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-public-route-shape',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-public-route-shape', sourceDisputeDelayMs: 5_000, now: 1_000 });
    state.crossJurisdictionSwaps?.set(route.orderId, {
      ...route,
      __debugOnly: secret('b6'),
    } as any);
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, __debugOnly: secret('b7') } as any,
    });
    account.mempool.push({
      type: 'swap_offer',
      data: {
        offerId: `${route.orderId}-mempool`,
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        minFillRatio: 0,
        crossJurisdiction: { ...route, __debugOnly: secret('b8') } as any,
      },
    });
    account.swapOrderHistory = new Map([[
      route.orderId,
      {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        priceTicks: 900n,
        createdHeight: 0,
        crossJurisdiction: { ...route, __debugOnly: secret('b9') },
        cancelRequested: false,
        lastUpdatedHeight: 0,
        resolves: [],
      } as any,
    ]]);

    const clonedRoute = cloneEntityState(state).crossJurisdictionSwaps?.get(route.orderId) as any;
    const projectedRoute = projectEntityCoreDoc(state).crossJurisdictionSwaps?.get(route.orderId) as any;
    const clonedAccount = cloneEntityState(state).accounts.get(sourceUser)! as any;
    const projectedAccount = projectAccountDoc(account) as any;
    expect('__debugOnly' in cloneCrossJurisdictionRoute({ ...route, __debugOnly: secret('ba') } as any)).toBe(false);
    expect(clonedRoute.__debugOnly).toBeUndefined();
    expect(projectedRoute.__debugOnly).toBeUndefined();
    expect(clonedRoute.source).toEqual(route.source);
    expect(clonedRoute.target).toEqual(route.target);
    expect(projectedRoute.source).toEqual(route.source);
    expect(projectedRoute.target).toEqual(route.target);
    expect(clonedAccount.swapOffers.get(route.orderId).crossJurisdiction.__debugOnly).toBeUndefined();
    expect(clonedAccount.mempool[0].data.crossJurisdiction.__debugOnly).toBeUndefined();
    expect(clonedAccount.swapOrderHistory.get(route.orderId).crossJurisdiction.__debugOnly).toBeUndefined();
    expect(projectedAccount.swapOffers.get(route.orderId).crossJurisdiction.__debugOnly).toBeUndefined();
    expect(projectedAccount.mempool[0].data.crossJurisdiction.__debugOnly).toBeUndefined();
    expect(projectedAccount.swapOrderHistory.get(route.orderId).crossJurisdiction.__debugOnly).toBeUndefined();
  });

  test('placeSwapOffer emits only public cross-j route into account tx', async () => {
    const env = createEmptyEnv('cross-place-offer-public-route');
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c1');
    const sourceHub = entity('c2');
    const targetHub = entity('c3');
    const targetUser = entity('c4');
    const sourceHubState = makeState(sourceHub, addr('c5'), eth, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-public-account-tx',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      }, { runtimeSeed: 'cross-public-account-tx', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'resting' as const,
    };

    const result = await applyEntityTx(env, sourceHubState, {
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: sourceUser,
        offerId: route.orderId,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        crossJurisdiction: route,
      },
    });

    const accountTx = result.mempoolOps?.[0]?.tx as any;
    expect(accountTx?.type).toBe('swap_offer');
    expect(accountTx.data.crossJurisdiction).toEqual(route);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)).toEqual(route);
  });

    test('swap_offer created event carries only public cross-j route', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('d1');
    const sourceHub = entity('d2');
    const targetHub = entity('d3');
    const targetUser = entity('d4');
    const account = makeAccount(sourceHub, sourceUser);
      const preparedRoute = buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-public-created-event',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000_000_000_000_000_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 1_000_000_000_000_000_000n },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      }, { runtimeSeed: 'cross-public-created-event', sourceDisputeDelayMs: 5_000, now: 1_000 });
      const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
        preparedRoute,
        'target',
        {
          type: 'pull_lock',
          data: {
            pullId: preparedRoute.targetPull!.pullId,
            tokenId: preparedRoute.targetPull!.tokenId,
            amount: preparedRoute.targetPull!.signedAmount,
            revealedUntilTimestamp: preparedRoute.targetPull!.revealedUntilTimestamp,
            fullHash: preparedRoute.targetPull!.fullHash,
            partialRoot: preparedRoute.targetPull!.partialRoot,
            crossJurisdiction: buildCrossJurisdictionPullBinding(preparedRoute, 'target'),
          },
        },
        targetHub,
        targetUser,
        1_000,
      );
      const route = {
        ...preparedRoute,
        status: 'resting' as const,
        targetReceipt,
      };
    account.pulls ??= new Map();
    account.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
        createdHeight: 1,
        createdTimestamp: 1_000,
      });
    const result = await processAccountTx(account, {
      type: 'swap_offer',
      data: {
        offerId: route.orderId,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        crossJurisdiction: route,
      },
    }, account.leftEntity === sourceUser, 1_000, 1);

    expect(result.success).toBe(true);
      expect(result.swapOfferCreated?.crossJurisdiction).toEqual(route);
      expect(account.swapOffers.get(route.orderId)?.crossJurisdiction).toEqual(route);
    });

    test('account layer rejects source pull reveal before target receipt and clear', async () => {
      const eth = makeJurisdiction('Ethereum', 1, '11', '12');
      const base = makeJurisdiction('Base', 8453, '21', '22');
      const sourceUser = entity('e1');
      const sourceHub = entity('e2');
      const targetHub = entity('e3');
      const targetUser = entity('e4');
      const account = makeAccount(sourceHub, sourceUser);
      const route = {
        ...buildPreparedCrossJurisdictionRoute({
          orderId: 'cross-early-source-reveal',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000_000_000_000_000_000n },
          target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 1_000_000_000_000_000_000n },
          status: 'resting',
          createdAt: 1_000,
          updatedAt: 1_000,
          expiresAt: 61_000,
        }, { runtimeSeed: 'cross-early-source-reveal', sourceDisputeDelayMs: 5_000, now: 1_000 }),
        status: 'resting' as const,
      };
      account.pulls ??= new Map();
      account.pulls.set(route.sourcePull!.pullId, {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
        createdHeight: 1,
        createdTimestamp: 1_000,
      });
      account.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        makerIsLeft: account.leftEntity === sourceUser,
        createdHeight: 1,
        crossJurisdiction: route,
      });
      const before = account.deltas.get(route.source.tokenId)!.offdelta;
      const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-early-source-reveal', route);
      const binary = buildCrossJurisdictionPullReveal(route, 65_535, privateSeed).binary;
      const result = await processAccountTx(account, {
        type: 'pull_resolve',
        data: { pullId: route.sourcePull!.pullId, binary },
      }, route.sourcePull!.signedAmount > 0n, 2_000, 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('CROSS_J_SOURCE_PULL_RESOLVE_TARGET_RECEIPT_MISSING');
      expect(account.deltas.get(route.source.tokenId)!.offdelta).toBe(before);
    });

    test('canonical route hash binds cross-j economic terms and terminal states reject overwrite', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const signer = addr('65');
    const baseRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-hash-test',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 100n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 90n },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const { routeHash: _routeHash, ...baseRouteWithoutHash } = baseRoute;
    const changedTerms = withCanonicalCrossJurisdictionRouteHash({
      ...baseRouteWithoutHash,
      target: { ...baseRoute.target, amount: 91n },
    });
    expect(changedTerms.routeHash).not.toBe(baseRoute.routeHash);

    const existingState = makeState(targetUser, signer, base, targetHub);
    existingState.crossJurisdictionSwaps?.set(baseRoute.orderId, { ...baseRoute, status: 'settled' });
    const env = createEmptyEnv('cross-terminal-overwrite');
    env.timestamp = 10_000;
    installJurisdictions(env, eth, base);
    const result = await applyEntityTx(env, existingState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...baseRoute, status: 'target_prepared' } },
    } as any);

    expect(result.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.status).toBe('settled');
    expect(result.newState.messages.some(message => message.includes('terminal state settled'))).toBe(true);
  });

  test('cross-j register enforces participant and explicit lifecycle transitions', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('71');
    const sourceHub = entity('72');
    const targetHub = entity('73');
    const targetUser = entity('74');
    const signer = addr('75');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-register-fsm',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 100n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 90n },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });

    const targetState = makeState(targetUser, signer, base, targetHub);
    targetState.crossJurisdictionSwaps?.set(route.orderId, route);
    const transitionEnv = createEmptyEnv('cross-register-fsm');
    installJurisdictions(transitionEnv, eth, base);
    const invalidTransition = await applyEntityTx(transitionEnv, targetState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...route, status: 'settled' } },
    } as any);
    expect(invalidTransition.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(invalidTransition.newState.messages.some(message => message.includes('invalid transition resting->settled'))).toBe(true);

    const outsiderState = makeState(entity('76'), signer, base, targetHub);
    const outsiderEnv = createEmptyEnv('cross-register-outsider');
    installJurisdictions(outsiderEnv, eth, base);
    const nonParticipant = await applyEntityTx(outsiderEnv, outsiderState, {
      type: 'registerCrossJurisdictionSwap',
      data: { route: { ...route, status: 'target_prepared' } },
    } as any);
    expect(nonParticipant.newState.crossJurisdictionSwaps?.has(route.orderId)).toBe(false);
    expect(nonParticipant.newState.messages.some(message => message.includes('non-participant entity'))).toBe(true);
  });

  test('route hash ignores mutable clearing policy but still binds economic terms', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('66');
    const sourceHub = entity('67');
    const targetHub = entity('68');
    const targetUser = entity('69');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-clearing-policy-mutable',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 100n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 90n },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });

    const clearingRoute = {
      ...route,
      status: 'clearing' as const,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    expect(withCanonicalCrossJurisdictionRouteHash(clearingRoute).routeHash).toBe(route.routeHash);

    const changedTerms = { ...route, target: { ...route.target, amount: 91n } };
    expect(() => withCanonicalCrossJurisdictionRouteHash(changedTerms)).toThrow(/CROSS_J_ROUTE_HASH_MISMATCH/);
  });

  test('partial cross-j fill ack is delayed-clearing and keeps order/pulls open', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('71');
    const sourceHub = entity('72');
    const targetHub = entity('73');
    const targetUser = entity('74');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-partial-delayed',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-partial-delayed-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: 1,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: 1_000,
    }]]);

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        executionSourceAmount: 500n,
        executionTargetAmount: 450n,
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/base:1',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(true);
    expect(account.pulls?.has(route.sourcePull!.pullId)).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.fillSeq).toBe(1);
    expect(updatedRoute?.filledSourceAmount).toBe(500n);
    expect(account.mempool.some(tx => tx.type === 'pull_resolve')).toBe(false);
  });

  test('cross-j fill ack records source-savings price improvement without changing hashledger ratio', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('79');
    const sourceHub = entity('7a');
    const targetHub = entity('7b');
    const targetUser = entity('7c');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-savings',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-source-savings-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionSourceAmount: 475n,
        executionTargetAmount: 450n,
        priceImprovementMode: 'source_savings',
        priceImprovementAmount: 25n,
        priceImprovementTokenId: 1,
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/base:1',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.filledSourceAmount).toBe(500n);
    expect(updatedRoute?.priceImprovementSourceAmount).toBe(25n);
    const history = account.swapOrderHistory?.get(route.orderId);
    expect(history?.resolves.at(-1)?.executionGiveAmount).toBe(475n);
    expect(history?.resolves.at(-1)?.executionWantAmount).toBe(450n);
  });

  test('cross-j terminal fill ack copies final resolve into closed-order history', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7d');
    const sourceHub = entity('7e');
    const targetHub = entity('7f');
    const targetUser = entity('80');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-terminal-history',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-terminal-history-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 1_000n,
        incrementalTargetAmount: 900n,
        cumulativeSourceAmount: 1_000n,
        cumulativeTargetAmount: 900n,
        cumulativeFillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        executionSourceAmount: 950n,
        executionTargetAmount: 900n,
        priceImprovementMode: 'source_savings',
        priceImprovementAmount: 50n,
        priceImprovementTokenId: 1,
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/base:1',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(false);
    const closed = account.swapClosedOrders?.get(route.orderId);
    expect(closed?.resolves).toHaveLength(1);
    expect(closed?.resolves[0]?.fillRatio).toBe(65_535);
    expect(closed?.resolves[0]?.executionGiveAmount).toBe(950n);
    expect(closed?.resolves[0]?.executionWantAmount).toBe(900n);
  });

  test('committed cross-j fill ack fails closed when source route mirror is missing', () => {
    const env = createEmptyEnv('cross-fill-ack-missing-route');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceHub = entity('7a');
    const sourceUser = entity('79');
    const state = makeState(sourceHub, addr('7a'), eth, sourceUser);
    state.crossJurisdictionSwaps = new Map();
    const outputs: EntityInput[] = [];
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: 'missing-source-route',
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionSourceAmount: 500n,
        executionTargetAmount: 450n,
        priceImprovementMode: 'none',
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/base:1',
      },
    };

    expect(() => applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      state,
      sourceUser,
      ackTx,
      outputs,
    )).toThrow('CROSS_J_FILL_ACK_ROUTE_MISSING');
    expect(outputs).toHaveLength(0);
  });

  test('cross-j partial fill uses exact ratio amounts instead of uint16-rounded economics', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7d');
    const sourceHub = entity('7e');
    const targetHub = entity('7f');
    const targetUser = entity('80');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-exact-quarter',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 40_000_000_000_000_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 100_000_000_000_000_000_000n,
      },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-exact-quarter-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: 40_000_000_000_000_000n,
      wantTokenId: 1,
      wantAmount: 100_000_000_000_000_000_000n,
      priceTicks: 2_500n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 10_000_000_000_000_000n,
        incrementalTargetAmount: 25_000_000_000_000_000_000n,
        cumulativeSourceAmount: 10_000_000_000_000_000n,
        cumulativeTargetAmount: 25_000_000_000_000_000_000n,
        cumulativeFillRatio: 16_384,
        fillNumerator: 1n,
        fillDenominator: 4n,
        executionSourceAmount: 10_000_000_000_000_000n,
        executionTargetAmount: 25_000_000_000_000_000_000n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:2/base:1',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.cumulativeFillRatio).toBe(16_384);
    expect(updatedRoute?.fillNumerator).toBe(1n);
    expect(updatedRoute?.fillDenominator).toBe(4n);
    expect(updatedRoute?.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(updatedRoute?.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
  });

  test('cross-j fill closes sub-lot remainder instead of leaving a zombie order', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const lot = SWAP_LOT_SCALE;
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-sub-lot-dust',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 2n * lot,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 2n * lot,
      },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-sub-lot-dust-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      priceTicks: 10_000n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const cumulative = lot + 1n;
    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulative,
        incrementalTargetAmount: cumulative,
        cumulativeSourceAmount: cumulative,
        cumulativeTargetAmount: cumulative,
        cumulativeFillRatio: 32_768,
        fillNumerator: cumulative,
        fillDenominator: 2n * lot,
        executionSourceAmount: cumulative,
        executionTargetAmount: cumulative,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:2/base:1',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(false);
    const closed = account.swapClosedOrders?.get(route.orderId);
    expect(closed).toBeDefined();
    expect(closed?.resolves.at(-1)?.cancelRemainder).toBe(true);
    expect(closed?.resolves.at(-1)?.fillNumerator).toBe(cumulative);
    expect(closed?.resolves.at(-1)?.fillDenominator).toBe(2n * lot);
  });

  test('cross-j source-savings fill ack uses target progress, not improved source spend', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const sourceTotal = 78n * 10n ** 18n;
    const executionSource = 75n * 10n ** 18n;
    const targetTotal = 3n * 10n ** 16n;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-savings-full-buy',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      source: { jurisdiction: jref(tron), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: sourceTotal },
      target: { jurisdiction: jref(eth), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: targetTotal },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-source-savings-full-buy-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const offer = {
      offerId: route.orderId,
      accountId: 'source-account',
      makerIsLeft: false,
      fromEntity: sourceHub,
      toEntity: sourceUser,
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: sourceTotal,
      quantizedGive: sourceTotal,
      wantTokenId: 2,
      wantAmount: targetTotal,
      quantizedWant: targetTotal,
      minFillRatio: 0,
      timeInForce: 0 as const,
      priceTicks: 26_000_000n,
      crossJurisdiction: { ...route, status: 'resting' as const },
    };
    const meta = buildCrossJurisdictionMarketOffer(offer, targetHub);
    expect(meta).not.toBeNull();
    const ack = buildCrossJurisdictionFillAck(
      'source-account',
      route.orderId,
      `source-account:${route.orderId}`,
      meta!,
      {
        filledLots: Number(targetTotal / SWAP_LOT_SCALE),
        weightedCost: (executionSource * ORDERBOOK_PRICE_SCALE) / SWAP_LOT_SCALE,
      },
    );

    expect(ack).not.toBeNull();
    expect(ack?.instruction.fillRatio).toBe(65_535);
    expect(ack?.instruction.sourceAmount).toBe(sourceTotal);
    expect(ack?.instruction.targetAmount).toBe(targetTotal);
    expect(ack?.instruction.executionSourceAmount).toBe(executionSource);
    expect(ack?.instruction.executionTargetAmount).toBe(targetTotal);
    expect(ack?.instruction.priceImprovementMode).toBe('source_savings');
    expect(ack?.instruction.priceImprovementAmount).toBe(sourceTotal - executionSource);
    expect(ack?.tx.data.cancelRemainder).toBe(true);
  });

  test('cross-j fill ack accepts floor-scaled source progress for target-derived exact ratio', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const sourceUser = entity('85');
    const sourceHub = entity('86');
    const targetHub = entity('87');
    const targetUser = entity('88');
    const account = makeAccount(sourceHub, sourceUser);
    const sourceTotal = 120_000_000_000_000_000_000n;
    const targetTotal = 120_024_000_000n;
    const fillNumerator = 240_001_921n;
    const fillDenominator = targetTotal;
    const cumulativeSource = (sourceTotal * fillNumerator) / fillDenominator;
    const cumulativeTarget = fillNumerator;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-floor-scaled-source-progress',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      source: { jurisdiction: jref(tron), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 2, amount: sourceTotal },
      target: { jurisdiction: jref(eth), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: targetTotal },
      priceImprovementMode: 'source_savings',
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-floor-scaled-source-progress-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      priceTicks: 1_000n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulativeSource,
        incrementalTargetAmount: cumulativeTarget,
        cumulativeSourceAmount: cumulativeSource,
        cumulativeTargetAmount: cumulativeTarget,
        cumulativeFillRatio: Number((65_535n * fillNumerator) / fillDenominator),
        fillNumerator,
        fillDenominator,
        executionSourceAmount: cumulativeSource,
        executionTargetAmount: cumulativeTarget,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/tron:2',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.filledSourceAmount).toBe(cumulativeSource);
    expect(updatedRoute?.filledTargetAmount).toBe(cumulativeTarget);
    expect(updatedRoute?.fillNumerator).toBe(fillNumerator);
    expect(updatedRoute?.fillDenominator).toBe(fillDenominator);
  });

  test('cross-j terminal cancel ack syncs source pull binding before pull resolve proposal', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const sourceUser = entity('8a');
    const sourceHub = entity('8b');
    const targetHub = entity('8c');
    const targetUser = entity('8d');
    const account = makeAccount(sourceHub, sourceUser);
    const sourceTotal = 78n * 10n ** 18n;
    const targetTotal = 3n * 10n ** 16n;
    const fillRatio = 63_015;
    const cumulativeSource = (sourceTotal * BigInt(fillRatio)) / 65_535n;
    const cumulativeTarget = (targetTotal * BigInt(fillRatio)) / 65_535n;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-terminal-cancel-binding',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      source: { jurisdiction: jref(tron), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: sourceTotal },
      target: { jurisdiction: jref(eth), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: targetTotal },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-terminal-cancel-binding-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: sourceTotal,
      wantTokenId: 2,
      wantAmount: targetTotal,
      priceTicks: 2_600n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    account.pulls = new Map([[
      route.sourcePull!.pullId,
      {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding({ ...route, status: 'resting' }, 'source'),
        createdHeight: 0,
        createdTimestamp: 1_000,
      },
    ]]);

    const result = await processAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulativeSource,
        incrementalTargetAmount: cumulativeTarget,
        cumulativeSourceAmount: cumulativeSource,
        cumulativeTargetAmount: cumulativeTarget,
        cumulativeFillRatio: fillRatio,
        executionSourceAmount: cumulativeSource,
        executionTargetAmount: cumulativeTarget,
        cancelRemainder: true,
        pairId: 'cross:tron:1/ethereum:2',
      },
    }, account.leftEntity === sourceHub, 2_000, 1);

    expect(result.success).toBe(true);
    expect(account.swapOffers.has(route.orderId)).toBe(false);
    expect(account.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.status).toBe('clear_requested');
    expect(account.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.clearingPolicy).toBe('cancel_and_clear');
  });

  test('payer can cancel expired pull and releases only remaining hold', async () => {
    const payer = entity('75');
    const beneficiary = entity('76');
    const account = makeAccount(beneficiary, payer);
    const delta = account.deltas.get(1)!;
    const beneficiaryIsLeft = account.leftEntity === beneficiary;
    const payerIsLeft = !beneficiaryIsLeft;
    const pullId = secret('77');
    const amount = 1_000n;
    if (payerIsLeft) delta.leftHold = 750n;
    else delta.rightHold = 750n;
    account.pulls = new Map([[pullId, {
      pullId,
      tokenId: 1,
      amount: beneficiaryIsLeft ? amount : -amount,
      claimedRatio: 16_384,
      claimedAmount: 250n,
      revealedUntilTimestamp: 10_000,
      fullHash: secret('78'),
      partialRoot: secret('79'),
      createdHeight: 1,
      createdTimestamp: 1_000,
    }]]);

    const early = await processAccountTx(account, {
      type: 'pull_cancel',
      data: { pullId, reason: 'expired' },
    }, payerIsLeft, 9_999, 2);
    expect(early.success).toBe(false);
    expect(account.pulls.has(pullId)).toBe(true);

    const expired = await processAccountTx(account, {
      type: 'pull_cancel',
      data: { pullId, reason: 'expired' },
    }, payerIsLeft, 10_000, 3);
    expect(expired.success).toBe(true);
    expect(account.pulls.has(pullId)).toBe(false);
    expect(payerIsLeft ? delta.leftHold : delta.rightHold).toBe(0n);
  });

  test('clear request reveals one source pull binary and can cancel remainder', async () => {
    const env = createEmptyEnv('cross-clear-delayed-seed');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const sourceHubSigner = addr('85');
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-clear-delayed',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    const sourcePullAbsAmount = route.sourcePull!.signedAmount >= 0n
      ? route.sourcePull!.signedAmount
      : -route.sourcePull!.signedAmount;
    const sourcePullPayerIsLeft = route.sourcePull!.signedAmount < 0n;
    const sourceDelta = account.deltas.get(route.sourcePull!.tokenId) ?? createDefaultDelta(route.sourcePull!.tokenId);
    account.deltas.set(route.sourcePull!.tokenId, sourceDelta);
    if (sourcePullPayerIsLeft) sourceDelta.leftHold = sourcePullAbsAmount;
    else sourceDelta.rightHold = sourcePullAbsAmount;
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: 1,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['pull_resolve', 'pull_cancel']);
    expect(result.mempoolOps?.[0]?.accountId).toBe(sourceUser);
    expect((result.mempoolOps?.[0]?.tx as any).data.binary).toMatch(/^0x/);
    expect((result.mempoolOps?.[1]?.tx as any).data.reason).toBe('cross_j_source_remainder_release');
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');

    const accountAfterClear = result.newState.accounts.get(sourceUser)!;
    const bySourceHub = sourceHub.toLowerCase() < sourceUser.toLowerCase();
    const resolveResult = await processAccountTx(accountAfterClear, result.mempoolOps![0]!.tx, bySourceHub, env.timestamp, 1);
    expect(resolveResult.success, resolveResult.error).toBe(true);
    const cancelResult = await processAccountTx(accountAfterClear, result.mempoolOps![1]!.tx, bySourceHub, env.timestamp, 2);
    expect(cancelResult.success, cancelResult.error).toBe(true);
    expect(accountAfterClear.pulls?.has(route.sourcePull!.pullId)).toBe(false);
    const releasedDelta = accountAfterClear.deltas.get(route.sourcePull!.tokenId)!;
    expect(sourcePullPayerIsLeft ? releasedDelta.leftHold : releasedDelta.rightHold).toBe(0n);
  });

  test('direct cancelPull cannot release a committed cross-j partial fill', async () => {
    const env = createEmptyEnv('cross-direct-cancel-blocked');
    env.timestamp = 90_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6e');
    const sourceHub = entity('6f');
    const targetHub = entity('70');
    const targetUser = entity('71');
    const state = makeState(sourceHub, addr('72'), eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-direct-cancel-blocked',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-direct-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = await applyEntityTx(env, state, {
      type: 'cancelPull',
      data: {
        counterpartyEntityId: sourceUser,
        pullId: route.sourcePull!.pullId,
        description: 'malicious direct release',
      },
    });

    expect(result.mempoolOps ?? []).toHaveLength(0);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('partially_filled');
    expect(result.newState.messages.some(message => message.includes('must clear through requestCrossJurisdictionClear'))).toBe(true);
  });

  test('account-layer pull_cancel cannot release a committed cross-j partial fill', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('72');
    const sourceHub = entity('73');
    const targetHub = entity('74');
    const targetUser = entity('75');
    const account = makeAccount(sourceHub, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-account-cancel-blocked',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-account-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: route,
    });
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: 1_000,
    }]]);

    const payerIsLeft = !(route.sourcePull!.signedAmount > 0n);
    const result = await handlePullCancel(account, {
      type: 'pull_cancel',
      data: { pullId: route.sourcePull!.pullId, reason: 'expired' },
    }, payerIsLeft, route.sourcePull!.revealedUntilTimestamp);

    expect(result.success).toBe(false);
    expect(result.error).toContain('must clear through requestCrossJurisdictionClear');
    expect(account.pulls?.has(route.sourcePull!.pullId)).toBe(true);
  });

  test('pull_cancel reports already-closed pull status explicitly', async () => {
    const account = makeAccount(entity('76'), entity('77'));
    const result = await handlePullCancel(account, {
      type: 'pull_cancel',
      data: { pullId: 'missing-pull-id', reason: 'expired' },
    }, true, 1_000);

    expect(result.success).toBe(true);
    expect(result.pullCancelled).toEqual({ pullId: 'missing-pull-id', status: 'already-closed' });
  });

  test('target pull resolve verifies relay binary and enters clearing before account commit', async () => {
    const env = createEmptyEnv('cross-target-resolve-guard');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6a');
    const sourceHub = entity('6b');
    const targetHub = entity('6c');
    const targetUser = entity('6d');
    const targetState = makeState(targetUser, addr('6e'), base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-resolve-guard',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
      }, { runtimeSeed: 'cross-target-resolve-guard-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
      targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const targetAccount = targetState.accounts.get(targetHub);
      expect(targetAccount, 'target account fixture must exist').toBeTruthy();
      const targetDelta = targetAccount!.deltas.get(route.targetPull!.tokenId) ?? createDefaultDelta(route.targetPull!.tokenId);
      targetAccount!.deltas.set(route.targetPull!.tokenId, targetDelta);
      const targetAbsAmount = route.targetPull!.signedAmount >= 0n
        ? route.targetPull!.signedAmount
        : -route.targetPull!.signedAmount;
      if (route.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
      else targetDelta.leftHold = targetAbsAmount;
      targetAccount!.pulls = new Map([[route.targetPull!.pullId, {
        pullId: route.targetPull!.pullId,
        tokenId: route.targetPull!.tokenId,
        amount: route.targetPull!.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
        fullHash: route.targetPull!.fullHash,
        partialRoot: route.targetPull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding({ ...route, status: 'target_locked' }, 'target'),
        createdHeight: 1,
        createdTimestamp: env.timestamp,
      }]]);
      const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-target-resolve-guard-seed', route);
      const binary = buildCrossJurisdictionPullReveal(route, 0x4567, privateSeed).binary;

    const blocked = await applyEntityTx(env, targetState, {
      type: 'resolvePull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        binary: partialBinary(0x4567),
      },
    });
    expect(blocked.mempoolOps ?? []).toHaveLength(0);
    expect(blocked.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');

    const result = await applyEntityTx(env, targetState, {
      type: 'resolvePull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        binary,
      },
      });
      expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['pull_resolve']);
      expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
      const syncedAccount = result.newState.accounts.get(targetHub);
      const syncedBinding = syncedAccount?.pulls?.get(route.targetPull!.pullId)?.crossJurisdiction;
      expect(syncedBinding?.status).toBe('clearing');
      expect(syncedBinding?.cumulativeFillRatio).toBe(0x4567);
      const accountResult = await processAccountTx(
        syncedAccount!,
        result.mempoolOps![0]!.tx,
        targetUser.toLowerCase() < targetHub.toLowerCase(),
        env.timestamp,
        1,
      );
      expect(accountResult.success).toBe(true);
    });

  test('clear request closes live cross-j offer before revealing pull', async () => {
    const env = createEmptyEnv('cross-clear-closes-offer-first');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('86');
    const sourceHub = entity('87');
    const targetHub = entity('88');
    const targetUser = entity('89');
    const state = makeState(sourceHub, addr('8a'), eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-clear-offer-first',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-clear-offer-first', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 500n,
      wantTokenId: 1,
      wantAmount: 450n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: 1,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.mempoolOps?.[0]?.tx as any).data.cancelRemainder).toBe(true);
    expect(result.mempoolOps?.some(op => op.tx.type === 'pull_resolve')).toBe(false);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
  });

  test('cross-j cancel requests do not emit plain swap_resolve', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('91');
    const sourceHub = entity('92');
    const targetHub = entity('93');
    const targetUser = entity('94');
    const state = makeState(sourceHub, addr('91'), eth, sourceUser);
    state.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: sourceHub,
        name: 'source hub',
        spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
    } as any;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-cancel-no-swap-resolve',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-cancel-no-swap-resolve', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const result = processOrderbookCancels(state, [{ accountId: sourceUser, offerId: route.orderId }]);
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]?.tx.type).toBe('cross_swap_fill_ack');
    expect(result.mempoolOps.some(op => op.tx.type === 'swap_resolve')).toBe(false);
  });

  test('cross-j cancel fails closed when orderbook extension is missing', async () => {
    const env = createEmptyEnv('cross-cancel-no-orderbook-ext');
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceHub = entity('9b');
    const targetHub = entity('9c');
    const targetUser = entity('9d');
    const seed = 'cross-cancel-no-orderbook-ext seed alpha beta gamma';
    const signer = registerTestSigner(env, seed, '1');
    const sourceUser = generateLazyEntityId([signer], 1n).toLowerCase();
    const state = makeState(sourceUser, signer, eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-cancel-no-orderbook-ext',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-cancel-no-orderbook-ext', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const account = state.accounts.get(sourceHub)!;
    account.currentFrame.prevFrameHash = 'genesis';
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    addReplica(env, state, signer);
    const replica = env.eReplicas.get(`${state.entityId}:${signer}`)!;

    await expect(applyEntityInput(env, replica, {
      entityId: sourceUser,
      signerId: signer,
      entityTxs: [{
        type: 'proposeCancelSwap',
        data: { counterpartyEntityId: sourceHub, offerId: route.orderId },
      }],
    })).rejects.toThrow('CROSS_J_ORDERBOOK_EXT_REQUIRED');
    expect(account.mempool.some(tx => tx.type === 'swap_resolve')).toBe(false);
  });

  test('fill notice validates target-side economics before mutating route', async () => {
    const env = createEmptyEnv('cross-fill-notice-invalid-target');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('95');
    const sourceHub = entity('96');
    const targetHub = entity('97');
    const targetUser = entity('98');
    const state = makeState(sourceHub, addr('92'), eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-fill-invalid-target',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-fill-invalid-target', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const route = { ...prepared, status: 'resting' as const };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    await expect(applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 451n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 451n,
        cumulativeFillRatio: 32_768,
        pairId: route.venueId || '',
      },
    })).rejects.toThrow(/CROSS_J_FILL_NOTICE_INVALID/);
  });

  test('valid fill notice only queues account ack and does not mutate canonical route before commit', async () => {
    const env = createEmptyEnv('cross-fill-notice-delayed-commit');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a1');
    const sourceHub = entity('a2');
    const targetHub = entity('a3');
    const targetUser = entity('a4');
    const state = makeState(sourceHub, addr('a2'), eth, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-fill-delayed-commit',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      }, { runtimeSeed: 'cross-fill-delayed-commit', sourceDisputeDelayMs: 5_000, now: env.timestamp }),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = await applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        pairId: route.venueId || '',
      },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    const canonical = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(canonical?.status).toBe('resting');
    expect(canonical?.fillSeq).toBeUndefined();
    expect(canonical?.cumulativeFillRatio).toBeUndefined();
  });

  test('duplicate fill notice is idempotent but same-seq divergent notice fails fast', async () => {
    const env = createEmptyEnv('cross-fill-notice-idempotent');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c1');
    const sourceHub = entity('c2');
    const targetHub = entity('c3');
    const targetUser = entity('c4');
    const state = makeState(sourceHub, addr('c2'), eth, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-fill-notice-idempotent',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      }, { runtimeSeed: 'cross-fill-notice-idempotent', sourceDisputeDelayMs: 5_000, now: env.timestamp }),
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const duplicate = await applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        previousFillSeq: 0,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        pairId: route.venueId || '',
      },
    });

    expect(duplicate.mempoolOps ?? []).toHaveLength(0);
    expect(duplicate.newState.crossJurisdictionSwaps?.get(route.orderId)?.fillSeq).toBe(1);

    await expect(applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        previousFillSeq: 0,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 451n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 451n,
        cumulativeFillRatio: 32_768,
        pairId: route.venueId || '',
      },
    })).rejects.toThrow(/CROSS_J_FILL_NOTICE_STALE_CONFLICT/);

    await expect(applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        routeHash: route.routeHash,
        previousFillSeq: 0,
        fillSeq: 2,
        incrementalSourceAmount: 250n,
        incrementalTargetAmount: 225n,
        cumulativeSourceAmount: 750n,
        cumulativeTargetAmount: 675n,
        cumulativeFillRatio: 49_152,
        pairId: route.venueId || '',
      },
    })).rejects.toThrow(/CROSS_J_FILL_NOTICE_PREV_SEQ_MISMATCH/);
  });

  test('fill notice is rejected on book owner when source hub owns the account ack', async () => {
    const env = createEmptyEnv('cross-fill-notice-book-owner-reject');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(targetHub, addr('b3'), base, targetUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-fill-book-owner-reject',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      }, { runtimeSeed: 'cross-fill-book-owner-reject', sourceDisputeDelayMs: 5_000, now: env.timestamp }),
      bookOwnerEntityId: targetHub,
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    await expect(applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 500n,
        incrementalTargetAmount: 450n,
        cumulativeSourceAmount: 500n,
        cumulativeTargetAmount: 450n,
        cumulativeFillRatio: 32_768,
        pairId: route.venueId || '',
      },
    })).rejects.toThrow('CROSS_J_FILL_NOTICE_SOURCE_HUB_REQUIRED');
  });

  test('committed fill notice frame removes terminal source offer on the remote owner account', async () => {
    const seed = 'cross-fill-notice-owner-roundtrip seed alpha beta';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    env.activeJurisdiction = eth.name;
    const sourceUserSigner = registerTestSigner(env, seed, '1');
    const sourceHubSigner = registerTestSigner(env, seed, '2');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = `0x${'3'.padStart(64, '0')}`;
    const targetUser = `0x${'4'.padStart(64, '0')}`;
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    sourceUserState.prevFrameHash = 'genesis';
    sourceHubState.prevFrameHash = 'genesis';
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-fill-notice-owner-roundtrip',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.timestamp });

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        priceTicks: 900n,
        timeInForce: 0,
        minFillRatio: 0,
        makerIsLeft: account.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
    const hubReplica = env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const hubResult = await applyEntityInput(env, hubReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [{
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 1_000n,
          incrementalTargetAmount: 900n,
          cumulativeSourceAmount: 1_000n,
          cumulativeTargetAmount: 900n,
          cumulativeFillRatio: 65_535,
          pairId: route.venueId || '',
        },
      }],
    });
    env.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, hubResult.workingReplica);
    const accountInputOutput = hubResult.outputs.find(output =>
      output.entityId === sourceUser &&
      output.entityTxs?.some(tx => tx.type === 'accountInput'),
    );
    expect(accountInputOutput?.entityTxs?.[0]?.type).toBe('accountInput');
    expect((accountInputOutput?.entityTxs?.[0]?.data as any)?.toEntityId).toBe(sourceUser);

    const userReplica = env.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!;
    const userResult = await applyEntityInput(env, userReplica, {
      entityId: sourceUser,
      signerId: sourceUserSigner,
      entityTxs: accountInputOutput!.entityTxs!,
    });

    const sourceAccount = userResult.workingReplica.state.accounts.get(sourceHub)!;
    expect(sourceAccount.currentHeight).toBe(1);
    expect(sourceAccount.swapOffers.has(route.orderId)).toBe(false);
    expect(userResult.outputs.some(output =>
      output.entityId === sourceHub &&
      output.entityTxs?.some(tx => tx.type === 'accountInput'),
    )).toBe(true);
  });

  test('committed partial fill notice frame updates source route without clearing offer', async () => {
    const seed = 'cross-fill-notice-owner-partial seed alpha beta';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    env.activeJurisdiction = eth.name;
    const sourceUserSigner = registerTestSigner(env, seed, '1');
    const sourceHubSigner = registerTestSigner(env, seed, '2');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = `0x${'3'.padStart(64, '0')}`;
    const targetUser = `0x${'4'.padStart(64, '0')}`;
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    sourceUserState.prevFrameHash = 'genesis';
    sourceHubState.prevFrameHash = 'genesis';
    const sourceTotal = 40_000_000_000_000_000n;
    const targetTotal = 100_000_000_000_000_000_000n;
    const fillSource = 10_000_000_000_000_000n;
    const fillTarget = 25_000_000_000_000_000_000n;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-fill-notice-owner-partial',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: sourceTotal },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: targetTotal },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.timestamp });

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: sourceTotal,
        wantTokenId: 1,
        wantAmount: targetTotal,
        priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
        timeInForce: 0,
        minFillRatio: 0,
        makerIsLeft: account.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
    const hubReplica = env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const hubResult = await applyEntityInput(env, hubReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [{
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: fillSource,
          incrementalTargetAmount: fillTarget,
          cumulativeSourceAmount: fillSource,
          cumulativeTargetAmount: fillTarget,
          cumulativeFillRatio: 16_384,
          fillNumerator: 1n,
          fillDenominator: 4n,
          pairId: route.venueId || '',
        },
      }],
    });
    const accountInputOutput = hubResult.outputs.find(output =>
      output.entityId === sourceUser &&
      output.entityTxs?.some(tx => tx.type === 'accountInput'),
    );
    expect(accountInputOutput?.entityTxs?.[0]?.type).toBe('accountInput');

    const userReplica = env.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!;
    const userResult = await applyEntityInput(env, userReplica, {
      entityId: sourceUser,
      signerId: sourceUserSigner,
      entityTxs: accountInputOutput!.entityTxs!,
    });

    const sourceAccount = userResult.workingReplica.state.accounts.get(sourceHub)!;
    expect(sourceAccount.swapOffers.has(route.orderId)).toBe(true);
    expect(sourceAccount.swapOffers.get(route.orderId)?.crossJurisdiction?.status).toBe('partially_filled');
    const updatedRoute = userResult.workingReplica.state.crossJurisdictionSwaps?.get(route.orderId);
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.filledSourceAmount).toBe(fillSource);
    expect(updatedRoute?.filledTargetAmount).toBe(fillTarget);
    expect(updatedRoute?.fillNumerator).toBe(1n);
    expect(updatedRoute?.fillDenominator).toBe(4n);
  });

  test('cross-j orderbook sweep closes expired unfilled route instead of being a no-op', async () => {
    const env = createEmptyEnv('cross-sweep-expired');
    env.timestamp = 100_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(sourceHub, addr('b2'), eth, sourceUser);
    state.timestamp = env.timestamp;
    addReplica(env, makeState(targetUser, addr('b5'), base, targetHub), addr('b5'));
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-sweep-expired',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 70_000,
      }, { runtimeSeed: 'cross-sweep-expired', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: 1,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: 1_000,
    }]]);

    const result = await applyEntityTx(env, state, {
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason: 'test-expired' },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack', 'pull_cancel']);
    expect(result.outputs.some(output =>
      output.entityId === targetUser &&
      output.entityTxs?.some(tx => tx.type === 'cancelPull'),
    )).toBe(true);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('expired');
  });

  test('cross-j orderbook sweep drives filled expired route into clear instead of terminal failed lock', async () => {
    const env = createEmptyEnv('cross-sweep-filled-expired-clear');
    env.timestamp = 100_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c1');
    const sourceHub = entity('c2');
    const targetHub = entity('c3');
    const targetUser = entity('c4');
    const state = makeState(sourceHub, addr('c2'), eth, sourceUser);
    state.timestamp = env.timestamp;
    addReplica(env, makeState(targetUser, addr('c5'), base, targetHub), addr('c5'));
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-sweep-filled-expired',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
        status: 'partially_filled',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 70_000,
      }, { runtimeSeed: 'cross-sweep-filled-expired-clear', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 500n,
      wantTokenId: 1,
      wantAmount: 450n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.pulls = new Map([[route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: 1,
      amount: route.sourcePull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 0,
      createdTimestamp: 1_000,
    }]]);

    const result = await applyEntityTx(env, state, {
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason: 'test-filled-expired' },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    const swept = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(swept?.status).toBe('clear_requested');
    expect(swept?.clearingPolicy).toBe('cancel_and_clear');
    expect(swept?.pendingClearRequestedAt).toBe(env.timestamp);
  });

  test('submitCrossJurisdictionSwap rejects missing target receiving account', async () => {
    const env = createEmptyEnv('cross-submit-missing-target');
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    env.jReplicas.set(eth.name, {
      name: eth.name,
      chainId: eth.chainId,
      rpcs: [eth.address],
      depositoryAddress: eth.depositoryAddress,
      entityProviderAddress: eth.entityProviderAddress,
      blockTimeMs: eth.blockTimeMs,
      defaultDisputeDelayBlocks: 5,
    } as any);
    env.jReplicas.set(base.name, {
      name: base.name,
      chainId: base.chainId,
      rpcs: [base.address],
      depositoryAddress: base.depositoryAddress,
      entityProviderAddress: base.entityProviderAddress,
      blockTimeMs: base.blockTimeMs,
      defaultDisputeDelayBlocks: 5,
    } as any);

    const sourceUser = entity('11');
    const sourceHub = entity('12');
    const targetHub = entity('13');
    const targetUser = entity('14');
    const sourceUserSigner = addr('41');
    const sourceHubSigner = addr('42');
    const targetHubSigner = addr('43');
    const targetUserSigner = addr('44');
    addReplica(env, makeState(sourceUser, sourceUserSigner, eth, sourceHub), sourceUserSigner);
    addReplica(env, makeState(sourceHub, sourceHubSigner, eth, sourceUser), sourceHubSigner);
    addReplica(env, makeState(targetHub, targetHubSigner, base, targetUser), targetHubSigner);
    addReplica(env, makeState(targetUser, targetUserSigner, base), targetUserSigner);

    await expect(submitCrossJurisdictionSwap(env, {
      orderId: 'cross-missing-target',
      sourceUserEntityId: sourceUser,
      sourceHubEntityId: sourceHub,
      targetHubEntityId: targetHub,
      targetUserEntityId: targetUser,
      sourceTokenId: 1,
      sourceAmount: 100n,
      targetTokenId: 1,
      targetAmount: 90n,
      sourceUserSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetUserSignerId: targetUserSigner,
    })).rejects.toThrow(/CROSS_SWAP_TARGET_ACCOUNT_MISSING/);
  });

  test('DisputeStarted relays payment secrets from source to target cross-j lock', async () => {
    const env = createEmptyEnv('cross-dispute-secret');
    env.scenarioMode = true;
    env.timestamp = 20_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('21');
    const hub = entity('22');
    const targetUser = entity('23');
    const targetHub = entity('24');
    const signer = registerTestSigner(env, 'cross-dispute-secret', '1');
    const targetSigner = registerTestSigner(env, 'cross-dispute-secret', '2');
    const state = makeState(user, signer, eth, hub);
    addReplica(env, makeState(targetUser, targetSigner, eth, targetHub), targetSigner);
    const revealedSecret = secret('77');
    const hashlock = hashHtlcSecret(revealedSecret);
    const targetLockId = secret('78');
    state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 100n,
      outboundEntity: hub,
      outboundLockId: secret('79'),
      crossJurisdictionRelay: {
        routeId: 'relay-dispute',
        fillRatio: 65_535,
        sourceAmount: 100n,
        targetAmount: 90n,
        targetEntityId: targetUser,
        targetCounterpartyEntityId: targetHub,
        targetLockId,
      },
      createdTimestamp: state.timestamp,
    });

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const paymentArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [revealedSecret], pulls: [] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[paymentArgs]]);
    const proofbodyHash = buildAccountProofBody(state.accounts.get(hub)!).proofBodyHash;
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: hub,
        counterentity: user,
        nonce: '1',
        proofbodyHash,
        starterInitialArguments,
        starterIncrementedArguments: '0x',
        disputeTimeout: 100,
        onChainNonce: 1,
      },
    };
    const signed = signJEventObservation(env, user, signer, {
      blockNumber: 2,
      blockHash: secret('7b'),
      transactionHash: secret('7c'),
      events: [disputeStartedEvent],
    });
    const result = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: disputeStartedEvent,
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('7b'),
        transactionHash: secret('7c'),
        ...signed,
      },
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('resolveHtlcLock');
    const data = result.outputs?.[0]?.entityTxs?.[0]?.data as any;
    expect(data.counterpartyEntityId).toBe(targetHub);
    expect(data.lockId).toBe(targetLockId);
    expect(data.secret).toBe(revealedSecret);
  });

  test('DisputeStarted with cross-pull args queues target sibling salvage', async () => {
    const env = createEmptyEnv('cross-dispute-salvage');
    env.scenarioMode = true;
    env.timestamp = 30_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('31');
    const sourceHub = entity('32');
    const targetHub = entity('33');
    const targetUser = entity('34');
    const signer = registerTestSigner(env, 'cross-dispute-salvage', '1');
    const targetSigner = registerTestSigner(env, 'cross-dispute-salvage', '2');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    addReplica(env, makeState(targetUser, targetSigner, base, targetHub), targetSigner);
    const oldSettledRoute = buildPreparedCrossJurisdictionRoute({
      orderId: 'old-cross-pull-dispute',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'settled' as const,
      createdAt: env.timestamp - 1_000,
      updatedAt: env.timestamp - 1_000,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp - 1_000 });
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-pull-dispute',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(oldSettledRoute.orderId, oldSettledRoute);
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    const proofbodyHash = buildAccountProofBody(state.accounts.get(sourceHub)!).proofBodyHash;
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        nonce: '1',
        proofbodyHash,
        starterInitialArguments,
        starterIncrementedArguments: '0x',
        disputeTimeout: 100,
        onChainNonce: 1,
      },
    };
    const signed = signJEventObservation(env, sourceUser, signer, {
      blockNumber: 2,
      blockHash: secret('8b'),
      transactionHash: secret('8c'),
      events: [disputeStartedEvent],
    });
    const result = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: disputeStartedEvent,
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('8b'),
        transactionHash: secret('8c'),
        ...signed,
      },
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('crossJurisdictionSalvage');
    const data = result.outputs?.[0]?.entityTxs?.[0]?.data as any;
    expect(data.routeId).toBe(route.orderId);
    expect(data.binary).toBe(binary);
    expect(data.fillRatio).toBe(0x1234);
  });

  test('DisputeFinalized sidecar args queue target sibling salvage', async () => {
    const env = createEmptyEnv('cross-dispute-finalized-salvage');
    env.scenarioMode = true;
    env.timestamp = 31_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('35');
    const sourceHub = entity('36');
    const targetHub = entity('37');
    const targetUser = entity('38');
    const signer = registerTestSigner(env, 'cross-dispute-finalized-salvage', '1');
    const targetSigner = registerTestSigner(env, 'cross-dispute-finalized-salvage', '2');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    addReplica(env, makeState(targetUser, targetSigner, base, targetHub), targetSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-pull-finalize',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x2345,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const leftArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    const finalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: secret('9a'),
        finalProofbodyHash: secret('9b'),
      },
    };
    const disputeFinalizationEvidence = [{
      sender: sourceHub,
      counterentity: sourceUser,
      initialNonce: '1',
      initialProofbodyHash: secret('9a'),
      finalProofbodyHash: secret('9b'),
      leftArguments,
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    }];
    const signed = signJEventObservation(env, sourceUser, signer, {
      blockNumber: 3,
      blockHash: secret('9c'),
      transactionHash: secret('9d'),
      events: [finalizedEvent],
      disputeFinalizationEvidence,
    });
    const result = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: finalizedEvent,
        observedAt: env.timestamp,
        blockNumber: 3,
        blockHash: secret('9c'),
        transactionHash: secret('9d'),
        disputeFinalizationEvidence,
        ...signed,
      },
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('crossJurisdictionSalvage');
    const data = result.outputs?.[0]?.entityTxs?.[0]?.data as any;
    expect(data.routeId).toBe(route.orderId);
    expect(data.binary).toBe(binary);
    expect(data.fillRatio).toBe(0x2345);
  });

  test('DisputeFinalized sidecar args are rejected unless the signer binds the evidence hash', async () => {
    const env = createEmptyEnv('cross-dispute-finalized-unsigned-sidecar');
    env.scenarioMode = true;
    env.timestamp = 32_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('39');
    const sourceHub = entity('3a');
    const targetHub = entity('3b');
    const targetUser = entity('3c');
    const signer = registerTestSigner(env, 'cross-dispute-finalized-unsigned-sidecar', '1');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-pull-finalize-unsigned-sidecar',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x2222,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const crossPullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const disputeFinalizationEvidence = [{
      sender: sourceHub,
      counterentity: sourceUser,
      initialNonce: '1',
      initialProofbodyHash: secret('aa'),
      finalProofbodyHash: secret('ab'),
      leftArguments: ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[crossPullArgs]]),
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    }];
    const finalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: secret('aa'),
        finalProofbodyHash: secret('ab'),
      },
    };
    const signedWithoutEvidence = signJEventObservation(env, sourceUser, signer, {
      blockNumber: 4,
      blockHash: secret('ac'),
      transactionHash: secret('ad'),
      events: [finalizedEvent],
    });

    await expect(applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: finalizedEvent,
        observedAt: env.timestamp,
        blockNumber: 4,
        blockHash: secret('ac'),
        transactionHash: secret('ad'),
        disputeFinalizationEvidence,
        ...signedWithoutEvidence,
      },
    })).rejects.toThrow('missing dispute finalization evidence hash');
  });

  test('DisputeFinalized sidecar args require validator threshold before salvage', async () => {
    const env = createEmptyEnv('cross-dispute-finalized-sidecar-quorum');
    env.scenarioMode = true;
    env.timestamp = 33_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('3d');
    const sourceHub = entity('3e');
    const targetHub = entity('3f');
    const targetUser = entity('40');
    const signerOne = registerTestSigner(env, 'cross-dispute-finalized-sidecar-quorum', '1');
    const signerTwo = registerTestSigner(env, 'cross-dispute-finalized-sidecar-quorum', '2');
    const state = makeState(sourceUser, signerOne, eth, sourceHub);
    state.config.validators = [signerOne, signerTwo];
    state.config.shares = { [signerOne]: 1n, [signerTwo]: 1n };
    state.config.threshold = 2n;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-pull-finalize-sidecar-quorum',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x3333,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const crossPullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const disputeFinalizationEvidence = [{
      sender: sourceHub,
      counterentity: sourceUser,
      initialNonce: '1',
      initialProofbodyHash: secret('ba'),
      finalProofbodyHash: secret('bb'),
      leftArguments: ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[crossPullArgs]]),
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    }];
    const finalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: secret('ba'),
        finalProofbodyHash: secret('bb'),
      },
    };
    const signedOne = signJEventObservation(env, sourceUser, signerOne, {
      blockNumber: 5,
      blockHash: secret('bc'),
      transactionHash: secret('bd'),
      events: [finalizedEvent],
      disputeFinalizationEvidence,
    });
    const first = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signerOne,
        event: finalizedEvent,
        observedAt: env.timestamp,
        blockNumber: 5,
        blockHash: secret('bc'),
        transactionHash: secret('bd'),
        disputeFinalizationEvidence,
        ...signedOne,
      },
    });
    expect(first.outputs).toEqual([]);

    const signedTwo = signJEventObservation(env, sourceUser, signerTwo, {
      blockNumber: 5,
      blockHash: secret('bc'),
      transactionHash: secret('bd'),
      events: [finalizedEvent],
    });
    const second = await applyEntityTx(env, first.newState, {
      type: 'j_event',
      data: {
        from: signerTwo,
        event: finalizedEvent,
        observedAt: env.timestamp,
        blockNumber: 5,
        blockHash: secret('bc'),
        transactionHash: secret('bd'),
        ...signedTwo,
      },
    });

    expect(second.newState.jBlockChain).toHaveLength(1);
    expect(second.outputs).toEqual([]);
  });

  test('crossJurisdictionSalvage starts target dispute then queues broadcast', async () => {
    const env = createEmptyEnv('cross-salvage-action');
    env.scenarioMode = true;
    env.timestamp = 40_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('41');
    const sourceHub = entity('42');
    const targetHubSigner = registerTestSigner(env, 'cross-salvage-action-target-hub', '1');
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const targetUser = entity('44');
    const signer = addr('71');
    const state = makeState(targetUser, signer, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-salvage-action',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const targetAccount = state.accounts.get(targetHub)!;
    targetAccount.pulls ??= new Map();
    targetAccount.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 1,
      createdTimestamp: env.timestamp,
    });
    targetAccount.proofHeader.nonce = 1;
    setDeltaTransformerAddress(addr('99'));
    const targetProof = buildAccountProofBody(targetAccount);
    storeDisputeArgumentSnapshot(
      targetAccount,
      captureDisputeArgumentSnapshot(targetAccount, targetProof.proofBodyHash, 1, targetProof.proofBodyStruct),
    );
    const targetDisputeHash = createDisputeProofHashWithNonce(
      targetAccount,
      targetProof.proofBodyHash,
      base.depositoryAddress,
      1,
    );
    const [targetDisputeHanko] = await signEntityHashes(env, targetHub, targetHubSigner, [targetDisputeHash]);
    if (!targetDisputeHanko) {
      throw new Error('Failed to sign target dispute proof hanko');
    }
    targetAccount.counterpartyDisputeProofBodyHash = targetProof.proofBodyHash;
    targetAccount.counterpartyDisputeProofHanko = targetDisputeHanko;
    targetAccount.counterpartyDisputeProofNonce = 1;
    targetAccount.counterpartyDisputeHash = targetDisputeHash;
    targetAccount.disputeProofNoncesByHash = { [targetProof.proofBodyHash]: 1 };
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;

    const result = await applyEntityTx(env, state, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 10,
      },
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.entityTxs).toHaveLength(3);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('resolvePull');
    expect(result.outputs?.[0]?.entityTxs?.[1]?.type).toBe('disputeStart');
    expect(result.outputs?.[0]?.entityTxs?.[2]?.type).toBe('j_broadcast');
    expect((result.outputs?.[0]?.entityTxs?.[0]?.data as any).counterpartyEntityId).toBe(targetHub);
    expect((result.outputs?.[0]?.entityTxs?.[0]?.data as any).binary).toBe(binary);
    expect((result.outputs?.[0]?.entityTxs?.[1]?.data as any).counterpartyEntityId).toBe(targetHub);
    const starterInitialArguments = (result.outputs?.[0]?.entityTxs?.[1]?.data as any).starterInitialArguments;
    expect(typeof starterInitialArguments).toBe('string');
    expect(starterInitialArguments).toMatch(/^0x[0-9a-f]+$/i);
    expect(starterInitialArguments.length).toBeGreaterThan(2);

    let chainedState = state;
    for (const entityTx of result.outputs?.[0]?.entityTxs ?? []) {
      const applied = await applyEntityTx(env, chainedState, entityTx);
      chainedState = applied.newState;
      for (const op of applied.mempoolOps ?? []) {
        const account = chainedState.accounts.get(op.accountId);
        expect(account, `mempool op account ${op.accountId.slice(-4)} must exist`).toBeDefined();
        account?.mempool.push(op.tx);
      }
    }
    const draftDisputeStarts = chainedState.jBatchState?.batch.disputeStarts ?? [];
    const sentDisputeStarts = chainedState.jBatchState?.sentBatch?.batch.disputeStarts ?? [];
    expect([...draftDisputeStarts, ...sentDisputeStarts]).toHaveLength(1);
    expect(chainedState.messages.some((message) => message.includes('blocked until evidence is stable'))).toBe(false);
  });

  test('crossJurisdictionSalvage ignores forged target pull binary', async () => {
    const env = createEmptyEnv('cross-salvage-forged-binary');
    env.scenarioMode = true;
    env.timestamp = 41_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('45');
    const sourceHub = entity('46');
    const targetHub = entity('47');
    const targetUser = entity('48');
    const signer = addr('72');
    const state = makeState(targetUser, signer, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-salvage-forged-binary',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const forgedBinary = partialBinary(0x1234);

    const result = await applyEntityTx(env, state, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: forgedBinary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 10,
      },
    });

    expect(result.outputs).toEqual([]);
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
  });

  test('target DisputeStarted without pull args forces source dispute first', async () => {
    const env = createEmptyEnv('cross-target-dispute-forces-source');
    env.scenarioMode = true;
    env.timestamp = 50_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceSigner = addr('81');
    const targetSigner = registerTestSigner(env, 'cross-target-dispute-force-source', '1');
    const sourceState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    const targetState = makeState(targetUser, targetSigner, base, targetHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, targetState, targetSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-dispute-force-source',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route });

    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: targetHub,
        counterentity: targetUser,
        nonce: '1',
        proofbodyHash: secret('9a'),
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
        disputeTimeout: 100,
        onChainNonce: 1,
      },
    };
    const signed = signJEventObservation(env, targetUser, targetSigner, {
      blockNumber: 2,
      blockHash: secret('9b'),
      transactionHash: secret('9c'),
      events: [disputeStartedEvent],
    });
    const result = await applyEntityTx(env, targetState, {
      type: 'j_event',
      data: {
        from: targetSigner,
        event: disputeStartedEvent,
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('9b'),
        transactionHash: secret('9c'),
        ...signed,
      },
    });

    const sourceOutput = result.outputs.find(output => output.entityId === sourceUser);
    expect(sourceOutput?.entityTxs?.map(tx => tx.type)).toEqual(['disputeStart', 'j_broadcast']);
    expect((sourceOutput?.entityTxs?.[0]?.data as any).counterpartyEntityId).toBe(sourceHub);
  });

  test('production cross-j API exposes only hashledger orderbook flow', async () => {
    const runtime = await import('../runtime');
    expect(typeof runtime.submitCrossJurisdictionSwap).toBe('function');
    expect('submitCrossJurisdictionSourceLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionTargetLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionSwapClaims' in runtime).toBe(false);
  });

  test('cross-j same-token market price uses jurisdiction asset orientation', () => {
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-same-token-market',
      makerEntityId: entity('c1'),
      hubEntityId: entity('c2'),
      bookOwnerEntityId: entity('c3'),
      source: {
        jurisdiction: 'stack:z:dep',
        entityId: entity('c1'),
        counterpartyEntityId: entity('c2'),
        tokenId: 1,
        amount: 2_000_000_000_000n,
      },
      target: {
        jurisdiction: 'stack:a:dep',
        entityId: entity('c3'),
        counterpartyEntityId: entity('c4'),
        tokenId: 1,
        amount: 1_000_000_000_000n,
      },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
      priceTicks: 1n,
      }, { runtimeSeed: 'cross-same-token-market', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer({
      offerId: route.orderId,
      accountId: route.source.entityId,
      makerIsLeft: true,
      fromEntity: route.source.entityId,
      toEntity: route.source.counterpartyEntityId,
      giveTokenId: 1,
      giveAmount: route.source.amount,
      wantTokenId: 1,
      wantAmount: route.target.amount,
      priceTicks: 1n,
      timeInForce: 0,
      minFillRatio: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    }, route.bookOwnerEntityId || '');

    expect(market?.pairId).toBe('cross:stack:a:dep:1/stack:z:dep:1');
    expect(market?.side).toBe(0);
    expect(market?.baseAmount).toBe(1_000_000_000_000n);
    expect(market?.quoteAmount).toBe(2_000_000_000_000n);
    expect(market?.priceTicks).toBe(20_000n);
  });

  test('cross-j market keeps USD stables as quote across jurisdictions', () => {
    const sourceHub = entity('stable-source-hub');
    const targetHub = entity('stable-target-hub');

    const sourceStableToTargetEth = deriveCanonicalCrossJurisdictionMarketForLegs('tron', 3, 'testnet', 2);
    expect(sourceStableToTargetEth.sourceIsBase).toBe(false);
    expect(sourceStableToTargetEth.baseKey).toBe('testnet:2');
    expect(sourceStableToTargetEth.quoteKey).toBe('tron:3');
    expect(sourceStableToTargetEth.venueId).toBe('cross:testnet:2/tron:3');
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      'tron',
      3,
      sourceHub,
      'testnet',
      2,
      targetHub,
    )).toBe(targetHub);

    const sourceEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs('testnet', 2, 'tron', 3);
    expect(sourceEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceEthToTargetStable.baseKey).toBe('testnet:2');
    expect(sourceEthToTargetStable.quoteKey).toBe('tron:3');
    expect(sourceEthToTargetStable.venueId).toBe('cross:testnet:2/tron:3');
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      'testnet',
      2,
      targetHub,
      'tron',
      3,
      sourceHub,
    )).toBe(targetHub);

    const sourceTronEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs('tron', 2, 'testnet', 3);
    expect(sourceTronEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceTronEthToTargetStable.baseKey).toBe('tron:2');
    expect(sourceTronEthToTargetStable.quoteKey).toBe('testnet:3');
    expect(sourceTronEthToTargetStable.venueId).toBe('cross:tron:2/testnet:3');
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      'tron',
      2,
      sourceHub,
      'testnet',
      3,
      targetHub,
    )).toBe(targetHub);
  });

  test('cross-j WETH/stable market offer prices in stable quote units', () => {
    const sourceHub = entity('stable-price-source-hub');
    const targetHub = entity('stable-price-target-hub');
    const canonicalMarket = deriveCanonicalCrossJurisdictionMarketForLegs('tron', 2, 'testnet', 3);
    expect(canonicalMarket.sourceIsBase).toBe(true);
    expect(canonicalMarket.baseKey).toBe('tron:2');
    expect(canonicalMarket.quoteKey).toBe('testnet:3');
    expect(canonicalMarket.venueId).toBe('cross:tron:2/testnet:3');
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-tron-weth-testnet-usdt-price',
        makerEntityId: entity('stable-price-maker'),
        hubEntityId: sourceHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: 'tron',
          entityId: entity('stable-price-maker'),
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 1_000_000_000_000_000_000n,
        },
        target: {
          jurisdiction: 'testnet',
          entityId: targetHub,
          counterpartyEntityId: entity('stable-price-taker'),
          tokenId: 3,
          amount: 2_500_000_000_000_000_000_000n,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
        priceTicks: 25_000_000n,
      }, { runtimeSeed: 'cross-tron-weth-testnet-usdt-price', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer({
      offerId: route.orderId,
      accountId: route.source.entityId,
      makerIsLeft: true,
      fromEntity: route.source.entityId,
      toEntity: route.source.counterpartyEntityId,
      giveTokenId: 2,
      giveAmount: route.source.amount,
      wantTokenId: 3,
      wantAmount: route.target.amount,
      priceTicks: 25_000_000n,
      timeInForce: 0,
      minFillRatio: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    }, targetHub);

    expect(market?.pairId).toBe('cross:tron:2/testnet:3');
    expect(market?.side).toBe(1);
    expect(market?.baseAmount).toBe(route.source.amount);
    expect(market?.quoteAmount).toBe(route.target.amount);
    expect(market?.priceTicks).toBe(25_000_000n);
  });

  test('cross-j stable/WETH market offer keeps stable quote units when source is stable', () => {
    const sourceHub = entity('stable-source-quote-hub');
    const targetHub = entity('stable-target-base-hub');
    const canonicalMarket = deriveCanonicalCrossJurisdictionMarketForLegs('tron', 3, 'testnet', 2);
    expect(canonicalMarket.sourceIsBase).toBe(false);
    expect(canonicalMarket.baseKey).toBe('testnet:2');
    expect(canonicalMarket.quoteKey).toBe('tron:3');
    expect(canonicalMarket.venueId).toBe('cross:testnet:2/tron:3');
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-tron-usdt-testnet-weth-price',
        makerEntityId: entity('stable-source-quote-maker'),
        hubEntityId: sourceHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: 'tron',
          entityId: entity('stable-source-quote-maker'),
          counterpartyEntityId: sourceHub,
          tokenId: 3,
          amount: 2_500_000_000_000_000_000_000n,
        },
        target: {
          jurisdiction: 'testnet',
          entityId: targetHub,
          counterpartyEntityId: entity('stable-target-base-taker'),
          tokenId: 2,
          amount: 1_000_000_000_000_000_000n,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
        priceTicks: 25_000_000n,
      }, { runtimeSeed: 'cross-tron-usdt-testnet-weth-price', sourceDisputeDelayMs: 5_000, now: 1_000 }),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer({
      offerId: route.orderId,
      accountId: route.source.entityId,
      makerIsLeft: true,
      fromEntity: route.source.entityId,
      toEntity: route.source.counterpartyEntityId,
      giveTokenId: 3,
      giveAmount: route.source.amount,
      wantTokenId: 2,
      wantAmount: route.target.amount,
      priceTicks: 25_000_000n,
      timeInForce: 0,
      minFillRatio: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    }, targetHub);

    expect(market?.pairId).toBe('cross:testnet:2/tron:3');
    expect(market?.side).toBe(0);
    expect(market?.baseAmount).toBe(route.target.amount);
    expect(market?.quoteAmount).toBe(route.source.amount);
    expect(market?.priceTicks).toBe(25_000_000n);
  });

  test('jurisdiction token catalog keeps Tron-only tokens off Testnet defaults', () => {
    expect(getTokenIdsForJurisdiction('Testnet')).toEqual([1, 2, 3]);
    expect(getTokenIdsForJurisdiction({ name: 'Testnet', chainId: 31338 })).toEqual([1, 2, 3]);
    expect(getTokenIdsForJurisdiction({ name: '', chainId: 31338 })).toEqual([1, 2, 3, 4, 5]);
    expect(getTokenIdsForJurisdiction({ name: 'Tron', chainId: 31338 })).toEqual([1, 2, 3, 4, 5]);
  });

  test('Tron-only tokens use USD stables as quote-side reference assets', () => {
    expect(getSwapPairOrientation(4, 1)).toEqual({ baseTokenId: 4, quoteTokenId: 1, pairId: '1/4' });
    expect(getSwapPairPolicyByBaseQuote(4, 1).mmMidPriceTicks).toBe(1_200n);
    expect(getSwapPairOrientation(5, 3)).toEqual({ baseTokenId: 5, quoteTokenId: 3, pairId: '3/5' });
    expect(getSwapPairPolicyByBaseQuote(5, 3).mmMidPriceTicks).toBe(200n);
  });

  test('swap trading pairs are normalized from the entity jurisdiction token catalog', () => {
    const testnetState = makeState(entity('same-token-catalog-testnet'), addr('12'), makeJurisdiction('Testnet', 31337, '11', '12'));
    normalizeEntitySwapTradingPairs(testnetState);
    expect(testnetState.swapTradingPairs?.map((pair) => `${pair.baseTokenId}/${pair.quoteTokenId}`)).toEqual([
      '2/1',
      '1/3',
      '2/3',
    ]);

    const tronState = makeState(entity('same-token-catalog-tron'), addr('13'), makeJurisdiction('Tron', 31338, '13', '14'));
    normalizeEntitySwapTradingPairs(tronState);
    const tronPairs = tronState.swapTradingPairs?.map((pair) => `${pair.baseTokenId}/${pair.quoteTokenId}`) ?? [];
    expect(tronPairs).toContain('4/1');
    expect(tronPairs).toContain('4/3');
    expect(tronPairs).toContain('5/1');
    expect(tronPairs).toContain('5/3');
  });

  test('cross-j rejects same-jurisdiction same-token route before orderbook admission', () => {
    expect(() => buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-same-chain-same-token-invalid',
      makerEntityId: entity('d1'),
      hubEntityId: entity('d2'),
      source: {
        jurisdiction: 'stack:testnet:dep',
        entityId: entity('d1'),
        counterpartyEntityId: entity('d2'),
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'stack:testnet:dep',
        entityId: entity('d3'),
        counterpartyEntityId: entity('d4'),
        tokenId: 1,
        amount: 1_000n,
      },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, {
      runtimeSeed: 'cross-same-chain-same-token-invalid',
      sourceDisputeDelayMs: 5_000,
      now: 1_000,
    })).toThrow(/CROSS_J_SAME_JURISDICTION_TOKEN_INVALID/);
  });
});
