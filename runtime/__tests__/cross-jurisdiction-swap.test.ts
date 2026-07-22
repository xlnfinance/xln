import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { applyEntityTx } from '../entity/tx/apply';
import { applyAccountTx } from '../account/tx/apply';
import { proposeAccountFrame } from '../account/consensus/propose';
import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import { handlePullCancel } from '../account/tx/handlers/pull';
import { computeAccountStateRoot } from '../account/state-root';
import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../entity/tx/handlers/account';
import { applyEntityInput, mergeEntityInputs } from '../entity/consensus/index';
import {
  appendDefaultProposerCrossJMaterializations,
  entityTxContainsCrossJMaterialization,
  selectCrossJCommitPhaseTxs,
  selectCrossJOpeningAccountProposalTxs,
} from '../entity/cross-j-proposer-materialization';
import { prepareLocallyAuthoredEntityTxs } from '../entity/command';
import {
  createEmptyEnv,
  handleInboundP2PEntityInputs,
  prepareAtomicCrossJAccountInputs,
  submitCrossJurisdictionSwap,
} from '../runtime';
import { buildCrossJurisdictionSwapSubmission } from '../machine/jurisdiction-api';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import type {
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityReplica,
  EntityTx,
  JurisdictionEvent,
  RuntimeEntityInputsEnvelope,
  RoutedEntityInput,
} from '../types';
import { generateLazyEntityId } from '../entity/factory';
import { createDefaultDelta } from '../validation-utils';
import { cloneAccountMachine, cloneEntityReplica, cloneEntityState } from '../state-helpers';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity/tx/handlers/account-cross-j-followups';
import {
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  deriveCrossJurisdictionRouteHash,
  hasCrossJurisdictionCommittedFill,
  hashCrossJurisdictionCloseBinary,
  isCrossJurisdictionRouteTransitionAllowed,
  projectCrossJurisdictionQuantizedClaim,
  validateCrossJurisdictionFillProgress,
  validateCrossJurisdictionQuantization,
  withCanonicalCrossJurisdictionRouteHash,
  withCrossJurisdictionClaimProgress,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j/index';
import {
  buildCrossJurisdictionCancelAck,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
} from '../extensions/cross-j/orderbook';
import { buildCrossJurisdictionPendingFillFromAck } from '../extensions/cross-j/fill-ack';
import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs, deriveCanonicalCrossJurisdictionMarketForLegs } from '../extensions/cross-j/market';
import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account/utils';
import { normalizeEntitySwapTradingPairs } from '../machine/swap-pairs';
import { verifyHashLadderBinary } from '../protocol/htlc/hash-ladder';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, quoteAmountAtPrice } from '../orderbook/types';
import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../protocol/dispute/arguments';
import { signEntityHashes } from '../hanko/signing';
import { hashCertifiedEntityOutputSemantic } from '../entity/consensus/output-certification';
import { queueCrossJurisdictionSourceDisputeFromTargetDispute } from '../entity/tx/j-events-htlc';
import { applyMergedEntityInputs } from '../machine/entity-inputs';
import { crossBookQtyLots } from '../entity/tx/handlers/account/orderbook-matching-cross';
import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHint,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../machine/entity-routing';
import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../machine/output-routing';
import { deliveryAccepted, deliveryDeferred } from '../protocol/payments/delivery-result';
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
  prepareJEventInput,
} from './helpers/cross-j';
import { applyJEventRange, buildJEventRangeData } from './helpers/j-history';
import { buildLocalEntityProfile } from '../networking/gossip-helper';
import { collectLocalProfileEncryptionAnnouncements } from '../networking/profile-encryption';
import { LIMITS } from '../constants';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { cloneIsolatedRoutedEntityInputs } from '../protocol/runtime-input-clone';

