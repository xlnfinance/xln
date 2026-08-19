import { describe, expect, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { ethers } from 'ethers';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyAccountTx } from '../../../account/tx/apply';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';

import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';

import {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from '../../../entity/tx/handlers/account/index';

import { applyEntityInput, mergeEntityInputs } from '../../../entity/consensus/index';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

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

import type { AccountReplica, AccountTx, SwapOffer } from '../../../types/account';
import { recordSwapOfferLifecycle } from '../../../account/tx/handlers/swap/lifecycle/history';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput, EntityReplica } from '../../../entity/types';
import type { RuntimeEntityInputsEnvelope, RoutedEntityInput } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';

import { encodeBoard, generateLazyEntityId, hashBoard } from '../../../entity/factory';

import { createDefaultDelta } from '../../../account/state/delta';

import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { cloneEntityReplica } from '../../../entity/replica/replica-clone';

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
  withCanonicalCrossJurisdictionRouteHash as withCanonicalCrossJurisdictionRouteHashCanonical,
  withCrossJurisdictionClaimProgress,
  withCrossJurisdictionCloseProofProgress,
  cloneCrossJurisdictionCloseProof,
  cloneCrossJurisdictionRoute,
} from '../../../extensions/cross-j/index';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;
// Explicit fixture policy; production rejects a route that omits either
// bilateral Account clock instead of supplying compatibility defaults.
const withFixtureDisputeConfig = (route: TestRouteInput): CrossJurisdictionSwapRoute => ({
  ...route,
  sourceDisputeConfig: TEST_DISPUTE_CONFIG,
  targetDisputeConfig: TEST_DISPUTE_CONFIG,
} as CrossJurisdictionSwapRoute);
const buildPreparedCrossJurisdictionRoute = (
  route: TestRouteInput,
  options: { runtimeSeed?: string; now: number },
): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRouteCanonical(
  withFixtureDisputeConfig(route),
  options,
);
const withCanonicalCrossJurisdictionRouteHash = (
  route: TestRouteInput,
): CrossJurisdictionSwapRoute => withCanonicalCrossJurisdictionRouteHashCanonical(
  withFixtureDisputeConfig(route),
);

const installSwapOffer = (account: AccountReplica, offer: SwapOffer): void => {
  account.state.swapOffers.set(offer.offerId, offer);
  recordSwapOfferLifecycle(account, offer);
};

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

import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';

import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../../../protocol/dispute/arguments';

import { signEntityHashes } from '../../../hanko/signing';

import { hashCertifiedEntityOutputSemantic } from '../../../entity/consensus/output/certification';

import { queueCrossJurisdictionSourceDisputeFromTargetDispute } from '../../../entity/tx/j-events-htlc';

import { applyMergedEntityInputs } from '../../../runtime/mempool/entity-inputs';

