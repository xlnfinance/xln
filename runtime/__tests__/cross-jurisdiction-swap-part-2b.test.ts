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
      { runtimeSeed: 'cross-floor-scaled-source-progress-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: 2,
      giveAmount: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      priceTicks: 1_000n,
      timeInForce: 0,
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
      makerIsLeft: invalidTargetAccount.leftEntity === sourceUser,
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
          cumulativeFillRatio: 0,
          fillNumerator,
          fillDenominator,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget + 1n,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/tron:2',
        },
      },
      invalidTargetAccount.leftEntity === sourceHub,
      2_000,
      1,
    );
    expect(invalidTargetResult.success).toBe(false);
    expect(invalidTargetResult.error).toContain('cumulative target mismatch');

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
          cumulativeFillRatio: 0,
          fillNumerator,
          fillDenominator,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget,
          priceImprovementMode: 'source_savings',
          cancelRemainder: false,
          pairId: 'cross:ethereum:1/tron:2',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

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
      { runtimeSeed: 'cross-terminal-cancel-binding-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
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
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: committedRoute,
    });
    account.pulls = new Map([
      [
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
          cumulativeFillRatio: 0,
          fillNumerator: BigInt(fillRatio),
          fillDenominator: 65_535n,
          executionSourceAmount: cumulativeSource,
          executionTargetAmount: cumulativeTarget,
          cancelRemainder: true,
          pairId: 'cross:tron:1/ethereum:2',
        },
      },
      account.leftEntity === sourceHub,
      2_000,
      1,
    );

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
    account.pulls = new Map([
      [
        pullId,
        {
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
        },
      ],
    ]);

    const early = await applyAccountTx(
      account,
      {
        type: 'pull_cancel',
        data: { pullId, reason: 'expired' },
      },
      payerIsLeft,
      9_999,
      2,
    );
    expect(early.success).toBe(false);
    expect(account.pulls.has(pullId)).toBe(true);

    const expired = await applyAccountTx(
      account,
      {
        type: 'pull_cancel',
        data: { pullId, reason: 'expired' },
      },
      payerIsLeft,
      11_000,
      3,
    );
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
      cumulativeFillRatio: 32_768,
      claimedRatio: 32_768,
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
    const sourceDelta = account.deltas.get(route.sourcePull!.tokenId) ?? createDefaultDelta(route.sourcePull!.tokenId);
    account.deltas.set(route.sourcePull!.tokenId, sourceDelta);
    if (sourcePullPayerIsLeft) sourceDelta.leftHold = sourcePullAbsAmount;
    else sourceDelta.rightHold = sourcePullAbsAmount;
    account.pulls = new Map([
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
          crossJurisdiction: buildCrossJurisdictionPullBinding(
            { ...route, status: 'clearing', clearingPolicy: 'cancel_and_clear' },
            'source',
          ),
          createdHeight: 0,
          createdTimestamp: env.timestamp,
        },
      ],
    ]);
    const targetAccount = targetState.accounts.get(targetUser)!;
    const targetPullAbsAmount =
      route.targetPull!.signedAmount >= 0n ? route.targetPull!.signedAmount : -route.targetPull!.signedAmount;
    const targetPullPayerIsLeft = route.targetPull!.signedAmount < 0n;
    const targetDelta =
      targetAccount.deltas.get(route.targetPull!.tokenId) ?? createDefaultDelta(route.targetPull!.tokenId);
    targetAccount.deltas.set(route.targetPull!.tokenId, targetDelta);
    if (targetPullPayerIsLeft) targetDelta.leftHold = targetPullAbsAmount;
    else targetDelta.rightHold = targetPullAbsAmount;
    targetAccount.pulls = new Map([
      [
        route.targetPull!.pullId,
        {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
          createdHeight: 0,
          createdTimestamp: env.timestamp,
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
        state: result.newState,
        mempool: [],
      } as EntityReplica,
      [],
    );
    expect(clearMaterialization?.type).toBe('materializeCrossJurisdictionClear');
    const sourceAccountRootBeforeMaterialization = computeAccountStateRoot(result.newState.accounts.get(sourceUser)!);
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
    expect(computeAccountStateRoot(materialized.newState.accounts.get(sourceUser)!)).toBe(
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
      env.timestamp,
      1,
    );
    expect(targetCloseResult.success, targetCloseResult.error).toBe(true);
    expect(stagedTargetClose.newState.accounts.get(targetUser)!.pulls?.has(route.targetPull!.pullId)).toBe(false);

    const accountAfterClear = materialized.newState.accounts.get(sourceUser)!;
    const invalidProposalAccount = cloneAccountMachine(accountAfterClear);
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
      proposeAccountFrame(env, invalidProposalAccount, env.timestamp, state.lastFinalizedJHeight),
    ).rejects.toThrow('CROSS_J_PULL_CLOSE_PROPOSAL_FAILED');
    expect(invalidProposalAccount.mempool).toEqual([invalidClose]);
    expect(invalidProposalAccount.pendingFrame).toBeUndefined();

    const bySourceHub = sourceHub.toLowerCase() < sourceUser.toLowerCase();
    const resolveResult = await applyAccountTx(
      accountAfterClear,
      materialized.accountTxs![0]!.tx,
      bySourceHub,
      env.timestamp,
      1,
    );
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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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
    const targetDelta =
      account.deltas.get(highRoute.targetPull!.tokenId) ?? createDefaultDelta(highRoute.targetPull!.tokenId);
    account.deltas.set(highRoute.targetPull!.tokenId, targetDelta);
    const targetAbsAmount =
      highRoute.targetPull!.signedAmount >= 0n
        ? highRoute.targetPull!.signedAmount
        : -highRoute.targetPull!.signedAmount;
    if (highRoute.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    account.pulls = new Map([
      [
        highRoute.targetPull!.pullId,
        {
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
      env.timestamp,
      1,
    );
    expect(lowerProofResult.success).toBe(false);
    expect(lowerProofResult.error).toContain('ratio');
    expect(account.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);

    const lowerBinaryResult = await applyAccountTx(
      account,
      {
        type: 'cross_pull_close',
        data: { pullId: highRoute.targetPull!.pullId, binary: lowBinary, proof: highProof },
      },
      byTargetUser,
      env.timestamp,
      2,
    );
    expect(lowerBinaryResult.success).toBe(false);
    expect(lowerBinaryResult.error).toContain('binary');
    expect(account.pulls?.has(highRoute.targetPull!.pullId)).toBe(true);
  });

  test('target cross_pull_close rejects user-authored economics before target binding has fill progress', async () => {
    const env = createEmptyEnv('cross-close-forged-target-economics');
    env.timestamp = 10_000;
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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      {
        runtimeSeed: env.runtimeSeed,
        sourceDisputeDelayMs: 5_000,
        now: env.timestamp,
      },
    );
    const fillRatio = 0x8000;
    const filledRoute = {
      ...prepared,
      status: 'source_claimed' as const,
      cumulativeFillRatio: fillRatio,
      claimedRatio: fillRatio,
      filledSourceAmount: 500n,
      filledTargetAmount: 450n,
      sourceClaimed: 500n,
      targetClaimed: 450n,
      clearingPolicy: 'cancel_and_clear' as const,
    };
    const privateSeed = deriveCrossJurisdictionPrivateSeed(env.runtimeSeed!, prepared);
    const binary = buildCrossJurisdictionPullReveal(prepared, fillRatio, privateSeed).binary;
    const honestProof = buildCrossJurisdictionCloseProof(filledRoute, binary);
    const forgedProof = {
      ...honestProof,
      cumulativeTargetAmount: 899n,
    };
    const account = makeAccount(targetUser, targetHub);
    const targetPull = prepared.targetPull!;
    const targetDelta = account.deltas.get(targetPull.tokenId) ?? createDefaultDelta(targetPull.tokenId);
    account.deltas.set(targetPull.tokenId, targetDelta);
    const targetAbsAmount = targetPull.signedAmount >= 0n ? targetPull.signedAmount : -targetPull.signedAmount;
    if (targetPull.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    account.pulls = new Map([
      [
        targetPull.pullId,
        {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'target'),
          createdHeight: 0,
          createdTimestamp: env.timestamp,
        },
      ],
    ]);
    const before = computeAccountStateRoot(account);
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
      env.timestamp,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Only the target Hub');
    expect(computeAccountStateRoot(account)).toBe(before);
    expect(account.pulls?.has(targetPull.pullId)).toBe(true);
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
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-direct-cancel-blocked',
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
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-direct-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
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

    expect(result.accountTxs ?? []).toHaveLength(0);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('partially_filled');
    expect(
      result.newState.messages.some(message => message.includes('must clear through requestCrossJurisdictionClear')),
    ).toBe(true);
  });

  test('account-layer pull_cancel cannot release a committed cross-j partial fill', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('72');
    const sourceHub = entity('73');
    const targetHub = entity('74');
    const targetUser = entity('75');
    const account = makeAccount(sourceHub, sourceUser);
    const prepared = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-account-cancel-blocked',
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
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-account-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
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
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: route,
    });
    account.pulls = new Map([
      [
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
          createdHeight: 0,
          createdTimestamp: 1_000,
        },
      ],
    ]);

    const payerIsLeft = !(route.sourcePull!.signedAmount > 0n);
    const result = await handlePullCancel(
      account,
      {
        type: 'pull_cancel',
        data: { pullId: route.sourcePull!.pullId, reason: 'expired' },
      },
      payerIsLeft,
      route.sourcePull!.revealedUntilTimestamp + 1_000,
    );

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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-target-direct-cancel-blocked',
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
        status: 'target_locked',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-target-direct-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    const result = await applyEntityTx(env, state, {
      type: 'cancelPull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        description: 'malicious unfilled target release',
      },
    });

    expect(result.accountTxs ?? []).toHaveLength(0);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe(route.status);
    expect(
      result.newState.messages.some(message => message.includes('must clear through requestCrossJurisdictionClear')),
    ).toBe(true);
  });

  test('account-layer pull_cancel cannot release an unfilled cross-j target pull', async () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const base = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('7c');
    const sourceHub = entity('7d');
    const targetHub = entity('7e');
    const targetUser = entity('7f');
    const account = makeAccount(targetUser, targetHub);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-account-target-cancel-blocked',
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
        status: 'target_locked',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-account-target-cancel-blocked-seed', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
    account.swapOffers.set(route.orderId, {
      offerId: route.orderId,
      giveTokenId: route.target.tokenId,
      giveAmount: route.target.amount,
      wantTokenId: route.source.tokenId,
      wantAmount: route.source.amount,
      priceTicks: 900n,
      timeInForce: 0,
      makerIsLeft: account.leftEntity === targetUser,
      createdHeight: 0,
      crossJurisdiction: route,
    });
    account.pulls = new Map([
      [
        route.targetPull!.pullId,
        {
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
        },
      ],
    ]);

    const beneficiaryIsLeft = route.targetPull!.signedAmount > 0n;
    const result = await handlePullCancel(
      account,
      {
        type: 'pull_cancel',
        data: { pullId: route.targetPull!.pullId, reason: 'beneficiary_release' },
      },
      beneficiaryIsLeft,
      10_000,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('must clear through requestCrossJurisdictionClear');
    expect(account.pulls?.has(route.targetPull!.pullId)).toBe(true);
  });

  test('pull_cancel reports already-closed pull status explicitly', async () => {
    const account = makeAccount(entity('76'), entity('77'));
    const result = await handlePullCancel(
      account,
      {
        type: 'pull_cancel',
        data: { pullId: 'missing-pull-id', reason: 'expired' },
      },
      true,
      1_000,
    );

    expect(result.success).toBe(true);
    expect(result.pullCancelled).toEqual({ pullId: 'missing-pull-id', status: 'already-closed' });
  });

  test('target user cannot resolve a cross-j pull even after observing the Hub proof', async () => {
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-target-resolve-guard',
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
      { runtimeSeed: 'cross-target-resolve-guard-seed', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    targetState.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'resting' });
    const targetAccount = targetState.accounts.get(targetHub);
    expect(targetAccount, 'target account fixture must exist').toBeTruthy();
    const targetDelta =
      targetAccount!.deltas.get(route.targetPull!.tokenId) ?? createDefaultDelta(route.targetPull!.tokenId);
    targetAccount!.deltas.set(route.targetPull!.tokenId, targetDelta);
    const targetAbsAmount =
      route.targetPull!.signedAmount >= 0n ? route.targetPull!.signedAmount : -route.targetPull!.signedAmount;
    if (route.targetPull!.signedAmount > 0n) targetDelta.rightHold = targetAbsAmount;
    else targetDelta.leftHold = targetAbsAmount;
    targetAccount!.pulls = new Map([
      [
        route.targetPull!.pullId,
        {
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
        },
      ],
    ]);
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
    expect(blocked.accountTxs ?? []).toHaveLength(0);
    expect(blocked.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(blocked.newState.messages.some(message => message.includes('only the Hub atomic close cohort'))).toBe(true);

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
    const result = await applyEntityTx(env, targetState, {
      type: 'resolvePull',
      data: {
        counterpartyEntityId: targetHub,
        pullId: route.targetPull!.pullId,
        binary,
      },
    });
    expect(result.accountTxs ?? []).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('resting');
    expect(result.newState.messages.some(message => message.includes('only the Hub atomic close cohort'))).toBe(true);
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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: env.runtimeSeed, sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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
      makerIsLeft: account.leftEntity === sourceUser,
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
      makerIsLeft: account.leftEntity === sourceUser,
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
    env.timestamp = 10_000;
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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: 70_000,
      },
      { runtimeSeed: 'cross-clear-offer-first', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
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
      makerIsLeft: account.leftEntity === sourceUser,
      createdHeight: 0,
      crossJurisdiction: { ...route },
    });
    account.pulls = new Map([
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
          createdHeight: 0,
          createdTimestamp: env.timestamp,
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId: route.orderId, cancelRemainder: true },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
    expect((result.accountTxs?.[0]?.tx as any).data.cancelRemainder).toBe(true);
    expect(result.accountTxs?.some(op => op.tx.type === 'pull_resolve')).toBe(false);
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
      { runtimeSeed: 'cross-cancel-no-swap-resolve', sourceDisputeDelayMs: 5_000, now: 1_000 },
    );
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