const makeLocalCrossJRoutingDeps = (): RuntimeEntityRoutingDeps => ({
  ensureRuntimeState: current => {
    if (!current.runtimeState) throw new Error('TEST_RUNTIME_STATE_REQUIRED');
    return current.runtimeState;
  },
  enqueueRuntimeInputs: () => {
    throw new Error('TEST_UNEXPECTED_RUNTIME_REQUEUE');
  },
  extractEntityId: replicaKey => replicaKey.split(':')[0] || '',
  hasLocalSignerForEntity: (current, entityId) => Array.from(current.eReplicas.values())
    .some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase()),
  hasLocalSignerForEntitySigner: (current, entityId, signerId) => Array.from(current.eReplicas.values())
    .some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase() &&
      replica.signerId.toLowerCase() === signerId.toLowerCase()),
  resolveSoleLocalSignerForEntity: (current, entityId) => {
    const signers = Array.from(current.eReplicas.values())
      .filter(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())
      .map(replica => replica.signerId);
    return signers.length === 1 ? signers[0]! : null;
  },
  getP2P: () => null,
});

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

  test('source hub materializes cross-j commitments once and validators replay them under different seeds', async () => {
    const proposerEnv = createEmptyEnv('cross-j-private-seed-a');
    const validatorEnv = createEmptyEnv('cross-j-private-seed-b');
    proposerEnv.timestamp = 10_000;
    validatorEnv.timestamp = 10_000;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 2, '21', '22');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceUserSigner = addr('68');
    const sourceHubSigner = addr('65');
    const targetHubSigner = addr('66');
    const baseRoute = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-seed-independent-replay',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: addr('67'),
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 90n,
      },
      status: 'intent',
      createdAt: 10_000,
      updatedAt: 10_000,
      expiresAt: 120_000,
    });
    const proposerState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const proposerTargetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    proposerState.timestamp = 10_000;
    proposerTargetHubState.timestamp = 10_000;
    const validatorState = cloneEntityState(proposerState);
    const validatorTargetHubState = cloneEntityState(proposerTargetHubState);
    installJurisdictions(proposerEnv, sourceJ, targetJ);
    installJurisdictions(validatorEnv, sourceJ, targetJ);
    addReplica(proposerEnv, proposerState, sourceHubSigner);
    addReplica(proposerEnv, proposerTargetHubState, targetHubSigner);
    addReplica(validatorEnv, validatorState, sourceHubSigner);
    addReplica(validatorEnv, validatorTargetHubState, targetHubSigner);
    const rawTx = { type: 'prepareCrossJurisdictionSwap', data: { route: baseRoute } } as const;
    const proposerRaw = await applyEntityTx(proposerEnv, proposerState, rawTx);
    const validatorRaw = await applyEntityTx(validatorEnv, validatorState, rawTx);
    const proposerReplica = {
      ...(proposerEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica),
      state: proposerRaw.newState,
    };
    const materialized = appendDefaultProposerCrossJMaterializations(proposerEnv, proposerReplica, []);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.type).toBe('materializeCrossJurisdictionSwap');
    const preparedRoute = (materialized[0] as Extract<EntityTx, {
      type: 'materializeCrossJurisdictionSwap';
    }>).data.route;
    const validatorSeedRoute = buildPreparedCrossJurisdictionRoute(baseRoute, {
      runtimeSeed: validatorEnv.runtimeSeed,
      sourceDisputeDelayMs: committedCrossJSourceDisputeDelayMs(validatorState, baseRoute),
      now: validatorEnv.timestamp,
    });
    expect(validatorSeedRoute.sourcePull?.fullHash).not.toBe(preparedRoute.sourcePull?.fullHash);

    const proposer = await applyEntityTx(proposerEnv, proposerRaw.newState, materialized[0]!);
    const validator = await applyEntityTx(validatorEnv, validatorRaw.newState, materialized[0]!);
    const sourceRegistration = proposer.outputs.find(output => output.entityId === sourceHub)?.entityTxs?.[0];
    if (sourceRegistration?.type !== 'registerCrossJurisdictionSwap') {
      throw new Error('TEST_CROSS_J_SOURCE_REGISTRATION_REQUIRED');
    }
    const proposerRegistered = await applyEntityTx(proposerEnv, proposer.newState, sourceRegistration);
    const validatorRegistered = await applyEntityTx(validatorEnv, validator.newState, sourceRegistration);

    expect(proposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull)
      .toEqual(preparedRoute.sourcePull);
    expect(validatorRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull)
      .toEqual(preparedRoute.sourcePull);
    expect(validator.outputs).toEqual(proposer.outputs);
    expect(validatorRegistered.mempoolOps).toEqual(proposerRegistered.mempoolOps);

    const buildClearingState = (state: EntityState): EntityState => {
      const next = cloneEntityState(state);
      const committed = next.crossJurisdictionSwaps?.get(baseRoute.orderId);
      if (!committed?.sourcePull) throw new Error('TEST_CROSS_J_SOURCE_PULL_REQUIRED');
      const clearingRoute = {
        ...committed,
        status: 'partially_filled' as const,
        fillSeq: 1,
        cumulativeFillRatio: 32_768,
        filledSourceAmount: 50n,
        filledTargetAmount: 45n,
      };
      next.crossJurisdictionSwaps?.set(baseRoute.orderId, clearingRoute);
      const account = next.accounts.get(sourceUser);
      if (!account) throw new Error('TEST_CROSS_J_SOURCE_ACCOUNT_REQUIRED');
      account.pulls = new Map([[clearingRoute.sourcePull.pullId, {
        pullId: clearingRoute.sourcePull.pullId,
        tokenId: clearingRoute.sourcePull.tokenId,
        amount: clearingRoute.sourcePull.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: clearingRoute.sourcePull.revealedUntilTimestamp,
        fullHash: clearingRoute.sourcePull.fullHash,
        partialRoot: clearingRoute.sourcePull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(clearingRoute, 'source'),
        createdHeight: 0,
        createdTimestamp: 10_000,
      }]]);
      return next;
    };
    const rawClear = {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: baseRoute.orderId, cancelRemainder: true },
    } as const;
    const proposerClear = await applyEntityTx(proposerEnv, buildClearingState(proposerRegistered.newState), rawClear);
    const validatorClear = await applyEntityTx(validatorEnv, buildClearingState(validatorRegistered.newState), rawClear);
    expect(proposerClear.mempoolOps).toEqual([]);
    expect(validatorClear.mempoolOps).toEqual([]);
    expect(proposerClear.outputs).toEqual([{ entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] }]);
    expect(validatorClear.outputs).toEqual(proposerClear.outputs);
    const clearingReplica = {
      ...proposerReplica,
      state: proposerClear.newState,
    };
    const clearMaterialization = appendDefaultProposerCrossJMaterializations(
      proposerEnv,
      clearingReplica,
      [],
    );
    expect(clearMaterialization).toHaveLength(1);
    expect(clearMaterialization[0]?.type).toBe('materializeCrossJurisdictionClear');
    const proposerMaterializedClear = await applyEntityTx(
      proposerEnv,
      proposerClear.newState,
      clearMaterialization[0]!,
    );
    const validatorMaterializedClear = await applyEntityTx(
      validatorEnv,
      validatorClear.newState,
      clearMaterialization[0]!,
    );
    expect(validatorMaterializedClear.mempoolOps).toEqual(proposerMaterializedClear.mempoolOps);
    expect(validatorMaterializedClear.outputs).toEqual(proposerMaterializedClear.outputs);
    expect(validatorMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId))
      .toEqual(proposerMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId));
    const verifiedClose = proposerMaterializedClear.mempoolOps?.find(
      op => op.tx.type === 'cross_pull_close',
    )?.tx;
    if (verifiedClose?.type !== 'cross_pull_close') throw new Error('TEST_CROSS_J_CLOSE_REQUIRED');
    expect(verifyHashLadderBinary({
      fullHash: preparedRoute.sourcePull!.fullHash,
      partialRoot: preparedRoute.sourcePull!.partialRoot,
    }, verifiedClose.data.binary).fillRatio).toBe(32_768);

    const delayedProposerState = cloneEntityState(proposerRaw.newState);
    const delayedValidatorState = cloneEntityState(validatorRaw.newState);
    delayedProposerState.timestamp = 12_000;
    delayedValidatorState.timestamp = 12_000;
    const [delayedProposer, delayedValidator] = await Promise.all([
      applyEntityTx(proposerEnv, delayedProposerState, materialized[0]!),
      applyEntityTx(validatorEnv, delayedValidatorState, materialized[0]!),
    ]);
    const delayedProposerRegistered = await applyEntityTx(
      proposerEnv,
      delayedProposer.newState,
      sourceRegistration,
    );
    const delayedValidatorRegistered = await applyEntityTx(
      validatorEnv,
      delayedValidator.newState,
      sourceRegistration,
    );
    expect(delayedProposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull)
      .toEqual(preparedRoute.sourcePull);
    expect(delayedValidator.outputs).toEqual(delayedProposer.outputs);
    expect(delayedValidatorRegistered.mempoolOps).toEqual(delayedProposerRegistered.mempoolOps);

    const tamperedRoute = {
      ...preparedRoute,
      targetPull: {
        ...preparedRoute.targetPull!,
        fullHash: secret('ff'),
      },
    };
    const tamperState = cloneEntityState(proposerRaw.newState);
    await expect(applyEntityTx(proposerEnv, tamperState, {
      type: 'materializeCrossJurisdictionSwap',
      data: { proposerSignerId: sourceHubSigner, route: tamperedRoute },
    })).rejects.toThrow('CROSS_J_PREPARED_FULL_HASH_MISMATCH');
    expect(tamperState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toBeUndefined();

    const exactRetry = await applyEntityTx(proposerEnv, proposerRaw.newState, rawTx);
    expect(exactRetry.outputs).toHaveLength(0);
    expect(exactRetry.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);
    const conflictingIntent = cloneCrossJurisdictionRoute(baseRoute);
    conflictingIntent.targetSignerId = addr('99');
    await expect(applyEntityTx(proposerEnv, proposerRaw.newState, {
      type: 'prepareCrossJurisdictionSwap',
      data: { route: conflictingIntent },
    })).rejects.toThrow('CROSS_J_RAW_PREPARE_CONFLICT');
    expect(proposerRaw.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);

    const mismatchedMaterialization = cloneCrossJurisdictionRoute(preparedRoute);
    mismatchedMaterialization.targetSignerId = addr('99');
    await expect(applyEntityTx(proposerEnv, proposerRaw.newState, {
      type: 'materializeCrossJurisdictionSwap',
      data: { proposerSignerId: sourceHubSigner, route: mismatchedMaterialization },
    })).rejects.toThrow('CROSS_J_MATERIALIZE_INTENT_MISMATCH');
  });

  test('hub siblings apply trusted runtime output without Hanko or sequence', async () => {
    const seed = 'cross-j-runtime-output-roundtrip';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(env, sourceJ, targetJ);
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const targetHubSigner = registerTestSigner(env, seed, '2');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceUser = entity('69');
    const targetUser = entity('6a');
    const targetUserSigner = addr('b2');
    const sourceUserSigner = addr('b4');
    env.gossip = {
      getProfiles: () => [
        {
          entityId: sourceUser,
          metadata: { board: { validators: [{ signerId: sourceUserSigner }] } },
        },
        {
          entityId: targetUser,
          metadata: { board: { validators: [{ signerId: targetUserSigner }] } },
        },
      ],
    } as Env['gossip'];
    const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    sourceHubState.prevFrameHash = 'genesis';
    targetHubState.prevFrameHash = 'genesis';
    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-runtime-output-roundtrip',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: addr('b1'),
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    });
    sourceHubState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    addReplica(env, sourceHubState, sourceHubSigner);
    addReplica(env, targetHubState, targetHubSigner);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    const sourceReplica = env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;

    const sourceCommit = await applyEntityInput(env, sourceReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [{
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: prepared },
      }],
    });
    expect(sourceCommit.outcome.kind).toBe('committed');
    expect(sourceCommit.outputs).toHaveLength(2);
    const localOutput = sourceCommit.outputs.find(output => output.entityId === targetHub)!;
    expect(localOutput.entityId).toBe(targetHub);
    expect(localOutput.certifiedOutputIdentity).toBeUndefined();
    expect(localOutput.entityTxs?.map(tx => tx.type)).toEqual(['runtimeOutput']);
    const runtimeOutput = localOutput.entityTxs?.[0];
    if (runtimeOutput?.type !== 'runtimeOutput') throw new Error('TEST_RUNTIME_OUTPUT_REQUIRED');
    expect(Object.keys(runtimeOutput.data).sort()).toEqual([
      'entityTxs',
      'protocol',
      'sourceEntityId',
      'targetEntityId',
    ]);
    expect(runtimeOutput.data.entityTxs.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);

    const targetReplica = env.eReplicas.get(`${targetHub}:${targetHubSigner}`)!;
    const targetCommit = await applyEntityInput(env, targetReplica, localOutput);
    expect(targetCommit.outcome.kind).toBe('committed');
    expect(targetCommit.newState.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash).toBe(intent.routeHash);
    expect(targetCommit.newState.accounts.get(targetUser)?.mempool.map(tx => tx.type)).toEqual(['pull_lock']);
    expect(targetCommit.newState.accounts.get(targetUser)?.pendingFrame).toBeUndefined();
    expect(targetCommit.outputs.flatMap(output => output.entityTxs ?? []).some(tx => tx.type === 'consensusOutput')).toBe(false);
    expect(selectCrossJOpeningAccountProposalTxs(
      env,
      targetCommit.newState,
      targetCommit.newState.accounts.get(targetUser)!,
    )).toBeNull();

    const sourceLocalOutput = sourceCommit.outputs.find(output => output.entityId === sourceHub)!;
    const sourceRegistration = await applyEntityInput(env, sourceCommit.workingReplica, sourceLocalOutput);
    env.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, sourceRegistration.workingReplica);
    env.eReplicas.set(`${targetHub}:${targetHubSigner}`, targetCommit.workingReplica);
    expect(selectCrossJOpeningAccountProposalTxs(
      env,
      targetCommit.newState,
      targetCommit.newState.accounts.get(targetUser)!,
    )).not.toBeNull();

    const sourceAccount = sourceRegistration.newState.accounts.get(sourceUser)!;
    sourceAccount.pendingFrame = {
      ...sourceAccount.currentFrame,
      height: sourceAccount.currentHeight + 1,
      accountTxs: structuredClone(sourceAccount.mempool),
    };
    const targetAccount = targetCommit.newState.accounts.get(targetUser)!;
    const laterTargetPull = structuredClone(targetAccount.mempool[0]);
    if (laterTargetPull?.type !== 'pull_lock' || !laterTargetPull.data.crossJurisdictionRoute) {
      throw new Error('TEST_CROSS_J_TARGET_PULL_REQUIRED');
    }
    laterTargetPull.data.crossJurisdiction.orderId = `${intent.orderId}-later`;
    laterTargetPull.data.crossJurisdictionRoute.orderId = `${intent.orderId}-later`;
    targetAccount.mempool.push(laterTargetPull);
    const selected = selectCrossJOpeningAccountProposalTxs(env, targetCommit.newState, targetAccount);
    expect(selected?.map(tx => tx.type)).toEqual(['pull_lock']);
    expect(selected?.[0]?.type === 'pull_lock' && selected[0].data.crossJurisdiction?.orderId)
      .toBe(intent.orderId);
    expect(targetAccount.mempool).toHaveLength(2);
  });

  test('hub sibling cascade commits both Entity frames in one Runtime input pass', async () => {
    const seed = 'cross-j-runtime-same-frame-cascade';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(env, sourceJ, targetJ);
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const targetHubSigner = registerTestSigner(env, seed, '2');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceUser = entity('6b');
    const targetUser = entity('6c');
    const targetUserSigner = addr('b3');
    const sourceUserSigner = addr('b4');
    env.gossip = {
      getProfiles: () => [
        {
          entityId: sourceUser,
          metadata: { board: { validators: [{ signerId: sourceUserSigner }] } },
        },
        {
          entityId: targetUser,
          metadata: { board: { validators: [{ signerId: targetUserSigner }] } },
        },
      ],
    } as Env['gossip'];
    const sourceState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    sourceState.prevFrameHash = 'genesis';
    targetState.prevFrameHash = 'genesis';
    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-runtime-same-frame-cascade',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    });
    sourceState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    addReplica(env, sourceState, sourceHubSigner);
    addReplica(env, targetState, targetHubSigner);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    const sourceHeight = sourceState.height;
    const targetHeight = targetState.height;

    const sourceInput: EntityInput = {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [{
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: prepared },
      }],
    };
    const reverseIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      routeHash: '',
      orderId: 'cross-j-runtime-same-frame-cascade-reverse',
      makerEntityId: targetUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      sourceSignerId: targetUserSigner,
      sourceHubSignerId: targetHubSigner,
      targetHubSignerId: sourceHubSigner,
      targetSignerId: sourceUserSigner,
      bookHubSignerId: targetHubSigner,
      source: {
        jurisdiction: jref(targetJ),
        entityId: targetUser,
        counterpartyEntityId: targetHub,
        tokenId: 1,
        amount: 900n,
      },
      target: {
        jurisdiction: jref(sourceJ),
        entityId: sourceHub,
        counterpartyEntityId: sourceUser,
        tokenId: 1,
        amount: 1_000n,
      },
    });
    const secondForwardIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      routeHash: '',
      orderId: 'cross-j-runtime-same-frame-cascade-forward-2',
    });
    const reversePrepared = buildPreparedCrossJurisdictionRoute(reverseIntent, {
      runtimeSeed: seed,
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    const reverseInput: EntityInput = {
      entityId: targetHub,
      signerId: targetHubSigner,
      entityTxs: [{
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: targetHubSigner, route: reversePrepared },
      }],
    };

    const saturatedEnv = createEmptyEnv(`${seed}-saturated-local-event`);
    saturatedEnv.timestamp = env.timestamp;
    saturatedEnv.quietRuntimeLogs = true;
    installJurisdictions(saturatedEnv, sourceJ, targetJ);
    registerTestSigner(saturatedEnv, seed, '1');
    registerTestSigner(saturatedEnv, seed, '2');
    saturatedEnv.gossip = env.gossip;
    saturatedEnv.eReplicas = new Map(
      [...env.eReplicas].map(([key, replica]) => [key, cloneEntityReplica(replica)]),
    );
    const saturatedTarget = saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)!;
    saturatedTarget.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => ({
      type: 'chatMessage' as const,
      data: { message: 'fills external target mempool', timestamp: saturatedEnv.timestamp },
    }));

    const saturated = await applyMergedEntityInputs(
      saturatedEnv,
      [sourceInput],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(saturated.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub]);
    const committedSaturatedTarget = saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)!.state;
    expect(committedSaturatedTarget.height).toBe(targetHeight + 1);
    expect(committedSaturatedTarget.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash).toBe(intent.routeHash);
    expect(saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.mempool).toHaveLength(LIMITS.MEMPOOL_SIZE);

    sourceState.crossJurisdictionSwaps?.set(secondForwardIntent.orderId, secondForwardIntent);
    targetState.crossJurisdictionSwaps?.set(reverseIntent.orderId, reverseIntent);
    const pass = await applyMergedEntityInputs(
      env,
      [sourceInput, reverseInput],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );

    expect(env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.height).toBe(sourceHeight + 4);
    expect(env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.height).toBe(targetHeight + 4);
    expect(env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash)
      .toBe(intent.routeHash);
    expect(pass.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub, targetHub]);
    expect(pass.localCrossJurisdictionEventTrace.map(input => input.entityId)).toEqual([
      sourceHub,
      targetHub,
      sourceHub,
      targetHub,
      targetHub,
      sourceHub,
    ]);
    const crossJOrderIds = (txs: readonly AccountTx[]): string[] => txs.flatMap(tx => {
      if (tx.type === 'pull_lock') return tx.data.crossJurisdiction?.orderId ?? [];
      if (tx.type === 'swap_offer') return tx.data.crossJurisdiction?.orderId ?? [];
      return [];
    });
    const registeredOrderIds = new Set([intent.orderId, secondForwardIntent.orderId, reverseIntent.orderId]);
    const sourceRegisteredAccount = env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!.state.accounts.get(sourceUser)!;
    const targetRegisteredAccount = env.eReplicas.get(`${targetHub}:${targetHubSigner}`)!.state.accounts.get(targetUser)!;
    expect(sourceRegisteredAccount.pendingFrame).toBeUndefined();
    expect(targetRegisteredAccount.pendingFrame).toBeUndefined();
    expect(new Set(crossJOrderIds(sourceRegisteredAccount.mempool))).toEqual(registeredOrderIds);
    expect(new Set(crossJOrderIds(targetRegisteredAccount.mempool))).toEqual(registeredOrderIds);
    expect(pass.entityOutbox).toEqual([]);

    const wakePass = await applyMergedEntityInputs(
      env,
      [
        { entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] },
        { entityId: targetHub, signerId: targetHubSigner, entityTxs: [] },
      ],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    const sourceAccount = env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!.state.accounts.get(sourceUser)!;
    const targetAccount = env.eReplicas.get(`${targetHub}:${targetHubSigner}`)!.state.accounts.get(targetUser)!;
    expect(new Set(crossJOrderIds(sourceAccount.pendingFrame?.accountTxs ?? []))).toEqual(registeredOrderIds);
    expect(new Set(crossJOrderIds(targetAccount.pendingFrame?.accountTxs ?? []))).toEqual(registeredOrderIds);
    expect(sourceAccount.mempool).toEqual([]);
    expect(targetAccount.mempool).toEqual([]);
    expect(env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.height).toBe(sourceHeight + 5);
    expect(env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.height).toBe(targetHeight + 5);
    expect(wakePass.entityOutbox.map(output => ({
      entityId: output.entityId,
      txTypes: output.entityTxs?.map(tx => tx.type) ?? [],
    })).sort((left, right) => left.entityId.localeCompare(right.entityId))).toEqual([
      {
        entityId: sourceUser,
        txTypes: ['consensusOutput'],
      },
      {
        entityId: targetUser,
        txTypes: ['consensusOutput'],
      },
    ].sort((left, right) => left.entityId.localeCompare(right.entityId)));
  });

  test('atomic opening applies two Hub proposals, then two User ACKs, with no receipt round trip', async () => {
    const seed = 'cross-j-atomic-opening';
    const userEnv = createEmptyEnv(`${seed}-user`);
    const hubEnv = createEmptyEnv(`${seed}-hub`);
    userEnv.timestamp = 10_000;
    hubEnv.timestamp = 10_000;
    userEnv.quietRuntimeLogs = true;
    hubEnv.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 8453, '21', '22');
    installJurisdictions(userEnv, sourceJ, targetJ);
    installJurisdictions(hubEnv, sourceJ, targetJ);

    const sourceUserSigner = registerTestSigner(userEnv, seed, 'source-user');
    const targetUserSigner = registerTestSigner(userEnv, seed, 'target-user');
    const sourceHubSigner = registerTestSigner(hubEnv, seed, 'source-hub');
    const targetHubSigner = registerTestSigner(hubEnv, seed, 'target-hub');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const targetUser = generateLazyEntityId([targetUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const sourceUserState = makeState(sourceUser, sourceUserSigner, sourceJ, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, targetJ, targetHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    sourceUserState.profile.name = 'source user';
    targetUserState.profile.name = 'target user';
    sourceHubState.profile.name = 'source hub';
    targetHubState.profile.name = 'target hub';
    sourceHubState.profile.isHub = true;
    targetHubState.profile.isHub = true;
    sourceHubState.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: sourceHub,
        name: 'source hub',
        spreadDistribution: {
          makerBps: 0,
          takerBps: 10_000,
          hubBps: 0,
          makerReferrerBps: 0,
          takerReferrerBps: 0,
        },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
    };
    for (const state of [sourceUserState, targetUserState, sourceHubState, targetHubState]) {
      state.prevFrameHash = 'genesis';
    }
    addReplica(userEnv, sourceUserState, sourceUserSigner);
    addReplica(userEnv, targetUserState, targetUserSigner);
    addReplica(hubEnv, sourceHubState, sourceHubSigner);
    addReplica(hubEnv, targetHubState, targetHubSigner);
    collectLocalProfileEncryptionAnnouncements(hubEnv, new Set([sourceHub, targetHub]));
    collectLocalProfileEncryptionAnnouncements(userEnv, new Set([sourceUser, targetUser]));
    const sourceHubProfile = buildLocalEntityProfile(hubEnv, sourceHubState);
    const targetHubProfile = buildLocalEntityProfile(hubEnv, targetHubState);
    const sourceUserProfile = buildLocalEntityProfile(userEnv, sourceUserState);
    const targetUserProfile = buildLocalEntityProfile(userEnv, targetUserState);
    userEnv.gossip = {
      getProfiles: () => [sourceHubProfile, targetHubProfile],
    } as typeof userEnv.gossip;
    hubEnv.gossip = {
      getProfiles: () => [sourceUserProfile, targetUserProfile],
    } as typeof hubEnv.gossip;

    const intent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-j-atomic-opening',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      bookHubSignerId: sourceHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'intent',
      createdAt: hubEnv.timestamp,
      updatedAt: hubEnv.timestamp,
      expiresAt: 70_000,
    });
    sourceHubState.crossJurisdictionSwaps?.set(intent.orderId, intent);
    const prepared = buildPreparedCrossJurisdictionRoute(intent, {
      runtimeSeed: seed,
      sourceDisputeDelayMs: 5_000,
      now: hubEnv.timestamp,
    });

    const hubProposalPass = await applyMergedEntityInputs(hubEnv, [{
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [{
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: prepared },
      }],
    }], [], { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() });
    expect(hubProposalPass.entityOutbox).toEqual([]);
    const hubWakePass = await applyMergedEntityInputs(
      hubEnv,
      [
        { entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] },
        { entityId: targetHub, signerId: targetHubSigner, entityTxs: [] },
      ],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(hubWakePass.entityOutbox.map(output => output.entityId).sort()).toEqual([
      sourceUser,
      targetUser,
    ].sort());

    const hubOnlySourceAccount = hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!
      .state.accounts.get(sourceUser)!;
    const hubOnlyTargetAccount = hubEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)!
      .state.accounts.get(targetUser)!;
    expect(hubOnlySourceAccount.pendingFrame?.accountTxs.map(tx => tx.type))
      .toEqual(['pull_lock', 'swap_offer']);
    expect(hubOnlyTargetAccount.pendingFrame?.accountTxs.map(tx => tx.type)).toEqual(['pull_lock']);
    expect(hubOnlySourceAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlyTargetAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlySourceAccount.pulls?.has(prepared.sourcePull!.pullId) ?? false).toBe(false);
    expect(hubOnlySourceAccount.swapOffers.has(prepared.orderId)).toBe(false);
    expect(buildAccountProofBody(hubOnlySourceAccount, '').runtimeProofBody.transformers).toEqual([]);
    const hubOnlyResolve = await applyAccountTx(
      cloneAccountMachine(hubOnlySourceAccount),
      {
        type: 'pull_resolve',
        data: { pullId: prepared.sourcePull!.pullId, binary: '0x' },
      },
      prepared.sourcePull!.signedAmount > 0n,
      hubEnv.timestamp,
      hubOnlySourceAccount.currentFrame.height,
    );
    expect(hubOnlyResolve).toMatchObject({
      success: false,
      error: `Pull ${prepared.sourcePull!.pullId} not found`,
    });

    const hubFrame = { height: 42, timestamp: hubEnv.timestamp };
    const proposals = hubWakePass.entityOutbox.map(output => ({
      ...output,
      from: hubEnv.runtimeId,
      runtimeId: userEnv.runtimeId,
      sourceRuntimeFrame: hubFrame,
    }));
    const dedupedProposals = buildPendingNetworkOutputs([
      { ...proposals[0]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.timestamp - 1 } },
      { ...proposals[1]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.timestamp - 1 } },
      ...proposals,
    ]);
    expect(dedupedProposals).toHaveLength(2);
    expect(selectPotentialCrossJAccountInputPairs(dedupedProposals)).toHaveLength(1);
    const repeatedCohorts = [
      { ...proposals[0]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.timestamp - 1 } },
      { ...proposals[1]!, sourceRuntimeFrame: { height: 41, timestamp: hubEnv.timestamp - 1 } },
      ...proposals,
    ];
    expect(selectPotentialCrossJAccountInputPairs(repeatedCohorts)).toHaveLength(2);
    const atomicRepeatedCohorts = repeatedCohorts.map(input => {
      const frame = input.sourceRuntimeFrame!;
      const cohort = repeatedCohorts.filter(candidate =>
        candidate.sourceRuntimeFrame?.height === frame.height &&
        candidate.sourceRuntimeFrame.timestamp === frame.timestamp);
      const pairKey = selectPotentialCrossJAccountInputPairs(cohort)[0]!.pairKey;
      return { ...input, atomicCrossJurisdictionPair: { phase: 'proposal' as const, pairKey } };
    });
    const mergedRepeatedCohorts = mergeEntityInputs(atomicRepeatedCohorts);
    expect(mergedRepeatedCohorts).toHaveLength(4);
    expect(selectPotentialCrossJAccountInputPairs(mergedRepeatedCohorts)).toHaveLength(2);
    const reversedProposals = [...proposals].reverse();
    const structuralPair = selectPotentialCrossJAccountInputPairs(reversedProposals)[0]!;
    expect(validateInboundP2PEntityInputsEnvelope(
      userEnv,
      hubEnv.runtimeId!,
      {
        sourceRuntimeId: hubEnv.runtimeId!,
        sourceRuntimeHeight: hubFrame.height,
        sourceRuntimeTimestamp: hubFrame.timestamp,
        atomicCrossJurisdictionPair: { phase: 'proposal', pairKey: structuralPair.pairKey },
        entityInputs: reversedProposals.map(({ from: _from, sourceRuntimeFrame: _frame, ...input }) => input),
      },
      makeLocalCrossJRoutingDeps(),
    )).toHaveLength(2);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!]).inputs).toEqual([]);
    const ordinaryUserInput = { entityId: sourceUser, signerId: sourceUserSigner, entityTxs: [] };
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!, ordinaryUserInput]).inputs)
      .toEqual([ordinaryUserInput]);
    const proposalSelection = selectMatchedCrossJAccountInputPairs(userEnv, proposals);
    expect(proposalSelection.pairs.map(pair => pair.phase)).toEqual(['proposal']);
    expect(proposalSelection.droppedInputIndexes).toEqual([]);

    const proposalFrame = (input: RoutedEntityInput) => {
      const accountInput = getEffectiveEntityInputTxs(input).flatMap(tx =>
        tx.type === 'accountInput' ? [tx.data] : [])[0];
      const proposal = accountInput ? accountInputProposal(accountInput) : undefined;
      if (!proposal) throw new Error(`TEST_CROSS_J_PROPOSAL_MISSING:${input.entityId}`);
      return proposal;
    };
    const targetPull = (inputs: RoutedEntityInput[]) => {
      const targetInput = inputs.find(input => input.entityId === targetUser);
      const pull = targetInput && proposalFrame(targetInput).frame.accountTxs.find(tx =>
        tx.type === 'pull_lock' && tx.data.crossJurisdiction?.leg === 'target');
      if (!pull || pull.type !== 'pull_lock') throw new Error('TEST_CROSS_J_TARGET_PULL_MISSING');
      return pull;
    };
    const corruptions: Array<{
      name: string;
      mutate(inputs: RoutedEntityInput[]): void;
    }> = [
      {
        name: 'cohort frame',
        mutate: inputs => { inputs[1]!.sourceRuntimeFrame!.height += 1; },
      },
      {
        name: 'route hash',
        mutate: inputs => { targetPull(inputs).data.crossJurisdiction!.routeHash = `0x${'f1'.repeat(32)}`; },
      },
      {
        name: 'target entity',
        mutate: inputs => {
          targetPull(inputs).data.crossJurisdictionRoute!.target.counterpartyEntityId = entity('ee');
        },
      },
      {
        name: 'asset',
        mutate: inputs => { targetPull(inputs).data.tokenId += 1; },
      },
      {
        name: 'amount',
        mutate: inputs => { targetPull(inputs).data.amount += 1n; },
      },
      {
        name: 'full hash',
        mutate: inputs => { targetPull(inputs).data.fullHash = `0x${'f2'.repeat(32)}`; },
      },
      {
        name: 'partial root',
        mutate: inputs => { targetPull(inputs).data.partialRoot = `0x${'f3'.repeat(32)}`; },
      },
      {
        name: 'pull id',
        mutate: inputs => { targetPull(inputs).data.pullId = 'corrupt-target-pull'; },
      },
      {
        name: 'deadline',
        mutate: inputs => { targetPull(inputs).data.revealedUntilTimestamp += 1; },
      },
      {
        name: 'account Hanko',
        mutate: inputs => { proposalFrame(inputs[1]!).frameHanko = '0x00'; },
      },
    ];
    for (const corruption of corruptions) {
      const corrupted = cloneIsolatedRoutedEntityInputs(proposals);
      corruption.mutate(corrupted);
      const replicasBefore = [...userEnv.eReplicas.entries()].map(([key, replica]) =>
        [key, cloneEntityReplica(replica)] as const);
      const incidentsBefore = [...(userEnv.runtimeState?.securityIncidents?.values() ?? [])]
        .reduce((sum, incident) => sum + incident.occurrences, 0);
      const rejected = await prepareAtomicCrossJAccountInputs(
        userEnv,
        [...corrupted, ordinaryUserInput],
        [],
        false,
        makeLocalCrossJRoutingDeps(),
      );
      expect(rejected.pairs, corruption.name).toEqual([]);
      expect(rejected.inputs, corruption.name).toEqual([ordinaryUserInput]);
      expect([...userEnv.eReplicas.entries()], corruption.name).toEqual(replicasBefore);
      const incidentsAfter = [...(userEnv.runtimeState?.securityIncidents?.values() ?? [])]
        .reduce((sum, incident) => sum + incident.occurrences, 0);
      expect(incidentsAfter, corruption.name)
        .toBeGreaterThan(incidentsBefore);
    }

    const validThenCorruptCohorts = cloneIsolatedRoutedEntityInputs(atomicRepeatedCohorts);
    const corruptNewestTarget = validThenCorruptCohorts.find(input =>
      input.entityId === targetUser && input.sourceRuntimeFrame?.height === hubFrame.height);
    if (!corruptNewestTarget) throw new Error('TEST_CROSS_J_NEWEST_TARGET_COHORT_MISSING');
    corruptNewestTarget.sourceRuntimeFrame!.height += 1;
    const retainedOlderCohort = await prepareAtomicCrossJAccountInputs(
      userEnv,
      validThenCorruptCohorts,
      [],
      false,
      makeLocalCrossJRoutingDeps(),
    );
    expect(retainedOlderCohort.pairs).toHaveLength(1);
    expect(retainedOlderCohort.inputs).toHaveLength(2);
    expect(retainedOlderCohort.inputs.every(input => input.sourceRuntimeFrame?.height === 41)).toBe(true);

    const preparedUserInputs = await prepareAtomicCrossJAccountInputs(
      userEnv,
      proposals,
      [],
      false,
      makeLocalCrossJRoutingDeps(),
    );
    const userAckPass = await applyMergedEntityInputs(
      userEnv,
      mergeEntityInputs(preparedUserInputs.inputs),
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(userAckPass.entityOutbox.map(output => output.entityId).sort()).toEqual([
      sourceHub,
      targetHub,
    ].sort());
    expect(userAckPass.entityOutbox.flatMap(output => output.entityTxs ?? []).every(tx =>
      tx.type === 'consensusOutput' && tx.data.entityTxs.every(inner =>
        inner.type === 'accountInput' && (inner.data.kind === 'ack' || inner.data.kind === 'frame_ack')),
    )).toBe(true);
    expect(userAckPass.localCrossJurisdictionEventTrace).toEqual([]);

    const userFrame = { height: 43, timestamp: userEnv.timestamp };
    const acknowledgements = userAckPass.entityOutbox.map(output => ({
      ...output,
      from: userEnv.runtimeId,
      runtimeId: hubEnv.runtimeId,
      sourceRuntimeFrame: userFrame,
      atomicCrossJurisdictionPair: {
        phase: 'ack' as const,
        pairKey: proposalSelection.pairs[0]!.pairKey,
      },
    }));
    const acknowledgement = (input: RoutedEntityInput) => {
      const accountInput = getEffectiveEntityInputTxs(input).flatMap(tx =>
        tx.type === 'accountInput' ? [tx.data] : [])[0];
      const ack = accountInput ? accountInputAck(accountInput) : undefined;
      if (!accountInput || !ack) throw new Error(`TEST_CROSS_J_ACK_MISSING:${input.entityId}`);
      return { accountInput, ack };
    };
    const ackCorruptions: Array<{
      name: string;
      mutate(inputs: RoutedEntityInput[]): void;
    }> = [
      {
        name: 'ACK cohort frame',
        mutate: inputs => { inputs[1]!.sourceRuntimeFrame!.height += 1; },
      },
      {
        name: 'ACK height',
        mutate: inputs => { acknowledgement(inputs[1]!).ack.height += 1; },
      },
      {
        name: 'ACK frame hash',
        mutate: inputs => { acknowledgement(inputs[1]!).ack.frameHash = `0x${'f4'.repeat(32)}`; },
      },
      {
        name: 'ACK Hanko',
        mutate: inputs => { acknowledgement(inputs[1]!).ack.frameHanko = '0x00'; },
      },
      {
        name: 'ACK sender entity',
        mutate: inputs => { acknowledgement(inputs[1]!).accountInput.fromEntityId = entity('ef'); },
      },
      {
        name: 'ACK domain',
        mutate: inputs => { acknowledgement(inputs[1]!).accountInput.domain.chainId += 1; },
      },
    ];
    const ordinaryHubInput = { entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] };
    for (const corruption of ackCorruptions) {
      const corrupted = cloneIsolatedRoutedEntityInputs(acknowledgements);
      corruption.mutate(corrupted);
      const replicasBefore = [...hubEnv.eReplicas.entries()].map(([key, replica]) =>
        [key, cloneEntityReplica(replica)] as const);
      const incidentsBefore = [...(hubEnv.runtimeState?.securityIncidents?.values() ?? [])]
        .reduce((sum, incident) => sum + incident.occurrences, 0);
      const rejected = await prepareAtomicCrossJAccountInputs(
        hubEnv,
        [...corrupted, ordinaryHubInput],
        [],
        false,
        makeLocalCrossJRoutingDeps(),
      );
      expect(rejected.pairs, corruption.name).toEqual([]);
      expect(rejected.inputs, corruption.name).toEqual([ordinaryHubInput]);
      expect([...hubEnv.eReplicas.entries()], corruption.name).toEqual(replicasBefore);
      const incidentsAfter = [...(hubEnv.runtimeState?.securityIncidents?.values() ?? [])]
        .reduce((sum, incident) => sum + incident.occurrences, 0);
      expect(incidentsAfter, corruption.name).toBeGreaterThan(incidentsBefore);
    }
    const queuedIntent = withCanonicalCrossJurisdictionRouteHash({
      ...cloneCrossJurisdictionRoute(intent),
      orderId: 'cross-j-atomic-opening-next',
      routeHash: '',
      status: 'intent',
      sourcePull: undefined,
      targetPull: undefined,
    });
    const sourceHubReplica = hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    sourceHubReplica.state.crossJurisdictionSwaps?.set(queuedIntent.orderId, queuedIntent);
    const queuedMaterialization = appendDefaultProposerCrossJMaterializations(hubEnv, sourceHubReplica, []);
    expect(queuedMaterialization.map(tx => tx.type)).toEqual(['materializeCrossJurisdictionSwap']);
    const queuedCommands = prepareLocallyAuthoredEntityTxs(
      hubEnv,
      sourceHubReplica.state,
      sourceHubSigner,
      queuedMaterialization,
    );
    sourceHubReplica.mempool.push(...queuedCommands);
    const sourceAckInput = acknowledgements.find(input => input.entityId === sourceHub)!;
    const ackPhaseTxs = appendDefaultProposerCrossJMaterializations(
      hubEnv,
      sourceHubReplica,
      sourceAckInput.entityTxs ?? [],
    );
    expect(ackPhaseTxs).toEqual(sourceAckInput.entityTxs);
    expect(ackPhaseTxs.some(tx => tx.type === 'materializeCrossJurisdictionSwap')).toBe(false);
    const phaseSelection = selectCrossJCommitPhaseTxs([
      ...sourceHubReplica.mempool,
      ...(sourceAckInput.entityTxs ?? []),
    ]);
    expect(phaseSelection.deferredCrossJSetup).toBe(true);
    expect(phaseSelection.txs).toEqual(sourceAckInput.entityTxs);
    expect(selectMatchedCrossJAccountInputPairs(hubEnv, [acknowledgements[0]!]).inputs).toEqual([]);
    const ackSelection = selectMatchedCrossJAccountInputPairs(hubEnv, acknowledgements);
    expect(ackSelection.pairs.map(pair => pair.phase)).toEqual(['ack']);
    expect(ackSelection.droppedInputIndexes).toEqual([]);

    const preparedHubInputs = await prepareAtomicCrossJAccountInputs(
      hubEnv,
      acknowledgements,
      [],
      false,
      makeLocalCrossJRoutingDeps(),
    );
    const hubAckPass = await applyMergedEntityInputs(
      hubEnv,
      mergeEntityInputs(preparedHubInputs.inputs),
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.accounts
      .get(sourceUser)?.currentFrame.accountTxs.map(tx => tx.type)).toEqual(['pull_lock', 'swap_offer']);
    expect(hubEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.accounts
      .get(targetUser)?.currentFrame.accountTxs.map(tx => tx.type)).toEqual(['pull_lock']);
    expect(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.orderbookExt?.books.size).toBe(1);
    expect(hubAckPass.entityOutbox).toEqual([]);
    expect(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.mempool
      .some(entityTxContainsCrossJMaterialization)).toBe(true);
    const retainedProposalCohort = rescheduleDeferredOutputs(
      hubEnv,
      [],
      proposals,
      [],
      makeLocalCrossJRoutingDeps(),
    );
    expect(retainedProposalCohort).toHaveLength(2);
    expect(pruneReceiptedReliableOutputs(hubEnv, retainedProposalCohort)).toEqual([]);
    expect(hubEnv.runtimeState?.deferredNetworkMeta?.size).toBe(0);
  });

  test('submitCrossJurisdictionSwap queues hub prepare, then prepare builds symmetric pull commitments', async () => {
    const env = createEmptyEnv('cross-submit');
    const hubEnv = createEmptyEnv('cross-submit-hub-runtime');
    env.scenarioMode = true;
    hubEnv.scenarioMode = true;
    env.timestamp = 10_000;
    hubEnv.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    hubEnv.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    installJurisdictions(hubEnv, eth, base);
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
    const sourceUserSigner = registerTestSigner(env, 'cross-submit', 'source-user');
    const targetUserSigner = registerTestSigner(env, 'cross-submit', 'target-user');
    const sourceHubSigner = registerTestSigner(hubEnv, 'cross-submit', 'source-hub');
    const targetHubSigner = registerTestSigner(hubEnv, 'cross-submit', 'target-hub');
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, base, targetHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    sourceHubState.profile.isHub = true;
    targetHubState.profile.isHub = true;
    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, targetUserState, targetUserSigner);
    addReplica(hubEnv, sourceHubState, sourceHubSigner);
    addReplica(hubEnv, targetHubState, targetHubSigner);
    const routingDeps = makeLocalCrossJRoutingDeps();
    registerEntityRuntimeHint(env, sourceHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHint(env, targetHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHint(hubEnv, sourceUser, env.runtimeId!, routingDeps);
    registerEntityRuntimeHint(hubEnv, targetUser, env.runtimeId!, routingDeps);
    let directAttempts = 0;
    let relayAttempts = 0;
    env.runtimeState!.directEntityInputsDispatch = targetRuntimeId => {
      expect(targetRuntimeId).toBe(hubEnv.runtimeId);
      directAttempts += 1;
      return deliveryDeferred({ outcome: 'deferred', code: 'ROUTE_DIRECT_MISS_FALLBACK' });
    };
    env.runtimeState!.p2p = {
      enqueueEntityInputsDelivery: (targetRuntimeId: string, envelope: RuntimeEntityInputsEnvelope) => {
        expect(targetRuntimeId).toBe(hubEnv.runtimeId);
        relayAttempts += 1;
        handleInboundP2PEntityInputs(hubEnv, env.runtimeId!, envelope);
        return deliveryAccepted('TEST_UNSIGNED_CROSS_J_INTENT_RELAYED');
      },
    } as any;

    const submitParams = {
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
    } as const;
    const result = await submitCrossJurisdictionSwap(env, submitParams);
    await submitCrossJurisdictionSwap(env, submitParams);
    expect(hubEnv.runtimeMempool?.entityInputs).toHaveLength(1);
    await expect(submitCrossJurisdictionSwap(env, {
      ...submitParams,
      targetAmount: 91n,
    })).rejects.toThrow('INBOUND_CROSS_J_INTENT_ORDER_ID_CONFLICT');
    expect(directAttempts).toBe(3);
    expect(relayAttempts).toBe(3);
    expect([...hubEnv.runtimeState!.securityIncidents!.values()].map(incident => incident.code))
      .toContain('CROSS_J_INTENT_ORDER_ID_CONFLICT');

    const queued = hubEnv.runtimeMempool?.entityInputs ?? [];
    expect(result.hashlock).toBeUndefined();
    expect(result.secret).toBeUndefined();
    expect(result.route.routeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.route.source.jurisdiction).toBe(jref(eth));
    expect(result.route.target.jurisdiction).toBe(jref(base));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.entityId).toBe(sourceHub);
    expect(queued[0]?.from).toBeUndefined();
    expect(queued[0]?.sourceRuntimeFrame).toBeUndefined();
    expect(queued[0]?.entityTxs?.[0]?.type).toBe('prepareCrossJurisdictionSwap');
    expect(env.runtimeMempool?.entityInputs).toEqual([]);

    sourceHubState.timestamp = hubEnv.timestamp;
    const requested = await applyEntityTx(hubEnv, sourceHubState, queued[0]!.entityTxs![0]!);
    expect(requested.outputs).toEqual([{ entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] }]);
    expect(requested.mempoolOps).toBeUndefined();
    const sourceHubReplica = {
      ...(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica),
      state: requested.newState,
    };
    const materialized = appendDefaultProposerCrossJMaterializations(hubEnv, sourceHubReplica, []);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.type).toBe('materializeCrossJurisdictionSwap');
    const prepared = await applyEntityTx(hubEnv, requested.newState, materialized[0]!);
      expect(prepared.mempoolOps).toBeUndefined();
      expect(prepared.outputs).toHaveLength(2);
      const sourceHubOutput = prepared.outputs.find(output => output.entityId === sourceHub);
      const targetHubOutput = prepared.outputs.find(output => output.entityId === targetHub);
      const targetUserOutput = prepared.outputs.find(output => output.entityId === targetUser);
      const sourceUserOutput = prepared.outputs.find(output => output.entityId === sourceUser);
      expect(sourceHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);
      expect(targetHubOutput?.entityTxs?.map(tx => tx.type)).toEqual(['registerCrossJurisdictionSwap']);
      expect(targetUserOutput).toBeUndefined();
      expect(sourceUserOutput).toBeUndefined();
      const preparedRoute = (targetHubOutput?.entityTxs?.[0]?.data as any).route;
      expect(preparedRoute.routeHash).toBe(result.route.routeHash);
      expect(deriveCrossJurisdictionRouteHash(preparedRoute)).toBe(preparedRoute.routeHash);
      expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
      expect(preparedRoute.sourcePull.partialRoot).toBe(preparedRoute.targetPull.partialRoot);
      const sourceRegistration = await applyEntityTx(hubEnv, prepared.newState, sourceHubOutput!.entityTxs![0]!);
      const targetRegistration = await applyEntityTx(hubEnv, targetHubState, targetHubOutput!.entityTxs![0]!);
      expect(sourceRegistration.mempoolOps?.map(op => op.tx.type)).toEqual(['pull_lock', 'swap_offer']);
      expect(targetRegistration.mempoolOps?.map(op => op.tx.type)).toEqual(['pull_lock']);
      expect((targetRegistration.mempoolOps?.[0]?.tx as any).data.crossJurisdiction).toMatchObject({
        orderId: preparedRoute.orderId,
        routeHash: preparedRoute.routeHash,
        leg: 'target',
      });
      expect(preparedRoute.targetPull.revealedUntilTimestamp - preparedRoute.sourcePull.revealedUntilTimestamp)
        .toBeGreaterThanOrEqual(5_000 + CROSS_J_TARGET_REVEAL_SAFETY_MS);
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
    sourceHubState.timestamp = env.timestamp;
    sourceUserState.timestamp = env.timestamp;
    addReplica(env, sourceHubState, addr('ae'));
    addReplica(env, sourceUserState, addr('af'));
    addReplica(env, targetHubState, addr('b0'));
    addReplica(env, targetUserState, addr('b1'));
    const staleIntent = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-prepared-routehash-immutable',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceSignerId: addr('af'),
      sourceHubSignerId: addr('ae'),
      targetHubSignerId: addr('b0'),
      targetSignerId: addr('b1'),
      bookHubSignerId: addr('ae'),
      source: { jurisdiction: jref(sourceUserAliasJurisdiction), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 2, amount: 1_000n },
      target: { jurisdiction: jref(targetJurisdiction), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'intent',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    });

    const rawPreparedResult = await applyEntityTx(env, sourceHubState, {
      type: 'prepareCrossJurisdictionSwap',
      data: { route: staleIntent },
    });
    const hubPreparedRoute = buildPreparedCrossJurisdictionRoute(staleIntent, {
      runtimeSeed: env.runtimeSeed,
      sourceDisputeDelayMs: committedCrossJSourceDisputeDelayMs(rawPreparedResult.newState, staleIntent),
      now: env.timestamp,
    });
    const preparedResult = await applyEntityTx(env, rawPreparedResult.newState, {
      type: 'materializeCrossJurisdictionSwap',
      data: { proposerSignerId: addr('ae'), route: hubPreparedRoute },
    });
      const sourceHubOutput = preparedResult.outputs.find(output => output.entityId === sourceHub);
      const targetHubOutput = preparedResult.outputs.find(output => output.entityId === targetHub);
      const preparedRoute = (targetHubOutput?.entityTxs?.find(tx => tx.type === 'registerCrossJurisdictionSwap')?.data as any)?.route;
      expect(preparedRoute.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
      expect(preparedRoute.routeHash).toBe(staleIntent.routeHash);
      expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    const sourceRegistration = await applyEntityTx(
      env,
      preparedResult.newState,
      sourceHubOutput!.entityTxs![0]!,
    );
    const sourcePullTx = sourceRegistration.mempoolOps?.find(op => op.tx.type === 'pull_lock')?.tx as
      | Extract<AccountTx, { type: 'pull_lock' }>
      | undefined;
    const swapOfferTx = sourceRegistration.mempoolOps?.find(op => op.tx.type === 'swap_offer')?.tx as
      | Extract<AccountTx, { type: 'swap_offer' }>
      | undefined;
    expect(sourcePullTx?.data.crossJurisdictionRoute?.routeHash).toBe(preparedRoute.routeHash);
    expect(swapOfferTx?.data.crossJurisdiction?.routeHash).toBe(preparedRoute.routeHash);
    expect(swapOfferTx?.data.crossJurisdiction?.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(swapOfferTx?.data.crossJurisdiction?.sourcePull?.fullHash).toBe(preparedRoute.sourcePull.fullHash);

      const clearingHubState = sourceRegistration.newState;
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
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(env, {
      entityId: sourceHub,
      signerId: addr('ae'),
      state: clearResult.newState,
      mempool: [],
    } as EntityReplica, []);
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const materializedClear = await applyEntityTx(env, clearResult.newState, clearMaterialization!);
    const resolveTx = materializedClear.mempoolOps?.find(op => op.tx.type === 'cross_pull_close')?.tx as any;
    expect(resolveTx?.data.pullId).toBe(clearingRoute.sourcePull.pullId);
    expect(resolveTx?.data.proof.routeHash).toBe(clearingRoute.routeHash);
    expect(() => verifyHashLadderBinary({
      fullHash: clearingRoute.sourcePull.fullHash,
      partialRoot: clearingRoute.sourcePull.partialRoot,
    }, resolveTx.data.binary)).not.toThrow();
  });

  test('cross-j clear request can advance directly to source claimed after committed pull resolve', () => {
    expect(isCrossJurisdictionRouteTransitionAllowed('clear_requested', 'source_claimed')).toBe(true);
    expect(isCrossJurisdictionRouteTransitionAllowed('clear_requested', 'settled')).toBe(false);
  });

  test('cross-j clear treats exact-only committed fill as pending before live offer cancel', async () => {
    const env = createEmptyEnv('cross-clear-exact-only-pending');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a7');
    const sourceHub = entity('a8');
    const targetHub = entity('a9');
    const targetUser = entity('aa');
    const sourceHubSigner = addr('ab');
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-clear-exact-only-pending',
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
      fillNumerator: 1n,
      fillDenominator: 2n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: Number(route.source.tokenId),
      giveAmount: BigInt(route.source.amount),
      wantTokenId: Number(route.target.tokenId),
      wantAmount: BigInt(route.target.amount),
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId },
    });

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.mempoolOps?.[0]?.tx as any).data.cumulativeFillRatio).toBe(32_768);
    expect((result.mempoolOps?.[0]?.tx as any).data.cumulativeSourceAmount).toBe(500n);
    expect((result.mempoolOps?.[0]?.tx as any).data.cumulativeTargetAmount).toBe(450n);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    expect(result.newState.messages.at(-1)).not.toContain('no pending fill');
  });

  test('source pull resolve accepts exact-only committed binding proof ratio', async () => {
    const env = createEmptyEnv('cross-source-resolve-exact-only-binding');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('ac');
    const sourceHub = entity('ad');
    const targetHub = entity('ae');
    const targetUser = entity('af');
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-resolve-exact-only-binding',
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
      status: 'clear_requested' as const,
      fillSeq: 1,
      fillNumerator: 1n,
      fillDenominator: 2n,
    };
    const account = makeAccount(sourceUser, sourceHub);
    const sourcePull = route.sourcePull!;
    const absAmount = sourcePull.signedAmount >= 0n ? sourcePull.signedAmount : -sourcePull.signedAmount;
    const beneficiaryIsLeft = sourcePull.signedAmount > 0n;
    const payerIsLeft = !beneficiaryIsLeft;
    const delta = account.deltas.get(sourcePull.tokenId) ?? createDefaultDelta(sourcePull.tokenId);
    account.deltas.set(sourcePull.tokenId, delta);
    if (payerIsLeft) delta.leftHold = absAmount;
    else delta.rightHold = absAmount;
    account.pulls = new Map([[sourcePull.pullId, {
      pullId: sourcePull.pullId,
      tokenId: sourcePull.tokenId,
      amount: sourcePull.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
      fullHash: sourcePull.fullHash,
      partialRoot: sourcePull.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);
    const binary = buildCrossJurisdictionPullReveal(
      route,
      32_768,
      deriveCrossJurisdictionPrivateSeed(env.runtimeSeed, route),
    ).binary;

    const result = await applyAccountTx(account, {
      type: 'pull_resolve',
      data: { pullId: sourcePull.pullId, binary },
    }, beneficiaryIsLeft, env.timestamp, 1);

    expect(result.success, result.error).toBe(true);
    expect(account.pulls?.get(sourcePull.pullId)?.claimedRatio).toBe(32_768);
    expect(account.pulls?.get(sourcePull.pullId)?.claimedAmount).toBe(500n);
  });

  test('source Account copies split book cleanup from the user-sibling close relay', () => {
    const hubEnv = createEmptyEnv('cross-source-close-hub-runtime');
    const userEnv = createEmptyEnv('cross-source-close-user-runtime');
    hubEnv.timestamp = 10_000;
    userEnv.timestamp = 10_000;
    hubEnv.quietRuntimeLogs = true;
    userEnv.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a1');
    const sourceHub = entity('a2');
    const targetHub = entity('a3');
    const targetUser = entity('a4');
    const sourceHubSigner = addr('a5');
    const targetUserSigner = addr('a6');
    const sourceUserSigner = addr('a7');
    const targetHubSigner = addr('a8');
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, base, targetHub);
    addReplica(hubEnv, sourceHubState, sourceHubSigner);
    addReplica(hubEnv, targetHubState, targetHubSigner);
    addReplica(userEnv, sourceUserState, sourceUserSigner);
    addReplica(userEnv, targetUserState, targetUserSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-hub-relay',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetUserSigner,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: hubEnv.timestamp,
      updatedAt: hubEnv.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-source-hub-relay-seed', sourceDisputeDelayMs: 5_000, now: hubEnv.timestamp });
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
    sourceUserState.crossJurisdictionSwaps?.set(filledRoute.orderId, cloneCrossJurisdictionRoute(filledRoute));
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-source-hub-relay-seed', filledRoute);
    const binary = buildCrossJurisdictionPullReveal(filledRoute, 0x8000, privateSeed).binary;
    const hubOutputs: EntityInput[] = [];
    const userOutputs: EntityInput[] = [];
    const committedResolve: Extract<AccountTx, { type: 'pull_resolve' }> = {
      type: 'pull_resolve',
      data: {
        pullId: filledRoute.sourcePull!.pullId,
        binary,
      },
    };

    const hubHandled = applyCommittedCrossJurisdictionAccountTxFollowup(
      hubEnv,
      sourceHubState,
      sourceUser,
      committedResolve,
      hubOutputs,
      hubEnv.timestamp,
      [],
    );
    const userHandled = applyCommittedCrossJurisdictionAccountTxFollowup(
      userEnv,
      sourceUserState,
      sourceHub,
      committedResolve,
      userOutputs,
      userEnv.timestamp,
      [],
    );

    expect(hubHandled).toBe(true);
    expect(userHandled).toBe(true);
    expect(sourceHubState.crossJurisdictionSwaps?.get(filledRoute.orderId)?.status).toBe('source_claimed');
    expect(sourceUserState.crossJurisdictionSwaps?.get(filledRoute.orderId)?.status).toBe('source_claimed');
    expect(hubOutputs).toEqual([]);
    expect(userOutputs).toHaveLength(1);
    const targetOutput = userOutputs[0];
    expect(targetOutput?.entityId).toBe(targetUser);
    expect(targetOutput?.signerId).toBe(targetUserSigner);
    expect(targetOutput?.localRuntimeProtocol).toBe('cross-j');
    expect(targetOutput?.entityTxs?.map(tx => tx.type)).toEqual(['crossPullClose']);
    const closeTx = targetOutput?.entityTxs?.[0];
    if (closeTx?.type !== 'crossPullClose') throw new Error('TEST_CROSS_J_CLOSE_OUTPUT_REQUIRED');
    expect(closeTx.data.counterpartyEntityId).toBe(targetHub);
    expect(closeTx.data.pullId).toBe(filledRoute.targetPull!.pullId);
    expect(closeTx.data.binary).toBe(binary);
    expect(closeTx.data.proof.fillRatio).toBe(0x8000);
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
    const sourceUserSigner = addr('ae');
    const targetUserSigner = addr('af');
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const targetUserState = makeState(targetUser, targetUserSigner, base, targetHub);
    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, targetUserState, targetUserSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-delayed-fill-ack',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceUserSigner,
      targetSignerId: targetUserSigner,
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
    const outputs: EntityInput[] = [];

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceUserState, sourceHub, {
      type: 'pull_resolve',
      data: {
        pullId: clearingRoute.sourcePull!.pullId,
        binary,
      },
    }, outputs, env.timestamp, [])).toBe(true);

    const updated = sourceUserState.crossJurisdictionSwaps?.get(clearingRoute.orderId);
    expect(updated?.status).toBe('source_claimed');
    expect(updated?.fillSeq).toBe(1);
    expect(updated?.cumulativeFillRatio).toBe(0x8000);
    expect(updated?.claimedRatio).toBe(0x8000);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(targetUser);
    expect(outputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['crossPullClose']);
  });

  test('committed exact-only terminal fill ack routes clear without book progress fallback', () => {
    const seed = 'cross-exact-only-terminal-fill-followup-seed';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHubSigner = registerTestSigner(env, seed, '1');
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    addReplica(env, sourceHubState, sourceHubSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-exact-only-terminal-fill-followup',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.timestamp });
    sourceHubState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 1_000n,
        incrementalTargetAmount: 900n,
        cumulativeSourceAmount: 1_000n,
        cumulativeTargetAmount: 900n,
        cumulativeFillRatio: 0,
        fillNumerator: 1n,
        fillDenominator: 1n,
        executionSourceAmount: 1_000n,
        executionTargetAmount: 900n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: route.venueId || '',
      },
    };
    const outputs: EntityInput[] = [];

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceHubState,
      sourceUser,
      ackTx,
      outputs,
    )).toBe(true);

    const updated = sourceHubState.crossJurisdictionSwaps?.get(route.orderId);
    expect(updated?.status).toBe('clear_requested');
    expect(updated?.cumulativeFillRatio).toBe(65_535);
    expect(updated?.fillNumerator).toBe(1n);
    expect(updated?.fillDenominator).toBe(1n);
    expect(outputs.some(output =>
      output.entityId === sourceHub &&
      output.entityTxs?.some(tx => tx.type === 'requestCrossJurisdictionClear'),
    )).toBe(true);
    expect(outputs.some(output =>
      output.entityTxs?.some(tx => tx.type === 'applyCrossJurisdictionBookProgress'),
    )).toBe(false);
  });

  test('target pull settlement does not duplicate source-side book removal', () => {
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
      bookOwnerEntityId: sourceHub,
      sourceHubSignerId: addr('af'),
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
    expect(outputs).toHaveLength(0);
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
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-delayed-fill-ack',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      sourceHubSignerId: addr('af'),
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
    const sourceUserState = makeState(sourceUser, addr('c5'), eth, sourceHub);
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

    const result = await applyEntityTx(env, sourceUserState, {
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: sourceHub,
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

  test('cross-j offer maker is always the entity/frame proposer', async () => {
    const env = createEmptyEnv('cross-maker-authority');
    env.scenarioMode = true;
    env.timestamp = 1_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c6');
    const sourceHub = entity('c7');
    const targetHub = entity('c8');
    const targetUser = entity('c9');
    const sourceUserState = makeState(sourceUser, addr('ca'), eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-forged-maker',
      makerEntityId: sourceHub,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-forged-maker', sourceDisputeDelayMs: 5_000, now: 1_000 });

    await expect(applyEntityTx(env, sourceUserState, {
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: sourceHub,
        offerId: route.orderId,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        crossJurisdiction: route,
      },
    })).rejects.toThrow('CROSS_J_SWAP_MAKER_NOT_PROPOSER');
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
      const route = {
        ...preparedRoute,
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
    const result = await applyAccountTx(account, {
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

    test('account layer rejects source pull reveal before clear', async () => {
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
      const result = await applyAccountTx(account, {
        type: 'pull_resolve',
        data: { pullId: route.sourcePull!.pullId, binary },
      }, route.sourcePull!.signedAmount > 0n, 2_000, 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('CROSS_J_SOURCE_PULL_RESOLVE_BEFORE_CLEAR');
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

  test('route hash binds domain, settlement policy, and time policy', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6a');
    const sourceHub = entity('6b');
    const targetHub = entity('6c');
    const targetUser = entity('6d');
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-policy-hash-test',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 2, amount: 900_000n },
      settlementPolicy: { roundingMode: 'uint16_ceil', maxSourceDust: 16n, maxTargetDust: 14n },
      priceTicks: 2500n,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const { routeHash: _routeHash, ...withoutHash } = route;

    expect(withCanonicalCrossJurisdictionRouteHash({
      ...withoutHash,
      domain: { ...route.domain!, sourceAssetRef: `${jref(eth)}:external:1` },
    }).routeHash).not.toBe(route.routeHash);
    expect(withCanonicalCrossJurisdictionRouteHash({
      ...withoutHash,
      settlementPolicy: { ...route.settlementPolicy!, maxSourceDust: route.settlementPolicy!.maxSourceDust + 1n },
    }).routeHash).not.toBe(route.routeHash);
    expect(withCanonicalCrossJurisdictionRouteHash({
      ...withoutHash,
      timePolicy: { ...route.timePolicy!, runtimeExpiresAtMs: route.timePolicy!.runtimeExpiresAtMs + 1 },
    }).routeHash).not.toBe(route.routeHash);
  });

  test('cross-j rejects non-collateralized risk modes until an executable policy exists', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    expect(() => withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-risk-mode-test',
      makerEntityId: entity('6e'),
      hubEntityId: entity('6f'),
      source: { jurisdiction: jref(eth), entityId: entity('70'), counterpartyEntityId: entity('71'), tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: entity('72'), counterpartyEntityId: entity('73'), tokenId: 2, amount: 900n },
      riskMode: 'credit_line',
      status: 'intent',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    })).toThrow('CROSS_J_RISK_MODE_UNSUPPORTED');
  });

  test('cross-j quantization policy rejects fills whose uint16 projection exceeds the dust budget', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const fillNumerator = 1n;
    const fillDenominator = 7n;
    const cumulativeFillRatio = 9_363;
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'route-quantization-policy-test',
      makerEntityId: entity('74'),
      hubEntityId: entity('75'),
      source: { jurisdiction: jref(eth), entityId: entity('76'), counterpartyEntityId: entity('77'), tokenId: 1, amount: 1_000_000n },
      target: { jurisdiction: jref(base), entityId: entity('78'), counterpartyEntityId: entity('79'), tokenId: 2, amount: 1_000_000n },
      settlementPolicy: { roundingMode: 'uint16_ceil', maxSourceDust: 0n, maxTargetDust: 0n },
      status: 'intent',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    });
    const projected = projectCrossJurisdictionQuantizedClaim(route.source.amount, {
      cumulativeFillRatio,
      fillNumerator,
      fillDenominator,
    });

    expect(projected.exactClaim).toBe(142_857n);
    expect(projected.quantizedClaim).toBeGreaterThan(projected.exactClaim);
    expect(validateCrossJurisdictionQuantization(route, {
      cumulativeFillRatio,
      fillNumerator,
      fillDenominator,
      cumulativeSourceAmount: projected.exactClaim,
      cumulativeTargetAmount: projected.exactClaim,
    })).toContain('source quantization dust');
    expect(() => projectCrossJurisdictionQuantizedClaim(route.source.amount, {
      cumulativeFillRatio,
      fillNumerator,
    })).toThrow('CROSS_J_EXACT_FILL_RATIO_INCOMPLETE');
    expect(() => projectCrossJurisdictionQuantizedClaim(route.source.amount, {
      cumulativeFillRatio,
      fillNumerator: fillDenominator + 1n,
      fillDenominator,
      orderId: route.orderId,
    })).toThrow(`CROSS_J_EXACT_FILL_RATIO_INVALID:${route.orderId}`);
    const invalidProgress = validateCrossJurisdictionFillProgress(route, {
      cumulativeFillRatio,
      fillNumerator,
    });
    expect(invalidProgress.ok).toBe(false);
    if (!invalidProgress.ok) {
      expect(invalidProgress.error).toBe(`CROSS_J_EXACT_FILL_RATIO_INCOMPLETE:${route.orderId}`);
    }
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
    account.currentFrame.timestamp = 1_500;
    account.pendingFrame = { ...account.currentFrame, height: 1, timestamp: 9_000 };

    const result = await applyAccountTx(account, {
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
    expect(updatedRoute?.updatedAt).toBe(2_000);
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

    const result = await applyAccountTx(account, {
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

    const result = await applyAccountTx(account, {
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
        priceImprovementMode: 'source_savings',
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

    const result = await applyAccountTx(account, {
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

  test('cross-j claim progress preserves exact filled amounts instead of uint16-rounded economics', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-exact-quarter-claim',
      makerEntityId: entity('7d'),
      hubEntityId: entity('7e'),
      source: {
        jurisdiction: jref(eth),
        entityId: entity('7d'),
        counterpartyEntityId: entity('7e'),
        tokenId: 2,
        amount: 40_000_000_000_000_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: entity('7f'),
        counterpartyEntityId: entity('80'),
        tokenId: 1,
        amount: 100_000_000_000_000_000_000n,
      },
      priceImprovementMode: 'source_savings',
      status: 'clearing',
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-exact-quarter-claim-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const filledRoute = {
      ...route,
      fillSeq: 1,
      cumulativeFillRatio: 0,
      fillNumerator: 1n,
      fillDenominator: 4n,
      filledSourceAmount: 10_000_000_000_000_000n,
      filledTargetAmount: 25_000_000_000_000_000_000n,
      sourceClaimed: 10_000_000_000_000_000n,
      targetClaimed: 25_000_000_000_000_000_000n,
      claimedRatio: 0,
    };

    const claimed = withCrossJurisdictionClaimProgress(filledRoute, 16_384, 3_000);

    expect(claimed.claimedRatio).toBe(16_384);
    expect(claimed.sourceClaimed).toBe(10_000_000_000_000_000n);
    expect(claimed.targetClaimed).toBe(25_000_000_000_000_000_000n);
    expect(claimed.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(claimed.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(claimed.cumulativeFillRatio).toBe(16_384);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(claimed.filledSourceAmount);
  });

  test('cross-j orderbook remaining and cancel ack use exact ratio fields before uint16 fallback', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-exact-quarter-cancel',
      makerEntityId: entity('89'),
      hubEntityId: entity('8a'),
      source: {
        jurisdiction: jref(eth),
        entityId: entity('89'),
        counterpartyEntityId: entity('8a'),
        tokenId: 2,
        amount: 40_000_000_000_000_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: entity('8b'),
        counterpartyEntityId: entity('8c'),
        tokenId: 1,
        amount: 100_000_000_000_000_000_000n,
      },
      priceImprovementMode: 'source_savings',
      status: 'partially_filled',
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-exact-quarter-cancel-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const ratioOnlyExactRoute = {
      ...route,
      fillSeq: 1,
      fillNumerator: 1n,
      fillDenominator: 4n,
    };

    const remaining = getCrossJurisdictionRouteRemainingAmounts(ratioOnlyExactRoute);
    const cancelAck = buildCrossJurisdictionCancelAck(ratioOnlyExactRoute.orderId, ratioOnlyExactRoute);
    const closeProof = buildCrossJurisdictionCloseProof(ratioOnlyExactRoute, '0x');
    const sourceBinding = buildCrossJurisdictionPullBinding(ratioOnlyExactRoute, 'source');
    const targetBinding = buildCrossJurisdictionPullBinding(ratioOnlyExactRoute, 'target');
    const pendingFromExactAck = buildCrossJurisdictionPendingFillFromAck({
      type: 'cross_swap_fill_ack',
      data: {
        offerId: ratioOnlyExactRoute.orderId,
        fillSeq: 1,
        incrementalSourceAmount: 10_000_000_000_000_000n,
        incrementalTargetAmount: 25_000_000_000_000_000_000n,
        cumulativeSourceAmount: 10_000_000_000_000_000n,
        cumulativeTargetAmount: 25_000_000_000_000_000_000n,
        cumulativeFillRatio: 0,
        fillNumerator: 1n,
        fillDenominator: 4n,
        ackKind: 'fill',
        executionSourceAmount: 10_000_000_000_000_000n,
        executionTargetAmount: 25_000_000_000_000_000_000n,
        cancelRemainder: false,
        pairId: ratioOnlyExactRoute.venueId || '',
      },
    }, 2_000);

    expect(hasCrossJurisdictionCommittedFill(route)).toBe(false);
    expect(hasCrossJurisdictionCommittedFill(ratioOnlyExactRoute)).toBe(true);
    expect(remaining.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(remaining.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(remaining.sourceRemaining).toBe(30_000_000_000_000_000n);
    expect(remaining.targetRemaining).toBe(75_000_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeSourceAmount).toBe(10_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(cancelAck.data.cumulativeFillRatio).toBe(16_384);
    expect(cancelAck.data.fillNumerator).toBe(1n);
    expect(cancelAck.data.fillDenominator).toBe(4n);
    expect(closeProof.fillRatio).toBe(16_384);
    expect(pendingFromExactAck?.cumulativeFillRatio).toBe(16_384);
    expect(pendingFromExactAck?.fillNumerator).toBe(1n);
    expect(pendingFromExactAck?.fillDenominator).toBe(4n);
    expect(closeProof.cumulativeSourceAmount).toBe(10_000_000_000_000_000n);
    expect(closeProof.cumulativeTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(sourceBinding.fillNumerator).toBe(1n);
    expect(sourceBinding.fillDenominator).toBe(4n);
    expect(sourceBinding.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(sourceBinding.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect(targetBinding.fillNumerator).toBe(1n);
    expect(targetBinding.fillDenominator).toBe(4n);
    expect(targetBinding.filledSourceAmount).toBe(10_000_000_000_000_000n);
    expect(targetBinding.filledTargetAmount).toBe(25_000_000_000_000_000_000n);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(remaining.filledSourceAmount);
  });

  test('cross-j next fill validates against exact previous ratio fields before uint16 fallback', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('8d');
    const sourceHub = entity('8e');
    const targetHub = entity('8f');
    const targetUser = entity('90');
    const account = makeAccount(sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-exact-quarter-next-fill',
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
      status: 'partially_filled',
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-exact-quarter-next-fill-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    const ratioOnlyExactRoute = {
      ...route,
      fillSeq: 1,
      cumulativeFillRatio: 0,
      fillNumerator: 1n,
      fillDenominator: 4n,
    };
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
      crossJurisdiction: ratioOnlyExactRoute,
    });

    const result = await applyAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        previousFillSeq: 1,
        fillSeq: 2,
        incrementalSourceAmount: 10_000_000_000_000_000n,
        incrementalTargetAmount: 25_000_000_000_000_000_000n,
        cumulativeSourceAmount: 20_000_000_000_000_000n,
        cumulativeTargetAmount: 50_000_000_000_000_000_000n,
        cumulativeFillRatio: 0,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionSourceAmount: 10_000_000_000_000_000n,
        executionTargetAmount: 25_000_000_000_000_000_000n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:2/base:1',
      },
    }, account.leftEntity === sourceHub, 3_000, 2);

    const updatedRoute = account.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(result.success).toBe(true);
    expect(updatedRoute?.fillSeq).toBe(2);
    expect(updatedRoute?.cumulativeFillRatio).toBe(32_768);
    expect(updatedRoute?.filledSourceAmount).toBe(20_000_000_000_000_000n);
    expect(updatedRoute?.filledTargetAmount).toBe(50_000_000_000_000_000_000n);
    expect((40_000_000_000_000_000n * 16_384n) / 65_535n).not.toBe(10_000_000_000_000_000n);
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
    const result = await applyAccountTx(account, {
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
    const sourceTotal = 78n * 10n ** 6n;
    const executionSource = 75n * 10n ** 6n;
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
        weightedCost: 25_000_000n * (targetTotal / SWAP_LOT_SCALE),
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

  test('paired cross-j ACKs conserve exact execution amounts and reject sub-lot liquidity', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const tron = makeJurisdiction('Tron', 728126428, '21', '22');
    const hub = entity('91');
    const seller = entity('92');
    const buyer = entity('93');
    const lot = SWAP_LOT_SCALE;
    const makerPrice = 25_000_000n;
    const takerLimit = 26_000_000n;
    const quoteAt = (price: bigint) => quoteAmountAtPrice(2, 1, lot, price);
    const sellRoute = buildPreparedCrossJurisdictionRoute({
      orderId: 'paired-sell',
      makerEntityId: seller,
      hubEntityId: hub,
      bookOwnerEntityId: hub,
      source: { jurisdiction: jref(eth), entityId: seller, counterpartyEntityId: hub, tokenId: 2, amount: 2n * lot },
      target: { jurisdiction: jref(tron), entityId: hub, counterpartyEntityId: seller, tokenId: 1, amount: 2n * quoteAt(makerPrice) },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    }, { runtimeSeed: 'paired-sell', sourceDisputeDelayMs: 5_000, now: 1 });
    const buyRoute = buildPreparedCrossJurisdictionRoute({
      orderId: 'paired-buy',
      makerEntityId: buyer,
      hubEntityId: hub,
      bookOwnerEntityId: hub,
      source: { jurisdiction: jref(tron), entityId: buyer, counterpartyEntityId: hub, tokenId: 1, amount: quoteAt(takerLimit) },
      target: { jurisdiction: jref(eth), entityId: hub, counterpartyEntityId: buyer, tokenId: 2, amount: lot },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    }, { runtimeSeed: 'paired-buy', sourceDisputeDelayMs: 5_000, now: 1 });
    const offer = (route: typeof sellRoute, accountId: string) => ({
      offerId: route.orderId,
      accountId,
      makerIsLeft: false,
      fromEntity: hub,
      toEntity: route.makerEntityId,
      createdHeight: 1,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      quantizedGive: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      quantizedWant: route.target.amount,
      minFillRatio: 0,
      timeInForce: 0 as const,
      crossJurisdiction: { ...route, status: 'resting' as const },
    });
    const sellMeta = buildCrossJurisdictionMarketOffer(offer(sellRoute, 'sell-account'), hub)!;
    const buyMeta = buildCrossJurisdictionMarketOffer(offer(buyRoute, 'buy-account'), hub)!;
    const fill = { filledLots: 1n, weightedCost: makerPrice };
    const sellAck = buildCrossJurisdictionFillAck('sell-account', sellRoute.orderId, 'sell-account:paired-sell', sellMeta, fill)!;
    const buyAck = buildCrossJurisdictionFillAck('buy-account', buyRoute.orderId, 'buy-account:paired-buy', buyMeta, fill)!;

    expect(sellAck.instruction.executionSourceAmount).toBe(buyAck.instruction.executionTargetAmount);
    expect(sellAck.instruction.executionTargetAmount).toBe(buyAck.instruction.executionSourceAmount);
    expect(buyAck.instruction.priceImprovementAmount).toBe(quoteAt(takerLimit) - quoteAt(makerPrice));
    expect(crossBookQtyLots(2, lot - 1n)).toBe(0n);
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

    const invalidTargetAccount = makeAccount(sourceHub, sourceUser);
    invalidTargetAccount.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      priceTicks: 1_000n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: invalidTargetAccount.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    const invalidTargetResult = await applyAccountTx(invalidTargetAccount, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulativeSource,
        incrementalTargetAmount: cumulativeTarget + 1n,
        cumulativeSourceAmount: cumulativeSource,
        cumulativeTargetAmount: cumulativeTarget + 1n,
        cumulativeFillRatio: 0,
        fillNumerator,
        fillDenominator,
        executionSourceAmount: cumulativeSource,
        executionTargetAmount: cumulativeTarget + 1n,
        priceImprovementMode: 'source_savings',
        cancelRemainder: false,
        pairId: 'cross:ethereum:1/tron:2',
      },
    }, invalidTargetAccount.leftEntity === sourceHub, 2_000, 1);
    expect(invalidTargetResult.success).toBe(false);
    expect(invalidTargetResult.error).toContain('cumulative target mismatch');

    const result = await applyAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulativeSource,
        incrementalTargetAmount: cumulativeTarget,
        cumulativeSourceAmount: cumulativeSource,
        cumulativeTargetAmount: cumulativeTarget,
        cumulativeFillRatio: 0,
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
    expect(updatedRoute?.cumulativeFillRatio).toBe(132);
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
    const committedRoute = {
      ...route,
      status: 'partially_filled' as const,
      fillSeq: 1,
      fillNumerator: BigInt(fillRatio),
      fillDenominator: 65_535n,
      filledSourceAmount: cumulativeSource,
      filledTargetAmount: cumulativeTarget,
    };
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
      crossJurisdiction: committedRoute,
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
        crossJurisdiction: buildCrossJurisdictionPullBinding(committedRoute, 'source'),
        createdHeight: 0,
        createdTimestamp: 1_000,
      },
    ]]);

    const result = await applyAccountTx(account, {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        fillSeq: 1,
        incrementalSourceAmount: cumulativeSource,
        incrementalTargetAmount: cumulativeTarget,
        cumulativeSourceAmount: cumulativeSource,
        cumulativeTargetAmount: cumulativeTarget,
        cumulativeFillRatio: 0,
        fillNumerator: BigInt(fillRatio),
        fillDenominator: 65_535n,
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
    expect(account.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.filledSourceAmount).toBe(cumulativeSource);
    expect(account.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.filledTargetAmount).toBe(cumulativeTarget);
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

    const early = await applyAccountTx(account, {
      type: 'pull_cancel',
      data: { pullId, reason: 'expired' },
    }, payerIsLeft, 9_999, 2);
    expect(early.success).toBe(false);
    expect(account.pulls.has(pullId)).toBe(true);

    const expired = await applyAccountTx(account, {
      type: 'pull_cancel',
      data: { pullId, reason: 'expired' },
    }, payerIsLeft, 11_000, 3);
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
      crossJurisdiction: buildCrossJurisdictionPullBinding({ ...route, status: 'clearing', clearingPolicy: 'cancel_and_clear' }, 'source'),
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.mempoolOps).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(env, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      state: result.newState,
      mempool: [],
    } as EntityReplica, []);
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const sourceAccountRootBeforeMaterialization = computeAccountStateRoot(result.newState.accounts.get(sourceUser)!);
    const materialized = await applyEntityTx(env, result.newState, clearMaterialization!);
    expect(materialized.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect(materialized.mempoolOps?.[0]?.accountId).toBe(sourceUser);
    expect((materialized.mempoolOps?.[0]?.tx as any).data.binary).toMatch(/^0x/);
    expect((materialized.mempoolOps?.[0]?.tx as any).data.proof.fillRatio).toBe(32_768);
    expect(materialized.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
    expect(computeAccountStateRoot(materialized.newState.accounts.get(sourceUser)!)).toBe(
      sourceAccountRootBeforeMaterialization,
    );

    const accountAfterClear = materialized.newState.accounts.get(sourceUser)!;
    const invalidProposalAccount = cloneAccountMachine(accountAfterClear);
    const validClose = materialized.mempoolOps![0]!.tx;
    if (validClose.type !== 'cross_pull_close') throw new Error('TEST_CROSS_J_CLOSE_REQUIRED');
    const invalidClose: Extract<AccountTx, { type: 'cross_pull_close' }> = {
      ...validClose,
      data: {
        ...validClose.data,
        binary: '0x00',
        proof: {
          ...validClose.data.proof,
          binaryHash: hashCrossJurisdictionCloseBinary('0x00'),
        },
      },
    };
    invalidProposalAccount.mempool = [invalidClose];
    await expect(
      proposeAccountFrame(env, invalidProposalAccount, env.timestamp, state.lastFinalizedJHeight),
    ).rejects.toThrow('CROSS_J_PULL_CLOSE_PROPOSAL_FAILED');
    expect(invalidProposalAccount.mempool).toEqual([invalidClose]);
    expect(invalidProposalAccount.pendingFrame).toBeUndefined();

    const bySourceHub = sourceHub.toLowerCase() < sourceUser.toLowerCase();
    const resolveResult = await applyAccountTx(accountAfterClear, materialized.mempoolOps![0]!.tx, bySourceHub, env.timestamp, 1);
    expect(resolveResult.success, resolveResult.error).toBe(true);
    expect(accountAfterClear.pulls?.has(route.sourcePull!.pullId)).toBe(false);
    const releasedDelta = accountAfterClear.deltas.get(route.sourcePull!.tokenId)!;
    expect(sourcePullPayerIsLeft ? releasedDelta.leftHold : releasedDelta.rightHold).toBe(0n);
  });

  test('target cross_pull_close rejects lower valid reveal than source close proof', async () => {
    const env = createEmptyEnv('cross-close-lower-ratio-reject');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('86');
    const sourceHub = entity('87');
    const targetHub = entity('88');
    const targetUser = entity('89');
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-close-lower-ratio-reject',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const highRatio = 0x8000;
    const lowRatio = 0x4000;
    const highRoute = {
      ...prepared,
      status: 'source_claimed' as const,
      fillSeq: 1,
      cumulativeFillRatio: highRatio,
      claimedRatio: highRatio,
      filledSourceAmount: (BigInt(prepared.source.amount) * BigInt(highRatio)) / 65_535n,
      filledTargetAmount: (BigInt(prepared.target.amount) * BigInt(highRatio)) / 65_535n,
      sourceClaimed: (BigInt(prepared.source.amount) * BigInt(highRatio)) / 65_535n,
      targetClaimed: (BigInt(prepared.target.amount) * BigInt(highRatio)) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const lowRoute = {
      ...highRoute,
      cumulativeFillRatio: lowRatio,
      claimedRatio: lowRatio,
      filledSourceAmount: (BigInt(prepared.source.amount) * BigInt(lowRatio)) / 65_535n,
      filledTargetAmount: (BigInt(prepared.target.amount) * BigInt(lowRatio)) / 65_535n,
      sourceClaimed: (BigInt(prepared.source.amount) * BigInt(lowRatio)) / 65_535n,
      targetClaimed: (BigInt(prepared.target.amount) * BigInt(lowRatio)) / 65_535n,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, highRoute);
    const highBinary = buildCrossJurisdictionPullReveal(highRoute, highRatio, privateSeed).binary;
    const lowBinary = buildCrossJurisdictionPullReveal(lowRoute, lowRatio, privateSeed).binary;
    const highProof = buildCrossJurisdictionCloseProof(highRoute, highBinary);
    const lowProof = buildCrossJurisdictionCloseProof(lowRoute, lowBinary);
    const account = makeAccount(targetUser, targetHub);
    const targetDelta = account.deltas.get(highRoute.targetPull!.tokenId) ?? createDefaultDelta(highRoute.targetPull!.tokenId);
    account.deltas.set(highRoute.targetPull!.tokenId, targetDelta);
    const targetAbsAmount = highRoute.targetPull!.signedAmount >= 0n
      ? highRoute.targetPull!.signedAmount
      : -highRoute.targetPull!.signedAmount;
    if (highRoute.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    account.pulls = new Map([[highRoute.targetPull!.pullId, {
      pullId: highRoute.targetPull!.pullId,
      tokenId: highRoute.targetPull!.tokenId,
      amount: highRoute.targetPull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: highRoute.targetPull!.revealedUntilTimestamp,
      fullHash: highRoute.targetPull!.fullHash,
      partialRoot: highRoute.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding({ ...highRoute, sourceCloseProof: highProof }, 'target'),
      createdHeight: 0,
      createdTimestamp: env.timestamp,
    }]]);
    const byTargetUser = targetUser.toLowerCase() < targetHub.toLowerCase();

    const lowerProofResult = await applyAccountTx(account, {
      type: 'cross_pull_close',
      data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: lowProof },
    }, byTargetUser, env.timestamp, 1);
    expect(lowerProofResult.success).toBe(false);
    expect(lowerProofResult.error).toContain('ratio');
    expect(account.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);

    const lowerBinaryResult = await applyAccountTx(account, {
      type: 'cross_pull_close',
      data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: highProof },
    }, byTargetUser, env.timestamp, 2);
    expect(lowerBinaryResult.success).toBe(false);
    expect(lowerBinaryResult.error).toContain('binary');
    expect(account.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);
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
    }, payerIsLeft, route.sourcePull!.revealedUntilTimestamp + 1_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('must clear through requestCrossJurisdictionClear');
    expect(account.pulls?.has(route.sourcePull!.pullId)).toBe(true);
  });

  test('direct cancelPull cannot release an unfilled cross-j target pull', async () => {
    const env = createEmptyEnv('cross-target-direct-cancel-blocked');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('78');
    const sourceHub = entity('79');
    const targetHub = entity('7a');
    const targetUser = entity('7b');
    const state = makeState(targetUser, addr('7c'), base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-direct-cancel-blocked',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'target_locked',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-target-direct-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = await applyEntityTx(env, state, {
      type: 'cancelPull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        description: 'malicious unfilled target release',
      },
    });

    expect(result.mempoolOps ?? []).toHaveLength(0);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe(route.status);
    expect(result.newState.messages.some(message => message.includes('must clear through requestCrossJurisdictionClear'))).toBe(true);
  });

  test('account-layer pull_cancel cannot release an unfilled cross-j target pull', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7c');
    const sourceHub = entity('7d');
    const targetHub = entity('7e');
    const targetUser = entity('7f');
    const account = makeAccount(targetUser, targetHub);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-account-target-cancel-blocked',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'target_locked',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 70_000,
    }, { runtimeSeed: 'cross-account-target-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 });
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: route.target.tokenId,
      giveAmount: route.target.amount,
      wantTokenId: route.source.tokenId,
      wantAmount: route.source.amount,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === targetUser,
      createdHeight: 0,
      crossJurisdiction: route,
    });
    account.pulls = new Map([[route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      createdHeight: 0,
      createdTimestamp: 1_000,
    }]]);

    const beneficiaryIsLeft = route.targetPull!.signedAmount > 0n;
    const result = await handlePullCancel(account, {
      type: 'pull_cancel',
      data: { pullId: route.targetPull!.pullId, reason: 'beneficiary_release' },
    }, beneficiaryIsLeft, 10_000);

    expect(result.success).toBe(false);
    expect(result.error).toContain('must clear through requestCrossJurisdictionClear');
    expect(account.pulls?.has(route.targetPull!.pullId)).toBe(true);
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

  test('target pull resolve verifies relay binary and enters clearing before account commit only with source proof', async () => {
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
        binary,
      },
    });
    expect(blocked.mempoolOps ?? []).toHaveLength(0);
    expect(blocked.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(blocked.newState.messages.some(message => message.includes('source close proof missing'))).toBe(true);

    const ratio = 0x4567;
    const claimedRoute = {
      ...route,
      status: 'resting' as const,
      cumulativeFillRatio: ratio,
      claimedRatio: ratio,
      filledSourceAmount: (BigInt(route.source.amount) * BigInt(ratio)) / 65_535n,
      filledTargetAmount: (BigInt(route.target.amount) * BigInt(ratio)) / 65_535n,
      sourceClaimed: (BigInt(route.source.amount) * BigInt(ratio)) / 65_535n,
      targetClaimed: (BigInt(route.target.amount) * BigInt(ratio)) / 65_535n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const proof = buildCrossJurisdictionCloseProof(claimedRoute, binary);
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...claimedRoute, sourceCloseProof: proof });
    const accountRootBeforeResolve = computeAccountStateRoot(targetAccount!);

    const result = await applyEntityTx(env, targetState, {
      type: 'resolvePull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        binary,
      },
      });
      expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
      expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
      const stagedAccount = result.newState.accounts.get(targetHub);
      expect(computeAccountStateRoot(stagedAccount!)).toBe(accountRootBeforeResolve);
      const accountResult = await applyAccountTx(
        stagedAccount!,
        result.mempoolOps![0]!.tx,
        targetUser.toLowerCase() < targetHub.toLowerCase(),
        env.timestamp,
        1,
      );
      expect(accountResult.success).toBe(true);
    });

  test('source user routes cross-j clear through the source Account', async () => {
    const env = createEmptyEnv('cross-clear-source-account');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const state = makeState(sourceUser, addr('85'), eth, sourceHub);
    await expect(applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: 'missing-cross-j-route', cancelRemainder: true },
    })).rejects.toThrow('CROSS_J_CLEAR_ROUTE_MISSING:missing-cross-j-route');
    const prepared = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-clear-source-account',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const restingRoute = {
      ...prepared,
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(restingRoute.orderId, restingRoute);
    const account = state.accounts.get(sourceHub)!;
    account.swapOffers.set(restingRoute.orderId, {
      offerId: restingRoute.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...restingRoute },
    });

    const ignored = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: restingRoute.orderId, cancelRemainder: false },
    });
    expect(ignored.mempoolOps).toEqual([]);
    expect(ignored.newState.crossJurisdictionSwaps?.get(restingRoute.orderId)?.status).toBe('resting');

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

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.outputs).toEqual([]);
    expect(result.mempoolOps).toEqual([{
      accountId: sourceHub,
      tx: { type: 'swap_cancel_request', data: { offerId: route.orderId } },
    }]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
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
    const admission = mergeCrossJurisdictionBookAdmission(state, route, state.timestamp);
    admission.status = 'admitted';
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = processOrderbookCancels(state, [{ accountId: sourceUser, offerId: route.orderId }]);
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]?.tx.type).toBe('cross_swap_fill_ack');
    expect(result.mempoolOps.some(op => op.tx.type === 'swap_resolve')).toBe(false);
  });

  test('cross-j cancel waits for an accepted fill and uses its committed progress', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const state = makeState(sourceHub, addr('85'), eth, sourceUser);
    state.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: sourceHub,
        name: 'source hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [],
      },
    } as any;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-cancel-after-accepted-fill',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: { jurisdiction: jref(eth), entityId: sourceUser, counterpartyEntityId: sourceHub, tokenId: 1, amount: 1_000n },
      target: { jurisdiction: jref(base), entityId: targetHub, counterpartyEntityId: targetUser, tokenId: 1, amount: 900n },
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 61_000,
    }, { runtimeSeed: 'cross-cancel-after-accepted-fill', sourceDisputeDelayMs: 5_000, now: 1_000 });
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
      crossJurisdiction: route,
    });
    const admission = mergeCrossJurisdictionBookAdmission(state, route, state.timestamp);
    admission.status = 'admitted';
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    account.mempool.push({
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        routeHash: route.routeHash,
        previousFillSeq: 0,
        fillSeq: 1,
        incrementalSourceAmount: 250n,
        incrementalTargetAmount: 225n,
        cumulativeSourceAmount: 250n,
        cumulativeTargetAmount: 225n,
        cumulativeFillRatio: 16_384,
        fillNumerator: 1n,
        fillDenominator: 4n,
        ackKind: 'fill',
        cancelRemainder: false,
      },
    });

    const cancelled = processOrderbookCancels(state, [{ accountId: sourceUser, offerId: route.orderId }]);
    expect(cancelled.mempoolOps).toEqual([]);
    expect(admission.pendingCancel?.bookRemovalCommittedAt).toBe(state.timestamp);

    account.mempool = [];
    const committedRoute = {
      ...route,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 16_384,
      fillNumerator: 1n,
      fillDenominator: 4n,
      filledSourceAmount: 250n,
      filledTargetAmount: 225n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, committedRoute);
    account.swapOffers.get(route.orderId)!.crossJurisdiction = committedRoute;

    const [cancelAck] = collectCommittedCrossJurisdictionCancelAcks(state);
    expect(cancelAck?.tx).toMatchObject({
      type: 'cross_swap_fill_ack',
      data: {
        offerId: route.orderId,
        previousFillSeq: 1,
        fillSeq: 1,
        cumulativeSourceAmount: 250n,
        cumulativeTargetAmount: 225n,
        cancelRemainder: true,
      },
    });
  });

  test('source hub waits for committed sibling book-removal receipt before Account ACK', async () => {
    const env = createEmptyEnv('cross-cancel-remote-book-owner');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Base', 8453, '21', '22');
    const targetJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('91');
    const sourceHub = entity('92');
    const targetHub = entity('93');
    const targetUser = entity('94');
    const sourceHubSigner = addr('95');
    const targetHubSigner = addr('96');
    const sourceHubState = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, targetJ, targetUser);
    addReplica(env, sourceHubState, sourceHubSigner);
    addReplica(env, targetHubState, targetHubSigner);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-cancel-remote-book-owner',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      source: {
        jurisdiction: jref(sourceJ),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJ),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: 70_000,
    }, { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const account = sourceHubState.accounts.get(sourceUser)!;
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
      crossJurisdiction: { ...route, status: 'partially_filled' },
    });
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, sourceHubState.timestamp);
    sourceHubState.crossJurisdictionSwaps?.set(route.orderId, route);
    const targetAdmission = mergeCrossJurisdictionBookAdmission(targetHubState, route, targetHubState.timestamp);
    targetAdmission.status = 'admitted';
    targetHubState.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = routeRemoteCrossJurisdictionBookCancels(env, sourceHubState, [{
      accountId: sourceUser,
      offerId: route.orderId,
    }]);

    expect(result.localBookCancels).toEqual([]);
    expect(result.mempoolOps).toEqual([]);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.values().next().value?.pendingCancel).toMatchObject({
      sourceAccountId: sourceUser,
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      entityId: targetHub,
      signerId: targetHubSigner,
      localRuntimeProtocol: 'cross-j',
      entityTxs: [{
        type: 'removeCrossJurisdictionBookOrder',
        data: {
          orderId: route.orderId,
          sourceEntityId: sourceUser,
          sourceAccountId: sourceUser,
          reason: 'cancel_request',
        },
      }],
    });

    const ownerRemoval = await applyEntityTx(env, targetHubState, result.outputs[0]!.entityTxs![0]!);
    expect(ownerRemoval.outputs).toHaveLength(1);
    expect(ownerRemoval.outputs[0]).toMatchObject({
      entityId: sourceHub,
      localRuntimeProtocol: 'cross-j',
      entityTxs: [{
        type: 'crossJurisdictionBookOrderRemoved',
        data: {
          orderId: route.orderId,
          sourceAccountId: sourceUser,
        },
      }],
    });
    expect(result.mempoolOps).toEqual([]);

    const sourceFollowup = await applyEntityTx(
      env,
      sourceHubState,
      ownerRemoval.outputs[0]!.entityTxs![0]!,
    );
    expect(sourceFollowup.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    const removedAt = (ownerRemoval.outputs[0]!.entityTxs![0] as Extract<EntityTx, {
      type: 'crossJurisdictionBookOrderRemoved';
    }>).data.removedAt;
    expect(sourceFollowup.newState.crossJurisdictionBookAdmissions?.values().next().value?.pendingCancel)
      .toMatchObject({ sourceAccountId: sourceUser, bookRemovalCommittedAt: removedAt });
  });

  test('source user queues cross-j Account cancel without a local orderbook extension', async () => {
    const env = createEmptyEnv('cross-cancel-no-orderbook-ext');
    env.scenarioMode = true;
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    const sourceHub = entity('9b');
    const sourceHubSigner = addr('9e');
    const targetHub = entity('9c');
    const targetUser = entity('9d');
    const seed = 'cross-cancel-no-orderbook-ext seed alpha beta gamma';
    const signer = registerTestSigner(env, seed, '1');
    const sourceUser = generateLazyEntityId([signer], 1n).toLowerCase();
    env.gossip = {
      getProfiles: () => [{
        entityId: sourceHub,
        metadata: { board: { validators: [{ signerId: sourceHubSigner }] } },
      }],
    } as typeof env.gossip;
    const state = makeState(sourceUser, signer, eth, sourceHub);
    state.prevFrameHash = 'genesis';
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

    const result = await applyEntityInput(env, replica, {
      entityId: sourceUser,
      signerId: signer,
      entityTxs: [{
        type: 'proposeCancelSwap',
        data: { counterpartyEntityId: sourceHub, offerId: route.orderId },
      }],
    });

    expect(result.outcome.kind).toBe('committed');
    expect(result.outputs.some(output =>
      output.entityId === sourceHub && output.entityTxs?.some(tx => tx.type === 'consensusOutput'),
    )).toBe(true);
    const workingAccount = result.workingReplica.state.accounts.get(sourceHub)!;
    expect([
      ...workingAccount.mempool,
      ...(workingAccount.pendingFrame?.accountTxs ?? []),
    ].some(tx => tx.type === 'swap_resolve')).toBe(false);
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
      fillNumerator: 1n,
      fillDenominator: 2n,
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
        cumulativeFillRatio: 0,
        fillNumerator: 1n,
        fillDenominator: 2n,
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
        cumulativeFillRatio: 0,
        fillNumerator: 1n,
        fillDenominator: 2n,
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
      output.entityTxs?.some(tx =>
        tx.type === 'consensusOutput' &&
        tx.data.entityTxs.some(nested => nested.type === 'accountInput')
      ),
    );
    const certifiedAccountInput = accountInputOutput?.entityTxs?.[0];
    expect(certifiedAccountInput?.type).toBe('consensusOutput');
    expect(certifiedAccountInput?.type === 'consensusOutput'
      ? certifiedAccountInput.data.entityTxs[0]?.type
      : undefined).toBe('accountInput');
    expect(certifiedAccountInput?.type === 'consensusOutput'
      ? (certifiedAccountInput.data.entityTxs[0]?.data as any)?.toEntityId
      : undefined).toBe(sourceUser);

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
      output.entityTxs?.some(tx =>
        tx.type === 'consensusOutput' &&
        tx.data.entityTxs.some(nested => nested.type === 'accountInput')
      ),
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
      output.entityTxs?.some(tx =>
        tx.type === 'consensusOutput' &&
        tx.data.entityTxs.some(nested => nested.type === 'accountInput')
      ),
    );
    const certifiedAccountInput = accountInputOutput?.entityTxs?.[0];
    expect(certifiedAccountInput?.type).toBe('consensusOutput');
    expect(certifiedAccountInput?.type === 'consensusOutput'
      ? certifiedAccountInput.data.entityTxs[0]?.type
      : undefined).toBe('accountInput');

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

    expect(result.mempoolOps?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack', 'cross_pull_close']);
    expect((result.mempoolOps?.[1]?.tx as any).data.binary).toBe('0x');
    expect((result.mempoolOps?.[1]?.tx as any).data.proof.fillRatio).toBe(0);
    expect(result.outputs.some(output =>
      output.entityId === targetUser &&
      output.entityTxs?.some(tx => tx.type === 'cancelPull'),
    )).toBe(false);
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
      fillNumerator: 1n,
      fillDenominator: 2n,
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
    expect((result.mempoolOps?.[0]?.tx as any).data.fillNumerator).toBe(1n);
    expect((result.mempoolOps?.[0]?.tx as any).data.fillDenominator).toBe(2n);
    expect((result.mempoolOps?.[0]?.tx as any).data.cumulativeSourceAmount).toBe(500n);
    expect((result.mempoolOps?.[0]?.tx as any).data.cumulativeTargetAmount).toBe(450n);
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
    installJurisdictions(env, eth);
    addReplica(env, state, signer);
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
        targetSignerId: targetSigner,
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
    const proofbodyHash = buildAccountProofBody(state.accounts.get(hub)!, '').proofBodyHash;
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
        jNonce: 1,
      },
    };
    const signed = prepareJEventInput(env, user, signer, {
      blockNumber: 2,
      blockHash: secret('7b'),
      transactionHash: secret('7c'),
      events: [disputeStartedEvent],
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(state, {
      from: signer,
      event: disputeStartedEvent,
      observedAt: env.timestamp,
      blockNumber: 2,
      blockHash: secret('7b'),
      transactionHash: secret('7c'),
      ...signed,
    }, env);

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.signerId).toBe(targetSigner);
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
    installJurisdictions(env, eth, base);
    addReplica(env, state, signer);
    addReplica(env, makeState(targetUser, targetSigner, base, targetHub), targetSigner);
    const oldSettledRoute = buildPreparedCrossJurisdictionRoute({
      orderId: 'old-cross-pull-dispute',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      targetSignerId: targetSigner,
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
      targetSignerId: targetSigner,
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
    const proofbodyHash = buildAccountProofBody(state.accounts.get(sourceHub)!, '').proofBodyHash;
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
        jNonce: 1,
      },
    };
    const signed = prepareJEventInput(env, sourceUser, signer, {
      blockNumber: 2,
      blockHash: secret('8b'),
      transactionHash: secret('8c'),
      events: [disputeStartedEvent],
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(state, {
      from: signer,
      event: disputeStartedEvent,
      observedAt: env.timestamp,
      blockNumber: 2,
      blockHash: secret('8b'),
      transactionHash: secret('8c'),
      ...signed,
    }, env);

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.signerId).toBe(targetSigner);
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
      targetSignerId: targetSigner,
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
    const sourceAccount = state.accounts.get(sourceHub)!;
    const finalizedProof = buildAccountProofBody(sourceAccount, '');
    sourceAccount.disputeProofBodiesByHash = {
      [finalizedProof.proofBodyHash]: finalizedProof.proofBodyStruct,
    };
    const finalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: finalizedProof.proofBodyHash,
        finalProofbodyHash: finalizedProof.proofBodyHash,
      },
    };
    const disputeFinalizationEvidence = [{
      sender: sourceHub,
      counterentity: sourceUser,
      initialNonce: '1',
      initialProofbodyHash: finalizedProof.proofBodyHash,
      finalProofbodyHash: finalizedProof.proofBodyHash,
      leftArguments,
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    }];
    const signed = prepareJEventInput(env, sourceUser, signer, {
      blockNumber: 3,
      blockHash: secret('9c'),
      transactionHash: secret('9d'),
      events: [finalizedEvent],
      disputeFinalizationEvidence,
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(state, {
      from: signer,
      event: finalizedEvent,
      observedAt: env.timestamp,
      blockNumber: 3,
      blockHash: secret('9c'),
      transactionHash: secret('9d'),
      disputeFinalizationEvidence,
      ...signed,
    }, env);

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.signerId).toBe(targetSigner);
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
    const signedWithoutEvidence = prepareJEventInput(env, sourceUser, signer, {
      blockNumber: 4,
      blockHash: secret('ac'),
      transactionHash: secret('ad'),
      events: [finalizedEvent],
      jurisdictionRef: jref(eth),
    });

    const unsignedEvidenceRange = buildJEventRangeData(state, {
      from: signer,
      event: finalizedEvent,
      observedAt: env.timestamp,
      blockNumber: 4,
      blockHash: secret('ac'),
      transactionHash: secret('ad'),
      ...signedWithoutEvidence,
    }, env);
    unsignedEvidenceRange.blocks[0]!.disputeFinalizationEvidence = disputeFinalizationEvidence;

    await expect(applyEntityTx(env, state, {
      type: 'j_event',
      data: unsignedEvidenceRange,
    })).rejects.toThrow('J_RANGE_EVIDENCE_HASH_MISMATCH');
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
    targetAccount.proofHeader.nextProofNonce = 1;
    const targetProof = buildAccountProofBody(targetAccount, addr('99'));
    targetAccount.disputeProofBodiesByHash = {
      [targetProof.proofBodyHash]: targetProof.proofBodyStruct,
    };
    storeDisputeArgumentSnapshot(
      targetAccount,
      captureDisputeArgumentSnapshot(targetAccount, targetProof.proofBodyHash, 1, targetProof.proofBodyStruct),
    );
    const targetDisputeHash = createDisputeProofHashWithNonce(
      targetAccount,
      targetProof.proofBodyHash,
      { chainId: base.chainId, depositoryAddress: base.depositoryAddress },
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

  const makeTargetDisputeRouteSelectionFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.timestamp = 50_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceSigner = addr('81');
    const targetSigner = addr('82');
    const state = makeState(targetUser, targetSigner, targetJ, targetHub);
    const sourceState = makeState(sourceUser, sourceSigner, sourceJ, sourceHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, state, targetSigner);
    const buildRoute = (
      orderId: string,
      options: {
        status?: 'resting' | 'settled' | 'cancelled' | 'expired' | 'failed';
        targetHub?: string;
        withoutTargetPull?: boolean;
      } = {},
    ) => {
      const route = {
        ...buildPreparedCrossJurisdictionRoute({
          orderId,
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          sourceSignerId: sourceSigner,
          source: {
            jurisdiction: jref(sourceJ),
            entityId: sourceUser,
            counterpartyEntityId: sourceHub,
            tokenId: 1,
            amount: 100n,
          },
          target: {
            jurisdiction: jref(targetJ),
            entityId: options.targetHub ?? targetHub,
            counterpartyEntityId: targetUser,
            tokenId: 1,
            amount: 90n,
          },
          status: 'resting',
          createdAt: env.timestamp,
          updatedAt: env.timestamp,
        }, { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp }),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
  };

  test('target dispute skips an older terminal route and selects the only active route', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-first');
    const terminal = fixture.buildRoute('a-terminal', { status: 'settled' });
    const active = fixture.buildRoute('z-active');
    fixture.state.crossJurisdictionSwaps?.set(terminal.orderId, terminal);
    fixture.state.crossJurisdictionSwaps?.set(active.orderId, active);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSourceDisputeFromTargetDispute(
      fixture.env,
      fixture.state,
      outputs,
      fixture.targetHub,
      '0x',
    )).toBe(true);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(fixture.sourceUser);
    expect(outputs[0]?.signerId).toBe(fixture.sourceSigner);
    expect(outputs[0]?.entityTxs?.[0]).toEqual({
      type: 'disputeStart',
      data: {
        counterpartyEntityId: fixture.sourceHub,
        crossJurisdictionRouteId: active.orderId,
      },
    });
  });

  test('target dispute ignores routes in every terminal status', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-only');
    for (const status of ['settled', 'cancelled', 'expired', 'failed'] as const) {
      const route = fixture.buildRoute(`terminal-${status}`, { status });
      fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    }
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSourceDisputeFromTargetDispute(
      fixture.env,
      fixture.state,
      outputs,
      fixture.targetHub,
      '0x',
    )).toBe(false);
    expect(outputs).toEqual([]);
  });

  test('target dispute ignores a route without a target pull commitment', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-no-target-pull');
    const route = fixture.buildRoute('active-without-target-pull', { withoutTargetPull: true });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSourceDisputeFromTargetDispute(
      fixture.env,
      fixture.state,
      outputs,
      fixture.targetHub,
      '0x',
    )).toBe(false);
    expect(outputs).toEqual([]);
  });

  test('target dispute fails closed and records sorted route ids when active routes are ambiguous', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-ambiguous');
    const later = fixture.buildRoute('z-active');
    const earlier = fixture.buildRoute('a-active');
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);
    fixture.state.crossJurisdictionSwaps?.set(earlier.orderId, earlier);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSourceDisputeFromTargetDispute(
      fixture.env,
      fixture.state,
      outputs,
      fixture.targetHub,
      '0x',
    )).toBe(false);
    expect(outputs).toEqual([]);
    expect(fixture.state.messages.at(-1)).toBe(
      `⚠️ Cross-j target dispute route ambiguous for ${fixture.targetHub.slice(-4)}: ` +
      'a-active,z-active; no source dispute queued',
    );
  });

  test('target dispute ignores a route bound to another target hub', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-other-hub');
    const route = fixture.buildRoute('other-target-hub', { targetHub: entity('55') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSourceDisputeFromTargetDispute(
      fixture.env,
      fixture.state,
      outputs,
      fixture.targetHub,
      '0x',
    )).toBe(false);
    expect(outputs).toEqual([]);
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
    const targetState = makeState(targetUser, targetSigner, base, targetHub);
    const sourceState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, targetState, targetSigner);
    installJurisdictions(env, eth, base);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-target-dispute-force-source',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceSigner,
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
        jNonce: 1,
      },
    };
    const signed = prepareJEventInput(env, targetUser, targetSigner, {
      blockNumber: 2,
      blockHash: secret('9b'),
      transactionHash: secret('9c'),
      events: [disputeStartedEvent],
      jurisdictionRef: jref(base),
    });
    const originalError = console.error;
    const originalWarn = console.warn;
    const errors: string[] = [];
    const warnings: string[] = [];
    let result: Awaited<ReturnType<typeof applyEntityTx>> | null = null;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      result = await applyJEventRange(targetState, {
        from: targetSigner,
        event: disputeStartedEvent,
        observedAt: env.timestamp,
        blockNumber: 2,
        blockHash: secret('9b'),
        transactionHash: secret('9c'),
        ...signed,
      }, env);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);

    const sourceOutput = result!.outputs.find(output => output.entityId === sourceUser);
    expect(sourceOutput?.signerId).toBe(sourceSigner);
    expect(sourceOutput?.entityTxs?.map(tx => tx.type)).toEqual(['disputeStart']);
    expect((sourceOutput?.entityTxs?.[0]?.data as any).counterpartyEntityId).toBe(sourceHub);
    expect((sourceOutput?.entityTxs?.[0]?.data as any).crossJurisdictionRouteId).toBe(route.orderId);
  });

  test('route-bound disputeStart fails loudly before touching an unknown route', async () => {
    const env = createEmptyEnv('cross-route-bound-dispute-missing');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const sourceUser = entity('55');
    const sourceHub = entity('56');
    const signer = addr('82');
    const state = makeState(
      sourceUser,
      signer,
      makeJurisdiction('Ethereum', 1, '11', '12'),
      sourceHub,
    );

    await expect(applyEntityTx(env, state, {
      type: 'disputeStart',
      data: {
        counterpartyEntityId: sourceHub,
        crossJurisdictionRouteId: 'missing-route',
      },
    })).rejects.toThrow('DISPUTE_START_CROSS_J_ROUTE_MISSING:missing-route');
  });

  test('production cross-j API exposes only hashledger orderbook flow', async () => {
    const runtime = await import('../runtime');
    expect(typeof runtime.submitCrossJurisdictionSwap).toBe('function');
    expect('submitCrossJurisdictionSourceLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionTargetLock' in runtime).toBe(false);
    expect('submitCrossJurisdictionSwapClaims' in runtime).toBe(false);
  });

  test('cross-j same-token market price uses jurisdiction asset orientation', () => {
    const sourceRef = `stack:2:0x${'22'.repeat(20)}`;
    const targetRef = `stack:1:0x${'11'.repeat(20)}`;
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-same-token-market',
      makerEntityId: entity('c1'),
      hubEntityId: entity('c2'),
      bookOwnerEntityId: entity('c3'),
      source: {
        jurisdiction: sourceRef,
        entityId: entity('c1'),
        counterpartyEntityId: entity('c2'),
        tokenId: 1,
        amount: 2_000_000_000_000n,
      },
      target: {
        jurisdiction: targetRef,
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

    expect(market?.pairId).toBe(`cross:${targetRef}:1/${sourceRef}:1`);
    expect(market?.side).toBe(0);
    expect(market?.baseAmount).toBe(1_000_000_000_000n);
    expect(market?.quoteAmount).toBe(2_000_000_000_000n);
    expect(market?.priceTicks).toBe(20_000n);
  });

  test('cross-j market keeps USD stables as quote independently from numeric-chain book ownership', () => {
    const sourceHub = entity('stable-source-hub');
    const targetHub = entity('stable-target-hub');
    const tronRef = `stack:728126428:0x${'31'.repeat(20)}`;
    const testnetRef = `stack:11155111:0x${'21'.repeat(20)}`;

    const sourceStableToTargetEth = deriveCanonicalCrossJurisdictionMarketForLegs(tronRef, 3, testnetRef, 2);
    expect(sourceStableToTargetEth.sourceIsBase).toBe(false);
    expect(sourceStableToTargetEth.baseKey).toBe(`${testnetRef}:2`);
    expect(sourceStableToTargetEth.quoteKey).toBe(`${tronRef}:3`);
    expect(sourceStableToTargetEth.venueId).toBe(`cross:${testnetRef}:2/${tronRef}:3`);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      tronRef,
      sourceHub,
      testnetRef,
      targetHub,
    )).toBe(targetHub);

    const sourceEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs(testnetRef, 2, tronRef, 3);
    expect(sourceEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceEthToTargetStable.baseKey).toBe(`${testnetRef}:2`);
    expect(sourceEthToTargetStable.quoteKey).toBe(`${tronRef}:3`);
    expect(sourceEthToTargetStable.venueId).toBe(`cross:${testnetRef}:2/${tronRef}:3`);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      testnetRef,
      targetHub,
      tronRef,
      sourceHub,
    )).toBe(targetHub);

    const sourceTronEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs(tronRef, 2, testnetRef, 3);
    expect(sourceTronEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceTronEthToTargetStable.baseKey).toBe(`${tronRef}:2`);
    expect(sourceTronEthToTargetStable.quoteKey).toBe(`${testnetRef}:3`);
    expect(sourceTronEthToTargetStable.venueId).toBe(`cross:${tronRef}:2/${testnetRef}:3`);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      tronRef,
      sourceHub,
      testnetRef,
      targetHub,
    )).toBe(targetHub);
  });

  test('cross-j WETH/stable market offer prices in stable quote units', () => {
    const sourceHub = entity('stable-price-source-hub');
    const targetHub = entity('stable-price-target-hub');
    const sourceRef = `stack:728126428:0x${'31'.repeat(20)}`;
    const targetRef = `stack:11155111:0x${'21'.repeat(20)}`;
    const canonicalMarket = deriveCanonicalCrossJurisdictionMarketForLegs(sourceRef, 2, targetRef, 3);
    expect(canonicalMarket.sourceIsBase).toBe(true);
    expect(canonicalMarket.baseKey).toBe(`${sourceRef}:2`);
    expect(canonicalMarket.quoteKey).toBe(`${targetRef}:3`);
    expect(canonicalMarket.venueId).toBe(`cross:${sourceRef}:2/${targetRef}:3`);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-tron-weth-testnet-usdt-price',
        makerEntityId: entity('stable-price-maker'),
        hubEntityId: sourceHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: sourceRef,
          entityId: entity('stable-price-maker'),
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 1_000_000_000_000_000_000n,
        },
        target: {
          jurisdiction: targetRef,
          entityId: targetHub,
          counterpartyEntityId: entity('stable-price-taker'),
          tokenId: 3,
          amount: 2_500n * 10n ** 6n,
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

    expect(market?.pairId).toBe(`cross:${sourceRef}:2/${targetRef}:3`);
    expect(market?.side).toBe(1);
    expect(market?.baseAmount).toBe(route.source.amount);
    expect(market?.quoteAmount).toBe(route.target.amount);
    expect(market?.priceTicks).toBe(25_000_000n);
  });

  test('cross-j stable/WETH market offer keeps stable quote units when source is stable', () => {
    const sourceHub = entity('stable-source-quote-hub');
    const targetHub = entity('stable-target-base-hub');
    const sourceRef = `stack:728126428:0x${'31'.repeat(20)}`;
    const targetRef = `stack:11155111:0x${'21'.repeat(20)}`;
    const canonicalMarket = deriveCanonicalCrossJurisdictionMarketForLegs(sourceRef, 3, targetRef, 2);
    expect(canonicalMarket.sourceIsBase).toBe(false);
    expect(canonicalMarket.baseKey).toBe(`${targetRef}:2`);
    expect(canonicalMarket.quoteKey).toBe(`${sourceRef}:3`);
    expect(canonicalMarket.venueId).toBe(`cross:${targetRef}:2/${sourceRef}:3`);
    const route = {
      ...buildPreparedCrossJurisdictionRoute({
        orderId: 'cross-tron-usdt-testnet-weth-price',
        makerEntityId: entity('stable-source-quote-maker'),
        hubEntityId: sourceHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: sourceRef,
          entityId: entity('stable-source-quote-maker'),
          counterpartyEntityId: sourceHub,
          tokenId: 3,
          amount: 2_500n * 10n ** 6n,
        },
        target: {
          jurisdiction: targetRef,
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

    expect(market?.pairId).toBe(`cross:${targetRef}:2/${sourceRef}:3`);
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
    const jurisdictionRef = `stack:31337:0x${'11'.repeat(20)}`;
    expect(() => buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-same-chain-same-token-invalid',
      makerEntityId: entity('d1'),
      hubEntityId: entity('d2'),
      source: {
        jurisdiction: jurisdictionRef,
        entityId: entity('d1'),
        counterpartyEntityId: entity('d2'),
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jurisdictionRef,
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
    })).toThrow(/CROSS_J_REQUIRES_DISTINCT_STACKS/);
  });
});
