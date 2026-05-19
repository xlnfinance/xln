import { describe, expect, test } from 'bun:test';

import { handleAccountInput, proposeAccountFrame } from '../account-consensus';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account-crypto';
import { handleHtlcLock } from '../account-tx/handlers/htlc-lock';
import { handleHtlcResolve } from '../account-tx/handlers/htlc-resolve';
import { checkAutoRebalance, handleRequestCollateral } from '../account-tx/handlers/request-collateral';
import { handleSwapOffer } from '../account-tx/handlers/swap-offer';
import { LIMITS } from '../constants';
import { ACCOUNT_PENDING_RESEND_AFTER_MS, executeCrontab, initCrontab } from '../entity-crontab';
import { generateLazyEntityId } from '../entity-factory';
import { isLeftEntity } from '../entity-id-utils';
import { applyEntityInput } from '../entity-consensus';
import { applyEntityTx } from '../entity-tx/apply';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity-tx/handlers/account-cross-j-followups';
import { handleJAbortSentBatch } from '../entity-tx/handlers/j-abort-sent-batch';
import { handleJRebroadcast } from '../entity-tx/handlers/j-rebroadcast';
import { handleJEvent } from '../entity-tx/j-events';
import {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from '../j-event-observation';
import { createEmptyBatch } from '../j-batch';
import { applyCommand, createBook, getBookOrder, type OrderbookExtState } from '../orderbook';
import { process, createEmptyEnv, registerEntityRuntimeHint, sendEntityInput } from '../runtime';
import { safeStringify } from '../serialization-utils';
import { projectAccountDoc } from '../storage/projections';
import { createDefaultDelta } from '../validation-utils';
import type { AccountMachine, AccountTx, ConsensusConfig, CrossJurisdictionSwapRoute, EntityInput, EntityReplica, EntityState, JurisdictionEvent } from '../types';

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

const signJEventObservation = (
  env: ReturnType<typeof createEmptyEnv>,
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
  test('cross-j system entity txs reject remote hops outside the two-runtime route topology', async () => {
    const env = createEmptyEnv('cross-j-intra-runtime-boundary');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const remoteRuntime = `0x${'99'.repeat(20)}`;

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: `0x${'11'.repeat(32)}`,
      entityTxs: [{
        type: 'requestCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    }])).rejects.toThrow('RUNTIME_CROSS_J_TOPOLOGY_INVALID');

    expect(() => sendEntityInput(env, {
      entityId: `0x${'22'.repeat(32)}`,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).not.toThrow();

    registerEntityRuntimeHint(env, `0x${'22'.repeat(32)}`, remoteRuntime);
    expect(() => sendEntityInput(env, {
      entityId: `0x${'22'.repeat(32)}`,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).toThrow('CROSS_J_REMOTE_TOPOLOGY_INVALID');
  });

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

  test('j_event rejects non-validator signer ids before observation aggregation', async () => {
    const state = makeEntityState(`0x${'11'.repeat(32)}`);
    const env = createEmptyEnv('j-event-non-validator');

    await expect(handleJEvent(state, {
      from: 'not-a-validator',
      observedAt: 1_000,
      blockNumber: 1,
      blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'33'.repeat(32)}`,
      event: {
        type: 'ReserveUpdated',
        data: {
          entity: state.entityId,
          tokenId: 1,
          newBalance: '100',
        },
      },
    }, env)).rejects.toThrow('j_event rejected: non-validator signer');
  });

  test('j_event finality requires quorum on canonical event set, not only block hash', async () => {
    const entityId = `0x${'44'.repeat(32)}`;
    let state = makeEntityState(entityId);
    state.config = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['1', '2', '3'],
      shares: { '1': 1n, '2': 1n, '3': 1n },
    };
    const env = createEmptyEnv('j-event-events-hash-quorum');
    const common = {
      observedAt: 1_000,
      blockNumber: 7,
      blockHash: `0x${'55'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
    };
    const honestEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const fakeEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '999' },
    };
    const signedHonest1 = signJEventObservation(env, entityId, '1', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [honestEvent],
    });
    const signedFake = signJEventObservation(env, entityId, '2', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [fakeEvent],
    });
    const signedHonest3 = signJEventObservation(env, entityId, '3', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [honestEvent],
    });

    state = (await handleJEvent(state, { ...common, from: '1', event: honestEvent, ...signedHonest1 }, env)).newState;
    state = (await handleJEvent(state, { ...common, from: '2', event: fakeEvent, ...signedFake }, env)).newState;
    expect(state.jBlockChain.length).toBe(0);
    expect(state.reserves.get(1)).toBeUndefined();

    state = (await handleJEvent(state, { ...common, from: '3', event: honestEvent, ...signedHonest3 }, env)).newState;
    expect(state.jBlockChain.length).toBe(1);
    expect(state.reserves.get(1)).toBe(100n);
  });

  test('multi-validator j_event observations must be signed by the claimed signer', async () => {
    const entityId = `0x${'4a'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['1', '2', '3'],
      shares: { '1': 1n, '2': 1n, '3': 1n },
    };
    const env = createEmptyEnv('j-event-observation-signature');
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const common = {
      observedAt: 1_000,
      blockNumber: 8,
      blockHash: `0x${'5a'.repeat(32)}`,
      transactionHash: `0x${'6a'.repeat(32)}`,
      event,
    };
    const signerOne = signJEventObservation(env, entityId, '1', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
    });

    await expect(handleJEvent(state, { ...common, from: '1' }, env)).rejects.toThrow(
      'missing observation signature',
    );
    await expect(handleJEvent(state, { ...common, from: '2', ...signerOne }, env)).rejects.toThrow(
      'invalid observation signature',
    );
  });

  test('htlc_resolve(error) cannot be used by payer to cancel an active lock before expiry', async () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const amount = 1000n;
    const delta = createDefaultDelta(1);
    delta.leftHold = amount;
    account.deltas.set(1, delta);
    account.locks.set('lock-1', {
      lockId: 'lock-1',
      hashlock: `0x${'77'.repeat(32)}`,
      timelock: 10_000n,
      revealBeforeHeight: 100,
      amount,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    const payerResult = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      true,
      1,
      1_000,
    );
    expect(payerResult.success).toBe(false);
    expect(account.locks.has('lock-1')).toBe(true);
    expect(account.deltas.get(1)?.leftHold).toBe(amount);

    const beneficiaryResult = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      false,
      1,
      1_000,
    );
    expect(beneficiaryResult.success).toBe(true);
    expect(account.locks.has('lock-1')).toBe(false);
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('failed account tx mutations do not leak into later valid txs in the same proposal', async () => {
    const env = createEmptyEnv('account-tx-atomicity');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as any;
    const { signerId, entityId: left } = registerLazySigner('account-tx-atomicity', '1');
    attachSigningReplica(env, left, signerId);
    const right = `0x${'ff'.repeat(32)}`;
    const account = makeProposalAccount([
      {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 100n,
          fromEntityId: right,
          toEntityId: left,
          route: [''],
        },
      },
      {
        type: 'set_credit_limit',
        data: {
          tokenId: 1,
          amount: 500n,
        },
      },
    ], left, right);
    account.deltas.set(1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    });

    const result = await proposeAccountFrame(env, account);

    expect(result.success).toBe(true);
    expect(result.accountInput?.newAccountFrame?.accountTxs.map((tx) => tx.type)).toEqual(['set_credit_limit']);
    const frameDelta = result.accountInput?.newAccountFrame?.deltas.find((delta) => delta.tokenId === 1);
    expect(frameDelta?.offdelta).toBe(0n);
    expect(frameDelta?.rightCreditLimit).toBe(500n);
  });

  test('entity frame commits mark the entity core doc dirty for storage replay', async () => {
    const seed = 'entity-frame-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId,
            name: 'Storage Marked',
          },
        },
      } as any],
    });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(marks.some((record) => record.family === 'entity' && record.entityId === entityId)).toBe(true);
  });

  test('crontab-only canonical mutations mark entity docs dirty for storage replay', async () => {
    const seed = 'crontab-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    state.timestamp = 50_000;
    state.crontabState = initCrontab();
    state.crontabState.tasks.clear();
    state.crontabState.hooks.set('test-settlement-window', {
      id: 'test-settlement-window',
      triggerAt: 49_000,
      type: 'settlement_window',
      data: {},
    });
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    await executeCrontab(env, replica, state.crontabState, { manualBroadcastInInput: false });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(state.crontabState.hooks.has('test-settlement-window')).toBe(false);
    expect(marks.some((record) => record.family === 'entity' && record.entityId === entityId)).toBe(true);
  });

  test('finalized j-events mark mutated account docs dirty for storage replay', async () => {
    const seed = 'j-event-account-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 20_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const entityIsLeft = isLeftEntity(entityId, counterpartyId);
    const account = makeProposalAccount(
      [],
      entityIsLeft ? entityId : counterpartyId,
      entityIsLeft ? counterpartyId : entityId,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: `0x${'56'.repeat(32)}`,
      initialNonce: 7,
      disputeTimeout: 22,
      onChainNonce: 7,
      initialArguments: '0x',
      finalizeQueued: true,
    };
    state.accounts.set(counterpartyId, account);
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{
        type: 'j_event',
        data: {
          from: signerId,
          observedAt: 20_000,
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
        },
      } as any],
    });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(marks.some((record) =>
      record.family === 'account' &&
      record.entityId === entityId &&
      record.counterpartyId === counterpartyId.toLowerCase(),
    )).toBe(true);
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

  test('request_collateral tops up an existing pending request without resubmitting in-flight batch', () => {
    const delta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 1_000n,
      leftCreditLimit: 0n,
      rightCreditLimit: 2_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      deltas: new Map([[1, delta]]),
      requestedRebalance: new Map<number, bigint>([[1, 590n]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: 10n,
        requestedAmount: 590n,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 800n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.requestedRebalance.get(1)).toBe(780n);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(20n);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.jBatchSubmittedAt).toBe(123);
    expect(delta.offdelta).toBe(990n);
  });

  test('auto-rebalance allows pending request top-up during settlement', () => {
    const usd = 10n ** 18n;
    const accountMachine = {
      settlementWorkspace: { status: 'sent' },
      mempool: [],
      pendingFrame: undefined,
      requestedRebalance: new Map<number, bigint>([[1, 590n * usd]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: 10n * usd,
        requestedAmount: 590n * usd,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
      rebalancePolicy: new Map([[1, {
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 100n * usd,
      }]]),
      deltas: new Map([[1, {
        tokenId: 1,
        collateral: 590n * usd,
        ondelta: 0n,
        offdelta: 1_390n * usd,
        leftCreditLimit: 0n,
        rightCreditLimit: 2_000n * usd,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      { policyVersion: 1, baseFee: 10n * usd, gasFee: 0n, liquidityFeeBps: 0n },
    );

    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('request_collateral');
    expect(txs[0]?.data.amount).toBe(800n * usd);
  });

  test('auto-rebalance tops up pending request fee when liquidity fee grows', () => {
    const usd = 10n ** 18n;
    const previousRequest = 590n * usd;
    const outPeerCredit = 1_000n * usd;
    const previousFee = 150_100_000_000_000_000n;
    const requiredFee = 200_000_000_000_000_000n;
    const feeTopup = requiredFee - previousFee;
    const delta = {
      tokenId: 1,
      collateral: previousRequest,
      ondelta: 0n,
      offdelta: previousRequest + outPeerCredit,
      leftCreditLimit: 2_000n * usd,
      rightCreditLimit: 2_000n * usd,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      settlementWorkspace: { status: 'sent' },
      mempool: [],
      pendingFrame: undefined,
      deltas: new Map([[1, delta]]),
      requestedRebalance: new Map<number, bigint>([[1, previousRequest]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: previousFee,
        requestedAmount: previousRequest,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
      rebalancePolicy: new Map([[1, {
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 300n * usd,
      }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      { policyVersion: 1, baseFee: usd / 10n, gasFee: 0n, liquidityFeeBps: 1n },
    );

    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('request_collateral');
    expect(txs[0]?.data.amount).toBe(outPeerCredit);
    expect(txs[0]?.data.feeAmount).toBe(requiredFee);

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: outPeerCredit, feeTokenId: 1, feeAmount: requiredFee, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.requestedRebalance.get(1)).toBe(outPeerCredit - requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.requestedAmount).toBe(outPeerCredit - requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.jBatchSubmittedAt).toBe(123);
    expect(delta.offdelta).toBe(previousRequest + outPeerCredit - feeTopup);
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

  test('proposeAccountFrame bundles the last outbound ACK into the next frame for loss recovery', async () => {
    const seed = 'account-frame-ack-loss-recovery';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([
      { type: 'add_delta', data: { tokenId: 1 } },
    ], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ab'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      prevHanko: `0x${'cd'.repeat(65)}`,
    };
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind).toBe('frame_ack');
    expect(result.accountInput?.height).toBe(10);
    expect(result.accountInput?.prevHanko).toBe(accountMachine.lastOutboundFrameAck?.prevHanko);
    expect(result.accountInput?.newAccountFrame.height).toBe(11);
    expect(accountMachine.pendingAccountInput?.kind).toBe('frame_ack');
  });

  test('account storage keeps last outbound ACK so restored runtimes can bundle the next frame', () => {
    const accountMachine = makeProposalAccount([], hex20('11'), hex20('22'));
    accountMachine.lastOutboundFrameAck = {
      height: 8,
      counterpartyEntityId: hex20('22'),
      prevHanko: `0x${'aa'.repeat(65)}`,
    };
    accountMachine.hankoSignature = `0x${'bb'.repeat(65)}`;
    accountMachine.pendingForward = {
      route: [hex20('33'), hex20('44')],
      tokenId: 1,
      amount: 123n,
      description: 'pending-forward-storage',
    };

    const doc = projectAccountDoc(accountMachine);

    expect(doc.lastOutboundFrameAck).toEqual(accountMachine.lastOutboundFrameAck);
    expect(doc.hankoSignature).toBe(accountMachine.hankoSignature);
    expect(doc.pendingForward).toEqual(accountMachine.pendingForward);
  });

  test('crontab resends bundled ACK plus pending frame after relay loss', async () => {
    const env = createEmptyEnv('account-frame-bundled-resend');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('22');
    const pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_RESEND_AFTER_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta' as const, data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: replica.entityId,
      toEntityId: counterpartyId,
      height: 10,
      prevHanko: `0x${'12'.repeat(65)}`,
      newAccountFrame: pendingFrame,
      newHanko: `0x${'34'.repeat(65)}`,
    };
    replica.state.accounts.set(counterpartyId, accountMachine);

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(counterpartyId);
    expect(outputs[0]?.entityTxs).toEqual([
      { type: 'accountInput', data: accountMachine.pendingAccountInput },
    ]);
  });

  test('handleAccountInput re-acks duplicate committed frames when the original ACK was lost', async () => {
    const seed = 'account-frame-duplicate-reack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      prevHanko: `0x${'12'.repeat(65)}`,
    };

    const result = await handleAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      height: 10,
      newAccountFrame: {
        ...accountMachine.currentFrame,
        prevFrameHash: `0x${'34'.repeat(32)}`,
      },
      newHanko: `0x${'56'.repeat(65)}`,
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    expect(result.response?.height).toBe(10);
    expect(result.response?.prevHanko).toBe(accountMachine.lastOutboundFrameAck.prevHanko);
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
      from: '1',
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
      from: '1',
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

  test('j_rebroadcast resubmits the exact sent batch without mutating ops', async () => {
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
      expect(rebroadcast.data.batch.disputeFinalizations.length).toBe(1);
      expect(rebroadcast.data.batch.reserveToReserve.length).toBe(1);
    }
    expect(result.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(1);
  });

  test('HankoBatchProcessed(false) drops stale dispute finalize when on-chain nonce already moved even before DisputeFinalized arrives', async () => {
    const entityId = `0x${'91'.repeat(32)}`;
    const counterpartyId = `0x${'92'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'93'.repeat(32)}`,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    account.onChainSettlementNonce = 7;
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
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
            initialProofbodyHash: `0x${'94'.repeat(32)}`,
            finalProofbody: { offdeltas: [], tokenIds: [], transformers: [] },
            finalArguments: '0x',
            initialArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'95'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 7,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 7,
    } as EntityState['jBatchState'];

    const failed = await handleJEvent(state, {
      from: '1',
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      event: {
        type: 'HankoBatchProcessed',
        data: {
          entityId,
          hankoHash: `0x${'98'.repeat(32)}`,
          nonce: 7,
          success: false,
        },
      },
    }, createEmptyEnv('failed-batch-stale-finalize'));

    expect(failed.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
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

  test('cross-j source fill ack routes book removal to canonical sibling owner', async () => {
    const env = createEmptyEnv('cross-book-owner-removal');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const orderId = 'cross-owner-full-fill';
    const pairId = 'cross:stack:1:0xdep:1/stack:2:0xdep:1';
    const namespacedOrderId = `${sourceUser}:${orderId}`;

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor('source-signer');
    const route: CrossJurisdictionSwapRoute = {
      orderId,
      bookOwnerEntityId: targetHub,
      venueId: pairId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: 'stack:2:0xdep',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'stack:1:0xdep',
        entityId: targetHub,
        counterpartyEntityId: `0x${'40'.repeat(32)}`,
        tokenId: 1,
        amount: 1_000n,
      },
      status: 'partially_filled',
      fillSeq: 1,
      cumulativeFillRatio: 100,
      filledSourceAmount: 1n,
      filledTargetAmount: 1n,
      createdAt: 1,
      updatedAt: 1,
    };
    sourceState.crossJurisdictionSwaps = new Map([
      [orderId, route],
    ]);

    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: sourceUser,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1,
    }).state;
    const targetState = makeEntityState(targetHub);
    targetState.config = makeSingleSignerConfigFor('target-signer');
    targetState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
      hubProfile: {
        entityId: targetHub,
        name: 'Target hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;
    env.eReplicas.set(`${sourceHub}:source-signer`, {
      entityId: sourceHub,
      signerId: 'source-signer',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${targetHub}:target-signer`, {
      entityId: targetHub,
      signerId: 'target-signer',
      mempool: [],
      isProposer: true,
      state: targetState,
    } satisfies EntityReplica);

    const outputs: EntityInput[] = [];
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: orderId,
        fillSeq: 1,
        incrementalSourceAmount: 0n,
        incrementalTargetAmount: 0n,
        cumulativeSourceAmount: 1n,
        cumulativeTargetAmount: 1n,
        cumulativeFillRatio: 100,
        cancelRemainder: true,
      },
    };
    const applied = applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceState,
      sourceUser,
      ackTx,
      outputs,
    );

    expect(applied).toBe(true);
    const removal = outputs.find(output => output.entityId === targetHub && output.entityTxs?.[0]?.type === 'removeCrossJurisdictionBookOrder');
    expect(removal?.signerId).toBe('target-signer');
    expect(removal?.entityTxs?.[0]).toMatchObject({
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId,
        sourceEntityId: sourceUser,
        reason: 'fill_ack_closed',
      },
    });
    expect((removal?.entityTxs?.[0] as any)?.data?.route?.orderId).toBe(orderId);

    const removed = await applyEntityTx(env, targetState, removal!.entityTxs![0]!);
    const nextBook = removed.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
  });
});
