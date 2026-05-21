import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyEntityTx } from '../entity-tx/apply';
import { processAccountTx } from '../account-tx/apply';
import { processOrderbookCancels } from '../entity-tx/handlers/account';
import { applyEntityInput } from '../entity-consensus';
import {
  createEmptyEnv,
  submitCrossJurisdictionSwap,
} from '../runtime';
import { hashHtlcSecret } from '../htlc-utils';
import { getJurisdictionStackId } from '../jurisdiction-runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import type { AccountMachine, ConsensusConfig, EntityReplica, EntityState, Env, JurisdictionConfig, JurisdictionEvent } from '../types';
import { createDefaultDelta } from '../validation-utils';
import { cloneEntityState } from '../state-helpers';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity-tx/handlers/account-cross-j-followups';
import {
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  deriveCrossJurisdictionRouteHash,
  isCrossJurisdictionRouteTransitionAllowed,
  withCanonicalCrossJurisdictionRouteHash,
  cloneCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import { verifyHashLadderBinary } from '../hashladder';
import {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from '../j-event-observation';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const secret = (byte: string): string => `0x${byte.repeat(32)}`;
const partialBinary = (ratio: number): string =>
  `0x${ratio.toString(16).padStart(4, '0')}${[secret('a1'), secret('a2'), secret('a3'), secret('a4')].map(node => node.slice(2)).join('')}`;

const makeJurisdiction = (name: string, chainId: number, depByte: string, epByte: string): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  blockTimeMs: 1_000,
  depositoryAddress: addr(depByte),
  entityProviderAddress: addr(epByte),
});

const registerTestSigner = (env: Env, seed: string, slot = '1'): string => {
  env.runtimeSeed = seed;
  const signerId = deriveSignerAddressSync(seed, slot);
  registerSignerKey(signerId, deriveSignerKeySync(seed, slot));
  return signerId;
};

const signJEventObservation = (
  env: Env,
  entityId: string,
  signerId: string,
  input: {
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    events: JurisdictionEvent[];
  },
): { eventsHash: string; signature: string } => {
  const eventsHash = canonicalJurisdictionEventsHash(input.events);
  const signature = signAccountFrame(
    env,
    signerId,
    buildJEventObservationDigest({
      entityId,
      signerId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      transactionHash: input.transactionHash,
      eventsHash,
    }),
  );
  return { eventsHash, signature };
};

const jref = (jurisdiction: JurisdictionConfig): string => getJurisdictionStackId(jurisdiction);

const makeConfig = (signerId: string, jurisdiction: JurisdictionConfig): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

const makeAccount = (selfId: string, counterpartyId: string): AccountMachine => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = 10n ** 30n;
  delta.rightCreditLimit = 10n ** 30n;
  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      stateHash: '',
      deltas: [],
      byLeft: true,
    },
    deltas: new Map([[1, delta]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
  };
};

