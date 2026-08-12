import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../entity/tx/apply';

import { applyAccountTx } from '../account/tx/apply';

import { proposeAccountFrame } from '../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../account/consensus/flush';

import { computeAccountStateRoot } from '../account/commitment/state-root';

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
} from '../entity/transition/cross-j-proposer-materialization';

import { prepareLocallyAuthoredEntityTxs } from '../entity/command';

import {
  createEmptyEnv,
  handleInboundP2PEntityInputs,
  admitAtomicCrossJAccountInputs,
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../runtime/jurisdiction-api';

import { hashHtlcSecret } from '../protocol/htlc/utils';

import type { AccountTx } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityInput, EntityReplica, EntityState } from '../entity/types';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../runtime/types';
import type { EntityTx } from '../types/entity-tx';
import type { JurisdictionEvent } from '../types/jurisdiction-events';

import { generateLazyEntityId } from '../entity/factory';

import { createDefaultDelta } from '../account/state/delta';

import { cloneAccountReplica } from '../account/state/state-clone';
import { cloneEntityReplica } from '../entity/replica/replica-clone';
import { cloneEntityState } from '../entity/state-clone';

import { projectAccountDoc, projectEntityCoreDoc } from '../storage/read/projections';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity/tx/handlers/account-cross-j-followups';

import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute as buildPreparedCrossJurisdictionRouteCanonical,
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

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;
// Every historical fixture in this suite models the same 10s/10s bilateral
// Account policy. Keep that explicit in one fixture constructor; production
// route construction has no default or compatibility path.
const buildPreparedCrossJurisdictionRoute = (
  route: TestRouteInput,
  options: { runtimeSeed?: string; now: number },
): CrossJurisdictionSwapRoute =>
  buildPreparedCrossJurisdictionRouteCanonical(
    {
      ...route,
      sourceDisputeConfig: TEST_DISPUTE_CONFIG,
      targetDisputeConfig: TEST_DISPUTE_CONFIG,
    } as CrossJurisdictionSwapRoute,
    options,
  );

import {
  buildCrossJurisdictionCancelAck,
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionRouteRemainingAmounts,
  mergeCrossJurisdictionBookAdmission,
  resolveCrossJurisdictionExecutionPriceTicks,
} from '../extensions/cross-j/orderbook';

import { buildCrossJurisdictionPendingFillFromAck } from '../extensions/cross-j/fill-ack';

import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account/utils';

import { normalizeEntitySwapTradingPairs } from '../runtime/finance/swap-pairs';

import { verifyHashLadderBinary } from '../protocol/htlc/hash-ladder';

import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, quoteAmountAtPrice } from '../orderbook/types';
import { cloneJBatch, createEmptyBatch, initJBatch } from '../jurisdiction/machine/batch';
import { applyHankoBatchProcessedEvent } from '../entity/tx/j-events-batch';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';

