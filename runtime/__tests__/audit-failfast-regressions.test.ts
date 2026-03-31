import { describe, expect, test } from 'bun:test';

import { proposeAccountFrame } from '../account-consensus';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { handleHtlcLock } from '../account-tx/handlers/htlc-lock';
import { handleRequestCollateral } from '../account-tx/handlers/request-collateral';
import { handleSwapOffer } from '../account-tx/handlers/swap-offer';
import { LIMITS } from '../constants';
import { initCrontab } from '../entity-crontab';
import { generateLazyEntityId } from '../entity-factory';
import { applyEntityInput } from '../entity-consensus';
import { handleJAbortSentBatch } from '../entity-tx/handlers/j-abort-sent-batch';
import { handleJRebroadcast } from '../entity-tx/handlers/j-rebroadcast';
import { handleJEvent } from '../entity-tx/j-events';
import { createEmptyBatch } from '../j-batch';
import { process, createEmptyEnv } from '../runtime';
import { safeStringify } from '../serialization-utils';
import type { AccountMachine, AccountTx, ConsensusConfig, EntityInput, EntityReplica, EntityState } from '../types';

const makeSingleSignerConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: ['1'],
  shares: { '1': 1n },
});

const makeSingleSignerConfigFor = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
});

const hex20 = (byte: string): string => `0x${byte.repeat(byte.length === 2 ? 20 : 40)}`;

const makeProposalAccount = (
  mempool: AccountTx[],
  leftEntity: string,
  rightEntity: string,
): AccountMachine => {
  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [...mempool],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [],
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  } as AccountMachine;
};

const attachSigningReplica = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
): void => {
  env.eReplicas.set(
    `${entityId}:${signerId}`,
    {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state: {
        entityId,
        config: makeSingleSignerConfigFor(signerId),
      },
    } as unknown as EntityReplica,
  );
};

const registerLazySigner = (
  seed: string,
  signerSlot: string,
): { signerId: string; entityId: string } => {
  const signerId = deriveSignerAddressSync(seed, signerSlot);
  const privateKey = deriveSignerKeySync(seed, signerSlot);
  registerSignerKey(signerId, privateKey);
  registerSignerKey(signerId.slice(-4).toLowerCase(), privateKey);
  return {
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
  };
};

const makeReplicaMissingPrevFrameHash = (): EntityReplica => ({
  entityId: `0x${'11'.repeat(32)}`,
  signerId: '1',
  mempool: [],
  isProposer: true,
  state: {
    entityId: `0x${'11'.repeat(32)}`,
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: makeSingleSignerConfig(),
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: `0x${'33'.repeat(32)}`,
    entityEncPrivKey: `0x${'44'.repeat(32)}`,
    profile: {
      name: 'Audit Entity',
      isHub: false,
      avatar: '',
      bio: '',
      website: '',
    },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
    crontabState: initCrontab(),
  },
});

