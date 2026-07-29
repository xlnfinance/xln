import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../state-helpers';

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
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../runtime/jurisdiction-api';

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

import { createDefaultDelta } from '../account/delta';

import { cloneAccountState, cloneEntityReplica, cloneEntityState } from '../state-helpers';

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
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j/index';

import {
  buildCrossJurisdictionCancelAck,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
  resolveCrossJurisdictionExecutionPriceTicks,
} from '../extensions/cross-j/orderbook';

import { buildCrossJurisdictionPendingFillFromAck } from '../extensions/cross-j/fill-ack';

import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';

import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account/utils';

import { normalizeEntitySwapTradingPairs } from '../runtime/swap-pairs';

import { verifyHashLadderBinary } from '../protocol/htlc/hash-ladder';

import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, quoteAmountAtPrice } from '../orderbook/types';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';

import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../protocol/dispute/arguments';

import { signEntityHashes } from '../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../entity/consensus/output-certification';

import { queueCrossJurisdictionSourceDisputeFromTargetDispute } from '../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../runtime/entity-inputs';

import { crossBookQtyLots } from '../entity/tx/handlers/account/orderbook-matching-cross';

import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../runtime/entity-routing';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../runtime/output-routing';

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

import { assertRuntimeOutputAuthorization } from '../entity/authorization';

import { cloneIsolatedRoutedEntityInputs } from '../protocol/runtime-input-clone';

import { createDueScheduledWakeInputs } from '../runtime/scheduled-wake';

import { ACCOUNT_PENDING_RESEND_AFTER_MS } from '../entity/scheduler';

const makeLocalCrossJRoutingDeps = (): RuntimeEntityRoutingDeps => ({
  ensureRuntimeState: current => {
    if (!current.runtimeState) throw new Error('TEST_RUNTIME_STATE_REQUIRED');
    return current.runtimeState;
  },
  enqueueRuntimeInputs: () => {
    throw new Error('TEST_UNEXPECTED_RUNTIME_REQUEUE');
  },
  extractEntityId: replicaKey => replicaKey.split(':')[0] || '',
  hasLocalSignerForEntity: (current, entityId) =>
    Array.from(current.eReplicas.values()).some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase()),
  hasLocalSignerForEntitySigner: (current, entityId, signerId) =>
    Array.from(current.eReplicas.values()).some(
      replica =>
        replica.entityId.toLowerCase() === entityId.toLowerCase() &&
        replica.signerId.toLowerCase() === signerId.toLowerCase(),
    ),
  resolveSoleLocalSignerForEntity: (current, entityId) => {
    const signers = Array.from(current.eReplicas.values())
      .filter(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())
      .map(replica => replica.signerId);
    return signers.length === 1 ? signers[0]! : null;
  },
  getP2P: () => null,
});

