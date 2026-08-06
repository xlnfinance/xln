import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';
import { ethers } from 'ethers';
import { applyEntityTx } from '../entity/tx/apply';
import { applyAccountTx } from '../account/tx/apply';
import { proposeAccountFrame } from '../account/consensus/propose';

import { accountInputAck, accountInputProposal } from '../account/consensus/flush';

import { computeAccountStateRoot } from '../account/state-root';

import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../entity/tx/handlers/account';

import { applyEntityFrame, applyEntityInput, mergeEntityInputs } from '../entity/consensus/index';
import { initCrontab, scheduleHook } from '../entity/scheduler';

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
  admitAtomicCrossJAccountInputs,
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../runtime/jurisdiction-api';

import { hashHtlcSecret } from '../protocol/htlc/utils';

import type { AccountTx } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityInput, EntityReplica } from '../entity/types';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../runtime/types';
import type { EntityTx } from '../types/entity-tx';
import type { JurisdictionEvent } from '../types/jurisdiction-events';

import { generateLazyEntityId } from '../entity/factory';

import { createDefaultDelta } from '../account/delta';

import { cloneAccountReplica } from '../account/state-clone';
import { cloneEntityReplica } from '../entity/replica-clone';
import { cloneEntityState } from '../entity/state-clone';

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