const makeState = (
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
  counterpartyId?: string,
): EntityState => ({
  entityId,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeConfig(signerId, jurisdiction),
  reserves: new Map(),
  accounts: counterpartyId ? new Map([[counterpartyId, makeAccount(entityId, counterpartyId)]]) : new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'aa'.repeat(32)}`,
  entityEncPrivKey: `0x${'bb'.repeat(32)}`,
  profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  crossJurisdictionSwaps: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const addReplica = (env: Env, state: EntityState, signerId: string, isProposer = true): void => {
  env.eReplicas.set(`${state.entityId}:${signerId}`, {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer,
  } as EntityReplica);
};

const installJurisdictions = (env: Env, ...jurisdictions: JurisdictionConfig[]): void => {
  for (const jurisdiction of jurisdictions) {
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
};

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
    expect(prepared.outputs).toHaveLength(3);
    const targetHubOutput = prepared.outputs.find(output => output.entityId === targetHub);
    const targetUserOutput = prepared.outputs.find(output => output.entityId === targetUser);
    const sourceUserOutput = prepared.outputs.find(output => output.entityId === sourceUser);
    expect(targetHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap', 'pullLock']);
    expect(targetUserOutput?.entityTxs?.[0]?.type).toBe('registerCrossJurisdictionSwap');
    expect(sourceUserOutput?.entityTxs?.[0]?.type).toBe('commitCrossJurisdictionSwap');
    const preparedRoute = (sourceUserOutput?.entityTxs?.[0]?.data as any).route;
    expect(preparedRoute.routeHash).toBe(result.route.routeHash);
    expect(deriveCrossJurisdictionRouteHash(preparedRoute)).toBe(preparedRoute.routeHash);
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    expect(preparedRoute.sourcePull.partialRoot).toBe(preparedRoute.targetPull.partialRoot);
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
    const preparedRoute = (preparedResult.outputs.find(output => output.entityId === sourceUser)?.entityTxs?.[0]?.data as any)?.route;
    expect(preparedRoute.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(preparedRoute.routeHash).toBe(staleIntent.routeHash);
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);

    sourceUserState.crossJurisdictionSwaps?.set(staleIntent.orderId, staleIntent);
    const commitResult = await applyEntityTx(env, sourceUserState, {
      type: 'commitCrossJurisdictionSwap',
      data: { route: preparedRoute },
    });
    const placeSwapOfferTx = commitResult.outputs
      .flatMap(output => output.entityTxs ?? [])
      .find(tx => tx.type === 'placeSwapOffer') as any;
    expect(placeSwapOfferTx?.data.crossJurisdiction.routeHash).toBe(preparedRoute.routeHash);
    expect(placeSwapOfferTx?.data.crossJurisdiction.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(placeSwapOfferTx?.data.crossJurisdiction.sourcePull.fullHash).toBe(preparedRoute.sourcePull.fullHash);

    const clearingHubState = preparedResult.newState;
    const clearingRoute = {
      ...preparedRoute,
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
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-public-created-event',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000_000_000_000_000_000n },
        target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 1_000_000_000_000_000_000n },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      }, { runtimeSeed: 'cross-public-created-event', sourceDisputeDelayMs: 5_000, now: 1_000 }),
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
    const env = createEmptyEnv('cross-clear-request');
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
    }, { runtimeSeed: 'cross-clear-delayed-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
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

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['pull_resolve']);
    expect(result.mempoolOps?.[0]?.accountId).toBe(sourceUser);
    expect((result.mempoolOps?.[0]?.tx as any).data.binary).toMatch(/^0x/);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
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
    env.runtimeSeed = seed;
    const signer = deriveSignerAddressSync(seed, '1');
    registerSignerKey(signer, deriveSignerKeySync(seed, '1'));
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

    const result = await applyEntityTx(env, state, {
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
    });

    expect(result.mempoolOps ?? []).toHaveLength(0);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.fillSeq).toBeUndefined();
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
    const state = makeState(user, signer, eth, hub);
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
    const initialArguments = abiCoder.encode(['bytes[]'], [[paymentArgs]]);
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: hub,
        counterentity: user,
        nonce: '1',
        proofbodyHash: secret('7a'),
        initialArguments,
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
    const state = makeState(sourceUser, signer, eth, sourceHub);
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
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const binary = partialBinary(0x1234);
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const initialArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        nonce: '1',
        proofbodyHash: secret('8a'),
        initialArguments,
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

  test('crossJurisdictionSalvage starts target dispute then queues broadcast', async () => {
    const env = createEmptyEnv('cross-salvage-action');
    env.scenarioMode = true;
    env.timestamp = 40_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('41');
    const sourceHub = entity('42');
    const targetHub = entity('43');
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
    const binary = partialBinary(0x1234);

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
    expect((result.outputs?.[0]?.entityTxs?.[1]?.data as any).initialArguments).toBeUndefined();
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
        initialArguments: '0x',
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
});
