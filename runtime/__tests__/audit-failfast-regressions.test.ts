import { describe, expect, test } from 'bun:test';

import { handleAccountInput, proposeAccountFrame } from '../account-consensus';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account-crypto';
import { handleHtlcLock } from '../account-tx/handlers/htlc-lock';
import { handleHtlcResolve } from '../account-tx/handlers/htlc-resolve';
import { checkAutoRebalance, handleRequestCollateral } from '../account-tx/handlers/request-collateral';
import { handleSwapOffer } from '../account-tx/handlers/swap-offer';
import { createFrameHash } from '../account-consensus-frame';
import { LIMITS } from '../constants';
import { ACCOUNT_PENDING_RESEND_AFTER_MS, executeCrontab, initCrontab } from '../entity-crontab';
import { generateLazyEntityId } from '../entity-factory';
import { isLeftEntity } from '../entity-id-utils';
import { applyEntityFrame, applyEntityInput } from '../entity-consensus';
import { createEntityFrameHash } from '../entity-consensus-frame';
import { assertCrossJurisdictionOrderAdmissible } from '../entity-consensus/cross-j-orderbook';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../cross-jurisdiction-orderbook';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../cross-jurisdiction';
import { applyEntityTx } from '../entity-tx/apply';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity-tx/handlers/account-cross-j-followups';
import { handleAdmitCrossJurisdictionBookOrderEntityTx } from '../entity-tx/handlers/cross-j-book-order';
import { handleDisputeFinalize, handleDisputeStart } from '../entity-tx/handlers/dispute';
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
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../dispute-arguments';
import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../proof-builder';
import { signEntityHashes } from '../hanko/signing';
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

  test('single-validator j_event observations must still be signed by the claimed signer', async () => {
    const seed = 'j-event-single-validator-signature';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const common = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 2,
      blockHash: `0x${'12'.repeat(32)}`,
      transactionHash: `0x${'13'.repeat(32)}`,
      event,
    };
    const signed = signJEventObservation(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
    });

    await expect(handleJEvent(state, { ...common } as any, env)).rejects.toThrow(
      'missing eventsHash',
    );
    await expect(handleJEvent(state, { ...common, eventsHash: signed.eventsHash } as any, env)).rejects.toThrow(
      'missing observation signature',
    );

    const result = await handleJEvent(state, { ...common, ...signed }, env);
    expect(result.newState.jBlockChain.length).toBe(1);
    expect(result.newState.reserves.get(1)).toBe(100n);
  });

  test('j_event auth rejects are fatal inside applyEntityTx', async () => {
    const seed = 'j-event-auth-reject-fatal';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const eventsHash = canonicalJurisdictionEventsHash([event]);

    await expect(applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signerId,
        observedAt: 1_000,
        blockNumber: 3,
        blockHash: `0x${'14'.repeat(32)}`,
        transactionHash: `0x${'15'.repeat(32)}`,
        eventsHash,
        event,
      },
    } as any)).rejects.toThrow('j_event rejected: missing observation signature');
  });

  test('entity frame aborts instead of partially committing after a skipped tx', async () => {
    const env = createEmptyEnv('entity-frame-atomicity');
    env.quietRuntimeLogs = true;
    const state = makeEntityState(`0x${'61'.repeat(32)}`);
    const signer = 'atomic-signer';

    await expect(applyEntityFrame(env, state, [
      { type: 'chatMessage', data: { message: 'first mutation' } } as any,
      { type: 'definitely_unknown_entity_tx', data: {} } as any,
      { type: 'chatMessage', data: { message: 'late mutation' } } as any,
    ], 1_000)).rejects.toThrow('ENTITY_FRAME_TX_FAILED: type=definitely_unknown_entity_tx');

    expect(state.messages).toHaveLength(0);
    expect(state.nonces.has(signer)).toBe(false);
  });

  test('cross-j remote route cannot seed missing sibling runtime hints before topology validation', async () => {
    const env = createEmptyEnv('cross-j-topology-hints');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const localRuntime = `0x${'10'.repeat(20)}`;
    const remoteRuntime = `0x${'20'.repeat(20)}`;
    env.runtimeId = localRuntime;
    const sourceUserId = `0x${'31'.repeat(32)}`;
    const targetUserId = `0x${'32'.repeat(32)}`;
    const sourceHubId = `0x${'41'.repeat(32)}`;
    const targetHubId = `0x${'42'.repeat(32)}`;
    attachSigningReplica(env, sourceUserId, '1');
    attachSigningReplica(env, targetUserId, '1');

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: sourceUserId,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: {
          route: {
            orderId: 'route-derived-hint-attack',
            source: { entityId: sourceUserId, counterpartyEntityId: sourceHubId },
            target: { entityId: targetHubId, counterpartyEntityId: targetUserId },
            bookOwnerEntityId: sourceHubId,
            hubEntityId: sourceHubId,
          },
        },
      } as any],
    }])).rejects.toThrow('RUNTIME_CROSS_J_TOPOLOGY_INVALID');
  });

  test('cross-j order admission requires committed source and target pull receipts', () => {
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const sourcePull = {
      pullId: 'source-pull',
      tokenId: 1,
      amount: 1_000n,
      signedAmount: 1_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'aa'.repeat(32)}`,
      partialRoot: `0x${'bb'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'target-pull',
      tokenId: 2,
      amount: 900n,
      signedAmount: 900n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'cc'.repeat(32)}`,
      partialRoot: `0x${'dd'.repeat(32)}`,
    };
    const sourceHubState = {
      entityId: sourceHub,
      accounts: new Map(),
      crossJurisdictionBookAdmissions: new Map(),
    } as EntityState;
    const route = {
      orderId: 'cross-admit-missing-target-lock',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      venueId: 'cross:test:1/target:2',
      source: {
        jurisdiction: 'test',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'target',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 900n,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const sourceReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'source',
      {
        type: 'pull_lock',
        data: {
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
          revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
          fullHash: sourcePull.fullHash,
          partialRoot: sourcePull.partialRoot,
        },
      },
      sourceHub,
      sourceUser,
      1_000,
    );
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_000, sourceReceipt);

    expect(getCrossJurisdictionBookAdmissionError(sourceHubState, route, 1_000))
      .toContain('CROSS_J_BOOK_ADMISSION_PENDING');
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_000))
      .toThrow('CROSS_J_BOOK_ADMISSION_PENDING');

    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_001, targetReceipt);
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_001)).not.toThrow();

    const env = createEmptyEnv('cross-j-admit-handler');
    const handlerState = makeEntityState(sourceHub);
    handlerState.accounts.set(sourceUser, {
      ...makeProposalAccount([], sourceUser, sourceHub),
      swapOffers: new Map([[route.orderId, {
        offerId: route.orderId,
        makerIsLeft: true,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        createdHeight: 1,
        crossJurisdiction: route,
      }]]),
    });
    const sourceAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, handlerState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'source_pull_committed' },
    });
    expect(sourceAdmit.swapOffersCreated).toHaveLength(0);
    expect(sourceAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('pending');

    const targetAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, sourceAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: targetReceipt, reason: 'target_pull_committed' },
    });
    expect(targetAdmit.swapOffersCreated).toHaveLength(1);
    expect(targetAdmit.swapOffersCreated[0]?.crossJurisdiction?.orderId).toBe(route.orderId);
    expect(targetAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('admitted');

    const badTargetReceipt = { ...targetReceipt, signedAmount: targetReceipt.signedAmount + 1n };
    const resolvingAdmission = targetAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value;
    if (!resolvingAdmission) throw new Error('test fixture missing cross-j admission');
    resolvingAdmission.status = 'resolving';
    const duplicateResolvingAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: targetReceipt, reason: 'duplicate_target_pull_committed' },
    });
    expect(duplicateResolvingAdmit.swapOffersCreated).toHaveLength(0);
    expect(duplicateResolvingAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('resolving');
    expect(() => handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: badTargetReceipt, reason: 'bad_duplicate' },
    })).toThrow('CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH');

    const closedAdmission = duplicateResolvingAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value;
    if (!closedAdmission) throw new Error('test fixture missing cross-j admission');
    closedAdmission.status = 'closed';
    const duplicateClosedAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, duplicateResolvingAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'duplicate_source_pull_committed' },
    });
    expect(duplicateClosedAdmit.swapOffersCreated).toHaveLength(0);
    expect(duplicateClosedAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('closed');

    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_002, badTargetReceipt);
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_002))
      .toThrow('CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH');
  });

  test('committed source pull advances source route to resting before fill notice', () => {
    const env = createEmptyEnv('cross-j-source-commit-resting');
    env.timestamp = 10_000;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-commit-resting',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      venueId: 'cross:test:1/target:2',
      source: {
        jurisdiction: 'test',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'target',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 900n,
      },
      status: 'target_prepared',
      createdAt: 10_000,
      updatedAt: 10_000,
      expiresAt: 60_000,
    }, { runtimeSeed: 'cross-source-commit-resting', sourceDisputeDelayMs: 5_000, now: 10_000 });
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
        },
      },
      targetHub,
      targetUser,
      10_001,
    );
    const sourceHubState = makeEntityState(sourceHub);
    sourceHubState.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    const outputs: EntityInput[] = [];

    applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, {
      type: 'pull_lock',
      data: {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding({
          ...route,
          targetReceipt,
          status: 'resting',
        }, 'source'),
      },
    }, outputs);

    const sourceRoute = sourceHubState.crossJurisdictionSwaps.get(route.orderId);
    expect(sourceRoute?.status).toBe('resting');
    expect(sourceRoute?.targetReceipt?.receiptHash).toBe(targetReceipt.receiptHash);
    expect(outputs.some((output) =>
      output.entityTxs?.some((tx) => tx.type === 'admitCrossJurisdictionBookOrder'),
    )).toBe(true);
  });

  test('cross-j same-token swap_offer quantizes by jurisdiction market side', async () => {
    const sourceUser = `0x${'33'.repeat(32)}`;
    const sourceHub = `0x${'43'.repeat(32)}`;
    const targetHub = `0x${'44'.repeat(32)}`;
    const targetUser = `0x${'34'.repeat(32)}`;
    const sourcePull = {
      pullId: 'same-token-source-pull',
      tokenId: 1,
      amount: 2_000_000_000_000n,
      signedAmount: 2_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ab'.repeat(32)}`,
      partialRoot: `0x${'bc'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'same-token-target-pull',
      tokenId: 1,
      amount: 1_000_000_000_000n,
      signedAmount: 1_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'cd'.repeat(32)}`,
      partialRoot: `0x${'de'.repeat(32)}`,
    };
    const route = {
      orderId: 'cross-same-token-offer',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:stack:a:dep:1/stack:z:dep:1',
      source: {
        jurisdiction: 'stack:z:dep',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'stack:a:dep',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );
    const admittedRoute = { ...route, targetReceipt } satisfies CrossJurisdictionSwapRoute;
    const account = makeProposalAccount([], sourceUser, sourceHub);
    (account as AccountMachine & { pulls: Map<string, typeof sourcePull> }).pulls = new Map([[
      sourcePull.pullId,
      {
        ...sourcePull,
        crossJurisdiction: buildCrossJurisdictionPullBinding(admittedRoute, 'source'),
      },
    ]]);

    const result = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: route.source.amount,
        wantTokenId: 1,
        wantAmount: route.target.amount,
        priceTicks: 20_000n,
        minFillRatio: 0,
        crossJurisdiction: admittedRoute,
      },
    }, true, 1);

    expect(result.success).toBe(true);
    const offer = account.swapOffers.get(route.orderId);
    expect(offer?.giveAmount).toBe(route.source.amount);
    expect(offer?.wantAmount).toBe(route.target.amount);
    expect(offer?.priceTicks).toBe(20_000n);
  });

  test('target-side cross-j book owner admits remote source offer from committed receipts', () => {
    const sourceUser = `0x${'35'.repeat(32)}`;
    const sourceHub = `0x${'45'.repeat(32)}`;
    const targetHub = `0x${'46'.repeat(32)}`;
    const targetUser = `0x${'36'.repeat(32)}`;
    const sourcePull = {
      pullId: 'remote-source-pull',
      tokenId: 1,
      amount: 75_000_000_000_000_000_000n,
      signedAmount: 75_000_000_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'remote-target-pull',
      tokenId: 2,
      amount: 30_000_000_000_000_000n,
      signedAmount: 30_000_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const route = {
      orderId: 'remote-source-admit',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:base:2/tron:1',
      source: {
        jurisdiction: 'tron',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'base',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const staleTargetRoute = {
      ...route,
      status: 'target_prepared' as const,
      updatedAt: 999,
    } satisfies CrossJurisdictionSwapRoute;
    const env = createEmptyEnv('target-side-cross-book-owner');
    const targetHubState = makeEntityState(targetHub);
    const sourceReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'source',
      {
        type: 'pull_lock',
        data: {
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
          revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
          fullHash: sourcePull.fullHash,
          partialRoot: sourcePull.partialRoot,
        },
      },
      sourceHub,
      sourceUser,
      1_000,
    );
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      staleTargetRoute,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );

    const pending = handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetHubState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'source_pull_committed' },
    });
    expect(pending.swapOffersCreated).toHaveLength(0);

    const admitted = handleAdmitCrossJurisdictionBookOrderEntityTx(env, pending.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route: staleTargetRoute, receipt: targetReceipt, reason: 'target_pull_committed' },
    });
    expect(admitted.swapOffersCreated).toHaveLength(1);
    expect(admitted.swapOffersCreated[0]?.accountId).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.fromEntity).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.toEntity).toBe(sourceHub);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.orderId).toBe(route.orderId);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.status).toBe('resting');
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

    await expect(handleJEvent(state, { ...common, from: '1', eventsHash: signerOne.eventsHash }, env)).rejects.toThrow(
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

  test('proposeAccountFrame throws instead of dropping invalid cross-j fill ack', async () => {
    const env = createEmptyEnv('cross-fill-ack-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const account = makeProposalAccount([
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: 'missing-cross-offer',
          fillSeq: 1,
          incrementalSourceAmount: 1n,
          incrementalTargetAmount: 1n,
          cumulativeSourceAmount: 1n,
          cumulativeTargetAmount: 1n,
          cumulativeFillRatio: 1,
          executionSourceAmount: 1n,
          executionTargetAmount: 1n,
          cancelRemainder: false,
          pairId: 'cross:testnet:1/tron:1',
        },
      },
    ], left, right);

    await expect(proposeAccountFrame(env, account)).rejects.toThrow(/CROSS_J_FILL_ACK_PROPOSAL_FAILED/);
    expect(account.mempool).toHaveLength(1);
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
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
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
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: `0x${'56'.repeat(32)}`,
        finalProofbodyHash: `0x${'57'.repeat(32)}`,
      },
    };
    const signed = signJEventObservation(env, entityId, signerId, {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
    });

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
          ...signed,
          event: disputeFinalizedEvent,
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
              leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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
              leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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
          type: 'chatMessage',
          data: { message: 'forces single-signer frame creation' },
        },
      ],
    };

    await expect(applyEntityInput(env, replica, entityInput)).rejects.toThrow(
      'ENTITY_FRAME_CHAIN_CORRUPTED',
    );
  });

  test('entity commit catch-up does not apply unsigned proposed newState mutations', async () => {
    const seed = 'entity-commit-catch-up-state-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 42_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const frameTxs: EntityTx[] = [{
      type: 'profile-update',
      data: {
        profile: {
          entityId,
          name: 'Signed Profile',
        },
      },
    } as any];

    const honestBaseState = makeEntityState(entityId);
    honestBaseState.config = makeSingleSignerConfigFor(signerId);
    const { newState: honestFrameState } = await applyEntityFrame(
      env,
      honestBaseState,
      frameTxs,
      env.timestamp,
    );
    const honestNewState: EntityState = {
      ...honestFrameState,
      entityId,
      height: 1,
      timestamp: env.timestamp,
    };
    const frameHash = await createEntityFrameHash(
      'genesis',
      1,
      env.timestamp,
      frameTxs,
      honestNewState,
    );
    const frameSig = signAccountFrame(env, signerId, frameHash);
    const tamperedNewState: EntityState = {
      ...honestNewState,
      profile: {
        ...honestNewState.profile,
        name: 'Injected Profile',
      },
    };
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: false,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      proposedFrame: {
        height: 1,
        txs: frameTxs,
        hash: frameHash,
        newState: tamperedNewState,
        collectedSigs: new Map([[signerId, [frameSig]]]),
      },
    });

    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.profile.name).toBe('Signed Profile');
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

  test('handleAccountInput rejects frames whose byLeft does not match the signed proposer', async () => {
    const seed = 'account-frame-by-left-binding';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nonce: 0 };

    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const maliciousFrame = {
      height: 1,
      timestamp: env.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      stateHash: '',
      byLeft: false,
      deltas: [{
        tokenId: 1,
        collateral: 0n,
        ondelta: 0n,
        offdelta: 0n,
        leftCreditLimit: 100n,
        rightCreditLimit: 0n,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }],
    };
    maliciousFrame.stateHash = await createFrameHash(maliciousFrame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [maliciousFrame.stateHash]);

    const result = await handleAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      height: 1,
      newAccountFrame: maliciousFrame,
      newHanko,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Frame proposer side mismatch');
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
  });

  test('handleAccountInput rejects dispute seal hash mismatch before committing frame', async () => {
    const seed = 'account-frame-poisoned-dispute-seal';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nonce: 0 };
    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const frame = {
      height: 1,
      timestamp: env.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      stateHash: '',
      byLeft: true,
      deltas: [{
        tokenId: 1,
        collateral: 0n,
        ondelta: 0n,
        offdelta: 0n,
        leftCreditLimit: 100n,
        rightCreditLimit: 0n,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }],
    };
    frame.stateHash = await createFrameHash(frame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]);
    const poisonedHash = `0x${'ab'.repeat(32)}`;
    const [newDisputeHanko] = await signEntityHashes(env, left.entityId, left.signerId, [poisonedHash]);

    const result = await handleAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      height: 1,
      newAccountFrame: frame,
      newHanko,
      newDisputeHanko,
      newDisputeHash: poisonedHash,
      newDisputeProofBodyHash: `0x${'11'.repeat(32)}`,
      disputeProofNonce: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('FRAME:DISPUTE_SEAL_HASH_MISMATCH');
    expect(receiverAccount.currentHeight).toBe(0);
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
    expect(receiverAccount.counterpartyDisputeHash).toBeUndefined();
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
          leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: `0x${'56'.repeat(32)}`,
        finalProofbodyHash: `0x${'57'.repeat(32)}`,
      },
    };
    const signedDisputeFinalized = signJEventObservation(env, entityId, '1', {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
    });
    const finalized = await handleJEvent(state, {
      from: '1',
      observedAt: 2000,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      ...signedDisputeFinalized,
      event: disputeFinalizedEvent,
    }, env);

    expect(finalized.newState.accounts.get(counterpartyId)?.activeDispute).toBeUndefined();
    expect(finalized.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(finalized.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(0);

    const failedBatchEvent: JurisdictionEvent = {
      type: 'HankoBatchProcessed',
      data: {
        entityId,
        hankoHash: `0x${'55'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = signJEventObservation(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      events: [failedBatchEvent],
    });
    const failed = await handleJEvent(finalized.newState, {
      from: '1',
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      ...signedFailedBatch,
      event: failedBatchEvent,
    }, env);

    expect(failed.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
  });

  test('disputeFinalize uses signed counter-proof and incremented starter arguments when a newer proof is available', async () => {
    const starterId = `0x${'21'.repeat(32)}`;
    const finalizerId = `0x${'22'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const state = makeEntityState(finalizerId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress,
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    const account = makeProposalAccount([], starterId, finalizerId);
    account.proofHeader = { fromEntity: starterId, toEntity: finalizerId, nonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const initialProof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );

    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 75n });
    const counterProof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, counterProof.proofBodyHash, 2, counterProof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
      [counterProof.proofBodyHash]: counterProof.proofBodyStruct,
    };
    account.counterpartyDisputeProofBodyHash = counterProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofHanko = '0x1234';
    account.counterpartyDisputeHash = createDisputeProofHashWithNonce(
      account,
      counterProof.proofBodyHash,
      depositoryAddress,
      2,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      onChainNonce: 0,
      starterInitialArguments: '0x1111',
      starterIncrementedArguments: '0x2222',
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

    const env = createEmptyEnv('counter-finalize-runtime');
    env.quietRuntimeLogs = true;
    env.lastJBlock = 1;

    const { newState } = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: starterId },
      },
      env,
    );

    const finalization = newState.jBatchState?.batch.disputeFinalizations[0];
    expect(finalization).toBeDefined();
    expect(finalization?.initialNonce).toBe(1);
    expect(finalization?.finalNonce).toBe(2);
    expect(finalization?.sig).toBe('0x1234');
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody.offdeltas).toEqual([75n]);
    expect(finalization?.finalProofbody.tokenIds).toEqual([1n]);
    expect(finalization?.leftArguments).toBe('0x2222');
    expect(finalization?.rightArguments).toBe('0x');
    expect(finalization?.starterInitialArguments).toBe('0x1111');
    expect(finalization?.starterIncrementedArguments).toBe('0x2222');
    expect(newState.accounts.get(starterId)?.activeDispute?.finalizeQueued).toBe(true);
  });

  test('disputeStart rejects unsupported incremented argument override instead of silently ignoring it', async () => {
    const entityId = `0x${'31'.repeat(32)}`;
    const counterpartyId = `0x${'32'.repeat(32)}`;
    const env = createEmptyEnv('dispute-start-incremented-override');
    const state = makeEntityState(entityId);

    await expect(handleDisputeStart(
      state,
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: counterpartyId,
          starterIncrementedArguments: '0x1234',
        },
      },
      env,
    )).rejects.toThrow('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
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
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
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

    const env = createEmptyEnv('failed-batch-stale-finalize');
    const failedBatchEvent: JurisdictionEvent = {
      type: 'HankoBatchProcessed',
      data: {
        entityId,
        hankoHash: `0x${'98'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = signJEventObservation(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      events: [failedBatchEvent],
    });
    const failed = await handleJEvent(state, {
      from: '1',
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      ...signedFailedBatch,
      event: failedBatchEvent,
    }, env);

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

  test('cross-j committed pull_resolve followup rejects malformed binary instead of skipping it', () => {
    const env = createEmptyEnv('cross-pull-resolve-invalid-binary');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const targetUser = `0x${'40'.repeat(32)}`;
    const sourceState = makeEntityState(sourceHub);
    sourceState.crossJurisdictionSwaps = new Map([
      ['cross-invalid-binary', {
        orderId: 'cross-invalid-binary',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: 'eth',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 1_000n,
        },
        sourcePull: {
          pullId: 'source-pull',
          tokenId: 1,
          amount: 1_000n,
          signedAmount: 1_000n,
          revealedUntilTimestamp: 60_000,
          fullHash: `0x${'aa'.repeat(32)}`,
          partialRoot: `0x${'bb'.repeat(32)}`,
        },
        targetPull: {
          pullId: 'target-pull',
          tokenId: 1,
          amount: 1_000n,
          signedAmount: 1_000n,
          revealedUntilTimestamp: 60_000,
          fullHash: `0x${'cc'.repeat(32)}`,
          partialRoot: `0x${'dd'.repeat(32)}`,
        },
        status: 'partially_filled',
        cumulativeFillRatio: 1,
        fillSeq: 1,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 60_000,
      } satisfies CrossJurisdictionSwapRoute],
    ]);

    expect(() => applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceState,
      sourceUser,
      {
        type: 'pull_resolve',
        data: {
          pullId: 'source-pull',
          binary: '0x1234',
        },
      },
      [],
    )).toThrow('CROSS_J_PULL_RESOLVE_BINARY_INVALID');
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

  test('disputeStart removes same-account orderbook rows before freezing the account', async () => {
    const env = createEmptyEnv('dispute-start-orderbook-freeze');
    const hubId = `0x${'90'.repeat(32)}`;
    const userId = `0x${'91'.repeat(32)}`;
    const offerId = 'dispute-freeze-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      minFillRatio: 0,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
    } as unknown as OrderbookExtState;

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.messages.some((msg) => msg.includes('Dispute removed 1 local orderbook row'))).toBe(true);
  });
});