import {
  buildDisputeArgumentsFromSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';

import { signEntityHashes } from '../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../entity/consensus/output-certification';

import {
  planCrossJurisdictionTargetRecovery,
  queueCrossJurisdictionSalvageFromFinalizedArguments,
} from '../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../runtime/entity-inputs';

import { crossBookQtyLots } from '../entity/tx/handlers/account/orderbook-matching-cross';
import { buildFinalProofPayload } from '../entity/tx/handlers/dispute/finalize-proof';

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

import { recordValidatorJHistory } from '../jurisdiction/machine/local-history';
import { canonicalDisputeFinalizationEvidenceHash } from '../jurisdiction/machine/event-observation';

import { buildLocalEntityProfile } from '../network/p2p/gossip-helper';

import { collectLocalProfileEncryptionAnnouncements } from '../entity/profile-encryption';

import { LIMITS } from '../config/constants';

import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';

import { assertRuntimeOutputAuthorization } from '../entity/authorization';

import { cloneIsolatedRoutedEntityInputs } from '../runtime/input-clone';

import { createDueScheduledWakeInputs } from '../runtime/scheduled-wake';

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
    Array.from(current.state.eReplicas.values()).some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase()),
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

  const makeTargetDisputeRouteSelectionFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.state.timestamp = 50_000;
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
        sourceUser?: string;
        sourceHub?: string;
        sourceSigner?: string;
      } = {},
    ) => {
      const routeSourceUser = options.sourceUser ?? sourceUser;
      const routeSourceHub = options.sourceHub ?? sourceHub;
      const route = {
        ...buildPreparedCrossJurisdictionRoute(
          {
            orderId,
            makerEntityId: routeSourceUser,
            hubEntityId: routeSourceHub,
            sourceSignerId: options.sourceSigner ?? sourceSigner,
            source: {
              jurisdiction: jref(sourceJ),
              entityId: routeSourceUser,
              counterpartyEntityId: routeSourceHub,
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
            createdAt: env.state.timestamp,
            updatedAt: env.state.timestamp,
          },
          { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
        ),
        status: options.status ?? 'resting',
        ...(options.status === undefined || options.status === 'resting'
          ? {
              cumulativeFillRatio: 0x1234,
              fillNumerator: 0x1234n,
              fillDenominator: 65_535n,
              filledSourceAmount: (100n * 0x1234n) / 65_535n,
              filledTargetAmount: (90n * 0x1234n) / 65_535n,
            }
          : {}),
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    const plan = (
      outputs: EntityInput[],
      suppliedResults: Readonly<Record<string, string>> = {},
    ) => {
      const account = state.accounts.get(targetHub)!;
      account.state.pulls = new Map();
      for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
        if (!route.targetPull || route.target.entityId !== targetHub) continue;
        account.state.pulls.set(route.targetPull.pullId, {
          pullId: route.targetPull.pullId,
          tokenId: route.targetPull.tokenId,
          amount: route.targetPull.signedAmount,
          revealedUntilTimestamp: route.targetPull.revealedUntilTimestamp,
          fullHash: route.targetPull.fullHash,
          partialRoot: route.targetPull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
          createdHeight: 1,
          createdTimestamp: state.timestamp,
        });
      }
      const proof = buildAccountProofBody(account, addr('99'));
      storeDisputeArgumentSnapshot(
        account,
        captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
      );
      return planCrossJurisdictionTargetRecovery(
        state,
        account,
        targetHub,
        [proof.proofBodyHash],
        suppliedResults,
        outputs,
      );
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute, plan };
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
          jurisdiction: jref(sourceJ), entityId: sourceUser,
          counterpartyEntityId: sourceHub, tokenId: 1, amount: 100n,
        },
        target: {
          jurisdiction: jref(targetJ), entityId: targetHub,
          counterpartyEntityId: targetUser, tokenId: 1, amount: 90n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: scenario, sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
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
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
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
        finalizedProof.proofBodyStruct,
      ),
    );
    const targetAccount = targetState.accounts.get(targetHub)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
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
      captureDisputeArgumentSnapshot(
        targetAccount,
        targetProof.proofBodyHash,
        1,
        targetProof.proofBodyStruct,
      ),
    );
    const buildSourceDisputeRange = () => {
      const crossPullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
        [{ fillRatios: [], secrets: [], pulls: [binary] }],
      );
      const event: JurisdictionEvent = {
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
        leftArguments: ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[crossPullArgs]]),
        rightArguments: '0x',
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      }];
      const range = buildJEventRangeData(sourceState, {
        from: sourceSigner,
        event,
        observedAt: env.state.timestamp,
        blockNumber: 1,
        blockHash: secret('8b'),
        transactionHash: secret('8c'),
        disputeFinalizationEvidence,
        disputeFinalizationEvidenceHash:
          canonicalDisputeFinalizationEvidenceHash(disputeFinalizationEvidence),
      }, env);
      env.state.eReplicas.get(`${sourceUser}:${sourceSigner}`)!.jHistory = recordValidatorJHistory(undefined, {
        jurisdictionRef: range.jurisdictionRef,
        scannedThroughHeight: range.scannedThroughHeight,
        tipBlockHash: range.tipBlockHash,
        blocks: range.blocks.map(block => ({
          jurisdictionRef: range.jurisdictionRef,
          jHeight: block.blockNumber,
          jBlockHash: block.blockHash,
          eventsHash: block.eventsHash,
          events: block.events,
          ...(block.disputeFinalizationEvidence
            ? { disputeFinalizationEvidence: block.disputeFinalizationEvidence }
            : {}),
          ...(block.disputeFinalizationEvidenceHash
            ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
            : {}),
        })),
      }, sourceState);
      return range;
    };
    return {
      env, sourceJ, sourceUser, sourceHub, targetUser, sourceSigner,
      targetSigner, alternateTargetSigner, sourceState, route, fillRatio, binary, buildSourceDisputeRange,
    };
  };

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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-cancel-after-accepted-fill',
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
      { runtimeSeed: 'cross-cancel-after-accepted-fill', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
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
    expect(cancelled.accountTxs).toEqual([]);
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
    account.state.swapOffers.get(route.orderId)!.crossJurisdiction = committedRoute;

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

  test('source hub waits for committed sibling book-removal ACK before Account ACK', async () => {
    const env = createEmptyEnv('cross-cancel-remote-book-owner');
    env.state.timestamp = 10_000;
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    const account = sourceHubState.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'partially_filled' },
    });
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, sourceHubState.timestamp);
    sourceHubState.crossJurisdictionSwaps?.set(route.orderId, route);
    const targetAdmission = mergeCrossJurisdictionBookAdmission(targetHubState, route, targetHubState.timestamp);
    targetAdmission.status = 'admitted';
    targetHubState.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = routeRemoteCrossJurisdictionBookCancels(env, sourceHubState, [
      {
        accountId: sourceUser,
        offerId: route.orderId,
      },
    ]);

    expect(result.localBookCancels).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.values().next().value?.pendingCancel).toMatchObject({
      sourceAccountId: sourceUser,
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      entityId: targetHub,
      signerId: targetHubSigner,
      localRuntimeProtocol: 'cross-j',
      entityTxs: [
        {
          type: 'removeCrossJurisdictionBookOrder',
          data: {
            orderId: route.orderId,
            sourceEntityId: sourceUser,
            sourceAccountId: sourceUser,
            reason: 'cancel_request',
          },
        },
      ],
    });

    const ownerRemoval = await applyEntityTx(env, targetHubState, result.outputs[0]!.entityTxs![0]!);
    expect(ownerRemoval.outputs).toHaveLength(1);
    expect(ownerRemoval.outputs[0]).toMatchObject({
      entityId: sourceHub,
      localRuntimeProtocol: 'cross-j',
      entityTxs: [
        {
          type: 'crossJurisdictionBookOrderRemoved',
          data: {
            orderId: route.orderId,
            sourceAccountId: sourceUser,
          },
        },
      ],
    });
    expect(result.accountTxs).toEqual([]);

    const sourceFollowup = await applyEntityTx(env, sourceHubState, ownerRemoval.outputs[0]!.entityTxs![0]!);
    expect(sourceFollowup.accountTxs).toEqual([]);
    expect(sourceFollowup.outputs).toEqual([]);
    const removedAt = (
      ownerRemoval.outputs[0]!.entityTxs![0] as Extract<
        EntityTx,
        {
          type: 'crossJurisdictionBookOrderRemoved';
        }
      >
    ).data.removedAt;
    expect(sourceFollowup.newState.crossJurisdictionBookAdmissions?.values().next().value?.pendingCancel).toMatchObject(
      { sourceAccountId: sourceUser, bookRemovalCommittedAt: removedAt },
    );
    expect(collectCommittedCrossJurisdictionCancelAcks(sourceFollowup.newState).map(({ tx }) => tx.type)).toEqual([
      'cross_swap_fill_ack',
    ]);
  });

  test('source user queues cross-j Account cancel without a local orderbook extension', async () => {
    const env = createEmptyEnv('cross-cancel-no-orderbook-ext');
    env.scenarioMode = true;
    env.state.timestamp = 10_000;
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
      getProfiles: () => [
        {
          entityId: sourceHub,
          metadata: { board: { validators: [{ signerId: sourceHubSigner }] } },
        },
      ],
    } as typeof env.gossip;
    const state = makeState(sourceUser, signer, eth, sourceHub);
    state.prevFrameHash = 'genesis';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-cancel-no-orderbook-ext',
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-cancel-no-orderbook-ext', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    const account = state.accounts.get(sourceHub)!;
    account.currentFrame.prevFrameHash = 'genesis';
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    addReplica(env, state, signer);
    const replica = env.state.eReplicas.get(`${state.entityId}:${signer}`)!;

    const result = await applyEntityInput(env, replica, {
      entityId: sourceUser,
      signerId: signer,
      entityTxs: [
        {
          type: 'proposeCancelSwap',
          data: { counterpartyEntityId: sourceHub, offerId: route.orderId },
        },
      ],
    });

    expect(result.outcome.kind).toBe('committed');
    expect(
      result.outputs.some(
        output => output.entityId === sourceHub && output.entityTxs?.some(tx => tx.type === 'consensusOutput'),
      ),
    ).toBe(true);
    const workingAccount = result.workingReplica.state.accounts.get(sourceHub)!;
    expect(
      [...workingAccount.mempool, ...(workingAccount.pendingFrame?.accountTxs ?? [])].some(
        tx => tx.type === 'swap_resolve',
      ),
    ).toBe(false);
  });

  test('fill notice validates target-side economics before mutating route', async () => {
    const env = createEmptyEnv('cross-fill-notice-invalid-target');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('95');
    const sourceHub = entity('96');
    const targetHub = entity('97');
    const targetUser = entity('98');
    const state = makeState(sourceHub, addr('92'), eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-fill-invalid-target',
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-fill-invalid-target', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    const route = { ...prepared, status: 'resting' as const };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    await expect(
      applyEntityTx(env, state, {
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 500n,
          incrementalTargetAmount: 451n,
          cumulativeSourceAmount: 500n,
          cumulativeTargetAmount: 451n,
          cumulativeFillRatio: 32_768,
          fillNumerator: 1n,
          fillDenominator: 2n,
          pairId: route.venueId || '',
        },
      }),
    ).rejects.toThrow(/CROSS_J_FILL_NOTICE_INVALID/);
  });

  test('valid fill notice queues only the source account ack and waits for admission before target progress', async () => {
    const env = createEmptyEnv('cross-fill-notice-delayed-commit');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('a1');
    const sourceHub = entity('a2');
    const targetHub = entity('a3');
    const targetUser = entity('a4');
    const state = makeState(sourceHub, addr('a2'), eth, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-fill-delayed-commit',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          targetHubSignerId: addr('a3'),
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
          createdAt: env.state.timestamp,
          updatedAt: env.state.timestamp,
          expiresAt: 70_000,
        },
        { runtimeSeed: 'cross-fill-delayed-commit', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
      ),
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
        fillNumerator: 1n,
        fillDenominator: 2n,
        pairId: route.venueId || '',
      },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect(result.outputs.some(output =>
      output.entityId === targetHub &&
      output.entityTxs?.some(tx => tx.type === 'crossJurisdictionFillNotice')),
    ).toBe(false);
    const canonical = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(canonical?.status).toBe('resting');
    expect(canonical?.fillSeq).toBeUndefined();
    expect(canonical?.cumulativeFillRatio).toBeUndefined();
  });

  test('duplicate fill notice is idempotent but same-seq divergent notice fails fast', async () => {
    const env = createEmptyEnv('cross-fill-notice-idempotent');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c1');
    const sourceHub = entity('c2');
    const targetHub = entity('c3');
    const targetUser = entity('c4');
    const state = makeState(sourceHub, addr('c2'), eth, sourceUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-fill-notice-idempotent',
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
          createdAt: env.state.timestamp,
          updatedAt: env.state.timestamp,
          expiresAt: 70_000,
        },
        { runtimeSeed: 'cross-fill-notice-idempotent', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
      ),
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
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
        cumulativeFillRatio: 32_768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        pairId: route.venueId || '',
      },
    });

    expect(duplicate.accountTxs ?? []).toHaveLength(0);
    expect(duplicate.newState.crossJurisdictionSwaps?.get(route.orderId)?.fillSeq).toBe(1);

    await expect(
      applyEntityTx(env, state, {
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
          fillNumerator: 1n,
          fillDenominator: 2n,
          pairId: route.venueId || '',
        },
      }),
    ).rejects.toThrow(/CROSS_J_FILL_NOTICE_STALE_CONFLICT/);

    await expect(
      applyEntityTx(env, state, {
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
          fillNumerator: 3n,
          fillDenominator: 4n,
          pairId: route.venueId || '',
        },
      }),
    ).rejects.toThrow(/CROSS_J_FILL_NOTICE_PREV_SEQ_MISMATCH/);
  });

  test('target hub commits a full source progress notice as the paired target Account leg', async () => {
    const env = createEmptyEnv('cross-fill-notice-book-owner-reject');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(targetHub, addr('b3'), base, targetUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-fill-book-owner-reject',
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
          createdAt: env.state.timestamp,
          updatedAt: env.state.timestamp,
          expiresAt: 70_000,
        },
        { runtimeSeed: 'cross-fill-book-owner-reject', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
      ),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const targetAccount = state.accounts.get(targetUser)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      createdHeight: 0,
      createdTimestamp: env.state.timestamp,
    });

    const result = await applyEntityTx(env, state, {
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: 1_000n,
          incrementalTargetAmount: 900n,
          cumulativeSourceAmount: 1_000n,
          cumulativeTargetAmount: 900n,
          cumulativeFillRatio: 65_535,
          fillNumerator: 1n,
          fillDenominator: 1n,
          pairId: route.venueId || '',
        },
      });
    expect(result.accountTxs?.map(operation => operation.tx.type)).toEqual(['cross_pull_progress']);
    expect(result.accountTxs?.[0]?.accountId).toBe(targetUser);
    const progressTx = result.accountTxs?.[0]?.tx;
    if (progressTx?.type !== 'cross_pull_progress') throw new Error('TEST_CROSS_J_TARGET_PROGRESS_MISSING');
    const progress = await applyAccountTx(
      targetAccount,
      progressTx,
      targetAccount.state.leftEntity === targetHub,
      env.state.timestamp,
      1,
    );
    expect(progress.success).toBe(true);
    expect(targetAccount.state.pulls?.get(route.targetPull!.pullId)?.crossJurisdiction).toMatchObject({
      fillSeq: 1,
      cumulativeFillRatio: 65_535,
      status: 'clear_requested',
    });
  });

  test('committed fill notice frame removes terminal source offer on the remote owner account', async () => {
    const seed = 'cross-fill-notice-owner-roundtrip seed alpha beta';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    env.activeJurisdiction = eth.name;
    const sourceUserSigner = registerTestSigner(env, seed, '1');
    const sourceHubSigner = registerTestSigner(env, seed, '2');
    const targetHubSigner = registerTestSigner(env, seed, '3');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const targetUser = `0x${'4'.padStart(64, '0')}`;
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    sourceUserState.prevFrameHash = 'genesis';
    sourceHubState.prevFrameHash = 'genesis';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-fill-notice-owner-roundtrip',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.state.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        priceTicks: 900n,
        timeInForce: 0,
        makerIsLeft: account.state.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    targetHubState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
    addReplica(env, targetHubState, targetHubSigner);
    const hubReplica = env.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const hubResult = await applyEntityInput(env, hubReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [
        {
          type: 'crossJurisdictionFillNotice',
          data: {
            orderId: route.orderId,
            fillSeq: 1,
            incrementalSourceAmount: 1_000n,
            incrementalTargetAmount: 900n,
            cumulativeSourceAmount: 1_000n,
            cumulativeTargetAmount: 900n,
            cumulativeFillRatio: 65_535,
            fillNumerator: 1n,
            fillDenominator: 1n,
            pairId: route.venueId || '',
          },
        },
      ],
    });
    env.state.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, hubResult.workingReplica);
    const accountInputOutput = hubResult.outputs.find(
      output =>
        output.entityId === sourceUser &&
        output.entityTxs?.some(
          tx => tx.type === 'consensusOutput' && tx.data.entityTxs.some(nested => nested.type === 'accountInput'),
        ),
    );
    const certifiedAccountInput = accountInputOutput?.entityTxs?.[0];
    expect(certifiedAccountInput?.type).toBe('consensusOutput');
    expect(
      certifiedAccountInput?.type === 'consensusOutput' ? certifiedAccountInput.data.entityTxs[0]?.type : undefined,
    ).toBe('accountInput');
    expect(
      certifiedAccountInput?.type === 'consensusOutput'
        ? (certifiedAccountInput.data.entityTxs[0]?.data as any)?.toEntityId
        : undefined,
    ).toBe(sourceUser);

    const userReplica = env.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!;
    const userResult = await applyEntityInput(env, userReplica, {
      entityId: sourceUser,
      signerId: sourceUserSigner,
      entityTxs: accountInputOutput!.entityTxs!,
    });

    const sourceAccount = userResult.workingReplica.state.accounts.get(sourceHub)!;
    expect(sourceAccount.currentHeight).toBe(1);
    expect(sourceAccount.state.swapOffers.has(route.orderId)).toBe(false);
    expect(
      userResult.outputs.some(
        output =>
          output.entityId === sourceHub &&
          output.entityTxs?.some(
            tx => tx.type === 'consensusOutput' && tx.data.entityTxs.some(nested => nested.type === 'accountInput'),
          ),
      ),
    ).toBe(true);
  });

  test('committed partial fill notice frame updates source route without clearing offer', async () => {
    const seed = 'cross-fill-notice-owner-partial seed alpha beta';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    env.activeJurisdiction = eth.name;
    const sourceUserSigner = registerTestSigner(env, seed, '1');
    const sourceHubSigner = registerTestSigner(env, seed, '2');
    const targetHubSigner = registerTestSigner(env, seed, '3');
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = generateLazyEntityId([targetHubSigner], 1n).toLowerCase();
    const targetUser = `0x${'4'.padStart(64, '0')}`;
    const sourceUserState = makeState(sourceUser, sourceUserSigner, eth, sourceHub);
    const sourceHubState = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    sourceUserState.prevFrameHash = 'genesis';
    sourceHubState.prevFrameHash = 'genesis';
    const sourceTotal = 40_000_000_000_000_000n;
    const targetTotal = 100_000_000_000_000_000_000n;
    const fillSource = 10_000_000_000_000_000n;
    const fillTarget = 25_000_000_000_000_000_000n;
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-fill-notice-owner-partial',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        targetHubSignerId: targetHubSigner,
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: sourceTotal,
        },
        target: {
          jurisdiction: jref(base),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: targetTotal,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: seed, sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.state.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: sourceTotal,
        wantTokenId: 1,
        wantAmount: targetTotal,
        priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
        timeInForce: 0,
        makerIsLeft: account.state.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
    const targetHubState = makeState(targetHub, targetHubSigner, base, targetUser);
    targetHubState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
    addReplica(env, targetHubState, targetHubSigner);
    const hubReplica = env.state.eReplicas.get(`${sourceHub}:${sourceHubSigner}`)!;
    const hubResult = await applyEntityInput(env, hubReplica, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityTxs: [
        {
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
        },
      ],
    });
    const accountInputOutput = hubResult.outputs.find(
      output =>
        output.entityId === sourceUser &&
        output.entityTxs?.some(
          tx => tx.type === 'consensusOutput' && tx.data.entityTxs.some(nested => nested.type === 'accountInput'),
        ),
    );
    const certifiedAccountInput = accountInputOutput?.entityTxs?.[0];
    expect(certifiedAccountInput?.type).toBe('consensusOutput');
    expect(
      certifiedAccountInput?.type === 'consensusOutput' ? certifiedAccountInput.data.entityTxs[0]?.type : undefined,
    ).toBe('accountInput');

    const userReplica = env.state.eReplicas.get(`${sourceUser}:${sourceUserSigner}`)!;
    const userResult = await applyEntityInput(env, userReplica, {
      entityId: sourceUser,
      signerId: sourceUserSigner,
      entityTxs: accountInputOutput!.entityTxs!,
    });

    const sourceAccount = userResult.workingReplica.state.accounts.get(sourceHub)!;
    expect(sourceAccount.state.swapOffers.has(route.orderId)).toBe(true);
    expect(sourceAccount.state.swapOffers.get(route.orderId)?.crossJurisdiction?.status).toBe('partially_filled');
    const updatedRoute = userResult.workingReplica.state.crossJurisdictionSwaps?.get(route.orderId);
    expect(updatedRoute?.status).toBe('partially_filled');
    expect(updatedRoute?.filledSourceAmount).toBe(fillSource);
    expect(updatedRoute?.filledTargetAmount).toBe(fillTarget);
    expect(updatedRoute?.fillNumerator).toBe(1n);
    expect(updatedRoute?.fillDenominator).toBe(4n);
  });

  test('cross-j orderbook sweep closes expired unfilled route instead of being a no-op', async () => {
    const env = createEmptyEnv('cross-sweep-expired');
    env.state.timestamp = 100_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('b1');
    const sourceHub = entity('b2');
    const targetHub = entity('b3');
    const targetUser = entity('b4');
    const state = makeState(sourceHub, addr('b2'), eth, sourceUser);
    state.timestamp = env.state.timestamp;
    addReplica(env, makeState(targetUser, addr('b5'), base, targetHub), addr('b5'));
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-sweep-expired',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          bookOwnerEntityId: sourceHub,
          sourceSignerId: addr('b1'),
          sourceHubSignerId: state.config.validators[0]!,
          targetHubSignerId: addr('b3'),
          targetSignerId: addr('b5'),
          bookHubSignerId: state.config.validators[0]!,
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
          expiresAt: 70_000,
        },
        { runtimeSeed: 'cross-sweep-expired', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
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
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason: 'test-expired' },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect(result.outputs).toEqual([{
      entityId: sourceHub,
      signerId: state.config.validators[0]!,
      entityTxs: [],
    }]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');

    installJurisdictions(env, eth, base);
    const frameState = cloneEntityState(state);
    frameState.crontabState = initCrontab();
    const jobs: Extract<EntityTx, { type: 'scheduledWake' }>['data']['jobs'] = [];
    for (let index = 0; index < 4; index++) {
      const hookId = `cross-j-sweep:fixed:${index}`;
      scheduleHook(frameState.crontabState, {
        id: hookId,
        triggerAt: 70_000,
        type: 'cross_j_orderbook_sweep',
        data: { reason: hookId },
      });
      jobs.push({ kind: 'hook', id: hookId, dueAt: 70_000 });
    }
    const frameResult = await applyEntityFrame(env, frameState, [{
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: frameState.config.validators[0]!,
        dueAt: 70_000,
        jobs,
      },
    }], env.state.timestamp);
    const frameAccount = frameResult.newState.accounts.get(sourceUser)!;
    expect([
      ...frameAccount.mempool,
      ...(frameAccount.pendingFrame?.accountTxs ?? []),
    ].map(tx => tx.type)).toEqual([
      'cross_swap_fill_ack',
    ]);
    expect(frameResult.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(readEntityFrameEventMessages(frameResult.newState)).toEqual([
      `🌉 Cross-j clear ${route.orderId} queued account offer close before pull reveal`,
      '🌉 Cross-j orderbook sweep: cross-j-sweep:fixed:0 expired=1 closedOffers=1 waiting=0',
      `🌉 Cross-j clear ${route.orderId} waiting for account offer close ack`,
      '🌉 Cross-j orderbook sweep: cross-j-sweep:fixed:1 expired=1 closedOffers=0 waiting=0',
      `🌉 Cross-j clear ${route.orderId} waiting for account offer close ack`,
      '🌉 Cross-j orderbook sweep: cross-j-sweep:fixed:2 expired=1 closedOffers=0 waiting=0',
      `🌉 Cross-j clear ${route.orderId} waiting for account offer close ack`,
      '🌉 Cross-j orderbook sweep: cross-j-sweep:fixed:3 expired=1 closedOffers=0 waiting=0',
      '🚀 Proposed frame 1 with 1 transactions',
    ]);

    const updatedAccount = result.newState.accounts.get(sourceUser)!;
    const cancelAck = result.accountTxs![0]!.tx;
    expect((await applyAccountTx(
      updatedAccount,
      cancelAck,
      updatedAccount.state.leftEntity === sourceHub,
      env.state.timestamp,
    )).success).toBe(true);
    const continuation = await applyEntityTx(env, result.newState, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });
    expect(continuation.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect((continuation.accountTxs?.[0]?.tx as any).data.binary).toBe('0x');
    expect((continuation.accountTxs?.[0]?.tx as any).data.proof.fillRatio).toBe(0);
    expect(continuation.outputs.some(output =>
      output.entityId === targetHub && output.entityTxs?.some(tx => tx.type === 'crossPullClose'),
    )).toBe(true);
    expect(continuation.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
  });

  test('cross-j orderbook sweep drives filled expired route into clear instead of terminal failed lock', async () => {
    const env = createEmptyEnv('cross-sweep-filled-expired-clear');
    env.state.timestamp = 100_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('c1');
    const sourceHub = entity('c2');
    const targetHub = entity('c3');
    const targetUser = entity('c4');
    const state = makeState(sourceHub, addr('c2'), eth, sourceUser);
    state.timestamp = env.state.timestamp;
    addReplica(env, makeState(targetUser, addr('c5'), base, targetHub), addr('c5'));
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-sweep-filled-expired',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          bookOwnerEntityId: sourceHub,
          sourceSignerId: addr('c1'),
          sourceHubSignerId: state.config.validators[0]!,
          targetHubSignerId: addr('c3'),
          targetSignerId: addr('c5'),
          bookHubSignerId: state.config.validators[0]!,
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
          status: 'partially_filled',
          createdAt: 1_000,
          updatedAt: 1_000,
          expiresAt: 70_000,
        },
        { runtimeSeed: 'cross-sweep-filled-expired-clear', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'partially_filled' as const,
      fillSeq: 1,
      fillNumerator: 1n,
      fillDenominator: 2n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 500n,
      wantTokenId: 1,
      wantAmount: 450n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
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
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason: 'test-filled-expired' },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.accountTxs?.[0]?.tx as any).data.fillNumerator).toBe(1n);
    expect((result.accountTxs?.[0]?.tx as any).data.fillDenominator).toBe(2n);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeSourceAmount).toBe(500n);
    expect((result.accountTxs?.[0]?.tx as any).data.cumulativeTargetAmount).toBe(450n);
    const swept = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(swept?.status).toBe('clear_requested');
    expect(swept?.clearingPolicy).toBe('cancel_and_clear');
    expect(swept?.pendingClearRequestedAt).toBe(env.state.timestamp);
  });

  test('submitCrossJurisdictionSwap rejects missing target receiving account', async () => {
    const env = createEmptyEnv('cross-submit-missing-target');
    env.scenarioMode = true;
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    env.state.jReplicas.set(eth.name, {
      name: eth.name,
      chainId: eth.chainId,
      rpcs: [eth.address],
      depositoryAddress: eth.depositoryAddress,
      entityProviderAddress: eth.entityProviderAddress,
      blockTimeMs: eth.blockTimeMs,
      defaultDisputeDelayBlocks: 5,
    } as any);
    env.state.jReplicas.set(base.name, {
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

    await expect(
      submitCrossJurisdictionSwap(env, {
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
      }),
    ).rejects.toThrow(/CROSS_SWAP_TARGET_ACCOUNT_MISSING/);
  });

  test('DisputeStarted relays payment secrets from source to target cross-j lock', async () => {
    const env = createEmptyEnv('cross-dispute-secret');
    env.scenarioMode = true;
    env.state.timestamp = 20_000;
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
        watchSeed: state.accounts.get(hub)!.state.watchSeed,
      },
    };
    const signed = prepareJEventInput(env, user, signer, {
      blockNumber: 2,
      blockHash: secret('7b'),
      transactionHash: secret('7c'),
      events: [disputeStartedEvent],
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(
      state,
      {
        from: signer,
        event: disputeStartedEvent,
        observedAt: env.state.timestamp,
        blockNumber: 2,
        blockHash: secret('7b'),
        transactionHash: secret('7c'),
        ...signed,
      },
      env,
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.signerId).toBe(targetSigner);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('resolveHtlcLock');
    const data = result.outputs?.[0]?.entityTxs?.[0]?.data as any;
    expect(data.counterpartyEntityId).toBe(targetHub);
    expect(data.lockId).toBe(targetLockId);
    expect(data.secret).toBe(revealedSecret);
  });

  test('source DisputeFinalized queues one atomic target result and source mirror', async () => {
    const {
      env, sourceUser, targetUser, sourceSigner, targetSigner,
      alternateTargetSigner, route, fillRatio, binary, buildSourceDisputeRange,
    } = makeBidirectionalSalvageRuntimeFixture('cross-dispute-salvage');
    const alternateBefore = cloneEntityState(
      env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state,
    );
    const range = buildSourceDisputeRange();
    const result = await applyMergedEntityInputs(
      env,
      [
        { entityId: sourceUser, signerId: sourceSigner, entityTxs: [{ type: 'j_event', data: range }] },
        { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
        { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
      ],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(result.localCrossJurisdictionEventTrace.map(input => input.entityId)).toEqual([targetUser, sourceUser]);
    expect(result.localCrossJurisdictionEventTrace.map(input => input.signerId)).toEqual([targetSigner, sourceSigner]);
    const targetSalvage = getEffectiveEntityInputTxs(result.localCrossJurisdictionEventTrace[0]!)[0];
    const sourceMirror = getEffectiveEntityInputTxs(result.localCrossJurisdictionEventTrace[1]!)[0];
    expect(targetSalvage).toMatchObject({
      type: 'crossJurisdictionSalvage',
      data: { routeId: route.orderId, binary, fillRatio },
    });
    expect(sourceMirror).toEqual(targetSalvage);
    expect(result.entityOutbox).toEqual([]);
    expect(result.jOutbox).toEqual([]);
    const committedSource = env.state.eReplicas.get(`${sourceUser}:${sourceSigner}`)!.state;
    const committedTarget = env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state;
    const sourceRoute = committedSource.crossJurisdictionSwaps?.get(route.orderId);
    const targetRoute = committedTarget.crossJurisdictionSwaps?.get(route.orderId);
    expect(sourceRoute?.status).toBe('clearing');
    expect(targetRoute?.status).toBe('clearing');
    expect(sourceRoute?.pendingClearRequestedAt).toBe(targetRoute?.pendingClearRequestedAt);
    expect(committedTarget.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(committedTarget.accounts.get(route.target.entityId)?.disputePrepare
      ?.crossJurisdictionRecovery?.resultsByPullId).toEqual({
        [route.targetPull!.pullId]: binary,
      });
    expect(env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state).toEqual(alternateBefore);

    const replay = makeBidirectionalSalvageRuntimeFixture('cross-dispute-salvage');
    const replayResult = await applyMergedEntityInputs(
      replay.env,
      [
        {
          entityId: replay.sourceUser,
          signerId: replay.sourceSigner,
          entityTxs: [{ type: 'j_event', data: replay.buildSourceDisputeRange() }],
        },
        { entityId: replay.sourceUser, signerId: replay.sourceSigner, entityTxs: [] },
        { entityId: replay.sourceUser, signerId: replay.sourceSigner, entityTxs: [] },
      ],
      [],
      { isReplay: true, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(replayResult.localCrossJurisdictionEventTrace.map(input => input.signerId))
      .toEqual(result.localCrossJurisdictionEventTrace.map(input => input.signerId));
    expect(replayResult.localCrossJurisdictionEventTrace.map(getEffectiveEntityInputTxs))
      .toEqual(result.localCrossJurisdictionEventTrace.map(getEffectiveEntityInputTxs));
  });

  test('same-pass salvage aborts before publish when the source mirror loses its route', async () => {
    const {
      env, sourceUser, targetUser, sourceSigner, targetSigner,
      route, buildSourceDisputeRange,
    } = makeBidirectionalSalvageRuntimeFixture('cross-salvage-missing-source-route');
    let targetApplied = false;
    let sourceMirrorAttempted = false;

    await expect(applyMergedEntityInputs(
      env,
      [{
        entityId: sourceUser,
        signerId: sourceSigner,
        entityTxs: [{ type: 'j_event', data: buildSourceDisputeRange() }],
      }, {
        entityId: sourceUser,
        signerId: sourceSigner,
        entityTxs: [],
      }, {
        entityId: sourceUser,
        signerId: sourceSigner,
        entityTxs: [],
      }],
      [],
      {
        isReplay: false,
        routingDeps: makeLocalCrossJRoutingDeps(),
        beforeEntityApply: entityId => {
          if (entityId === targetUser) targetApplied = true;
          if (targetApplied && entityId === sourceUser) {
            sourceMirrorAttempted = true;
            env.state.eReplicas
              .get(`${sourceUser}:${sourceSigner}`)!
              .state.crossJurisdictionSwaps
              ?.delete(route.orderId);
          }
        },
      },
    )).rejects.toThrow('RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN');

    expect(sourceMirrorAttempted).toBe(true);
    const targetState = env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state;
    expect(targetState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(targetState.jBatchState?.sentBatch?.batch.disputeStarts ?? []).toEqual([]);
  });

  test('salvage fails loud instead of rebinding to another local target signer', async () => {
    const {
      env, sourceUser, targetUser, sourceSigner, targetSigner,
      alternateTargetSigner, buildSourceDisputeRange,
    } = makeBidirectionalSalvageRuntimeFixture('cross-salvage-pinned-target-signer');
    const alternateBefore = cloneEntityState(
      env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state,
    );
    env.state.eReplicas.delete(`${targetUser}:${targetSigner}`);

    await expect(applyMergedEntityInputs(
      env,
      [
        {
          entityId: sourceUser,
          signerId: sourceSigner,
          entityTxs: [{ type: 'j_event', data: buildSourceDisputeRange() }],
        },
        { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
        { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
      ],
      [],
      { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
    )).rejects.toThrow('RUNTIME_OUTPUT_TARGET_NOT_LOCAL');

    expect(env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state).toEqual(alternateBefore);
  });

  test('same-pass salvage fails loud on corrupt target pull or bilateral account', async () => {
    const corruptions = [
      {
        name: 'target-pull',
        error: 'CROSS_J_SALVAGE_TARGET_PULL_MISSING',
        mutate: (state: EntityReplica['state'], route: CrossJurisdictionSwapRoute) => {
          delete state.crossJurisdictionSwaps?.get(route.orderId)?.targetPull;
        },
      },
      {
        name: 'target-account',
        error: 'CROSS_J_SALVAGE_TARGET_ACCOUNT_MISSING',
        mutate: (state: EntityReplica['state'], route: CrossJurisdictionSwapRoute) => {
          state.accounts.delete(route.target.entityId);
        },
      },
    ];
    for (const corruption of corruptions) {
      const {
        env, sourceUser, targetUser, sourceSigner, targetSigner,
        route, buildSourceDisputeRange,
      } = makeBidirectionalSalvageRuntimeFixture(`cross-salvage-corrupt-${corruption.name}`);
      let injected = false;
      await expect(applyMergedEntityInputs(
        env,
        [
          {
            entityId: sourceUser,
            signerId: sourceSigner,
            entityTxs: [{ type: 'j_event', data: buildSourceDisputeRange() }],
          },
          { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
          { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
        ],
        [],
        {
          isReplay: false,
          routingDeps: makeLocalCrossJRoutingDeps(),
          beforeEntityApply: entityId => {
            if (injected || entityId !== targetUser) return;
            injected = true;
            corruption.mutate(
              env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state,
              route,
            );
          },
        },
      )).rejects.toThrow(corruption.error);
      expect(injected).toBe(true);
      const targetState = env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state;
      expect(targetState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
      expect(targetState.jBatchState?.sentBatch?.batch.disputeStarts ?? []).toEqual([]);
    }
  });

  test('DisputeFinalized sidecar args queue target sibling salvage', async () => {
    const env = createEmptyEnv('cross-dispute-finalized-salvage');
    env.scenarioMode = true;
    env.state.timestamp = 31_000;
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x2345);
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
    const pullArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    const sourceAccount = state.accounts.get(sourceHub)!;
    sourceAccount.state.pulls ??= new Map();
    sourceAccount.state.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
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
    const finalizedSnapshot = captureDisputeArgumentSnapshot(
      sourceAccount,
      finalizedProof.proofBodyHash,
      1,
      finalizedProof.proofBodyStruct,
    );
    storeDisputeArgumentSnapshot(sourceAccount, finalizedSnapshot);
    const pullIsLeft = finalizedSnapshot.plan.leftPullIds.includes(route.sourcePull!.pullId);
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
    const disputeFinalizationEvidence = [
      {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: finalizedProof.proofBodyHash,
        finalProofbodyHash: finalizedProof.proofBodyHash,
        leftArguments: pullIsLeft ? pullArguments : '0x',
        rightArguments: pullIsLeft ? '0x' : pullArguments,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      },
    ];
    const signed = prepareJEventInput(env, sourceUser, signer, {
      blockNumber: 3,
      blockHash: secret('9c'),
      transactionHash: secret('9d'),
      events: [finalizedEvent],
      disputeFinalizationEvidence,
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(
      state,
      {
        from: signer,
        event: finalizedEvent,
        observedAt: env.state.timestamp,
        blockNumber: 3,
        blockHash: secret('9c'),
        transactionHash: secret('9d'),
        disputeFinalizationEvidence,
        ...signed,
      },
      env,
    );

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
    env.state.timestamp = 32_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('39');
    const sourceHub = entity('3a');
    const targetHub = entity('3b');
    const targetUser = entity('3c');
    const signer = registerTestSigner(env, 'cross-dispute-finalized-unsigned-sidecar', '1');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    route.cumulativeFillRatio = 0x1234;
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
    const disputeFinalizationEvidence = [
      {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: secret('aa'),
        finalProofbodyHash: secret('ab'),
        leftArguments: ethers.AbiCoder.defaultAbiCoder().encode(['bytes[]'], [[crossPullArgs]]),
        rightArguments: '0x',
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
      },
    ];
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

    const unsignedEvidenceRange = buildJEventRangeData(
      state,
      {
        from: signer,
        event: finalizedEvent,
        observedAt: env.state.timestamp,
        blockNumber: 4,
        blockHash: secret('ac'),
        transactionHash: secret('ad'),
        ...signedWithoutEvidence,
      },
      env,
    );
    unsignedEvidenceRange.blocks[0]!.disputeFinalizationEvidence = disputeFinalizationEvidence;

    await expect(
      applyEntityTx(env, state, {
        type: 'j_event',
        data: unsignedEvidenceRange,
      }),
    ).rejects.toThrow('J_RANGE_EVIDENCE_HASH_MISMATCH');
  });

  test('source dispute preserves Solidity pull slots instead of rematching binaries', () => {
    const env = createEmptyEnv('cross-salvage-route-binary-match');
    env.state.timestamp = 39_000;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('31');
    const sourceHub = entity('32');
    const sourceSigner = addr('60');
    const state = makeState(sourceUser, sourceSigner, eth, sourceHub);
    const buildRoute = (orderId: string, targetByte: string, targetSignerByte: string) =>
      buildPreparedCrossJurisdictionRoute({
        orderId,
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: sourceSigner,
        targetSignerId: addr(targetSignerByte),
        source: {
          jurisdiction: jref(eth),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 100n,
        },
        target: {
          jurisdiction: jref(base),
          entityId: entity('33'),
          counterpartyEntityId: entity(targetByte),
          tokenId: 1,
          amount: 90n,
        },
        status: 'resting' as const,
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      }, {
        runtimeSeed: `route-seed-${orderId}`,
        sourceDisputeDelayMs: 5_000,
        now: env.state.timestamp,
      });
    const first = buildRoute('cross-salvage-a', '34', '61');
    const second = buildRoute('cross-salvage-b', '35', '62');
    applyExactTestFill(first, 0x1234);
    applyExactTestFill(second, 0x4321);
    state.crossJurisdictionSwaps?.set(first.orderId, first);
    state.crossJurisdictionSwaps?.set(second.orderId, second);
    const firstReveal = buildCrossJurisdictionPullReveal(
      first,
      0x1234,
      deriveCrossJurisdictionPrivateSeed(`route-seed-${first.orderId}`, first),
    );
    const secondReveal = buildCrossJurisdictionPullReveal(
      second,
      0x4321,
      deriveCrossJurisdictionPrivateSeed(`route-seed-${second.orderId}`, second),
    );
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const pullArgs = abi.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [secondReveal.binary, firstReveal.binary] }],
    );
    const starterArgs = abi.encode(['bytes[]'], [[pullArgs]]);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSalvageFromFinalizedArguments(
      state,
      outputs,
      sourceHub,
      { leftArguments: starterArgs, rightArguments: '0x' },
      {
        leftPullIds: [first.sourcePull!.pullId, second.sourcePull!.pullId],
        rightPullIds: [],
      },
      12,
    )).toBe(true);
    expect(outputs.map(output => ({
      routeId: (output.entityTxs?.[0]?.data as { routeId?: string }).routeId,
      binary: (output.entityTxs?.[0]?.data as { binary?: string }).binary,
    }))).toEqual([
      { routeId: first.orderId, binary: '0x' },
      { routeId: second.orderId, binary: '0x' },
    ]);
  });

  test('crossJurisdictionSalvage lets prepareDispute safely schedule the target broadcast', async () => {
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
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const targetAccount = state.accounts.get(targetHub)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
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
      createdTimestamp: env.state.timestamp,
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
      targetAccount.state,
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

    expect(result.outputs).toHaveLength(2);
    const sourceMirror = result.outputs?.[0];
    const targetBroadcast = result.outputs?.[1];
    expect(sourceMirror?.entityId).toBe(sourceUser);
    expect(sourceMirror?.signerId).toBe(sourceSigner);
    expect(sourceMirror?.localRuntimeProtocol).toBe('cross-j');
    expect(sourceMirror?.entityTxs).toEqual([{
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 10,
      },
    }]);
    expect(targetBroadcast?.entityId).toBe(targetUser);
    expect(targetBroadcast?.entityTxs?.map(tx => tx.type)).toEqual(['j_broadcast']);
    const draftDisputeStarts = result.newState.jBatchState?.batch.disputeStarts ?? [];
    expect(draftDisputeStarts).toHaveLength(1);
    const starterInitialArguments = draftDisputeStarts[0]!.starterInitialArguments;
    expect(typeof starterInitialArguments).toBe('string');
    expect(starterInitialArguments).toMatch(/^0x[0-9a-f]+$/i);
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const [wrapped] = abi.decode(['bytes[]'], starterInitialArguments) as unknown as [string[]];
    const [decoded] = abi.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      wrapped[0]!,
    ) as unknown as [{ pulls: string[] }];
    expect(Array.from(decoded.pulls)).toEqual([binary]);

    const sourceState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    sourceState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    const sourceResult = await applyEntityTx(env, sourceState, sourceMirror!.entityTxs[0]!);
    expect(sourceResult.outputs).toEqual([]);
    const mirroredSourceRoute = sourceResult.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(mirroredSourceRoute?.status).toBe('clearing');
    expect(mirroredSourceRoute?.pendingClearRequestedAt)
      .toBe(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingClearRequestedAt);

    const claimedSourceState = makeState(sourceUser, sourceSigner, eth, sourceHub);
    const claimedRoute = cloneCrossJurisdictionRoute(route);
    claimedRoute.status = 'source_claimed';
    claimedSourceState.crossJurisdictionSwaps?.set(route.orderId, claimedRoute);
    const claimedSourceResult = await applyEntityTx(env, claimedSourceState, sourceMirror!.entityTxs[0]!);
    expect(claimedSourceResult.outputs).toEqual([]);
    expect(claimedSourceResult.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('source_claimed');
    expect(claimedSourceResult.newState.crossJurisdictionSwaps?.get(route.orderId)?.pendingClearRequestedAt)
      .toBe(claimedSourceState.timestamp);

    expect(readEntityFrameEventMessages(result.newState)
      .some(message => message.includes('blocked until evidence is stable'))).toBe(false);

    const starterState = cloneEntityState(state);
    const starterAccount = starterState.accounts.get(targetHub)!;
    starterAccount.status = 'disputed';
    starterAccount.activeDispute = {
      startedByLeft: starterAccount.state.leftEntity === targetUser,
      initialProofbodyHash: targetProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 0,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: true,
      observedBlockNumber: 1,
      finalizeQueued: false,
      crossJurisdictionRecovery: {
        requiredPullIds: [route.targetPull!.pullId],
        resultsByPullId: {},
      },
    };
    await expect(applyEntityTx(env, starterState, {
      type: 'crossJurisdictionSalvage',
      data: {
        routeId: route.orderId,
        binary,
        fillRatio: 0x1234,
        sourceEntityId: sourceUser,
        sourceCounterpartyEntityId: sourceHub,
        observedAt: 10,
      },
    })).rejects.toThrow(`CROSS_J_SALVAGE_STARTER_EVIDENCE_LATE:${route.orderId}`);

    const nonstarterState = cloneEntityState(starterState);
    const nonstarterAccount = nonstarterState.accounts.get(targetHub)!;
    nonstarterAccount.activeDispute!.startedByLeft =
      nonstarterAccount.state.leftEntity !== targetUser;
    const recovered = await applyEntityTx(env, nonstarterState, {
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
    expect(recovered.outputs).toHaveLength(1);
    const recoveredAccount = recovered.newState.accounts.get(targetHub)!;
    const payload = buildFinalProofPayload(
      recovered.newState,
      recoveredAccount,
      targetHub,
      {
        finalNonce: 1,
        finalNonceSource: 'test',
        finalizeSig: '0x',
        finalProofbody: targetProof.proofBodyStruct,
        finalProofbodyHash: targetProof.proofBodyHash,
        shouldUseCounterProof: false,
        callerSide: recoveredAccount.state.leftEntity === targetUser ? 'left' : 'right',
      },
      env,
    );
    const [otherWrapped] = abi.decode(['bytes[]'], payload.otherArguments) as unknown as [string[]];
    const [otherDecoded] = abi.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      otherWrapped[0]!,
    ) as unknown as [{ pulls: string[] }];
    expect(Array.from(otherDecoded.pulls)).toContain(binary);
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
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
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

  test('target dispute skips an older terminal route and selects the only active route', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-first');
    const terminal = fixture.buildRoute('a-terminal', { status: 'settled' });
    const active = fixture.buildRoute('z-active');
    fixture.state.crossJurisdictionSwaps?.set(terminal.orderId, terminal);
    fixture.state.crossJurisdictionSwaps?.set(active.orderId, active);
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs)).not.toBeNull();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(fixture.sourceUser);
    expect(outputs[0]?.signerId).toBe(fixture.sourceSigner);
    expect(outputs[0]?.entityTxs?.[0]).toEqual({
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: fixture.sourceHub,
        crossJurisdictionRouteId: active.orderId,
        description: `Cross-j source dispute prepare ${active.orderId}`,
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

    expect(fixture.plan(outputs)).toBeNull();
    expect(outputs).toEqual([]);
  });

  test('target dispute ignores a route without a target pull commitment', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-no-target-pull');
    const route = fixture.buildRoute('active-without-target-pull', { withoutTargetPull: true });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs)).toBeNull();
    expect(outputs).toEqual([]);
  });

  test('target dispute requires only committed-fill routes present in the selected snapshot', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-selected-snapshot');
    const selected = fixture.buildRoute('a-selected');
    const later = fixture.buildRoute('z-later');
    fixture.state.crossJurisdictionSwaps?.set(selected.orderId, selected);
    const account = fixture.state.accounts.get(fixture.targetHub)!;
    account.state.pulls = new Map([[selected.targetPull!.pullId, {
      pullId: selected.targetPull!.pullId,
      tokenId: selected.targetPull!.tokenId,
      amount: selected.targetPull!.signedAmount,
      revealedUntilTimestamp: selected.targetPull!.revealedUntilTimestamp,
      fullHash: selected.targetPull!.fullHash,
      partialRoot: selected.targetPull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(selected, 'target'),
      createdHeight: 1,
      createdTimestamp: fixture.state.timestamp,
    }]]);
    const proof = buildAccountProofBody(account, addr('99'));
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);
    const outputs: EntityInput[] = [];

    const plan = planCrossJurisdictionTargetRecovery(
      fixture.state,
      account,
      fixture.targetHub,
      [proof.proofBodyHash],
      {},
      outputs,
    );
    expect(plan?.recovery.requiredPullIds).toEqual([selected.targetPull!.pullId]);
    expect(outputs).toHaveLength(1);
    expect((outputs[0]?.entityTxs?.[0]?.data as { crossJurisdictionRouteId?: string })
      .crossJurisdictionRouteId).toBe(selected.orderId);
  });

  test('target dispute groups concurrent routes on one source Account into one canonical dispute', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-ambiguous');
    const later = fixture.buildRoute('z-active');
    const earlier = fixture.buildRoute('a-active');
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);
    fixture.state.crossJurisdictionSwaps?.set(earlier.orderId, earlier);
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs)).not.toBeNull();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      entityId: fixture.sourceUser,
      signerId: fixture.sourceSigner,
      entityTxs: [{
        type: 'prepareDispute',
        data: {
          counterpartyEntityId: fixture.sourceHub,
          crossJurisdictionRouteId: 'a-active',
        },
      }],
    });
  });

  test('target dispute emits distinct source Accounts in canonical lane order', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-groups');
    const otherUser = entity('61');
    const otherHub = entity('62');
    const otherSigner = addr('83');
    fixture.state.crossJurisdictionSwaps?.set('z-default', fixture.buildRoute('z-default'));
    fixture.state.crossJurisdictionSwaps?.set('a-other', fixture.buildRoute('a-other', {
      sourceUser: otherUser,
      sourceHub: otherHub,
      sourceSigner: otherSigner,
    }));
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs)).not.toBeNull();
    expect(outputs.map(output => [output.entityId, output.signerId])).toEqual([
      [fixture.sourceUser, fixture.sourceSigner],
      [otherUser, otherSigner],
    ]);
  });

  test('target dispute validates every source lane before emitting any output', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-atomic-validation');
    fixture.state.crossJurisdictionSwaps?.set('a-valid', fixture.buildRoute('a-valid'));
    const invalid = fixture.buildRoute('z-invalid', { sourceUser: entity('61'), sourceHub: entity('62') });
    delete invalid.sourceSignerId;
    fixture.state.crossJurisdictionSwaps?.set(invalid.orderId, invalid);
    const outputs: EntityInput[] = [];

    expect(() => fixture.plan(outputs))
      .toThrow('CROSS_J_ROUTE_HASH_MISMATCH:z-invalid');
    expect(outputs).toEqual([]);
  });

  test('target dispute rejects conflicting signers for one source Account atomically', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-signer-conflict');
    fixture.state.crossJurisdictionSwaps?.set('a-first', fixture.buildRoute('a-first'));
    fixture.state.crossJurisdictionSwaps?.set('z-conflict', fixture.buildRoute('z-conflict', {
      sourceSigner: addr('84'),
    }));
    const outputs: EntityInput[] = [];

    expect(() => fixture.plan(outputs))
      .toThrow('CROSS_J_SOURCE_DISPUTE_SIGNER_CONFLICT:z-conflict');
    expect(outputs).toEqual([]);
  });

  test('target dispute still protects an uncovered Account when another Account supplied pull evidence', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-partial-coverage');
    const covered = fixture.buildRoute('a-covered');
    const uncovered = fixture.buildRoute('z-uncovered', {
      sourceUser: entity('61'),
      sourceHub: entity('62'),
      sourceSigner: addr('83'),
    });
    fixture.state.crossJurisdictionSwaps?.set(covered.orderId, covered);
    fixture.state.crossJurisdictionSwaps?.set(uncovered.orderId, uncovered);
    const coveredBinary = buildCrossJurisdictionPullReveal(
      covered,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('test-seed', covered),
    ).binary;
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs, {
      [covered.targetPull!.pullId]: coveredBinary,
    })).not.toBeNull();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      entityId: uncovered.source.entityId,
      signerId: uncovered.sourceSignerId,
    });
  });

  test('target dispute ignores a route bound to another target hub', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-other-hub');
    const route = fixture.buildRoute('other-target-hub', { targetHub: entity('55') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(fixture.plan(outputs)).toBeNull();
    expect(outputs).toEqual([]);
  });

  test('target DisputeStarted without pull args forces source dispute first', async () => {
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
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x1234);
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route });

    const targetAccount = targetState.accounts.get(targetHub)!;
    targetAccount.state.pulls ??= new Map();
    targetAccount.state.pulls.set(route.targetPull!.pullId, {
      pullId: route.targetPull!.pullId,
      tokenId: route.targetPull!.tokenId,
      amount: route.targetPull!.signedAmount,
      revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
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
      captureDisputeArgumentSnapshot(
        targetAccount,
        targetProof.proofBodyHash,
        1,
        targetProof.proofBodyStruct,
      ),
    );

    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: targetHub,
        counterentity: targetUser,
        nonce: '1',
        proofbodyHash: targetProof.proofBodyHash,
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
        disputeTimeout: 100,
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

    const sourceOutput = result!.outputs.find(output => output.entityId === sourceUser);
    expect(sourceOutput?.signerId).toBe(sourceSigner);
    expect(sourceOutput?.entityTxs?.map(tx => tx.type)).toEqual(['prepareDispute']);
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
    const state = makeState(sourceUser, signer, makeJurisdiction('Ethereum', 1, '11', '12'), sourceHub);

    await expect(
      applyEntityTx(env, state, {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: sourceHub,
          crossJurisdictionRouteId: 'missing-route',
        },
      }),
    ).rejects.toThrow('DISPUTE_START_CROSS_J_ROUTE_MISSING:missing-route');
  });

  test('route-bound disputeStart rejects a route from another bilateral account', async () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-route-bound-role-mismatch');
    const route = fixture.buildRoute('wrong-target-account', { targetHub: entity('99') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    await expect(
      applyEntityTx(fixture.env, fixture.state, {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: fixture.targetHub,
          crossJurisdictionRouteId: route.orderId,
        },
      }),
    ).rejects.toThrow(`DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${route.orderId}`);
  });

});