import { crossBookQtyLots } from '../../../entity/tx/handlers/account/orderbook';

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
  makeConfig,
  makeJurisdiction,
  makeState,
  partialBinary,
  registerTestSigner,
  secret,
  prepareJEventInput,
} from '../../helpers/cross-j';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

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
  test('close-proof cloning rejects non-canonical ratio and mode instead of rewriting evidence', () => {
    const valid = {
      orderId: 'clone-proof',
      routeHash: `0x${'11'.repeat(32)}`,
      sourcePullId: 'source-pull',
      targetPullId: 'target-pull',
      fillRatio: 1,
      cumulativeSourceAmount: 1n,
      cumulativeTargetAmount: 1n,
      binaryHash: `0x${'22'.repeat(32)}`,
      closeMode: 'partial_cancel_remainder' as const,
    };
    expect(cloneCrossJurisdictionCloseProof(valid)).toEqual(valid);
    expect(() => cloneCrossJurisdictionCloseProof({ ...valid, fillRatio: 65_536 }))
      .toThrow('CROSS_J_CLOSE_PROOF_FILL_RATIO_INVALID');
    expect(() => cloneCrossJurisdictionCloseProof({ ...valid, fillRatio: 1.5 }))
      .toThrow('CROSS_J_CLOSE_PROOF_FILL_RATIO_INVALID');
    expect(() => cloneCrossJurisdictionCloseProof({
      ...valid,
      closeMode: 'invalid_cancel' as never,
    })).toThrow('CROSS_J_CLOSE_PROOF_MODE_INVALID');
  });

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
            createdAt: env.state.timestamp,
            updatedAt: env.state.timestamp,
          },
          { runtimeSeed: 'test-seed', now: env.state.timestamp },
        ),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
  };

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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-floor-scaled-source-progress',
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: jref(tron),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: sourceTotal,
        },
        target: {
          jurisdiction: jref(eth),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: targetTotal,
        },
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-floor-scaled-source-progress-seed', now: 1_000 },
    );
    installSwapOffer(account, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(2, 1),
      giveTokenId: 2,
      giveAmount: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      maxFee: 0n,
      minNetReceive: targetTotal,
      priceTicks: 1_000n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });

    const invalidTargetAccount = makeAccount(sourceHub, sourceUser);
    invalidTargetAccount.state.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(2, 1),
      giveTokenId: 2,
      giveAmount: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      maxFee: 0n,
      minNetReceive: targetTotal,
      priceTicks: 1_000n,
      timeInForce: 0,
      makerIsLeft: invalidTargetAccount.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route, status: 'resting' },
    });
    const invalidTargetResult = await applyAccountTx(
      invalidTargetAccount,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: cumulativeSource,
          incrementalTargetAmount: cumulativeTarget + 1n,
          cumulativeSourceAmount: cumulativeSource,
          cumulativeTargetAmount: cumulativeTarget + 1n,
          cumulativeFillRatio: 132,
          fillNumerator,
          fillDenominator,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget + 1n,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/tron:2',
        },
      },
      invalidTargetAccount.state.leftEntity === sourceHub,
      2_000,
      1,
    );
    expect(invalidTargetResult.ok).toBe(false);
    expect(invalidTargetResult.ok ? undefined : invalidTargetResult.rejection.message).toContain('cumulative target mismatch');

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: cumulativeSource,
          incrementalTargetAmount: cumulativeTarget,
          cumulativeSourceAmount: cumulativeSource,
          cumulativeTargetAmount: cumulativeTarget,
          cumulativeFillRatio: 132,
          fillNumerator,
          fillDenominator,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/tron:2',
        },
      },
      account.state.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.ok).toBe(true);
    const updatedRoute = account.state.swapOffers.get(route.orderId)?.crossJurisdiction;
    expect(updatedRoute?.filledSourceAmount).toBe(cumulativeSource);
    expect(updatedRoute?.filledTargetAmount).toBe(cumulativeTarget);
    expect(updatedRoute?.cumulativeFillRatio).toBe(132);
    expect(updatedRoute?.fillNumerator).toBe(fillNumerator);
    expect(updatedRoute?.fillDenominator).toBe(fillDenominator);
  });

  test('cross-j terminal cancel ack syncs source pull binding before close proposal', async () => {
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-terminal-cancel-binding',
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        source: {
          jurisdiction: jref(tron),
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: sourceTotal,
        },
        target: {
          jurisdiction: jref(eth),
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: targetTotal,
        },
        status: 'resting',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
      { runtimeSeed: 'cross-terminal-cancel-binding-seed', now: 1_000 },
    );
    const committedRoute = {
      ...route,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: fillRatio,
      fillNumerator: BigInt(fillRatio),
      fillDenominator: 65_535n,
      filledSourceAmount: cumulativeSource,
      filledTargetAmount: cumulativeTarget,
    };
    installSwapOffer(account, {
      offerId: route.orderId,
      ...getStaticSwapTokenDimensions(1, 2),
      giveTokenId: 1,
      giveAmount: sourceTotal,
      wantTokenId: 2,
      wantAmount: targetTotal,
      maxFee: 0n,
      minNetReceive: targetTotal,
      priceTicks: 2_600n,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: committedRoute,
    });
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(committedRoute, 'source'),
          createdHeight: 0,
          createdTimestamp: 1_000,
        },
      ],
    ]);

    const result = await applyAccountTx(
      account,
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: route.orderId,
          fillSeq: 1,
          incrementalSourceAmount: cumulativeSource,
          incrementalTargetAmount: cumulativeTarget,
          cumulativeSourceAmount: cumulativeSource,
          cumulativeTargetAmount: cumulativeTarget,
          cumulativeFillRatio: fillRatio,
          fillNumerator: BigInt(fillRatio),
          fillDenominator: 65_535n,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget,
          cancelRemainder: true,
          pairId: 'cross:tron:1/ethereum:2',
        },
      },
      account.state.leftEntity === sourceHub,
      2_000,
      1,
    );

    expect(result.ok).toBe(true);
    expect(account.state.swapOffers.has(route.orderId)).toBe(false);
    expect(account.state.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.status).toBe('clear_requested');
    expect(account.state.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.clearingPolicy).toBe('cancel_and_clear');
    expect(account.state.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.filledSourceAmount).toBe(cumulativeSource);
    expect(account.state.pulls.get(route.sourcePull!.pullId)?.crossJurisdiction?.filledTargetAmount).toBe(cumulativeTarget);
  });

  test('clear request reveals one source pull binary and can cancel remainder', async () => {
    const env = createEmptyEnv('cross-clear-delayed-seed');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const sourceHubSigner = addr('85');
    const targetHubSigner = addr('86');
    const targetUserSigner = addr('87');
    const state = makeState(sourceHub, sourceHubSigner, eth, sourceUser);
    const targetState = makeState(targetHub, targetHubSigner, base, targetUser);
    addReplica(env, state, sourceHubSigner);
    addReplica(env, targetState, targetHubSigner);
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-delayed',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    targetState.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
    const account = state.accounts.get(sourceUser)!;
    const sourcePullAbsAmount =
      route.sourcePull!.signedAmount >= 0n ? route.sourcePull!.signedAmount : -route.sourcePull!.signedAmount;
    const sourcePullPayerIsLeft = route.sourcePull!.signedAmount < 0n;
    const sourceDelta = account.state.deltas.get(route.sourcePull!.tokenId) ?? createDefaultDelta(route.sourcePull!.tokenId);
    account.state.deltas.set(route.sourcePull!.tokenId, sourceDelta);
    if (sourcePullPayerIsLeft) sourceDelta.leftHold = sourcePullAbsAmount;
    else sourceDelta.rightHold = sourcePullAbsAmount;
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
          crossJurisdiction: buildCrossJurisdictionPullBinding(
            { ...route, status: 'clearing', clearingPolicy: 'cancel_and_clear' },
            'source',
          ),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const targetAccount = targetState.accounts.get(targetUser)!;
    const targetPullAbsAmount =
      route.targetPull!.signedAmount >= 0n ? route.targetPull!.signedAmount : -route.targetPull!.signedAmount;
    const targetPullPayerIsLeft = route.targetPull!.signedAmount < 0n;
    const targetDelta =
      targetAccount.state.deltas.get(route.targetPull!.tokenId) ?? createDefaultDelta(route.targetPull!.tokenId);
    targetAccount.state.deltas.set(route.targetPull!.tokenId, targetDelta);
    if (targetPullPayerIsLeft) targetDelta.leftHold = targetPullAbsAmount;
    else targetDelta.rightHold = targetPullAbsAmount;
    targetAccount.state.pulls = new Map([
      [
        route.targetPull!.pullId,
        {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.accountTxs).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
    const [clearMaterialization] = appendDefaultProposerCrossJMaterializations(
      env,
      {
        entityId: sourceHub,
        signerId: sourceHubSigner,
        entityEncPubKey: '',
        state: result.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const sourceAccountRootBeforeMaterialization = computeAccountStateRoot(result.newState.accounts.get(sourceUser)!.state);
    const materialized = await applyEntityTx(env, result.newState, clearMaterialization!);
    expect(materialized.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect(materialized.accountTxs?.[0]?.accountId).toBe(sourceUser);
    expect((materialized.accountTxs?.[0]?.tx as any).data.binary).toMatch(/^0x/);
    expect((materialized.accountTxs?.[0]?.tx as any).data.proof.fillRatio).toBe(32_768);
    const targetCloseOutput = materialized.outputs.find(output => output.entityId === targetHub);
    expect(targetCloseOutput).toMatchObject({
      entityId: targetHub,
      signerId: targetHubSigner,
      localRuntimeProtocol: 'cross-j',
    });
    expect(targetCloseOutput?.entityTxs?.map(tx => tx.type)).toEqual(['crossPullClose']);
    expect(materialized.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
    expect(computeAccountStateRoot(materialized.newState.accounts.get(sourceUser)!.state)).toBe(
      sourceAccountRootBeforeMaterialization,
    );
    const targetCloseCommand = targetCloseOutput!.entityTxs![0]!;
    const stagedTargetClose = await applyEntityTx(env, targetState, targetCloseCommand);
    expect(stagedTargetClose.accountTxs?.map(op => op.tx.type)).toEqual(['cross_pull_close']);
    expect(stagedTargetClose.accountTxs?.[0]?.accountId).toBe(targetUser);
    expect(stagedTargetClose.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clearing');
    const byTargetHub = targetHub.toLowerCase() < targetUser.toLowerCase();
    const targetCloseResult = await applyAccountTx(
      stagedTargetClose.newState.accounts.get(targetUser)!,
      stagedTargetClose.accountTxs![0]!.tx,
      byTargetHub,
      env.state.timestamp,
      1,
    );
    expect(targetCloseResult.ok, targetCloseResult.ok ? undefined : targetCloseResult.rejection.message).toBe(true);
    expect(stagedTargetClose.newState.accounts.get(targetUser)!.state.pulls?.has(route.targetPull!.pullId)).toBe(false);

    const accountAfterClear = materialized.newState.accounts.get(sourceUser)!;
    const invalidProposalAccount = forkAccountReplicaShell(accountAfterClear);
    const validClose = materialized.accountTxs![0]!.tx;
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
      proposeAccountFrame(createAccountConsensusContext(env), invalidProposalAccount, env.state.timestamp, state.lastFinalizedJHeight),
    ).rejects.toThrow('CROSS_J_PULL_CLOSE_PROPOSAL_FAILED');
    expect(invalidProposalAccount.mempool).toEqual([invalidClose]);
    expect(invalidProposalAccount.pendingFrame).toBeUndefined();

    const bySourceHub = sourceHub.toLowerCase() < sourceUser.toLowerCase();
    const resolveResult = await applyAccountTx(
      accountAfterClear,
      materialized.accountTxs![0]!.tx,
      bySourceHub,
      env.state.timestamp,
      1,
    );
    expect(resolveResult.ok, resolveResult.ok ? undefined : resolveResult.rejection.message).toBe(true);
    expect(accountAfterClear.state.pulls?.has(route.sourcePull!.pullId)).toBe(false);
    const releasedDelta = accountAfterClear.state.deltas.get(route.sourcePull!.tokenId)!;
    expect(sourcePullPayerIsLeft ? releasedDelta.leftHold : releasedDelta.rightHold).toBe(0n);
  });

  test('source-savings clear materialization cannot split its two Account effects at the mempool cap', async () => {
    const env = createEmptyEnv('cross-clear-source-savings-atomic-capacity');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('91');
    const targetHub = entity('93');
    const targetUser = entity('94');
    const sourceHubSigner = registerTestSigner(env, 'cross-clear-source-savings-atomic-capacity', '1');
    const sourceHub = hashBoard(encodeBoard(makeConfig(sourceHubSigner, sourceJ))).toLowerCase();
    const targetHubSigner = addr('96');
    const state = makeState(sourceHub, sourceHubSigner, sourceJ, sourceUser);
    addReplica(env, state, sourceHubSigner);

    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-source-savings-atomic-capacity',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
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
        priceImprovementMode: 'source_savings',
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      priceImprovementSourceAmount: 25n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    account.state.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(
            { ...route, status: 'clearing', clearingPolicy: 'cancel_and_clear' },
            'source',
          ),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);

    const requested = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });
    const [materialization] = appendDefaultProposerCrossJMaterializations(
      env,
      {
        entityId: sourceHub,
        signerId: sourceHubSigner,
        entityEncPubKey: '',
        state: requested.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    if (materialization?.type !== 'materializeCrossJurisdictionClear') {
      throw new Error('TEST_CROSS_J_CLEAR_MATERIALIZATION_REQUIRED');
    }
    const derived = await applyEntityTx(env, requested.newState, materialization);
    expect(derived.accountTxs?.map(({ tx }) => tx.type)).toEqual([
      'cross_pull_close',
      'direct_payment',
    ]);

    const capacityState = requested.newState;
    capacityState.prevFrameHash ??= `0x${'91'.repeat(32)}`;
    const capacityAccount = capacityState.accounts.get(sourceUser)!;
    capacityAccount.mempool = Array.from(
      { length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 },
      (_, index): AccountTx => ({
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 1n,
          route: [sourceHub, sourceUser],
          deliveryMode: 'direct',
          description: `capacity-${index}`,
          fromEntityId: sourceHub,
          toEntityId: sourceUser,
        },
      }),
    );
    const beforeAccount = capacityState.accounts.get(sourceUser);
    const beforeRoute = capacityState.crossJurisdictionSwaps?.get(route.orderId);
    const frameTxs = prepareLocallyAuthoredEntityTxs(
      env,
      capacityState,
      sourceHubSigner,
      [materialization],
    );

    await expect(
      applyEntityFrameWithMaterializedTestInfraContext(env, capacityState, frameTxs, env.state.timestamp),
    ).rejects.toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
    expect(capacityState.accounts.get(sourceUser)).toBe(beforeAccount);
    expect(capacityState.crossJurisdictionSwaps?.get(route.orderId)).toBe(beforeRoute);
    expect(capacityState.accounts.get(sourceUser)!.mempool).toHaveLength(
      LIMITS.ACCOUNT_MEMPOOL_SIZE - 1,
    );
    expect(capacityState.accounts.get(sourceUser)!.mempool.some(tx => tx.type === 'cross_pull_close')).toBe(false);
    expect(capacityState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
  });

  test('target cross_pull_close rejects lower valid reveal than source close proof', async () => {
    const env = createEmptyEnv('cross-close-lower-ratio-reject');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('86');
    const sourceHub = entity('87');
    const targetHub = entity('88');
    const targetUser = entity('89');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-lower-ratio-reject',
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
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const highRatio = 0x8000;
    const lowRatio = 0x4000;
    const highRoute = {
      ...prepared,
      status: 'clearing' as const,
      fillSeq: 1,
      cumulativeFillRatio: highRatio,
      claimedRatio: highRatio,
      fillNumerator: BigInt(highRatio),
      fillDenominator: 65_535n,
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
      fillNumerator: BigInt(lowRatio),
      fillDenominator: 65_535n,
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
    const targetDelta =
      account.state.deltas.get(highRoute.targetPull!.tokenId) ?? createDefaultDelta(highRoute.targetPull!.tokenId);
    account.state.deltas.set(highRoute.targetPull!.tokenId, targetDelta);
    const targetAbsAmount =
      highRoute.targetPull!.signedAmount >= 0n
        ? highRoute.targetPull!.signedAmount
        : -highRoute.targetPull!.signedAmount;
    if (highRoute.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    account.state.pulls = new Map([
      [
        highRoute.targetPull!.pullId,
        {
          pullId: highRoute.targetPull!.pullId,
          tokenId: highRoute.targetPull!.tokenId,
          amount: highRoute.targetPull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: highRoute.targetPull!.fullHash,
          partialRoot: highRoute.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding({ ...highRoute, sourceCloseProof: highProof }, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const byTargetUser = targetUser.toLowerCase() < targetHub.toLowerCase();

    const lowerProofResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: lowProof },
      },
      byTargetUser,
      env.state.timestamp,
      1,
    );
    expect(lowerProofResult.ok).toBe(false);
    expect(lowerProofResult.ok ? undefined : lowerProofResult.rejection.message).toContain('ratio');
    expect(account.state.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);

    const lowerBinaryResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: highProof },
      },
      byTargetUser,
      env.state.timestamp,
      2,
    );
    expect(lowerBinaryResult.ok).toBe(false);
    expect(lowerBinaryResult.ok ? undefined : lowerBinaryResult.rejection.message).toContain('binary');
    expect(account.state.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);
  });

  test('target cross_pull_close rejects user-authored economics before target binding has fill progress', async () => {
    const env = createEmptyEnv('cross-close-forged-target-economics');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7a');
    const sourceHub = entity('7b');
    const targetHub = entity('7c');
    const targetUser = entity('7d');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-forged-target-economics',
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
      {
        runtimeSeed: env.runtimeSeed,
        now: env.state.timestamp,
      },
    );
    const fillRatio = 0x8000;
    const filledRoute = {
      ...prepared,
      status: 'clearing' as const,
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    // The proof is economically consistent (chain-proportional for the
    // revealed ratio), so the rejection must come from the authorization gate:
    // a close authored by the user side is never accepted, whatever it pays.
    const forgedProof = buildCrossJurisdictionCloseProof(filledRoute, binary);
    const account = makeAccount(targetUser, targetHub);
    const targetPull = prepared.targetPull!;
    const targetDelta = account.state.deltas.get(targetPull.tokenId) ?? createDefaultDelta(targetPull.tokenId);
    account.state.deltas.set(targetPull.tokenId, targetDelta);
    const targetAbsAmount = targetPull.signedAmount >= 0n ? targetPull.signedAmount : -targetPull.signedAmount;
    if (targetPull.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    account.state.pulls = new Map([
      [
        targetPull.pullId,
        {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'target'),
          createdHeight: 0,
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);
    const before = computeAccountStateRoot(account.state);
    const result = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: {
          pullId: targetPull.pullId,
          binary,
          proof: forgedProof,
        },
      },
      targetUser.toLowerCase() < targetHub.toLowerCase(),
      env.state.timestamp,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.rejection.message).toContain('Only the target Hub');
    expect(computeAccountStateRoot(account.state)).toBe(before);
    expect(account.state.pulls?.has(targetPull.pullId)).toBe(true);
  });

  test('source cross_pull_close cannot invent fill progress or a cumulative debit', async () => {
    const env = createEmptyEnv('cross-close-forged-source-economics');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('6a');
    const sourceHub = entity('6b');
    const targetHub = entity('6c');
    const targetUser = entity('6d');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-forged-source-economics',
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
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const fillRatio = 0x8000;
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    const honestProof = buildCrossJurisdictionCloseProof({
      ...prepared,
      status: 'clearing',
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    }, binary);
    const account = makeAccount(sourceUser, sourceHub);
    const sourcePull = prepared.sourcePull!;
    const delta = account.state.deltas.get(sourcePull.tokenId) ?? createDefaultDelta(sourcePull.tokenId);
    account.state.deltas.set(sourcePull.tokenId, delta);
    const held = sourcePull.signedAmount >= 0n ? sourcePull.signedAmount : -sourcePull.signedAmount;
    if (sourcePull.signedAmount > 0n) delta.rightHold = held;
    else delta.leftHold = held;
    account.state.pulls = new Map([
      [sourcePull.pullId, {
        pullId: sourcePull.pullId,
        tokenId: sourcePull.tokenId,
        amount: sourcePull.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        fullHash: sourcePull.fullHash,
        partialRoot: sourcePull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'source'),
        createdHeight: 0,
        createdTimestamp: env.state.timestamp,
      }],
    ]);
    const initialRoot = computeAccountStateRoot(account.state);
    const uncommittedResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: {
          pullId: sourcePull.pullId,
          binary,
          proof: { ...honestProof, cumulativeSourceAmount: 999n },
        },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      1,
    );

    expect(uncommittedResult.ok).toBe(false);
    expect(uncommittedResult.ok ? undefined : uncommittedResult.rejection.message).toContain('chain-proportional');
    expect(computeAccountStateRoot(account.state)).toBe(initialRoot);
    expect(account.state.pulls?.has(sourcePull.pullId)).toBe(true);

    const committedAccount = forkAccountReplicaShell(account);
    const binding = committedAccount.state.pulls!.get(sourcePull.pullId)!.crossJurisdiction!;
    binding.status = 'clearing';
    binding.cumulativeFillRatio = fillRatio;
    binding.fillNumerator = 1n;
    binding.fillDenominator = 2n;
    binding.filledSourceAmount = 500n;
    binding.filledTargetAmount = 450n;
    const committedRoot = computeAccountStateRoot(committedAccount.state);
    const forgedAmountResult = await applyAccountTx(
      committedAccount,
      {
        type: 'cross_pull_close',
        data: {
          pullId: sourcePull.pullId,
          binary,
          proof: { ...honestProof, cumulativeSourceAmount: 999n },
        },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      2,
    );

    expect(forgedAmountResult.ok).toBe(false);
    expect(forgedAmountResult.ok ? undefined : forgedAmountResult.rejection.message).toContain('source amount 999 != committed 500');
    expect(computeAccountStateRoot(committedAccount.state)).toBe(committedRoot);

    const canonicalAmountResult = await applyAccountTx(
      committedAccount,
      {
        type: 'cross_pull_close',
        data: { pullId: sourcePull.pullId, binary, proof: honestProof },
      },
      sourceHub.toLowerCase() < sourceUser.toLowerCase(),
      env.state.timestamp,
      3,
    );
    expect(canonicalAmountResult.ok, canonicalAmountResult.ok ? undefined : canonicalAmountResult.rejection.message).toBe(true);
    expect(committedAccount.state.pulls?.has(sourcePull.pullId)).toBe(false);
  });

  test('source user routes cross-j clear through the source Account', async () => {
    const env = createEmptyEnv('cross-clear-source-account');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('81');
    const sourceHub = entity('82');
    const targetHub = entity('83');
    const targetUser = entity('84');
    const state = makeState(sourceUser, addr('85'), eth, sourceHub);
    await expect(
      applyEntityTx(env, state, {
        type: 'requestCrossJurisdictionClear',
        data: { orderId: 'missing-cross-j-route', cancelRemainder: true },
      }),
    ).rejects.toThrow('CROSS_J_CLEAR_ROUTE_MISSING:missing-cross-j-route');
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-source-account',
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
      { runtimeSeed: env.runtimeSeed, now: env.state.timestamp },
    );
    const restingRoute = {
      ...prepared,
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(restingRoute.orderId, restingRoute);
    const account = state.accounts.get(sourceHub)!;
    account.state.swapOffers.set(restingRoute.orderId, {
      offerId: restingRoute.orderId,
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
      crossJurisdiction: { ...restingRoute },
    });

    const ignored = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: restingRoute.orderId, cancelRemainder: false },
    });
    expect(ignored.accountTxs).toEqual([]);
    expect(ignored.newState.crossJurisdictionSwaps?.get(restingRoute.orderId)?.status).toBe('resting');

    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    installSwapOffer(account, {
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

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.outputs).toEqual([]);
    expect(result.accountTxs).toEqual([
      {
        accountId: sourceHub,
        tx: { type: 'swap_cancel_request', data: { offerId: route.orderId } },
      },
    ]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('clear_requested');
  });

  test('clear request closes live cross-j offer before revealing pull', async () => {
    const env = createEmptyEnv('cross-clear-closes-offer-first');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('86');
    const sourceHub = entity('87');
    const targetHub = entity('88');
    const targetUser = entity('89');
    const state = makeState(sourceHub, addr('8a'), eth, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-clear-offer-first',
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
      { runtimeSeed: 'cross-clear-offer-first', now: env.state.timestamp },
    );
    const route = {
      ...prepared,
      status: 'partially_filled' as const,
      fillSeq: 1,
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);
    const account = state.accounts.get(sourceUser)!;
    installSwapOffer(account, {
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
          createdTimestamp: env.state.timestamp,
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.accountTxs?.[0]?.tx as any).data.cancelRemainder).toBe(true);
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-cancel-no-swap-resolve',
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
      { runtimeSeed: 'cross-cancel-no-swap-resolve', now: 1_000 },
    );
    const account = state.accounts.get(sourceUser)!;
    installSwapOffer(account, {
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
    const admission = mergeCrossJurisdictionBookAdmission(state, route, state.timestamp);
    admission.status = 'admitted';
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = processOrderbookCancels(state, [{ accountId: sourceUser, offerId: route.orderId }]);
    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs[0]?.tx.type).toBe('cross_swap_fill_ack');
    expect(result.accountTxs.some(op => op.tx.type === 'swap_resolve')).toBe(false);
  });
});