import {
  buildDisputeArgumentsFromSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';

import { signEntityHashes } from '../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../entity/consensus/output/certification';

import {
  countDeferredHashLadderReveals,
  flushDeferredHashLadderReveals,
  planCrossJurisdictionTargetRecovery,
  queueCrossJurisdictionRevealPorts,
} from '../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../runtime/input-pipeline/entity-inputs';

import { crossBookQtyLots } from '../entity/tx/handlers/account/orderbook-matching';
import { buildFinalProofPayload } from '../entity/tx/handlers/dispute/finalize-proof';

import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../runtime/routing/entity-routing';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../runtime/routing/output-routing';

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

import { recordValidatorJHistory } from '../jurisdiction/machine/local-history';
import { canonicalDisputeFinalizationEvidenceHash } from '../jurisdiction/machine/event-observation';

import { buildLocalEntityProfile } from '../network/p2p/gossip/helper';

import { collectLocalProfileEncryptionAnnouncements } from '../entity/profile/profile-encryption';

import { LIMITS } from '../config/constants';

import { getEffectiveEntityInputTxs } from '../entity/consensus/output/envelope';

import { assertRuntimeOutputAuthorization } from '../entity/auth/authorization';

import { cloneIsolatedRoutedEntityInputs } from '../runtime/input-pipeline/input-clone';

import { createDueScheduledWakeInputs } from '../runtime/input-pipeline/scheduled-wake';

import { ACCOUNT_PENDING_RESEND_AFTER_MS } from '../entity/scheduler';

const makeLocalCrossJRoutingDeps = (): RuntimeEntityRoutingDeps => ({
  ensureRuntimeInfrastructure: current => {
    if (!current.infrastructure) throw new Error('TEST_RUNTIME_STATE_REQUIRED');
    return current.infrastructure;
  },
  enqueueRuntimeInputs: () => {
    throw new Error('TEST_UNEXPECTED_RUNTIME_REQUEUE');
  },
  extractEntityId: replicaKey => replicaKey.split(':')[0] || '',
  hasLocalSignerForEntity: (current, entityId) =>
    Array.from(current.state.eReplicas.values()).some(
      replica => replica.entityId.toLowerCase() === entityId.toLowerCase(),
    ),
  hasLocalSignerForEntitySigner: (current, entityId, signerId) =>
    Array.from(current.state.eReplicas.values()).some(
      replica =>
        replica.entityId.toLowerCase() === entityId.toLowerCase() &&
        replica.signerId.toLowerCase() === signerId.toLowerCase(),
    ),
  resolveSoleLocalSignerForEntity: (current, entityId) => {
    const signers = Array.from(current.state.eReplicas.values())
      .filter(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())
      .map(replica => replica.signerId);
    return signers.length === 1 ? signers[0]! : null;
  },
  getP2P: () => null,
});

describe('cross-jurisdiction hashledger swap', () => {
  const applyExactTestFill = (route: CrossJurisdictionSwapRoute, ratio: number): void => {
    route.cumulativeFillRatio = ratio;
    route.fillNumerator = BigInt(ratio);
    route.fillDenominator = 65_535n;
    route.filledSourceAmount = (BigInt(route.source.amount) * BigInt(ratio)) / 65_535n;
    route.filledTargetAmount = (BigInt(route.target.amount) * BigInt(ratio)) / 65_535n;
  };

  /**
   * Install the exact initial ProofBody observed by the registry-registration
   * path. A route object alone is deliberately insufficient authorization:
   * lazy binding must prove that this Pull was in the active bilateral dispute.
   */
  const installActivePullRegistrationProof = (
    state: EntityState,
    accountCounterparty: string,
    route: CrossJurisdictionSwapRoute,
    role: 'source' | 'target',
  ) => {
    const account = state.accounts.get(accountCounterparty)!;
    const pull = role === 'source' ? route.sourcePull! : route.targetPull!;
    account.state.pulls ??= new Map();
    account.state.pulls.set(pull.pullId, {
      pullId: pull.pullId,
      tokenId: pull.tokenId,
      amount: pull.signedAmount,
      fullHash: pull.fullHash,
      partialRoot: pull.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, role),
      createdHeight: 1,
      createdTimestamp: state.timestamp,
    });
    const proof = buildAccountProofBody(account, addr('99'));
    account.counterpartyDisputeProofBodyHash = proof.proofBodyHash;
    account.disputeProofBodiesByHash = {
      ...(account.disputeProofBodiesByHash ?? {}),
      [proof.proofBodyHash]: proof.proofBodyStruct,
    };
    account.disputeProofNoncesByHash = {
      ...(account.disputeProofNoncesByHash ?? {}),
      [proof.proofBodyHash]: 1,
    };
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, true, proof.proofBodyStruct),
    );
    const startSeconds = Math.max(1, Math.floor(state.timestamp / 1_000));
    account.status = 'disputed';
    account.activeDispute = {
      startedByLeft: account.state.leftEntity !== state.entityId,
      initialProofbodyHash: proof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout:
        startSeconds +
        account.state.disputeConfig.leftResponseSeconds +
        account.state.disputeConfig.rightResponseSeconds,
      disputeStartTimestamp: startSeconds,
      jNonce: 0,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      observedOnChain: true,
      observedBlockNumber: 1,
      finalizeQueued: false,
    };
    return account;
  };

  const makeBidirectionalSalvageRuntimeFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.state.timestamp = 30_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceHub = entity('32');
    const targetHub = entity('33');
    const sourceSigner = registerTestSigner(env, scenario, '1');
    const targetSigner = registerTestSigner(env, scenario, '2');
    const alternateTargetSigner = registerTestSigner(env, scenario, '3');
    const sourceUser = generateLazyEntityId([sourceSigner], 1n).toLowerCase();
    const targetUser = generateLazyEntityId([targetSigner], 1n).toLowerCase();
    const sourceState = makeState(sourceUser, sourceSigner, sourceJ, sourceHub);
    const targetState = makeState(targetUser, targetSigner, targetJ, targetHub);
    const alternateTargetState = makeState(targetUser, alternateTargetSigner, targetJ, targetHub);
    sourceState.prevFrameHash = 'genesis';
    targetState.prevFrameHash = 'genesis';
    alternateTargetState.prevFrameHash = 'genesis';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: `${scenario}-route`,
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: sourceSigner,
        targetSignerId: targetSigner,
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
          tokenId: 1,
          amount: 90n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: scenario, now: env.state.timestamp },
    );
    const fillRatio = 0x1234;
    route.cumulativeFillRatio = fillRatio;
    route.fillNumerator = BigInt(fillRatio);
    route.fillDenominator = 65_535n;
    route.filledSourceAmount = (BigInt(route.source.amount) * BigInt(fillRatio)) / 65_535n;
    route.filledTargetAmount = (BigInt(route.target.amount) * BigInt(fillRatio)) / 65_535n;
    sourceState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    targetState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    alternateTargetState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    installJurisdictions(env, sourceJ, targetJ);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, targetState, targetSigner);
    addReplica(env, alternateTargetState, alternateTargetSigner);
    const binary = buildCrossJurisdictionPullReveal(
      route,
      fillRatio,
      deriveCrossJurisdictionPrivateSeed(scenario, route),
    ).binary;
    const sourceAccount = sourceState.accounts.get(sourceHub)!;
    sourceAccount.state.pulls ??= new Map();
    sourceAccount.state.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 1,
      createdTimestamp: env.state.timestamp,
    });
    const finalizedProof = buildAccountProofBody(sourceAccount, addr('99'));
    sourceAccount.disputeProofBodiesByHash = {
      [finalizedProof.proofBodyHash]: finalizedProof.proofBodyStruct,
    };
    storeDisputeArgumentSnapshot(
      sourceAccount,
      captureDisputeArgumentSnapshot(
        sourceAccount,
        finalizedProof.proofBodyHash,
        1,
        true,
        finalizedProof.proofBodyStruct,
      ),
    );
    const targetAccount = targetState.accounts.get(targetHub)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 1,
      createdTimestamp: env.state.timestamp,
    });
    const targetProof = buildAccountProofBody(targetAccount, addr('99'));
    targetAccount.counterpartyDisputeProofBodyHash = targetProof.proofBodyHash;
    targetAccount.disputeProofBodiesByHash = {
      [targetProof.proofBodyHash]: targetProof.proofBodyStruct,
    };
    targetAccount.disputeProofNoncesByHash = { [targetProof.proofBodyHash]: 1 };
    storeDisputeArgumentSnapshot(
      targetAccount,
      captureDisputeArgumentSnapshot(targetAccount, targetProof.proofBodyHash, 1, true, targetProof.proofBodyStruct),
    );

    // The target registry write is authorized only by the exact initial body
    // of an observed active dispute, never by the unauthenticated route cache.
    targetAccount.status = 'disputed';
    targetAccount.activeDispute = {
      startedByLeft: targetAccount.state.leftEntity !== targetUser,
      initialProofbodyHash: targetProof.proofBodyHash,
      initialNonce: 1,
      // Source evidence is observed at unix 30s. With 10s/10s signed phases,
      // opening the target dispute at 20s makes 30s the exact Target boundary.
      disputeTimeout: 40,
      disputeStartTimestamp: 20,
      jNonce: 0,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      observedOnChain: true,
      observedBlockNumber: 1,
      finalizeQueued: false,
    };
    const buildSourceRevealRange = () => {
      // The recovery trigger is the on-chain reveal registration itself: the
      // hub cannot claim the source pull without publishing portable proof.
      const reveal = buildCrossJurisdictionPullReveal(
        route,
        fillRatio,
        deriveCrossJurisdictionPrivateSeed(scenario, route),
      );
      const event: JurisdictionEvent = {
        type: 'HashLadderRevealRegistered',
        data: {
          entity: sourceHub,
          counterpartyEntity: sourceUser,
          ladderHash: ethers.keccak256(
            ethers.solidityPacked(['bytes32', 'bytes32'], [route.sourcePull!.fullHash, route.sourcePull!.partialRoot]),
          ),
          fillRatio,
          fullSecret: reveal.fullSecret ?? `0x${'00'.repeat(32)}`,
          reveals: reveal.reveals ?? [
            `0x${'00'.repeat(32)}`,
            `0x${'00'.repeat(32)}`,
            `0x${'00'.repeat(32)}`,
            `0x${'00'.repeat(32)}`,
          ],
          targetRole: false,
          revealedAt: 30,
        },
      };
      const range = buildJEventRangeData(
        sourceState,
        {
          from: sourceSigner,
          event,
          observedAt: env.state.timestamp,
          blockNumber: 1,
          blockHash: secret('8b'),
          transactionHash: secret('8c'),
        },
        env,
      );
      env.state.eReplicas.get(`${sourceUser}:${sourceSigner}`)!.jHistory = recordValidatorJHistory(
        undefined,
        {
          jurisdictionRef: range.jurisdictionRef,
          scannedThroughHeight: range.scannedThroughHeight,
          tipBlockHash: range.tipBlockHash,
          blocks: range.blocks.map(block => ({
            jurisdictionRef: range.jurisdictionRef,
            jHeight: block.blockNumber,
            jBlockHash: block.blockHash,
            eventsHash: block.eventsHash,
            events: block.events,
          })),
        },
        sourceState,
      );
      return range;
    };
    return {
      env,
      sourceJ,
      sourceUser,
      sourceHub,
      targetUser,
      sourceSigner,
      targetSigner,
      alternateTargetSigner,
      sourceState,
      route,
      fillRatio,
      binary,
      buildSourceRevealRange,
    };
  };

  test('crossJurisdictionSalvage queues a target-chain registry write and broadcasts', async () => {
    const env = createEmptyEnv('cross-salvage-action');
    env.scenarioMode = true;
    env.state.timestamp = 40_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('41');
    const sourceHub = entity('42');
    const sourceSigner = addr('70');
    const targetHubSigner = registerTestSigner(env, 'cross-salvage-action-target-hub', '1');
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const targetUser = entity('44');
    const signer = addr('71');
    const state = makeState(targetUser, signer, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-salvage-action',
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    installActivePullRegistrationProof(state, targetHub, route, 'target');
    // Target is writable from its own dispute start, including this exact
    // runtime millisecond; there is no synthetic second-phase delay.
    state.timestamp = state.accounts.get(targetHub)!.activeDispute!.disputeStartTimestamp! * 1_000;
    state.crossJurisdictionSwaps?.set(route.orderId, route);
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

    // The port is one self-lane flush: a registry write plus its broadcast.
    // No dispute start, no argument injection, no source mirror.
    expect(result.outputs).toHaveLength(1);
    const flush = result.outputs[0]!;
    expect(flush.entityId).toBe(targetUser);
    expect(flush.entityTxs?.map(tx => tx.type)).toEqual(['j_broadcast']);
    const queued = result.newState.jBatchState?.batch.hashLadderRegistrations ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      targetRole: true,
      witness: { fillRatio: 0x1234 },
    });
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('target_prepared');

    // An identical or lower replay never duplicates or downgrades the write.
    const replay = await applyEntityTx(env, result.newState, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 11,
      },
    });
    expect(replay.outputs).toEqual([]);
    expect(replay.newState.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);

    // Once that registration is sealed, a higher Target witness enters the
    // next mutable draft immediately. Its exact Hanko ACK owns the single
    // replacement continuation; no premature broadcast may collide with the
    // immutable sentBatch.
    const deferredState = replay.newState;
    const pendingBatchHash = secret('7d');
    const pendingBatch = cloneJBatch(deferredState.jBatchState!.batch);
    deferredState.jBatchState!.batch = createEmptyBatch();
    deferredState.jBatchState!.sentBatch = {
      batch: pendingBatch,
      batchHash: pendingBatchHash,
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: deferredState.timestamp,
      lastSubmittedAt: deferredState.timestamp,
      submitAttempts: 1,
    };
    deferredState.jBatchState!.status = 'sent';
    const higherRatio = 0x2345;
    const higherBinary = buildCrossJurisdictionPullReveal(
      route,
      higherRatio,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const deferred = await applyEntityTx(env, deferredState, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: higherBinary,
        fillRatio: higherRatio,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 12,
      },
    });
    expect(deferred.outputs).toEqual([]);
    expect(deferred.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingTargetRegistryReveal).toBeUndefined();
    expect(deferred.newState.jBatchState?.batch.hashLadderRegistrations[0]?.witness.fillRatio).toBe(higherRatio);
    expect(deferred.newState.jBatchState?.autoBroadcastDraft).toBe(true);

    const ackOutputs: EntityInput[] = [];
    await applyHankoBatchProcessedEvent({
      newState: deferred.newState,
      event: {
        type: 'HankoBatchProcessed',
        data: {
          entityId: targetUser,
          batchHash: pendingBatchHash,
          nonce: 1,
        },
      },
      blockNumber: 10,
      outputs: ackOutputs,
    });
    expect(deferred.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingTargetRegistryReveal).toBeUndefined();
    expect(deferred.newState.jBatchState?.batch.hashLadderRegistrations[0]?.witness.fillRatio).toBe(higherRatio);
    expect(ackOutputs.filter(output => output.entityTxs?.some(tx => tx.type === 'j_broadcast'))).toHaveLength(1);

    // Capacity deferral without an immutable sentBatch must still own one
    // durable continuation. It drains the current full draft; that batch's ACK
    // later flushes the retained Target witness into its successor.
    const fullDraftState = deferred.newState;
    const existing = fullDraftState.jBatchState!.batch.hashLadderRegistrations[0]!;
    fullDraftState.jBatchState!.batch.hashLadderRegistrations = Array.from(
      { length: 32 },
      (_, index) => ({
        ...existing,
        targetRole: false,
        fullHash: ethers.zeroPadValue(ethers.toBeHex(index + 1000), 32),
        partialRoot: ethers.zeroPadValue(ethers.toBeHex(index + 2000), 32),
      }),
    );
    const capacityRatio = 0x3456;
    const capacityBinary = buildCrossJurisdictionPullReveal(
      route,
      capacityRatio,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const capacityDeferred = await applyEntityTx(env, fullDraftState, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary: capacityBinary,
        fillRatio: capacityRatio,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 13,
      },
    });
    expect(capacityDeferred.outputs.filter(
      output => output.entityTxs?.some(tx => tx.type === 'j_broadcast'),
    )).toHaveLength(1);
    expect(capacityDeferred.newState.crossJurisdictionSwaps
      ?.get(route.orderId)?.pendingTargetRegistryReveal?.fillRatio).toBe(capacityRatio);
  });

  test('verified target reveal waits for and then enters the target dispute window', async () => {
    const env = createEmptyEnv('cross-salvage-prebinding');
    env.scenarioMode = true;
    env.state.timestamp = 40_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('41');
    const sourceHub = entity('42');
    const targetHub = entity('43');
    const targetUser = entity('44');
    const targetSigner = registerTestSigner(env, 'cross-salvage-prebinding-target', '1');
    const state = makeState(targetUser, targetSigner, targetJ, targetHub);
    installJurisdictions(env, sourceJ, targetJ);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-salvage-prebinding',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: addr('70'),
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
          tokenId: 1,
          amount: 90n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'prebinding-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('prebinding-seed', route),
    ).binary;

    const buffered = await applyEntityTx(env, state, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 1,
      },
    });
    expect(buffered.outputs.filter(output => output.entityTxs?.some(tx => tx.type === 'j_broadcast'))).toHaveLength(0);
    expect(buffered.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingTargetRegistryReveal?.fillRatio).toBe(0x1234);
    expect(buffered.newState.jBatchState?.batch.hashLadderRegistrations ?? []).toHaveLength(0);
    expect(countDeferredHashLadderReveals(buffered.newState)).toBe(0);
    expect(flushDeferredHashLadderReveals(buffered.newState)).toBe(0);

    installActivePullRegistrationProof(buffered.newState, targetHub, route, 'target');
    expect(countDeferredHashLadderReveals(buffered.newState)).toBe(1);
    expect(flushDeferredHashLadderReveals(buffered.newState)).toBe(1);
    expect(buffered.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingTargetRegistryReveal).toBeUndefined();
    expect(buffered.newState.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);

    const terminalRoute = buffered.newState.crossJurisdictionSwaps?.get(route.orderId)!;
    terminalRoute.status = 'settled';
    const delayed = await applyEntityTx(env, buffered.newState, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 2,
      },
    });
    expect(delayed.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingTargetRegistryReveal).toBeUndefined();
  });

  test('crossJurisdictionSalvage still queues after off-chain target deadline', async () => {
    const env = createEmptyEnv('cross-salvage-past-wallclock');
    env.scenarioMode = true;
    env.state.timestamp = 40_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('41');
    const sourceHub = entity('42');
    const sourceSigner = addr('70');
    const targetHubSigner = registerTestSigner(env, 'cross-salvage-past-wallclock-hub', '1');
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const targetUser = entity('44');
    const signer = addr('71');
    const state = makeState(targetUser, signer, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-salvage-past-wallclock',
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    installActivePullRegistrationProof(state, targetHub, route, 'target');
    // Wall-clock advance must not gate reveal port — L1 dispute clocks own settle.
    env.state.timestamp = 10_000_000;
    state.timestamp = env.state.timestamp;
    state.crossJurisdictionSwaps?.set(route.orderId, route);
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
        observedAt: env.state.timestamp,
      },
    });
    expect(result.newState.jBatchState?.batch.hashLadderRegistrations ?? []).toHaveLength(1);
  });

  test('a self-registered reveal confirms the pending port result', async () => {
    const env = createEmptyEnv('cross-port-confirm');
    env.scenarioMode = true;
    env.state.timestamp = 41_000;
    env.quietRuntimeLogs = true;
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('45');
    const sourceHub = entity('46');
    const targetHub = entity('47');
    const targetUser = entity('48');
    const targetSigner = registerTestSigner(env, 'cross-port-confirm', '2');
    const state = makeState(targetUser, targetSigner, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-port-confirm',
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = installActivePullRegistrationProof(state, targetHub, route, 'target');
    account.activeDispute!.crossJurisdictionRecovery = {
      requiredPullIds: [route.targetPull!.pullId],
      resultsByPullId: {},
    };

    const revealEvent: JurisdictionEvent = {
      type: 'HashLadderRevealRegistered',
      data: {
        entity: targetUser,
        counterpartyEntity: targetHub,
        ladderHash: ethers.keccak256(
          ethers.solidityPacked(['bytes32', 'bytes32'], [route.targetPull!.fullHash, route.targetPull!.partialRoot]),
        ),
        fillRatio: 0x1234,
        fullSecret: `0x${'00'.repeat(32)}`,
        reveals: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`],
        targetRole: true,
        revealedAt: 41,
      },
    };
    const signed = prepareJEventInput(env, targetUser, targetSigner, {
      blockNumber: 4,
      blockHash: secret('9e'),
      transactionHash: secret('9f'),
      events: [revealEvent],
      jurisdictionRef: jref(base),
    });
    const result = await applyJEventRange(
      state,
      {
        from: targetSigner,
        event: revealEvent,
        observedAt: env.state.timestamp,
        blockNumber: 4,
        blockHash: secret('9e'),
        transactionHash: secret('9f'),
        ...signed,
      },
      env,
    );
    expect(result.outputs).toEqual([]);
    const recovery = result.newState.accounts.get(targetHub)?.activeDispute?.crossJurisdictionRecovery;
    expect(recovery?.resultsByPullId).toEqual({
      [route.targetPull!.pullId]: String(0x1234),
    });
  });

  test('crossJurisdictionSalvage ignores forged target pull binary', async () => {
    const env = createEmptyEnv('cross-salvage-forged-binary');
    env.scenarioMode = true;
    env.state.timestamp = 41_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('45');
    const sourceHub = entity('46');
    const targetHub = entity('47');
    const targetUser = entity('48');
    const signer = addr('72');
    const state = makeState(targetUser, signer, base, targetHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const forgedBinary = partialBinary(0x1234);
    const initialStatus = route.status;

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
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe(initialStatus);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingClearRequestedAt).toBeUndefined();
  });

  test('target DisputeStarted attaches port-wait recovery and fans out sibling dispute', async () => {
    const env = createEmptyEnv('cross-target-dispute-forces-source');
    env.scenarioMode = true;
    env.state.timestamp = 50_000;
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route });

    const targetAccount = targetState.accounts.get(targetHub)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 1,
      createdTimestamp: env.state.timestamp,
    });
    const targetProof = buildAccountProofBody(targetAccount, addr('99'));
    targetAccount.disputeProofBodiesByHash = {
      [targetProof.proofBodyHash]: targetProof.proofBodyStruct,
    };
    targetAccount.disputeProofNoncesByHash = { [targetProof.proofBodyHash]: 1 };
    storeDisputeArgumentSnapshot(
      targetAccount,
      captureDisputeArgumentSnapshot(targetAccount, targetProof.proofBodyHash, 1, true, targetProof.proofBodyStruct),
    );

    // Competing same-block start race: the counterparty can mine the exact
    // signed start before our start+Target-registration batch. The observed
    // start must retire only E6-doomed start calldata and preserve the lazy
    // registration plus unrelated operations for immediate rebroadcast.
    const sealedBatch = createEmptyBatch();
    sealedBatch.disputeStarts.push({
      counterentity: targetHub,
      nonce: 1,
      proposerIsLeft: true,
      proofbodyHash: targetProof.proofBodyHash,
      initialProofbody: structuredClone(targetProof.proofBodyStruct),
      watchSeed: targetAccount.state.watchSeed,
      sig: '0x',
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
      starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    sealedBatch.hashLadderRegistrations.push({
      counterpartyEntity: route.target.entityId,
      targetRole: true,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      witness: {
        fillRatio: 0x1234,
        fullSecret: secret('a1'),
        reveals: [secret('a2'), secret('a3'), secret('a4'), secret('a5')],
      },
    });
    sealedBatch.reserveToReserve.push({
      receivingEntity: entity('55'),
      tokenId: 1,
      amount: 7n,
    });
    targetState.jBatchState = initJBatch();
    targetState.jBatchState.status = 'sent';
    targetState.jBatchState.sentBatch = {
      batch: sealedBatch,
      batchHash: secret('a6'),
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: env.state.timestamp,
      lastSubmittedAt: env.state.timestamp,
      submitAttempts: 1,
    };

    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: targetHub,
        counterentity: targetUser,
        nonce: '1',
        proposerIsLeft: true,
        proofbodyHash: targetProof.proofBodyHash,
        initialProofbody: structuredClone(targetProof.proofBodyStruct),
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        disputeTimeout: 1700000020,
        disputeStartTimestamp: 1700000000,
        leftResponseSeconds: 10,
        rightResponseSeconds: 10,
        watchSeed: targetState.accounts.get(targetHub)!.state.watchSeed,
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
      result = await applyJEventRange(
        targetState,
        {
          from: targetSigner,
          event: disputeStartedEvent,
          observedAt: env.state.timestamp,
          blockNumber: 2,
          blockHash: secret('9b'),
          transactionHash: secret('9c'),
          ...signed,
        },
        env,
      );
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);

    // Local recovery stays a port-wait on the target account. Sibling fanout
    // asks the source-user lane to start its own dispute clock so both legs
    // can reveal/port before either chain's T expires.
    const fanout = result!.outputs.filter(output =>
      output.entityTxs?.some(tx => tx.type === 'crossJurisdictionForceSiblingDispute'),
    );
    expect(fanout).toHaveLength(1);
    expect(fanout[0]?.entityId.toLowerCase()).toBe(sourceUser.toLowerCase());
    expect(fanout[0]?.signerId.toLowerCase()).toBe(sourceSigner.toLowerCase());
    expect(fanout[0]?.entityTxs).toEqual([
      {
        type: 'crossJurisdictionForceSiblingDispute',
        data: {
          routeId: route.orderId,
          observedCounterpartyEntityId: targetHub.toLowerCase(),
          observedAt: 2,
        },
      },
    ]);
    const recovery = result!.newState.accounts.get(targetHub)?.activeDispute?.crossJurisdictionRecovery;
    expect(recovery?.requiredPullIds).toEqual([route.targetPull!.pullId]);
    expect(recovery?.resultsByPullId).toEqual({});
    expect(recovery).not.toHaveProperty('resolveByTimestamp');
    expect(result!.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result!.newState.jBatchState?.batch.disputeStarts).toEqual([]);
    // The sealed remainder stays a separately contract-valid FIFO recovery
    // batch. Merging it into the editable draft could overflow batch limits.
    expect(result!.newState.jBatchState?.batch.hashLadderRegistrations).toEqual([]);
    expect(result!.newState.jBatchState?.batch.reserveToReserve).toEqual([]);
    expect(result!.newState.jBatchState?.recoveryBatches?.[0]?.hashLadderRegistrations).toHaveLength(1);
    expect(result!.newState.jBatchState?.recoveryBatches?.[0]?.reserveToReserve).toEqual([
      {
        receivingEntity: entity('55'),
        tokenId: 1,
        amount: 7n,
      },
    ]);
    expect(result!.newState.jBatchState?.status).toBe('accumulating');
    const rebroadcasts = result!.outputs.filter(
      output =>
        output.entityId.toLowerCase() === targetUser.toLowerCase() &&
        output.entityTxs?.some(tx => tx.type === 'j_broadcast'),
    );
    expect(rebroadcasts).toHaveLength(1);
  });
});
