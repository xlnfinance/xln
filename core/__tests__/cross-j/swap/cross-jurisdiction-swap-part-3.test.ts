import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyAccountTx } from '../../../account/tx/apply';
import { recordSwapOfferLifecycle } from '../../../account/tx/handlers/swap/lifecycle/history';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';

import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../../../entity/tx/handlers/account/index';

import { applyEntityInput, mergeEntityInputs } from '../../../entity/consensus/index';

import {
  appendDefaultProposerCrossJMaterializations,
  entityTxContainsCrossJMaterialization,
  selectCrossJCommitPhaseTxs,
  selectCrossJOpeningAccountProposalTxs,
} from '../../../entity/transition/cross-j-proposer-materialization';

import { prepareLocallyAuthoredEntityTxs } from '../../../entity/command';

import {
  createEmptyEnv,
  handleInboundP2PEntityInputs,
  admitAtomicCrossJAccountInputs,
  submitCrossJurisdictionIntent,
  submitCrossJurisdictionSwap,
} from '../../../runtime';

import { buildCrossJurisdictionSwapSubmission } from '../../../runtime/j-submit/api';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';

import type { AccountTx } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityReplica, EntityState } from '../../../entity/types';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';

import { generateLazyEntityId } from '../../../entity/factory';

import { createDefaultDelta } from '../../../account/state/delta';

import { cloneAccountReplica } from '../../../account/state/state-clone';
import { cloneEntityReplica } from '../../../entity/replica/replica-clone';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';

import { projectAccountDoc, projectEntityCoreDoc } from '../../../storage/read/projections';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../entity/tx/handlers/account-cross-j-followups';

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
} from '../../../extensions/cross-j/index';

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
} from '../../../extensions/cross-j/orderbook';

import { buildCrossJurisdictionPendingFillFromAck } from '../../../extensions/cross-j/fill-ack';

import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../../../extensions/cross-j/market';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../../../account/utils';

import { normalizeEntitySwapTradingPairs } from '../../../runtime/swap-cmd/swap-pairs';

import { verifyHashLadderBinary } from '../../../protocol/htlc/hash-ladder';

import {
  getStaticSwapTokenDimensions,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  quoteAmountAtPrice,
} from '../../../orderbook/types';
import { cloneJBatch, createEmptyBatch, initJBatch } from '../../../jurisdiction/machine/batch';
import { applyHankoBatchProcessedEvent } from '../../../entity/tx/j-events-batch';

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';

import {
  buildDisputeArgumentsFromSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../protocol/dispute/arguments';

import { signEntityHashes } from '../../../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../../../entity/consensus/output/certification';

import {
  countDeferredHashLadderReveals,
  flushDeferredHashLadderReveals,
  planCrossJurisdictionTargetRecovery,
  queueCrossJurisdictionRevealPorts,
} from '../../../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../../../runtime/mempool/entity-inputs';

import { crossBookQtyLots } from '../../../entity/tx/handlers/account/orderbook';
import { buildFinalProofPayload } from '../../../entity/tx/handlers/dispute/finalize-proof';

import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  selectPotentialCrossJAccountInputPairs,
  selectMatchedCrossJAccountInputPairs,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeEntityRoutingDeps,
} from '../../../runtime/delivery/topology/entity-routing';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  dispatchEntityOutputs,
  planEntityOutputs,
  rescheduleDeferredOutputs,
  splitPendingOutputsByRetryWindow,
} from '../../../runtime/delivery/topology/output-routing';

import { deliveryAccepted, deliveryDeferred } from '../../../protocol/payments/delivery-result';

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
} from '../../helpers/cross-j';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

import { recordValidatorJHistory } from '../../../jurisdiction/machine/local-history';
import { canonicalDisputeFinalizationEvidenceHash } from '../../../jurisdiction/machine/event-observation';

import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';


import { LIMITS } from '../../../config/constants';

import { getEffectiveEntityInputTxs } from '../../../entity/consensus/output/envelope';

import { assertRuntimeOutputAuthorization } from '../../../entity/auth/authorization';

