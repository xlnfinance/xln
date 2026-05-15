import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyEntityTx } from '../entity-tx/apply';
import {
  createEmptyEnv,
  submitCrossJurisdictionSwap,
} from '../runtime';
import { hashHtlcSecret } from '../htlc-utils';
import type { AccountMachine, ConsensusConfig, EntityReplica, EntityState, Env, JurisdictionConfig } from '../types';
import { createDefaultDelta } from '../validation-utils';
import {
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  buildPreparedCrossJurisdictionRoute,
} from '../cross-jurisdiction';

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
    expect(result.route.source.jurisdiction).toBe('Ethereum');
    expect(result.route.target.jurisdiction).toBe('Base');
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
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    expect(preparedRoute.sourcePull.partialRoot).toBe(preparedRoute.targetPull.partialRoot);
    expect(preparedRoute.hashLadderPrivateSeed).toBeUndefined();
    expect(preparedRoute.targetPull.revealedUntilTimestamp - preparedRoute.sourcePull.revealedUntilTimestamp)
      .toBeGreaterThanOrEqual(5_000 + CROSS_J_TARGET_REVEAL_SAFETY_MS);
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
    const signer = addr('51');
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
    const result = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: {
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
        },
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('7b'),
        transactionHash: secret('7c'),
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
    const signer = addr('61');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-pull-dispute',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: eth.name,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: base.name,
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
    const result = await applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signer,
        event: {
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
        },
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('8b'),
        transactionHash: secret('8c'),
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
        jurisdiction: eth.name,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: base.name,
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
    const targetSigner = addr('82');
    const sourceState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    const targetState = makeState(targetUser, targetSigner, base, targetHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, targetState, targetSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-dispute-force-source',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: eth.name,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: base.name,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 90n,
      },
      status: 'resting' as const,
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route, hashLadderPrivateSeed: undefined });

    const result = await applyEntityTx(env, targetState, {
      type: 'j_event',
      data: {
        from: targetSigner,
        event: {
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
        },
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('9b'),
        transactionHash: secret('9c'),
      },
    });

    const sourceOutput = result.outputs.find(output => output.entityId === sourceUser);
    expect(sourceOutput?.entityTxs?.map(tx => tx.type)).toEqual(['disputeStart', 'j_broadcast']);
    expect((sourceOutput?.entityTxs?.[0]?.data as any).counterpartyEntityId).toBe(sourceHub);
  });
});