describe('cross-jurisdiction hashledger swap', () => {
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
        ...buildPreparedCrossJurisdictionRoute(
          {
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
          },
          { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
        ),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
  };

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

    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs?.[0]?.tx.type).toBe('htlc_lock');
    expect((result.accountTxs?.[0]?.tx as any).data.envelope).toBeUndefined();
    expect(result.newState.htlcRoutes.get(hashlock)?.outboundLockId).toBe(`0x${'55'.repeat(32)}`);
    expect(result.newState.lockBook.get(`0x${'55'.repeat(32)}`)?.direction).toBe('outgoing');
  });

  test('cross-j close proposals are accepted only as one exact source+target cohort', () => {
    const env = createEmptyEnv('cross-j-close-cohort');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Source', 1, '11', '12');
    const targetJ = makeJurisdiction('Target', 2, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceUserSigner = addr('55');
    const targetUserSigner = addr('56');
    addReplica(env, makeState(sourceUser, sourceUserSigner, sourceJ, sourceHub), sourceUserSigner);
    addReplica(env, makeState(targetUser, targetUserSigner, targetJ, targetHub), targetUserSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-j-close-cohort',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
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
        status: 'clearing',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    const proof = buildCrossJurisdictionCloseProof(route, '0x');
    const closeInput = (
      entityId: string,
      signerId: string,
      fromEntityId: string,
      pullId: string,
      account: ReturnType<typeof makeAccount>,
      txProof = proof,
    ): RoutedEntityInput => ({
      entityId,
      signerId,
      from: env.runtimeId,
      runtimeId: env.runtimeId,
      sourceRuntimeFrame: { height: 7, timestamp: env.timestamp },
      entityTxs: [
        {
          type: 'accountInput',
          data: {
            kind: 'frame',
            fromEntityId,
            toEntityId: entityId,
            domain: account.domain,
            proposal: {
              frame: {
                ...account.currentFrame,
                height: 1,
                timestamp: env.timestamp,
                stateHash: secret('57'),
                accountStateRoot: secret('58'),
                accountTxs: [
                  {
                    type: 'cross_pull_close',
                    data: { pullId, binary: '0x', proof: txProof },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    const sourceInput = closeInput(
      sourceUser,
      sourceUserSigner,
      sourceHub,
      route.sourcePull!.pullId,
      makeAccount(sourceUser, sourceHub, sourceJ),
    );
    const targetInput = closeInput(
      targetUser,
      targetUserSigner,
      targetHub,
      route.targetPull!.pullId,
      makeAccount(targetUser, targetHub, targetJ),
    );

    expect(selectPotentialCrossJAccountInputPairs([sourceInput])).toEqual([]);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput]).inputs).toEqual([]);
    expect(selectPotentialCrossJAccountInputPairs([sourceInput, targetInput])).toHaveLength(1);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput, targetInput])).toMatchObject({
      inputs: [sourceInput, targetInput],
      droppedInputIndexes: [],
    });

    const mismatchedTarget = closeInput(
      targetUser,
      targetUserSigner,
      targetHub,
      route.targetPull!.pullId,
      makeAccount(targetUser, targetHub, targetJ),
      { ...proof, cumulativeTargetAmount: proof.cumulativeTargetAmount + 1n },
    );
    expect(selectPotentialCrossJAccountInputPairs([sourceInput, mismatchedTarget])).toEqual([]);
    expect(selectMatchedCrossJAccountInputPairs(env, [sourceInput, mismatchedTarget]).inputs).toEqual([]);
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
    const preparedRoute = (
      materialized[0] as Extract<
        EntityTx,
        {
          type: 'materializeCrossJurisdictionSwap';
        }
      >
    ).data.route;
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

    expect(proposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(validatorRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(validator.outputs).toEqual(proposer.outputs);
    expect(validatorRegistered.accountTxs).toEqual(proposerRegistered.accountTxs);

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
      account.pulls = new Map([
        [
          clearingRoute.sourcePull.pullId,
          {
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
          },
        ],
      ]);
      return next;
    };
    const rawClear = {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: baseRoute.orderId, cancelRemainder: true },
    } as const;
    const proposerClear = await applyEntityTx(proposerEnv, buildClearingState(proposerRegistered.newState), rawClear);
    const validatorClear = await applyEntityTx(
      validatorEnv,
      buildClearingState(validatorRegistered.newState),
      rawClear,
    );
    expect(proposerClear.accountTxs).toEqual([]);
    expect(validatorClear.accountTxs).toEqual([]);
    expect(proposerClear.outputs).toEqual([{ entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] }]);
    expect(validatorClear.outputs).toEqual(proposerClear.outputs);
    const clearingReplica = {
      ...proposerReplica,
      state: proposerClear.newState,
    };
    const clearMaterialization = appendDefaultProposerCrossJMaterializations(proposerEnv, clearingReplica, []);
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
    expect(validatorMaterializedClear.accountTxs).toEqual(proposerMaterializedClear.accountTxs);
    expect(validatorMaterializedClear.outputs).toEqual(proposerMaterializedClear.outputs);
    expect(validatorMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(
      proposerMaterializedClear.newState.crossJurisdictionSwaps?.get(baseRoute.orderId),
    );
    const verifiedClose = proposerMaterializedClear.accountTxs?.find(op => op.tx.type === 'cross_pull_close')?.tx;
    if (verifiedClose?.type !== 'cross_pull_close') throw new Error('TEST_CROSS_J_CLOSE_REQUIRED');
    expect(
      verifyHashLadderBinary(
        {
          fullHash: preparedRoute.sourcePull!.fullHash,
          partialRoot: preparedRoute.sourcePull!.partialRoot,
        },
        verifiedClose.data.binary,
      ).fillRatio,
    ).toBe(32_768);

    const delayedProposerState = cloneEntityState(proposerRaw.newState);
    const delayedValidatorState = cloneEntityState(validatorRaw.newState);
    delayedProposerState.timestamp = 12_000;
    delayedValidatorState.timestamp = 12_000;
    const [delayedProposer, delayedValidator] = await Promise.all([
      applyEntityTx(proposerEnv, delayedProposerState, materialized[0]!),
      applyEntityTx(validatorEnv, delayedValidatorState, materialized[0]!),
    ]);
    const delayedProposerRegistered = await applyEntityTx(proposerEnv, delayedProposer.newState, sourceRegistration);
    const delayedValidatorRegistered = await applyEntityTx(validatorEnv, delayedValidator.newState, sourceRegistration);
    expect(delayedProposerRegistered.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toEqual(
      preparedRoute.sourcePull,
    );
    expect(delayedValidator.outputs).toEqual(delayedProposer.outputs);
    expect(delayedValidatorRegistered.accountTxs).toEqual(delayedProposerRegistered.accountTxs);

    const tamperedRoute = {
      ...preparedRoute,
      targetPull: {
        ...preparedRoute.targetPull!,
        fullHash: secret('ff'),
      },
    };
    const tamperState = cloneEntityState(proposerRaw.newState);
    await expect(
      applyEntityTx(proposerEnv, tamperState, {
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: tamperedRoute },
      }),
    ).rejects.toThrow('CROSS_J_PREPARED_FULL_HASH_MISMATCH');
    expect(tamperState.crossJurisdictionSwaps?.get(baseRoute.orderId)?.sourcePull).toBeUndefined();

    const exactRetry = await applyEntityTx(proposerEnv, proposerRaw.newState, rawTx);
    expect(exactRetry.outputs).toHaveLength(0);
    expect(exactRetry.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);
    const conflictingIntent = cloneCrossJurisdictionRoute(baseRoute);
    conflictingIntent.targetSignerId = addr('99');
    await expect(
      applyEntityTx(proposerEnv, proposerRaw.newState, {
        type: 'prepareCrossJurisdictionSwap',
        data: { route: conflictingIntent },
      }),
    ).rejects.toThrow('CROSS_J_RAW_PREPARE_CONFLICT');
    expect(proposerRaw.newState.crossJurisdictionSwaps?.get(baseRoute.orderId)).toEqual(baseRoute);

    const mismatchedMaterialization = cloneCrossJurisdictionRoute(preparedRoute);
    mismatchedMaterialization.targetSignerId = addr('99');
    await expect(
      applyEntityTx(proposerEnv, proposerRaw.newState, {
        type: 'materializeCrossJurisdictionSwap',
        data: { proposerSignerId: sourceHubSigner, route: mismatchedMaterialization },
      }),
    ).rejects.toThrow('CROSS_J_MATERIALIZE_INTENT_MISMATCH');
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
    } as RuntimeState['gossip'];
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
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: sourceHubSigner, route: prepared },
        },
      ],
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
    expect(
      targetCommit.outputs.flatMap(output => output.entityTxs ?? []).some(tx => tx.type === 'consensusOutput'),
    ).toBe(false);
    expect(
      selectCrossJOpeningAccountProposalTxs(
        env,
        targetCommit.newState,
        targetCommit.newState.accounts.get(targetUser)!,
      ),
    ).toBeNull();

    const sourceLocalOutput = sourceCommit.outputs.find(output => output.entityId === sourceHub)!;
    const sourceRegistration = await applyEntityInput(env, sourceCommit.workingReplica, sourceLocalOutput);
    env.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, sourceRegistration.workingReplica);
    env.eReplicas.set(`${targetHub}:${targetHubSigner}`, targetCommit.workingReplica);
    expect(
      selectCrossJOpeningAccountProposalTxs(
        env,
        targetCommit.newState,
        targetCommit.newState.accounts.get(targetUser)!,
      ),
    ).not.toBeNull();

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
    expect(selected?.[0]?.type === 'pull_lock' && selected[0].data.crossJurisdiction?.orderId).toBe(intent.orderId);
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
    } as RuntimeState['gossip'];
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
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: sourceHubSigner, route: prepared },
        },
      ],
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
      entityTxs: [
        {
          type: 'materializeCrossJurisdictionSwap',
          data: { proposerSignerId: targetHubSigner, route: reversePrepared },
        },
      ],
    };

    const saturatedEnv = createEmptyEnv(`${seed}-saturated-local-event`);
    saturatedEnv.timestamp = env.timestamp;
    saturatedEnv.quietRuntimeLogs = true;
    installJurisdictions(saturatedEnv, sourceJ, targetJ);
    registerTestSigner(saturatedEnv, seed, '1');
    registerTestSigner(saturatedEnv, seed, '2');
    saturatedEnv.gossip = env.gossip;
    saturatedEnv.eReplicas = new Map([...env.eReplicas].map(([key, replica]) => [key, cloneEntityReplica(replica)]));
    const saturatedTarget = saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)!;
    saturatedTarget.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => ({
      type: 'chatMessage' as const,
      data: { message: 'fills external target mempool', timestamp: saturatedEnv.timestamp },
    }));

    const saturated = await applyMergedEntityInputs(saturatedEnv, [sourceInput], [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
    });
    expect(saturated.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub]);
    const committedSaturatedTarget = saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)!.state;
    expect(committedSaturatedTarget.height).toBe(targetHeight + 1);
    expect(committedSaturatedTarget.crossJurisdictionSwaps?.get(intent.orderId)?.routeHash).toBe(intent.routeHash);
    expect(saturatedEnv.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.mempool).toHaveLength(LIMITS.MEMPOOL_SIZE);

    sourceState.crossJurisdictionSwaps?.set(secondForwardIntent.orderId, secondForwardIntent);
    targetState.crossJurisdictionSwaps?.set(reverseIntent.orderId, reverseIntent);
    const pass = await applyMergedEntityInputs(env, [sourceInput, reverseInput], [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
    });

    expect(env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.height).toBe(sourceHeight + 3);
    expect(env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.height).toBe(targetHeight + 3);
    expect(
      env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.crossJurisdictionSwaps?.get(intent.orderId)
        ?.routeHash,
    ).toBe(intent.routeHash);
    expect(pass.appliedEntityInputs.map(input => input.entityId)).toEqual([sourceHub, targetHub]);
    expect(pass.localCrossJurisdictionEventTrace.map(input => input.entityId)).toEqual([
      sourceHub,
      targetHub,
      targetHub,
      sourceHub,
    ]);
    expect(
      pass.localCrossJurisdictionEventTrace.map(input =>
        input.entityTxs[0]?.type === 'runtimeOutput' ? input.entityTxs[0].data.entityTxs.length : 0,
      ),
    ).toEqual([2, 2, 1, 1]);
    const crossJOrderIds = (txs: readonly AccountTx[]): string[] =>
      txs.flatMap(tx => {
        if (tx.type === 'pull_lock') return tx.data.crossJurisdiction?.orderId ?? [];
        if (tx.type === 'swap_offer') return tx.data.crossJurisdiction?.orderId ?? [];
        return [];
      });
    const registeredOrderIds = new Set([intent.orderId, secondForwardIntent.orderId, reverseIntent.orderId]);
    const sourceRegisteredAccount = env.eReplicas
      .get(`${sourceHub}:${sourceHubSigner}`)!
      .state.accounts.get(sourceUser)!;
    const targetRegisteredAccount = env.eReplicas
      .get(`${targetHub}:${targetHubSigner}`)!
      .state.accounts.get(targetUser)!;
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
    expect(env.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.height).toBe(sourceHeight + 4);
    expect(env.eReplicas.get(`${targetHub}:${targetHubSigner}`)?.state.height).toBe(targetHeight + 4);
    expect(
      wakePass.entityOutbox
        .map(output => ({
          entityId: output.entityId,
          txTypes: output.entityTxs?.map(tx => tx.type) ?? [],
        }))
        .sort((left, right) => left.entityId.localeCompare(right.entityId)),
    ).toEqual(
      [
        {
          entityId: sourceUser,
          txTypes: ['consensusOutput'],
        },
        {
          entityId: targetUser,
          txTypes: ['consensusOutput'],
        },
      ].sort((left, right) => left.entityId.localeCompare(right.entityId)),
    );
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

    const hubProposalPass = await applyMergedEntityInputs(
      hubEnv,
      [
        {
          entityId: sourceHub,
          signerId: sourceHubSigner,
          entityTxs: [
            {
              type: 'materializeCrossJurisdictionSwap',
              data: { proposerSignerId: sourceHubSigner, route: prepared },
            },
          ],
        },
      ],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
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
    expect(hubWakePass.entityOutbox.map(output => output.entityId).sort()).toEqual([sourceUser, targetUser].sort());

    const hubOnlySourceAccount = hubEnv.eReplicas
      .get(`${sourceHub}:${sourceHubSigner}`)!
      .state.accounts.get(sourceUser)!;
    const hubOnlyTargetAccount = hubEnv.eReplicas
      .get(`${targetHub}:${targetHubSigner}`)!
      .state.accounts.get(targetUser)!;
    expect(hubOnlySourceAccount.pendingFrame?.accountTxs.map(tx => tx.type)).toEqual(['pull_lock', 'swap_offer']);
    expect(hubOnlyTargetAccount.pendingFrame?.accountTxs.map(tx => tx.type)).toEqual(['pull_lock']);
    expect(hubOnlySourceAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlyTargetAccount.currentFrame.accountTxs).toEqual([]);
    expect(hubOnlySourceAccount.pulls?.has(prepared.sourcePull!.pullId) ?? false).toBe(false);
    expect(hubOnlySourceAccount.swapOffers.has(prepared.orderId)).toBe(false);
    expect(buildAccountProofBody(hubOnlySourceAccount, '').runtimeProofBody.transformers).toEqual([]);
    const hubOnlyResolve = await applyAccountTx(
      cloneAccountState(hubOnlySourceAccount),
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
      const cohort = repeatedCohorts.filter(
        candidate =>
          candidate.sourceRuntimeFrame?.height === frame.height &&
          candidate.sourceRuntimeFrame.timestamp === frame.timestamp,
      );
      const pairKey = selectPotentialCrossJAccountInputPairs(cohort)[0]!.pairKey;
      return { ...input, atomicCrossJurisdictionPair: { phase: 'proposal' as const, pairKey } };
    });
    const mergedRepeatedCohorts = mergeEntityInputs(atomicRepeatedCohorts);
    expect(mergedRepeatedCohorts).toHaveLength(4);
    expect(selectPotentialCrossJAccountInputPairs(mergedRepeatedCohorts)).toHaveLength(2);
    const reversedProposals = [...proposals].reverse();
    const structuralPair = selectPotentialCrossJAccountInputPairs(reversedProposals)[0]!;
    expect(
      validateInboundP2PEntityInputsEnvelope(
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
      ),
    ).toHaveLength(2);
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!]).inputs).toEqual([]);
    const ordinaryUserInput = { entityId: sourceUser, signerId: sourceUserSigner, entityTxs: [] };
    expect(selectMatchedCrossJAccountInputPairs(userEnv, [proposals[0]!, ordinaryUserInput]).inputs).toEqual([
      ordinaryUserInput,
    ]);
    const proposalSelection = selectMatchedCrossJAccountInputPairs(userEnv, proposals);
    expect(proposalSelection.pairs.map(pair => pair.phase)).toEqual(['proposal']);
    expect(proposalSelection.droppedInputIndexes).toEqual([]);

    const proposalFrame = (input: RoutedEntityInput) => {
      const accountInput = getEffectiveEntityInputTxs(input).flatMap(tx =>
        tx.type === 'accountInput' ? [tx.data] : [],
      )[0];
      const proposal = accountInput ? accountInputProposal(accountInput) : undefined;
      if (!proposal) throw new Error(`TEST_CROSS_J_PROPOSAL_MISSING:${input.entityId}`);
      return proposal;
    };
    const targetPull = (inputs: RoutedEntityInput[]) => {
      const targetInput = inputs.find(input => input.entityId === targetUser);
      const pull =
        targetInput &&
        proposalFrame(targetInput).frame.accountTxs.find(
          tx => tx.type === 'pull_lock' && tx.data.crossJurisdiction?.leg === 'target',
        );
      if (!pull || pull.type !== 'pull_lock') throw new Error('TEST_CROSS_J_TARGET_PULL_MISSING');
      return pull;
    };
    const corruptions: Array<{
      name: string;
      mutate(inputs: RoutedEntityInput[]): void;
    }> = [
      {
        name: 'cohort frame',
        mutate: inputs => {
          inputs[1]!.sourceRuntimeFrame!.height += 1;
        },
      },
      {
        name: 'route hash',
        mutate: inputs => {
          targetPull(inputs).data.crossJurisdiction!.routeHash = `0x${'f1'.repeat(32)}`;
        },
      },
      {
        name: 'target entity',
        mutate: inputs => {
          targetPull(inputs).data.crossJurisdictionRoute!.target.counterpartyEntityId = entity('ee');
        },
      },
      {
        name: 'asset',
        mutate: inputs => {
          targetPull(inputs).data.tokenId += 1;
        },
      },
      {
        name: 'amount',
        mutate: inputs => {
          targetPull(inputs).data.amount += 1n;
        },
      },
      {
        name: 'full hash',
        mutate: inputs => {
          targetPull(inputs).data.fullHash = `0x${'f2'.repeat(32)}`;
        },
      },
      {
        name: 'partial root',
        mutate: inputs => {
          targetPull(inputs).data.partialRoot = `0x${'f3'.repeat(32)}`;
        },
      },
      {
        name: 'pull id',
        mutate: inputs => {
          targetPull(inputs).data.pullId = 'corrupt-target-pull';
        },
      },
      {
        name: 'deadline',
        mutate: inputs => {
          targetPull(inputs).data.revealedUntilTimestamp += 1;
        },
      },
      {
        name: 'account Hanko',
        mutate: inputs => {
          proposalFrame(inputs[1]!).frameHanko = '0x00';
        },
      },
    ];
    for (const corruption of corruptions) {
      const corrupted = cloneIsolatedRoutedEntityInputs(proposals);
      corruption.mutate(corrupted);
      const replicasBefore = [...userEnv.eReplicas.entries()].map(
        ([key, replica]) => [key, cloneEntityReplica(replica)] as const,
      );
      const incidentsBefore = [...(userEnv.runtimeState?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
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
      const incidentsAfter = [...(userEnv.runtimeState?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
      expect(incidentsAfter, corruption.name).toBeGreaterThan(incidentsBefore);
    }

    const validThenCorruptCohorts = cloneIsolatedRoutedEntityInputs(atomicRepeatedCohorts);
    const corruptNewestTarget = validThenCorruptCohorts.find(
      input => input.entityId === targetUser && input.sourceRuntimeFrame?.height === hubFrame.height,
    );
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
    const userAckPass = await applyMergedEntityInputs(userEnv, mergeEntityInputs(preparedUserInputs.inputs), [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
    });
    expect(userAckPass.entityOutbox.map(output => output.entityId).sort()).toEqual([sourceHub, targetHub].sort());
    expect(
      userAckPass.entityOutbox
        .flatMap(output => output.entityTxs ?? [])
        .every(
          tx =>
            tx.type === 'consensusOutput' &&
            tx.data.entityTxs.every(
              inner => inner.type === 'accountInput' && (inner.data.kind === 'ack' || inner.data.kind === 'frame_ack'),
            ),
        ),
    ).toBe(true);
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
        tx.type === 'accountInput' ? [tx.data] : [],
      )[0];
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
        mutate: inputs => {
          inputs[1]!.sourceRuntimeFrame!.height += 1;
        },
      },
      {
        name: 'ACK height',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.height += 1;
        },
      },
      {
        name: 'ACK frame hash',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.frameHash = `0x${'f4'.repeat(32)}`;
        },
      },
      {
        name: 'ACK Hanko',
        mutate: inputs => {
          acknowledgement(inputs[1]!).ack.frameHanko = '0x00';
        },
      },
      {
        name: 'ACK sender entity',
        mutate: inputs => {
          acknowledgement(inputs[1]!).accountInput.fromEntityId = entity('ef');
        },
      },
      {
        name: 'ACK domain',
        mutate: inputs => {
          acknowledgement(inputs[1]!).accountInput.domain.chainId += 1;
        },
      },
    ];
    const ordinaryHubInput = { entityId: sourceHub, signerId: sourceHubSigner, entityTxs: [] };
    for (const corruption of ackCorruptions) {
      const corrupted = cloneIsolatedRoutedEntityInputs(acknowledgements);
      corruption.mutate(corrupted);
      const replicasBefore = [...hubEnv.eReplicas.entries()].map(
        ([key, replica]) => [key, cloneEntityReplica(replica)] as const,
      );
      const incidentsBefore = [...(hubEnv.runtimeState?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
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
      const incidentsAfter = [...(hubEnv.runtimeState?.securityIncidents?.values() ?? [])].reduce(
        (sum, incident) => sum + incident.occurrences,
        0,
      );
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

    hubEnv.timestamp += ACCOUNT_PENDING_RESEND_AFTER_MS + 1;
    const dueWake = createDueScheduledWakeInputs(hubEnv, hubEnv.timestamp).find(input => input.entityId === sourceHub);
    if (!dueWake) throw new Error('TEST_CROSS_J_SOURCE_HUB_WAKE_MISSING');
    expect(
      dueWake.entityTxs?.flatMap(tx => (tx.type === 'scheduledWake' ? tx.data.jobs.map(job => job.id) : [])),
    ).toContain('maintainPendingAccounts');
    const preparedHubInputsWithWake = await prepareAtomicCrossJAccountInputs(
      hubEnv,
      mergeEntityInputs([...acknowledgements, dueWake]),
      [],
      false,
      makeLocalCrossJRoutingDeps(),
    );
    expect(preparedHubInputsWithWake.pairs.map(pair => pair.phase)).toEqual(['ack']);
    expect(
      preparedHubInputsWithWake.inputs.slice(0, 2).every(input => input.atomicCrossJurisdictionPair?.phase === 'ack'),
    ).toBe(true);
    expect(preparedHubInputsWithWake.inputs[2]?.entityTxs?.some(tx => tx.type === 'scheduledWake')).toBe(true);
    expect(
      preparedHubInputsWithWake.inputs.some(input => input.entityTxs?.some(tx => tx.type === 'scheduledWake')),
    ).toBe(true);

    const preparedHubInputs = await prepareAtomicCrossJAccountInputs(
      hubEnv,
      acknowledgements,
      [],
      false,
      makeLocalCrossJRoutingDeps(),
    );
    const hubAckPass = await applyMergedEntityInputs(hubEnv, mergeEntityInputs(preparedHubInputs.inputs), [], {
      isReplay: false,
      routingDeps: makeLocalCrossJRoutingDeps(),
    });
    expect(
      hubEnv.eReplicas
        .get(`${sourceHub}:${sourceHubSigner}`)
        ?.state.accounts.get(sourceUser)
        ?.currentFrame.accountTxs.map(tx => tx.type),
    ).toEqual(['pull_lock', 'swap_offer']);
    expect(
      hubEnv.eReplicas
        .get(`${targetHub}:${targetHubSigner}`)
        ?.state.accounts.get(targetUser)
        ?.currentFrame.accountTxs.map(tx => tx.type),
    ).toEqual(['pull_lock']);
    expect(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.state.orderbookExt?.books.size).toBe(1);
    expect(hubAckPass.entityOutbox).toEqual([]);
    expect(
      hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)?.mempool.some(entityTxContainsCrossJMaterialization),
    ).toBe(true);

    const retainedProposalCohort = rescheduleDeferredOutputs(hubEnv, [], proposals, [], makeLocalCrossJRoutingDeps());
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
    env.runtimeState!.lifecyclePhase = 'running';
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
    registerEntityRuntimeHintWithDeps(env, sourceHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(env, targetHub, hubEnv.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(hubEnv, sourceUser, env.runtimeId!, routingDeps);
    registerEntityRuntimeHintWithDeps(hubEnv, targetUser, env.runtimeId!, routingDeps);
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
    await expect(
      submitCrossJurisdictionSwap(env, {
        ...submitParams,
        targetAmount: 91n,
      }),
    ).rejects.toThrow('INBOUND_CROSS_J_INTENT_ORDER_ID_CONFLICT');
    expect(directAttempts).toBe(3);
    expect(relayAttempts).toBe(3);
    expect([...hubEnv.runtimeState!.securityIncidents!.values()].map(incident => incident.code)).toContain(
      'CROSS_J_INTENT_ORDER_ID_CONFLICT',
    );
    const targetReceivingAccount = targetUserState.accounts.get(targetHub)!;
    const targetReceivingDelta = targetReceivingAccount.deltas.get(1)!;
    const previousLeftCredit = targetReceivingDelta.leftCreditLimit;
    const previousRightCredit = targetReceivingDelta.rightCreditLimit;
    targetReceivingDelta.leftCreditLimit = 0n;
    targetReceivingDelta.rightCreditLimit = 0n;
    await expect(submitCrossJurisdictionIntent(env, result.route)).rejects.toThrow('CROSS_J_TARGET_INBOUND_NOT_READY');
    expect(directAttempts).toBe(3);
    expect(relayAttempts).toBe(3);
    targetReceivingDelta.leftCreditLimit = previousLeftCredit;
    targetReceivingDelta.rightCreditLimit = previousRightCredit;

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
    expect(requested.accountTxs).toBeUndefined();
    const sourceHubReplica = {
      ...(hubEnv.eReplicas.get(`${sourceHub}:${sourceHubSigner}`) as EntityReplica),
      state: requested.newState,
    };
    const materialized = appendDefaultProposerCrossJMaterializations(hubEnv, sourceHubReplica, []);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.type).toBe('materializeCrossJurisdictionSwap');
    const prepared = await applyEntityTx(hubEnv, requested.newState, materialized[0]!);
    expect(prepared.accountTxs).toBeUndefined();
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
    expect(sourceRegistration.accountTxs?.map(op => op.tx.type)).toEqual(['pull_lock', 'swap_offer']);
    expect(targetRegistration.accountTxs?.map(op => op.tx.type)).toEqual(['pull_lock']);
    expect((targetRegistration.accountTxs?.[0]?.tx as any).data.crossJurisdiction).toMatchObject({
      orderId: preparedRoute.orderId,
      routeHash: preparedRoute.routeHash,
      leg: 'target',
    });
    expect(
      preparedRoute.targetPull.revealedUntilTimestamp - preparedRoute.sourcePull.revealedUntilTimestamp,
    ).toBeGreaterThanOrEqual(5_000 + CROSS_J_TARGET_REVEAL_SAFETY_MS);
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
      source: {
        jurisdiction: jref(sourceUserAliasJurisdiction),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(targetJurisdiction),
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 900n,
      },
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
    const preparedRoute = (
      targetHubOutput?.entityTxs?.find(tx => tx.type === 'registerCrossJurisdictionSwap')?.data as any
    )?.route;
    expect(preparedRoute.source.jurisdiction).toBe(jref(sourceUserAliasJurisdiction));
    expect(preparedRoute.routeHash).toBe(staleIntent.routeHash);
    expect(preparedRoute.sourcePull.fullHash).toBe(preparedRoute.targetPull.fullHash);
    const sourceRegistration = await applyEntityTx(env, preparedResult.newState, sourceHubOutput!.entityTxs![0]!);
    const sourcePullTx = sourceRegistration.accountTxs?.find(op => op.tx.type === 'pull_lock')?.tx as
      Extract<AccountTx, { type: 'pull_lock' }> | undefined;
    const swapOfferTx = sourceRegistration.accountTxs?.find(op => op.tx.type === 'swap_offer')?.tx as
      Extract<AccountTx, { type: 'swap_offer' }> | undefined;
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
    sourceAccount.pulls = new Map([
      [
        clearingRoute.sourcePull.pullId,
        {
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
        },
      ],
    ]);

    const clearResult = await applyEntityTx(env, clearingHubState, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: clearingRoute.orderId, cancelRemainder: true },
    });
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(
      env,
      {
        entityId: sourceHub,
        signerId: addr('ae'),
        entityEncPubKey: '',
        entityEncPrivKey: '',
        state: clearResult.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const materializedClear = await applyEntityTx(env, clearResult.newState, clearMaterialization!);
    const resolveTx = materializedClear.accountTxs?.find(op => op.tx.type === 'cross_pull_close')?.tx as any;
    expect(resolveTx?.data.pullId).toBe(clearingRoute.sourcePull.pullId);
    expect(resolveTx?.data.proof.routeHash).toBe(clearingRoute.routeHash);
    expect(() =>
      verifyHashLadderBinary(
        {
          fullHash: clearingRoute.sourcePull.fullHash,
          partialRoot: clearingRoute.sourcePull.partialRoot,
        },
        resolveTx.data.binary,
      ),
    ).not.toThrow();
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
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-exact-only-pending',
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeFillRatio).toBe(32_768);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeSourceAmount).toBe(500n);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeTargetAmount).toBe(450n);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    expect(readEntityFrameEventMessages(result.newState).at(-1)).not.toContain('no pending fill');
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
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-resolve-exact-only-binding',
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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
    account.pulls = new Map([
      [
        sourcePull.pullId,
        {
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
        },
      ],
    ]);
    const binary = buildCrossJurisdictionPullReveal(
      route,
      32_768,
      deriveCrossJurisdictionPrivateSeed(env.runtimeSeed, route),
    ).binary;

    const result = await applyAccountTx(
      account,
      {
        type: 'pull_resolve',
        data: { pullId: sourcePull.pullId, binary },
      },
      beneficiaryIsLeft,
      env.timestamp,
      1,
    );

    expect(result.success, result.error).toBe(true);
    expect(account.pulls?.get(sourcePull.pullId)?.claimedRatio).toBe(32_768);
    expect(account.pulls?.get(sourcePull.pullId)?.claimedAmount).toBe(500n);
  });

  test('source Account never lets the user sibling relay target close economics', () => {
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-hub-relay',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: sourceUserSigner,
        sourceHubSignerId: sourceHubSigner,
        targetHubSignerId: targetHubSigner,
        targetSignerId: targetUserSigner,
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
        status: 'resting',
        createdAt: hubEnv.timestamp,
        updatedAt: hubEnv.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-source-hub-relay-seed', sourceDisputeDelayMs: 5_000, now: hubEnv.timestamp },
    );
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
    expect(userOutputs).toEqual([]);
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-stale-claim',
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-source-stale-claim-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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

    expect(() =>
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        sourceHubState,
        sourceUser,
        {
          type: 'pull_resolve',
          data: {
            pullId: filledRoute.sourcePull!.pullId,
            binary: staleBinary,
          },
        },
        [],
      ),
    ).toThrow('CROSS_J_CLAIM_PROGRESS_INVALID');
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-delayed-fill-ack',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: sourceUserSigner,
        targetSignerId: targetUserSigner,
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-source-delayed-fill-ack-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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

    expect(
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        sourceUserState,
        sourceHub,
        {
          type: 'pull_resolve',
          data: {
            pullId: clearingRoute.sourcePull!.pullId,
            binary,
          },
        },
        outputs,
        env.timestamp,
        [],
      ),
    ).toBe(true);

    const updated = sourceUserState.crossJurisdictionSwaps?.get(clearingRoute.orderId);
    expect(updated?.status).toBe('source_claimed');
    expect(updated?.fillSeq).toBe(1);
    expect(updated?.cumulativeFillRatio).toBe(0x8000);
    expect(updated?.claimedRatio).toBe(0x8000);
    expect(outputs).toEqual([]);
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-exact-only-terminal-fill-followup',
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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

    expect(applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, ackTx, outputs)).toBe(
      true,
    );

    const updated = sourceHubState.crossJurisdictionSwaps?.get(route.orderId);
    expect(updated?.status).toBe('clear_requested');
    expect(updated?.cumulativeFillRatio).toBe(65_535);
    expect(updated?.fillNumerator).toBe(1n);
    expect(updated?.fillDenominator).toBe(1n);
    expect(
      outputs.some(
        output =>
          output.entityId === sourceHub && output.entityTxs?.some(tx => tx.type === 'requestCrossJurisdictionClear'),
      ),
    ).toBe(true);
    expect(outputs.some(output => output.entityTxs?.some(tx => tx.type === 'applyCrossJurisdictionBookProgress'))).toBe(
      false,
    );
  });

  test('target user settlement closes its source user sibling without duplicating book removal', async () => {
    const env = createEmptyEnv('cross-target-remote-book-owner');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('aa');
    const sourceHub = entity('ab');
    const targetHub = entity('ac');
    const targetUser = entity('ad');
    const sourceSigner = addr('a9');
    const targetUserState = makeState(targetUser, addr('ae'), base, targetHub);
    const sourceUserState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    addReplica(env, sourceUserState, sourceSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-target-remote-book-owner',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceSignerId: sourceSigner,
        sourceHubSignerId: addr('af'),
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-target-remote-book-owner-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    const targetRoute = {
      ...route,
      status: 'source_claimed' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0x8000,
    };
    targetUserState.crossJurisdictionSwaps?.set(targetRoute.orderId, targetRoute);
    sourceUserState.crossJurisdictionSwaps?.set(targetRoute.orderId, cloneCrossJurisdictionRoute(targetRoute));
    const privateSeed = deriveCrossJurisdictionPrivateSeed('cross-target-remote-book-owner-seed', targetRoute);
    const binary = buildCrossJurisdictionPullReveal(targetRoute, 0x8000, privateSeed).binary;
    sourceUserState.crossJurisdictionSwaps!.get(targetRoute.orderId)!.sourceCloseProof =
      buildCrossJurisdictionCloseProof(targetRoute, binary);
    const outputs: EntityInput[] = [];

    expect(
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        targetUserState,
        targetHub,
        {
          type: 'pull_resolve',
          data: {
            pullId: targetRoute.targetPull!.pullId,
            binary,
          },
        },
        outputs,
      ),
    ).toBe(true);
    expect(targetUserState.crossJurisdictionSwaps?.get(targetRoute.orderId)?.status).toBe('settled');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(sourceUser);
    expect(outputs[0]?.entityTxs?.map(tx => tx.type)).toEqual(['crossJurisdictionSettled']);
    expect(outputs.some(output => output.entityTxs?.some(tx => tx.type === 'removeCrossJurisdictionBookOrder'))).toBe(
      false,
    );

    const terminalTxs = outputs[0]!.entityTxs!;
    assertRuntimeOutputAuthorization(targetUser, sourceUser, terminalTxs, sourceUserState);
    const sourceResult = await applyEntityTx(env, sourceUserState, terminalTxs[0]!);
    expect(sourceResult.newState.crossJurisdictionSwaps?.get(targetRoute.orderId)?.status).toBe('settled');
    expect(
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        sourceResult.newState,
        sourceHub,
        {
          type: 'pull_resolve',
          data: { pullId: targetRoute.sourcePull!.pullId, binary },
        },
        [],
      ),
    ).toBe(true);
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
    const sourceSigner = addr('a9');
    const targetUserState = makeState(targetUser, addr('ae'), base, targetHub);
    addReplica(env, makeState(sourceUser, sourceSigner, eth, sourceHub), sourceSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-target-delayed-fill-ack',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceSignerId: sourceSigner,
        sourceHubSignerId: addr('af'),
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-target-delayed-fill-ack-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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

    expect(
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        targetUserState,
        targetHub,
        {
          type: 'pull_resolve',
          data: {
            pullId: targetRoute.targetPull!.pullId,
            binary,
          },
        },
        outputs,
      ),
    ).toBe(true);

    const updated = targetUserState.crossJurisdictionSwaps?.get(targetRoute.orderId);
    expect(updated?.status).toBe('settled');
    expect(updated?.fillSeq).toBe(1);
    expect(updated?.cumulativeFillRatio).toBe(0x8000);
    expect(updated?.claimedRatio).toBe(0x8000);
    expect(outputs[0]?.entityTxs?.map((tx: EntityTx) => tx.type)).toEqual(['crossJurisdictionSettled']);
  });

  test('target hub settlement closes only its source hub sibling with exact commitment binding', async () => {
    const seed = 'cross-target-hub-terminal';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('ba');
    const sourceHub = entity('bb');
    const targetHub = entity('bc');
    const targetUser = entity('bd');
    const sourceHubSigner = addr('be');
    const targetHubSigner = addr('bf');
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    addReplica(env, sourceHubState, sourceHubSigner);
    addReplica(env, targetHubState, targetHubSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-target-hub-terminal',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceHubSignerId: sourceHubSigner,
        targetHubSignerId: targetHubSigner,
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
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    const claimedRoute = {
      ...route,
      status: 'source_claimed' as const,
      fillSeq: 1,
      cumulativeFillRatio: 0x8000,
      claimedRatio: 0x8000,
    };
    targetHubState.crossJurisdictionSwaps?.set(route.orderId, {
      ...cloneCrossJurisdictionRoute(route),
      status: 'resting',
      fillSeq: 0,
      cumulativeFillRatio: 0,
      claimedRatio: 0,
    });
    sourceHubState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(claimedRoute));
    sourceHubState.crossJurisdictionSwaps!.get(route.orderId)!.status = 'clearing';
    const binary = buildCrossJurisdictionPullReveal(
      claimedRoute,
      0x8000,
      deriveCrossJurisdictionPrivateSeed(seed, claimedRoute),
    ).binary;
    const outputs: EntityInput[] = [];

    expect(
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        targetHubState,
        targetUser,
        {
          type: 'pull_resolve',
          data: { pullId: claimedRoute.targetPull!.pullId, binary },
        },
        outputs,
      ),
    ).toBe(true);
    expect(targetHubState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('settled');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(sourceHub);
    assertRuntimeOutputAuthorization(targetHub, sourceHub, outputs[0]!.entityTxs!, sourceHubState);

    const sourceResult = await applyEntityTx(env, sourceHubState, outputs[0]!.entityTxs![0]!);
    expect(sourceResult.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('settled');
    expect(sourceResult.newState.crossJurisdictionSwaps?.get(route.orderId)?.sourceCloseProof).toBeDefined();
    const forged = structuredClone(outputs[0]!.entityTxs![0]!) as Extract<
      EntityTx,
      { type: 'crossJurisdictionSettled' }
    >;
    forged.data.routeHash = `0x${'ff'.repeat(32)}`;
    await expect(applyEntityTx(env, sourceHubState, forged)).rejects.toThrow('CROSS_J_SETTLED_ROUTE_HASH_MISMATCH');
  });

  test('cross-j route clones and storage projection keep only public route fields', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(sourceHub, addr('b5'), eth, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-public-route-shape',
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
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-public-route-shape', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
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
        crossJurisdiction: { ...route, __debugOnly: secret('b8') } as any,
      },
    });
    account.swapOrderHistory = new Map([
      [
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
          resolves: [
            {
              fillRatio: 1,
              fillNumerator: 1n,
              fillDenominator: 1n,
              cancelRemainder: false,
              height: 1,
            },
          ],
        } as any,
      ],
    ]);

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
    clonedAccount.swapOrderHistory.get(route.orderId).resolves.push({
      fillRatio: 2,
      fillNumerator: 2n,
      fillDenominator: 1n,
      cancelRemainder: false,
      height: 2,
    });
    expect(account.swapOrderHistory.get(route.orderId)?.resolves).toHaveLength(1);
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
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-public-account-tx',
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
          status: 'resting',
          createdAt: 1_000,
          updatedAt: 1_000,
          expiresAt: 61_000,
        },
        { runtimeSeed: 'cross-public-account-tx', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
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
        crossJurisdiction: route,
      },
    });

    const accountTx = result.accountTxs?.[0]?.tx as any;
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-forged-maker',
        makerEntityId: sourceHub,
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
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-forged-maker', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );

    await expect(
      applyEntityTx(env, sourceUserState, {
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: sourceHub,
          offerId: route.orderId,
          giveTokenId: route.source.tokenId,
          giveAmount: route.source.amount,
          wantTokenId: route.target.tokenId,
          wantAmount: route.target.amount,
          crossJurisdiction: route,
        },
      }),
    ).rejects.toThrow('CROSS_J_SWAP_MAKER_NOT_PROPOSER');
  });
});