import { createDueScheduledWakeInputs } from '../../../runtime/mempool/scheduled-wake';

import { ACCOUNT_PENDING_RESEND_AFTER_MS } from '../../../entity/scheduler';

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
      { runtimeSeed: 'cross-cancel-after-accepted-fill', now: 1_000 },
    );
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      maxFee: 0n,
      minNetReceive: 900n,
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
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const account = sourceHubState.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      maxFee: 0n,
      minNetReceive: 900n,
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
      { runtimeSeed: 'cross-cancel-no-orderbook-ext', now: env.state.timestamp },
    );
    const account = state.accounts.get(sourceHub)!;
    account.currentFrame.prevFrameHash = 'genesis';
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      maxFee: 0n,
      minNetReceive: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    recordSwapOfferLifecycle(account, account.state.swapOffers.get(route.orderId)!);
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
      { runtimeSeed: 'cross-fill-invalid-target', now: env.state.timestamp },
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
        { runtimeSeed: 'cross-fill-delayed-commit', now: env.state.timestamp },
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
    expect(
      result.outputs.some(
        output =>
          output.entityId === targetHub && output.entityTxs?.some(tx => tx.type === 'crossJurisdictionFillNotice'),
      ),
    ).toBe(false);
    const canonical = result.newState.crossJurisdictionSwaps?.get(route.orderId);
    expect(canonical?.status).toBe('resting');
    expect(canonical?.fillSeq).toBeUndefined();
    expect(canonical?.cumulativeFillRatio).toBeUndefined();
  });

  test('never-filled cancel notice with 0/1 sentinel is not STALE_CONFLICT', async () => {
    // buildCrossJurisdictionCancelAck must send bigint fillNumerator/Denominator;
    // for fillSeq=0 it uses 0n/1n while the resting route has no exact fields.
    const env = createEmptyEnv('cross-fill-cancel-zero-sentinel');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('d1');
    const sourceHub = entity('d2');
    const targetHub = entity('d3');
    const targetUser = entity('d4');
    const state = makeState(targetHub, addr('d3'), base, targetUser);
    const route = {
      ...buildPreparedCrossJurisdictionRoute(
        {
          orderId: 'cross-fill-cancel-zero-sentinel',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          targetHubSignerId: addr('d3'),
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
        { runtimeSeed: 'cross-fill-cancel-zero-sentinel', now: env.state.timestamp },
      ),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const cancelAck = buildCrossJurisdictionCancelAck(route.orderId, route);
    expect(cancelAck.data.fillSeq).toBe(0);
    expect(cancelAck.data.fillNumerator).toBe(0n);
    expect(cancelAck.data.fillDenominator).toBe(1n);

    const result = await applyEntityTx(env, state, {
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: route.orderId,
        ...(route.routeHash ? { routeHash: route.routeHash } : {}),
        previousFillSeq: 0,
        fillSeq: 0,
        incrementalSourceAmount: 0n,
        incrementalTargetAmount: 0n,
        cumulativeSourceAmount: 0n,
        cumulativeTargetAmount: 0n,
        cumulativeFillRatio: 0,
        fillNumerator: 0n,
        fillDenominator: 1n,
        cancelRemainder: true,
        pairId: route.venueId || '',
      },
    });
    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_progress']);
    expect(result.accountTxs?.[0]?.tx).toMatchObject({
      type: 'cross_pull_progress',
      data: { fill: { ackKind: 'cancel', fillSeq: 0, cancelRemainder: true } },
    });
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
        { runtimeSeed: 'cross-fill-notice-idempotent', now: env.state.timestamp },
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
        { runtimeSeed: 'cross-fill-book-owner-reject', now: env.state.timestamp },
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
    expect(progress.ok).toBe(true);
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
      { runtimeSeed: seed, now: env.state.timestamp },
    );

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.state.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        ...getStaticSwapTokenDimensions(1, 1),
        giveTokenId: 1,
        giveAmount: 1_000n,
        wantTokenId: 1,
        wantAmount: 900n,
        maxFee: 0n,
        minNetReceive: 900n,
        priceTicks: 900n,
        timeInForce: 0,
        makerIsLeft: account.state.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
      recordSwapOfferLifecycle(account, account.state.swapOffers.get(route.orderId)!);
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
      { runtimeSeed: seed, now: env.state.timestamp },
    );

    for (const state of [sourceUserState, sourceHubState]) {
      state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
      const counterparty = state.entityId === sourceUser ? sourceHub : sourceUser;
      const account = state.accounts.get(counterparty)!;
      account.state.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        ...getStaticSwapTokenDimensions(1, 1),
        giveTokenId: 1,
        giveAmount: sourceTotal,
        wantTokenId: 1,
        wantAmount: targetTotal,
        maxFee: 0n,
        minNetReceive: targetTotal,
        priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
        timeInForce: 0,
        makerIsLeft: account.state.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
      recordSwapOfferLifecycle(account, account.state.swapOffers.get(route.orderId)!);
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
        { runtimeSeed: 'cross-sweep-expired', now: 1_000 },
      ),
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 1,
      wantAmount: 900n,
      maxFee: 0n,
      minNetReceive: 900n,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    recordSwapOfferLifecycle(account, account.state.swapOffers.get(route.orderId)!);
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: 1,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
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
    expect(result.outputs).toEqual([
      {
        entityId: sourceHub,
        signerId: state.config.validators[0]!,
        entityTxs: [],
      },
    ]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');

    const updatedAccount = result.newState.accounts.get(sourceUser)!;
    const cancelAck = result.accountTxs![0]!.tx;
    expect(
      (
        await applyAccountTx(
          updatedAccount,
          cancelAck,
          updatedAccount.state.leftEntity === sourceHub,
          env.state.timestamp,
        )
      ).ok,
    ).toBe(true);
    const continuation = await applyEntityTx(env, result.newState, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });
    expect(continuation.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect((continuation.accountTxs?.[0]?.tx as any).data.binary).toBe('0x');
    expect((continuation.accountTxs?.[0]?.tx as any).data.proof.fillRatio).toBe(0);
    expect(
      continuation.outputs.some(
        output => output.entityId === targetHub && output.entityTxs?.some(tx => tx.type === 'crossPullClose'),
      ),
    ).toBe(true);
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
        { runtimeSeed: 'cross-sweep-filled-expired-clear', now: 1_000 },
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
      ...getStaticSwapTokenDimensions(1, 1),
      giveTokenId: 1,
      giveAmount: 500n,
      wantTokenId: 1,
      wantAmount: 450n,
      maxFee: 0n,
      minNetReceive: 450n,
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
      contracts: { depository: eth.depositoryAddress, entityProvider: eth.entityProviderAddress },
      blockTimeMs: eth.blockTimeMs,
    } as any);
    env.state.jReplicas.set(base.name, {
      name: base.name,
      chainId: base.chainId,
      rpcs: [base.address],
      contracts: { depository: base.depositoryAddress, entityProvider: base.entityProviderAddress },
      blockTimeMs: base.blockTimeMs,
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
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      [{ fillRatios: [], secrets: [revealedSecret] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[paymentArgs]]);
    const disputeProof = buildAccountProofBody(state.accounts.get(hub)!, '');
    const proofbodyHash = disputeProof.proofBodyHash;
    state.accounts.get(hub)!.disputeProofBodiesByHash = {
      [proofbodyHash]: disputeProof.proofBodyStruct,
    };
    state.jBatchState = initJBatch();
    state.jBatchState.autoBroadcastDraft = true;
    state.jBatchState.batch.disputeStarts.push({
      counterentity: hub,
      nonce: 1,
      proposerIsLeft: true,
      proofbodyHash,
      initialProofbody: structuredClone(disputeProof.proofBodyStruct),
      watchSeed: state.accounts.get(hub)!.state.watchSeed,
      sig: '0x',
      starterInitialArguments,
      starterCounterArguments: '0x',
      starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: hub,
        counterentity: user,
        nonce: '1',
        proposerIsLeft: true,
        proofbodyHash,
        initialProofbody: structuredClone(disputeProof.proofBodyStruct),
        starterInitialArguments,
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        disputeTimeout: 1700000020,
        disputeStartTimestamp: 1700000000,
        leftResponseSeconds: 10,
        rightResponseSeconds: 10,
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
    // The external start invalidates our duplicate mutable start, but the
    // mutable batch already has the durable j_broadcast continuation emitted
    // when it was queued. Emitting a second continuation here could arrive
    // after the first seals the batch and fail-stop on the active sentBatch.
    expect(result.newState.jBatchState?.batch.disputeStarts).toEqual([]);
    expect(result.outputs?.filter(output => output.entityTxs?.[0]?.type === 'j_broadcast')).toEqual([]);
    expect(result.outputs?.[0]?.entityId).toBe(targetUser);
    expect(result.outputs?.[0]?.signerId).toBe(targetSigner);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('resolveHtlcLock');
    const data = result.outputs?.[0]?.entityTxs?.[0]?.data as any;
    expect(data.counterpartyEntityId).toBe(targetHub);
    expect(data.lockId).toBe(targetLockId);
    expect(data.secret).toBe(revealedSecret);
  });

  test('newer Pull counter-proof queues its Source reveal in the same batch', async () => {
    const env = createEmptyEnv('cross-counter-source-window');
    env.scenarioMode = true;
    env.state.timestamp = 1_700_000_000_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    installJurisdictions(env, eth, base);
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceHubSigner = registerTestSigner(env, 'cross-counter-source-window', '1');
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    state.timestamp = env.state.timestamp;
    addReplica(env, state, sourceHubSigner);
    const account = state.accounts.get(sourceUser)!;
    const sourceHubIsLeft = account.state.leftEntity.toLowerCase() === sourceHub.toLowerCase();
    account.state.disputeConfig = sourceHubIsLeft
      ? { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 }
      : { leftResponseSeconds: 86_400, rightResponseSeconds: 3_600 };

    const initialProof = buildAccountProofBody(account, addr('99'));
    const route = buildPreparedCrossJurisdictionRouteCanonical({
      orderId: 'cross-counter-source-window',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: addr('63'),
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
      sourceDisputeConfig: account.state.disputeConfig,
      targetDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
      status: 'resting',
      createdAt: env.state.timestamp,
      updatedAt: env.state.timestamp,
    }, { runtimeSeed: env.runtimeSeed, now: env.state.timestamp });
    applyExactTestFill(route, 0x2345);
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    account.state.pulls ??= new Map();
    account.state.pulls.set(route.sourcePull!.pullId, {
      pullId: route.sourcePull!.pullId,
      tokenId: route.sourcePull!.tokenId,
      amount: route.sourcePull!.signedAmount,
      fullHash: route.sourcePull!.fullHash,
      partialRoot: route.sourcePull!.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      createdHeight: 1,
      createdTimestamp: env.state.timestamp,
    });
    const counterProof = buildAccountProofBody(account, addr('99'));
    const counterProposerIsLeft = account.state.leftEntity.toLowerCase() === sourceUser.toLowerCase();
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
      [counterProof.proofBodyHash]: counterProof.proofBodyStruct,
    };
    account.disputeProofNoncesByHash = {
      [initialProof.proofBodyHash]: 1,
      [counterProof.proofBodyHash]: 2,
    };
    account.counterpartyDisputeProofBodyHash = counterProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofProposerIsLeft = counterProposerIsLeft;
    account.counterpartyDisputeProofHanko = '0x1234';
    account.counterpartyDisputeHash = createDisputeProofHashWithNonce(
      account.state,
      counterProof.proofBodyHash,
      { chainId: eth.chainId!, depositoryAddress: eth.depositoryAddress! },
      2,
      counterProposerIsLeft,
    );
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, counterProof.proofBodyHash, 2, counterProposerIsLeft, counterProof.proofBodyStruct),
    );

    const startSec = 1_700_000_000;
    const disputeStartedEvent: JurisdictionEvent = {
      type: 'DisputeStarted',
      data: {
        sender: sourceUser,
        counterentity: sourceHub,
        nonce: '1',
        proposerIsLeft: counterProposerIsLeft,
        proofbodyHash: initialProof.proofBodyHash,
        initialProofbody: initialProof.proofBodyStruct,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: ethers.ZeroHash,
        disputeTimeout: startSec + 90_000,
        disputeStartTimestamp: startSec,
        leftResponseSeconds: account.state.disputeConfig.leftResponseSeconds,
        rightResponseSeconds: account.state.disputeConfig.rightResponseSeconds,
        watchSeed: account.state.watchSeed,
      },
    };
    const signed = prepareJEventInput(env, sourceHub, sourceHubSigner, {
      blockNumber: 2,
      blockHash: secret('d1'),
      transactionHash: secret('d2'),
      events: [disputeStartedEvent],
      jurisdictionRef: jref(eth),
    });
    const stateBehindSentBatch = createEntityFrameCandidateState(state);
    stateBehindSentBatch.jBatchState = initJBatch();
    stateBehindSentBatch.jBatchState.status = 'sent';
    stateBehindSentBatch.jBatchState.sentBatch = {
      batch: createEmptyBatch(),
      batchHash: secret('d3'),
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: env.state.timestamp,
      lastSubmittedAt: env.state.timestamp,
      submitAttempts: 1,
    };
    const result = await applyJEventRange(state, {
      from: sourceHubSigner,
      event: disputeStartedEvent,
      observedAt: env.state.timestamp,
      blockNumber: 2,
      blockHash: secret('d1'),
      transactionHash: secret('d2'),
      ...signed,
    }, env);

    expect(result.newState.jBatchState?.batch.counterDisputes).toHaveLength(1);
    expect(result.newState.jBatchState?.batch.hashLadderRegistrations).toEqual([
      expect.objectContaining({
        counterpartyEntity: sourceUser,
        targetRole: false,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
      }),
    ]);

    const deferred = await applyJEventRange(stateBehindSentBatch, {
      from: sourceHubSigner,
      event: disputeStartedEvent,
      observedAt: env.state.timestamp,
      blockNumber: 2,
      blockHash: secret('d1'),
      transactionHash: secret('d2'),
      ...signed,
    }, env);
    expect(deferred.newState.jBatchState?.batch.counterDisputes).toHaveLength(1);
    expect(deferred.newState.jBatchState?.autoBroadcastDraft).toBe(true);
    const ackOutputs: EntityInput[] = [];
    await applyHankoBatchProcessedEvent({
      newState: deferred.newState,
      event: {
        type: 'HankoBatchProcessed',
        data: { entityId: sourceHub, batchHash: secret('d3'), nonce: 1 },
      },
      blockNumber: 3,
      outputs: ackOutputs,
    });
    expect(deferred.newState.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
    expect(ackOutputs.flatMap(output => output.entityTxs ?? []).map(tx => tx.type)).toEqual([
      'j_broadcast',
    ]);
  });

  test('source registry reveal ports to the target user lane deterministically', async () => {
    const {
      env,
      sourceUser,
      targetUser,
      sourceSigner,
      targetSigner,
      alternateTargetSigner,
      route,
      fillRatio,
      binary,
      buildSourceRevealRange,
    } = makeBidirectionalSalvageRuntimeFixture('cross-dispute-salvage');
    const alternateBefore = env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state;
    const range = buildSourceRevealRange();
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
    // Exactly one port instruction, source-user lane → target-user lane. There
    // is no source mirror anywhere in the port design: the on-chain registry
    // record itself is the shared evidence.
    expect(result.localCrossJurisdictionEventTrace.map(input => input.entityId)).toEqual([targetUser]);
    expect(result.localCrossJurisdictionEventTrace.map(input => input.signerId)).toEqual([targetSigner]);
    const port = getEffectiveEntityInputTxs(result.localCrossJurisdictionEventTrace[0]!)[0];
    expect(port).toMatchObject({
      type: 'crossJurisdictionSalvage',
      data: { routeId: route.orderId, binary, fillRatio },
    });
    // The target user flushed its own broadcast for the next frame.
    expect(result.entityOutbox.map(output => getEffectiveEntityInputTxs(output)[0]?.type)).toEqual(['j_broadcast']);
    const committedSource = env.state.eReplicas.get(`${sourceUser}:${sourceSigner}`)!.state;
    const committedTarget = env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state;
    // The port never injects dispute arguments: it queues a registry write.
    expect(committedTarget.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    const queuedReveals = committedTarget.jBatchState?.batch.hashLadderRegistrations ?? [];
    expect(queuedReveals).toHaveLength(1);
    expect(queuedReveals[0]).toMatchObject({
      targetRole: true,
      witness: { fillRatio },
    });
    // Hub wrote on-chain — observer must NOT latch the user's own Source slot
    // (shared ladderHash would make target salvage return already-queued).
    const sourceRoute = committedSource.crossJurisdictionSwaps?.get(route.orderId);
    expect(sourceRoute?.sourceRegistryFillRatio).toBeUndefined();
    expect(sourceRoute?.claimedRatio).toBeUndefined();
    expect(sourceRoute?.sourceRegistryRecord).toEqual({ fillRatio, revealedAt: 30 });
    // The source mirror is not touched by a port at all.
    expect(sourceRoute?.status).toBe('target_prepared');
    expect(env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state).toBe(alternateBefore);

    const replay = makeBidirectionalSalvageRuntimeFixture('cross-dispute-salvage');
    const replayResult = await applyMergedEntityInputs(
      replay.env,
      [
        {
          entityId: replay.sourceUser,
          signerId: replay.sourceSigner,
          entityTxs: [{ type: 'j_event', data: replay.buildSourceRevealRange() }],
        },
        { entityId: replay.sourceUser, signerId: replay.sourceSigner, entityTxs: [] },
        { entityId: replay.sourceUser, signerId: replay.sourceSigner, entityTxs: [] },
      ],
      [],
      { isReplay: true, routingDeps: makeLocalCrossJRoutingDeps() },
    );
    expect(replayResult.localCrossJurisdictionEventTrace.map(input => input.signerId)).toEqual(
      result.localCrossJurisdictionEventTrace.map(input => input.signerId),
    );
    expect(replayResult.localCrossJurisdictionEventTrace.map(getEffectiveEntityInputTxs)).toEqual(
      result.localCrossJurisdictionEventTrace.map(getEffectiveEntityInputTxs),
    );
  });

  test('reveal port fails loud instead of rebinding to another local target signer', async () => {
    const { env, sourceUser, targetUser, sourceSigner, targetSigner, alternateTargetSigner, buildSourceRevealRange } =
      makeBidirectionalSalvageRuntimeFixture('cross-salvage-pinned-target-signer');
    const alternateBefore = env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state;
    env.state.eReplicas.delete(`${targetUser}:${targetSigner}`);

    await expect(
      applyMergedEntityInputs(
        env,
        [
          {
            entityId: sourceUser,
            signerId: sourceSigner,
            entityTxs: [{ type: 'j_event', data: buildSourceRevealRange() }],
          },
          { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
          { entityId: sourceUser, signerId: sourceSigner, entityTxs: [] },
        ],
        [],
        { isReplay: false, routingDeps: makeLocalCrossJRoutingDeps() },
      ),
    ).rejects.toThrow('RUNTIME_OUTPUT_TARGET_NOT_LOCAL');

    expect(env.state.eReplicas.get(`${targetUser}:${alternateTargetSigner}`)!.state).toBe(alternateBefore);
  });

  test('reveal port fails loud on a corrupt target pull commitment', async () => {
    const { env, sourceUser, targetUser, sourceSigner, targetSigner, route, buildSourceRevealRange } =
      makeBidirectionalSalvageRuntimeFixture('cross-salvage-corrupt-target-pull');
    let injected = false;
    await expect(
      applyMergedEntityInputs(
        env,
        [
          {
            entityId: sourceUser,
            signerId: sourceSigner,
            entityTxs: [{ type: 'j_event', data: buildSourceRevealRange() }],
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
            delete env.state.eReplicas
              .get(`${targetUser}:${targetSigner}`)!
              .state.crossJurisdictionSwaps?.get(route.orderId)?.targetPull;
          },
        },
      ),
    ).rejects.toThrow('CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING');
    expect(injected).toBe(true);
    const targetState = env.state.eReplicas.get(`${targetUser}:${targetSigner}`)!.state;
    expect(targetState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(targetState.jBatchState?.batch.hashLadderRegistrations ?? []).toEqual([]);
  });

  test('registry reveal event queues the target sibling port', async () => {
    const env = createEmptyEnv('cross-reveal-port-event');
    env.scenarioMode = true;
    env.state.timestamp = 31_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('35');
    const sourceHub = entity('36');
    const targetHub = entity('37');
    const targetUser = entity('38');
    const signer = registerTestSigner(env, 'cross-reveal-port-event', '1');
    const targetSigner = registerTestSigner(env, 'cross-reveal-port-event', '2');
    const state = makeState(sourceUser, signer, eth, sourceHub);
    addReplica(env, makeState(targetUser, targetSigner, base, targetHub), targetSigner);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-pull-reveal-port',
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
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    applyExactTestFill(route, 0x2345);
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const reveal = buildCrossJurisdictionPullReveal(
      route,
      0x2345,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    );
    const revealEvent: JurisdictionEvent = {
      type: 'HashLadderRevealRegistered',
      data: {
        entity: sourceHub,
        counterpartyEntity: sourceUser,
        ladderHash: ethers.keccak256(
          ethers.solidityPacked(['bytes32', 'bytes32'], [route.sourcePull!.fullHash, route.sourcePull!.partialRoot]),
        ),
        fillRatio: 0x2345,
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
    const signed = prepareJEventInput(env, sourceUser, signer, {
      blockNumber: 3,
      blockHash: secret('9c'),
      transactionHash: secret('9d'),
      events: [revealEvent],
      jurisdictionRef: jref(eth),
    });
    const result = await applyJEventRange(
      state,
      {
        from: signer,
        event: revealEvent,
        observedAt: env.state.timestamp,
        blockNumber: 3,
        blockHash: secret('9c'),
        transactionHash: secret('9d'),
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
    expect(data.binary).toBe(reveal.binary);
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
      { runtimeSeed: 'test-seed', now: env.state.timestamp },
    );
    route.cumulativeFillRatio = 0x1234;
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x2222,
      deriveCrossJurisdictionPrivateSeed('test-seed', route),
    ).binary;
    const crossPullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      [{ fillRatios: [], secrets: [] }],
    );
    const finalProofbody = buildAccountProofBody(state.accounts.get(sourceHub)!, '').proofBodyStruct;
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
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
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
        finalizationEvidenceHash: secret('ad'),
        finalProofbody,
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

  test('dispute arguments never carry pull evidence', () => {
    const env = createEmptyEnv('cross-no-pull-args');
    env.state.timestamp = 39_000;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('31');
    const sourceHub = entity('32');
    const sourceSigner = addr('60');
    const state = makeState(sourceUser, sourceSigner, eth, sourceHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-no-pull-args',
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
          jurisdiction: jref(makeJurisdiction('Base', 8453, '21', '22')),
          entityId: entity('33'),
          counterpartyEntityId: entity('34'),
          tokenId: 1,
          amount: 90n,
        },
        status: 'resting' as const,
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      {
        runtimeSeed: 'route-seed-cross-no-pull-args',
        now: env.state.timestamp,
      },
    );
    const account = state.accounts.get(sourceHub)!;
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
          createdHeight: 1,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const proof = buildAccountProofBody(account, addr('99'));
    // The signed proof keeps the pull (it is account state), and the dispute
    // arguments for it carry nothing: pulls settle from the on-chain registry.
    expect(proof.runtimeProofBody.transformers[0]?.batch.pulls).toHaveLength(1);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, true, proof.proofBodyStruct),
    );
    const built = buildDisputeArgumentsFromSnapshot(account, proof.proofBodyHash, { secretsSide: 'none' }, []);
    expect(built.leftArguments).toBe('0x');
    expect(built.rightArguments).toBe('0x');
  });

});