const makeEntityState = (entityId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'55'.repeat(32)}`,
  entityEncPrivKey: `0x${'66'.repeat(32)}`,
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

describe('audit fail-fast regressions', () => {
  test('process requeues oversized runtime input instead of silently dropping it', async () => {
    const env = createEmptyEnv('audit-regression-seed');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const inputs = Array.from({ length: 10001 }, (_, i) => ({
      entityId: `0x${i.toString(16).padStart(64, '0')}`,
      entityTxs: [],
    }));

    await expect(process(env, inputs)).rejects.toThrow('Too many entity inputs');
    expect(env.height).toBe(0);
    expect(env.runtimeMempool?.entityInputs.length).toBe(10001);
  });

  test('safeStringify throws instead of hashing a placeholder string', () => {
    expect(() => safeStringify({ bad: new Date(Number.NaN) })).toThrow('SAFE_STRINGIFY_FAILED');
  });

  test('j_abort_sent_batch does not requeue dispute finalize after on-chain finalize already cleared activeDispute', async () => {
    const entityId = `0x${'aa'.repeat(32)}`;
    const counterpartyId = `0x${'bb'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    delete account.activeDispute;
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 3,
              finalNonce: 3,
              initialProofbodyHash: `0x${'11'.repeat(32)}`,
              finalProofbody: {
                offdeltas: [],
                tokenIds: [],
                transformers: [],
              },
              finalArguments: '0x',
              initialArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              disputeUntilBlock: 123,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 1,
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: { reason: 'submit_failed:E5()', requeueToCurrent: true },
      },
      createEmptyEnv('abort-stale-finalize'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(result.newState.jBatchState?.status).toBe('empty');
  });

  test('j_abort_sent_batch never resurrects dispute finalize into current batch', async () => {
    const entityId = `0x${'cc'.repeat(32)}`;
    const counterpartyId = `0x${'dd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'44'.repeat(32)}`,
      initialNonce: 5,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 5,
              finalNonce: 5,
              initialProofbodyHash: `0x${'44'.repeat(32)}`,
              finalProofbody: {
                offdeltas: [],
                tokenIds: [],
                transformers: [],
              },
              finalArguments: '0x',
              initialArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              disputeUntilBlock: 123,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'55'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
      },
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: {
          reason: 'submit_failed',
          requeueToCurrent: true,
        },
      },
      createEmptyEnv('abort-finalize-regression'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
    expect(result.newState.accounts.get(counterpartyId)?.activeDispute?.finalizeQueued).toBe(false);
  });

  test('request_collateral checks prepaid fee against derived outCapacity', () => {
    const feeDelta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 100n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 95n,
      rightHold: 0n,
    };
    const accountMachine = {
      deltas: new Map([[1, feeDelta]]),
      requestedRebalance: new Map<number, bigint>(),
      requestedRebalanceFeeState: new Map(),
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 50n, feeTokenId: 1, feeAmount: 10n, policyVersion: 1 },
      },
      true,
      0,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient fee capacity');
    expect(accountMachine.requestedRebalance.size).toBe(0);
    expect(feeDelta.offdelta).toBe(100n);
  });

  test('entity proposal fails fast when prevFrameHash is missing above genesis', async () => {
    const env = createEmptyEnv('audit-entity-seed');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const replica = makeReplicaMissingPrevFrameHash();
    const entityInput: EntityInput = {
      entityId: replica.entityId,
      entityTxs: [
        {
          type: 'openAccount',
          data: { targetEntityId: `0x${'22'.repeat(32)}` },
        },
      ],
    };

    await expect(applyEntityInput(env, replica, entityInput)).rejects.toThrow(
      'ENTITY_FRAME_CHAIN_CORRUPTED',
    );
  });

  test('swap_offer refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      leftEntity: 'left',
      rightEntity: 'right',
      deltas: new Map(),
      swapOffers: new Map(
        Array.from({ length: LIMITS.MAX_ACCOUNT_SWAP_OFFERS }, (_, index) => [String(index), {}]),
      ),
    };

    const result = await handleSwapOffer(
      accountMachine as Parameters<typeof handleSwapOffer>[0],
      {
        type: 'swap_offer',
        data: {
          offerId: 'overflow-offer',
          giveTokenId: 1,
          giveAmount: 100n,
          wantTokenId: 2,
          wantAmount: 100n,
          minFillRatio: 0,
        },
      },
      true,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_SWAP_OFFERS}`);
    expect(accountMachine.swapOffers.size).toBe(LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  });

  test('proposeAccountFrame caps the frame at 100 txs and leaves the remainder queued', async () => {
    const seed = 'account-frame-cap-seed';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const mempool = Array.from({ length: 105 }, (_, index) => ({
      type: 'add_delta' as const,
      data: { tokenId: index + 1 },
    }));
    const accountMachine = makeProposalAccount(mempool, left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(true);
    expect(result.accountInput?.newAccountFrame.accountTxs).toHaveLength(100);
    expect(accountMachine.pendingFrame?.accountTxs).toHaveLength(100);
    expect(accountMachine.mempool).toHaveLength(5);
    expect(accountMachine.mempool.map(tx => (tx as Extract<AccountTx, { type: 'add_delta' }>).data.tokenId)).toEqual([
      101, 102, 103, 104, 105,
    ]);
  });

  test('failed proposal keeps queued txs, including late arrivals, instead of wiping the mempool', async () => {
    const seed = 'account-proposal-failure-retains-mempool';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const firstTx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
    const lateTx: AccountTx = { type: 'add_delta', data: { tokenId: 2 } };
    const accountMachine = makeProposalAccount([firstTx], left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    queueMicrotask(() => {
      accountMachine.mempool.push(lateTx);
    });

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(false);
    expect(result.error).toContain('MISSING_DEPOSITORY_ADDRESS');
    expect(accountMachine.pendingFrame).toBeUndefined();
    expect(accountMachine.mempool).toHaveLength(2);
    expect(accountMachine.mempool).toEqual([firstTx, lateTx]);
  });

  test('swap_offer rejects minFillRatio for resting GTC orders', async () => {
    const accountMachine = {
      leftEntity: 'left',
      rightEntity: 'right',
      deltas: new Map(),
      swapOffers: new Map(),
    };

    const result = await handleSwapOffer(
      accountMachine as Parameters<typeof handleSwapOffer>[0],
      {
        type: 'swap_offer',
        data: {
          offerId: 'gtc-aon',
          giveTokenId: 1,
          giveAmount: 10n ** 18n,
          wantTokenId: 2,
          wantAmount: 2n * 10n ** 18n,
          minFillRatio: 32768,
          timeInForce: 0,
        },
      },
      true,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('minFillRatio > 0 requires timeInForce');
  });

  test('DisputeFinalized scrubs stale sentBatch finalize and failed Hanko does not resurrect it', async () => {
    const entityId = `0x${'12'.repeat(32)}`;
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'56'.repeat(32)}`,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: {
        ...createEmptyBatch(),
        disputeFinalizations: [{
          counterentity: counterpartyId,
          initialNonce: 7,
          finalNonce: 7,
          initialProofbodyHash: `0x${'56'.repeat(32)}`,
          finalProofbody: { offdeltas: [], tokenIds: [], transformers: [] },
          finalArguments: '0x',
          initialArguments: '0x',
          sig: '0x',
          startedByLeft: true,
          disputeUntilBlock: 123,
          cooperative: false,
        }],
      },
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
            initialProofbodyHash: `0x${'56'.repeat(32)}`,
            finalProofbody: { offdeltas: [], tokenIds: [], transformers: [] },
            finalArguments: '0x',
            initialArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'78'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 7,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 6,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('dispute-finalize-scrub-seed');
    const finalized = await handleJEvent(state, {
      from: `0x${'aa'.repeat(20)}`,
      observedAt: 2000,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      event: {
        type: 'DisputeFinalized',
        data: {
          sender: entityId,
          counterentity: counterpartyId,
          initialNonce: 7,
          initialProofbodyHash: `0x${'56'.repeat(32)}`,
          finalProofbodyHash: `0x${'57'.repeat(32)}`,
        },
      },
    }, env);

    expect(finalized.newState.accounts.get(counterpartyId)?.activeDispute).toBeUndefined();
    expect(finalized.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(finalized.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(0);

    const failed = await handleJEvent(finalized.newState, {
      from: `0x${'aa'.repeat(20)}`,
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      event: {
        type: 'HankoBatchProcessed',
        data: {
          entityId,
          hankoHash: `0x${'55'.repeat(32)}`,
          nonce: 7,
          success: false,
        },
      },
    }, env);

    expect(failed.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
  });

  test('j_rebroadcast filters stale dispute finalize and only resubmits live ops', async () => {
    const entityId = `0x${'ab'.repeat(32)}`;
    const counterpartyId = `0x${'cd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress: hex20('1'),
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }],
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 3,
            finalNonce: 3,
            initialProofbodyHash: `0x${'11'.repeat(32)}`,
            finalProofbody: { offdeltas: [], tokenIds: [], transformers: [] },
            finalArguments: '0x',
            initialArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('j-rebroadcast-scrub-seed');
    env.activeJurisdiction = 'Testnet';
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: hex20('1'),
      entityProviderAddress: hex20('2'),
      contracts: {
        account: hex20('3'),
        depository: hex20('1'),
        entityProvider: hex20('2'),
        deltaTransformer: hex20('4'),
      },
      rpcs: ['http://localhost:8545'],
      chainId: 31337,
    });

    const result = await handleJRebroadcast(
      state,
      { type: 'j_rebroadcast', data: {} },
      env,
    );

    expect(result.jOutputs.length).toBe(1);
    const rebroadcast = result.jOutputs[0]?.jTxs[0];
    expect(rebroadcast?.type).toBe('batch');
    if (rebroadcast?.type === 'batch') {
      expect(rebroadcast.data.batch.disputeFinalizations.length).toBe(0);
      expect(rebroadcast.data.batch.reserveToReserve.length).toBe(1);
    }
    expect(result.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(0);
  });

  test('htlc_lock refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      deltas: new Map(),
      currentHeight: 0,
      locks: new Map(
        Array.from({ length: LIMITS.MAX_ACCOUNT_HTLC_LOCKS }, (_, index) => [String(index), {}]),
      ),
    };

    const result = await handleHtlcLock(
      accountMachine as Parameters<typeof handleHtlcLock>[0],
      {
        type: 'htlc_lock',
        data: {
          lockId: 'overflow-lock',
          hashlock: `0x${'11'.repeat(32)}`,
          timelock: 1_000_000n,
          revealBeforeHeight: 100,
          amount: 1n,
          tokenId: 1,
        },
      },
      true,
      0,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`);
    expect(accountMachine.locks.size).toBe(LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  });
});
