import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';

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

import { cloneAccountState } from '../account/state-clone';
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
          { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
        ),
        status: options.status ?? 'resting',
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };
    return { env, state, sourceUser, sourceHub, targetHub, sourceSigner, buildRoute };
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
    expect(sourceFollowup.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
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
          pairId: route.venueId || '',
        },
      }),
    ).rejects.toThrow(/CROSS_J_FILL_NOTICE_INVALID/);
  });

  test('valid fill notice only queues account ack and does not mutate canonical route before commit', async () => {
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
        pairId: route.venueId || '',
      },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack']);
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
          cumulativeFillRatio: 0,
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
          pairId: route.venueId || '',
        },
      }),
    ).rejects.toThrow(/CROSS_J_FILL_NOTICE_PREV_SEQ_MISMATCH/);
  });

  test('fill notice is rejected on book owner when source hub owns the account ack', async () => {
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
      bookOwnerEntityId: targetHub,
      status: 'resting' as const,
    };
    state.crossJurisdictionSwaps?.set(route.orderId, route);

    await expect(
      applyEntityTx(env, state, {
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
      }),
    ).rejects.toThrow('CROSS_J_FILL_NOTICE_SOURCE_HUB_REQUIRED');
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
    const sourceUser = generateLazyEntityId([sourceUserSigner], 1n).toLowerCase();
    const sourceHub = generateLazyEntityId([sourceHubSigner], 1n).toLowerCase();
    const targetHub = `0x${'3'.padStart(64, '0')}`;
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
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
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
    expect(sourceAccount.swapOffers.has(route.orderId)).toBe(false);
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-fill-notice-owner-partial',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
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
      account.swapOffers.set(route.orderId, {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: sourceTotal,
        wantTokenId: 1,
        wantAmount: targetTotal,
        priceTicks: 2_500n * ORDERBOOK_PRICE_SCALE,
        timeInForce: 0,
        makerIsLeft: account.leftEntity === sourceUser,
        createdHeight: 0,
        crossJurisdiction: { ...route, status: 'resting' },
      });
    }

    addReplica(env, sourceUserState, sourceUserSigner);
    addReplica(env, sourceHubState, sourceHubSigner);
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
          createdTimestamp: 1_000,
        },
      ],
    ]);

    const result = await applyEntityTx(env, state, {
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason: 'test-expired' },
    });

    expect(result.accountTxs?.map(op => op.tx.type)).toEqual(['cross_swap_fill_ack', 'cross_pull_close']);
    expect((result.accountTxs?.[1]?.tx as any).data.binary).toBe('0x');
    expect((result.accountTxs?.[1]?.tx as any).data.proof.fillRatio).toBe(0);
    expect(
      result.outputs.some(
        output => output.entityId === targetUser && output.entityTxs?.some(tx => tx.type === 'cancelPull'),
      ),
    ).toBe(false);
    expect(result.newState.crossJurisdictionSwaps?.get(route.orderId)?.status).toBe('expired');
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

  test('DisputeStarted with cross-pull args queues target sibling salvage', async () => {
    const env = createEmptyEnv('cross-dispute-salvage');
    env.scenarioMode = true;
    env.state.timestamp = 30_000;
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
    const oldSettledRoute = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp - 1_000,
        updatedAt: env.state.timestamp - 1_000,
      },
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp - 1_000 },
    );
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
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
    const result = await applyJEventRange(
      state,
      {
        from: signer,
        event: disputeStartedEvent,
        observedAt: env.state.timestamp,
        blockNumber: 2,
        blockHash: secret('8b'),
        transactionHash: secret('8c'),
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
    expect(data.fillRatio).toBe(0x1234);
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
    const disputeFinalizationEvidence = [
      {
        sender: sourceHub,
        counterentity: sourceUser,
        initialNonce: '1',
        initialProofbodyHash: finalizedProof.proofBodyHash,
        finalProofbodyHash: finalizedProof.proofBodyHash,
        leftArguments,
        rightArguments: '0x',
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

  test('crossJurisdictionSalvage lets prepareDispute safely schedule the target broadcast', async () => {
    const env = createEmptyEnv('cross-salvage-action');
    env.scenarioMode = true;
    env.state.timestamp = 40_000;
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
    const route = buildPreparedCrossJurisdictionRoute(
      {
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
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      { runtimeSeed: 'test-seed', sourceDisputeDelayMs: 5_000, now: env.state.timestamp },
    );
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
    expect(result.outputs?.[0]?.entityTxs).toHaveLength(2);
    expect(result.outputs?.[0]?.entityTxs?.[0]?.type).toBe('resolvePull');
    expect(result.outputs?.[0]?.entityTxs?.[1]?.type).toBe('prepareDispute');
    expect((result.outputs?.[0]?.entityTxs?.[0]?.data as any).counterpartyEntityId).toBe(targetHub);
    expect((result.outputs?.[0]?.entityTxs?.[0]?.data as any).binary).toBe(binary);
    expect((result.outputs?.[0]?.entityTxs?.[1]?.data as any).counterpartyEntityId).toBe(targetHub);
    const starterInitialArguments = (result.outputs?.[0]?.entityTxs?.[1]?.data as any).starterInitialArguments;
    expect(typeof starterInitialArguments).toBe('string');
    expect(starterInitialArguments).toMatch(/^0x[0-9a-f]+$/i);
    expect(starterInitialArguments.length).toBeGreaterThan(2);

    let chainedState = state;
    const nestedOutputs: EntityInput[] = [];
    for (const entityTx of result.outputs?.[0]?.entityTxs ?? []) {
      const applied = await applyEntityTx(env, chainedState, entityTx);
      chainedState = applied.newState;
      nestedOutputs.push(...(applied.outputs ?? []));
      for (const op of applied.accountTxs ?? []) {
        const account = chainedState.accounts.get(op.accountId);
        expect(account, `mempool op account ${op.accountId.slice(-4)} must exist`).toBeDefined();
        account?.mempool.push(op.tx);
      }
    }
    expect(nestedOutputs.flatMap(output => output.entityTxs).map(tx => tx.type)).toEqual(['j_broadcast']);
    const draftDisputeStarts = chainedState.jBatchState?.batch.disputeStarts ?? [];
    const sentDisputeStarts = chainedState.jBatchState?.sentBatch?.batch.disputeStarts ?? [];
    expect([...draftDisputeStarts, ...sentDisputeStarts]).toHaveLength(1);
    expect(readEntityFrameEventMessages(chainedState)
      .some(message => message.includes('blocked until evidence is stable'))).toBe(false);
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

  test('target dispute skips an older terminal route and selects the only active route', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-first');
    const terminal = fixture.buildRoute('a-terminal', { status: 'settled' });
    const active = fixture.buildRoute('z-active');
    fixture.state.crossJurisdictionSwaps?.set(terminal.orderId, terminal);
    fixture.state.crossJurisdictionSwaps?.set(active.orderId, active);
    const outputs: EntityInput[] = [];

    expect(
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        fixture.state,
        outputs,
        fixture.targetHub,
        '0x',
      ),
    ).toBe(true);
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

    expect(
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        fixture.state,
        outputs,
        fixture.targetHub,
        '0x',
      ),
    ).toBe(false);
    expect(outputs).toEqual([]);
  });

  test('target dispute ignores a route without a target pull commitment', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-no-target-pull');
    const route = fixture.buildRoute('active-without-target-pull', { withoutTargetPull: true });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        fixture.state,
        outputs,
        fixture.targetHub,
        '0x',
      ),
    ).toBe(false);
    expect(outputs).toEqual([]);
  });

  test('target dispute fails closed and records sorted route ids when active routes are ambiguous', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-ambiguous');
    const later = fixture.buildRoute('z-active');
    const earlier = fixture.buildRoute('a-active');
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);
    fixture.state.crossJurisdictionSwaps?.set(earlier.orderId, earlier);
    const outputs: EntityInput[] = [];

    expect(
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        fixture.state,
        outputs,
        fixture.targetHub,
        '0x',
      ),
    ).toBe(false);
    expect(outputs).toEqual([]);
    expect(readEntityFrameEventMessages(fixture.state).at(-1)).toBe(
      `⚠️ Cross-j target dispute route ambiguous for ${fixture.targetHub.slice(-4)}: ` +
        'a-active,z-active; no source dispute queued',
    );
  });

  test('target dispute ignores a route bound to another target hub', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-other-hub');
    const route = fixture.buildRoute('other-target-hub', { targetHub: entity('55') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    const outputs: EntityInput[] = [];

    expect(
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        fixture.state,
        outputs,
        fixture.targetHub,
        '0x',
      ),
    ).toBe(false);
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
      ...buildPreparedCrossJurisdictionRoute(
        {
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
        },
        { runtimeSeed: 'cross-same-token-market', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer(
      {
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
        createdHeight: 1,
        crossJurisdiction: route,
      },
      route.bookOwnerEntityId || '',
    );

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
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(tronRef, sourceHub, testnetRef, targetHub)).toBe(targetHub);

    const sourceEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs(testnetRef, 2, tronRef, 3);
    expect(sourceEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceEthToTargetStable.baseKey).toBe(`${testnetRef}:2`);
    expect(sourceEthToTargetStable.quoteKey).toBe(`${tronRef}:3`);
    expect(sourceEthToTargetStable.venueId).toBe(`cross:${testnetRef}:2/${tronRef}:3`);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(testnetRef, targetHub, tronRef, sourceHub)).toBe(targetHub);

    const sourceTronEthToTargetStable = deriveCanonicalCrossJurisdictionMarketForLegs(tronRef, 2, testnetRef, 3);
    expect(sourceTronEthToTargetStable.sourceIsBase).toBe(true);
    expect(sourceTronEthToTargetStable.baseKey).toBe(`${tronRef}:2`);
    expect(sourceTronEthToTargetStable.quoteKey).toBe(`${testnetRef}:3`);
    expect(sourceTronEthToTargetStable.venueId).toBe(`cross:${tronRef}:2/${testnetRef}:3`);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(tronRef, sourceHub, testnetRef, targetHub)).toBe(targetHub);
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
      ...buildPreparedCrossJurisdictionRoute(
        {
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
        },
        { runtimeSeed: 'cross-tron-weth-testnet-usdt-price', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer(
      {
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
        createdHeight: 1,
        crossJurisdiction: route,
      },
      targetHub,
    );

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
      ...buildPreparedCrossJurisdictionRoute(
        {
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
        },
        { runtimeSeed: 'cross-tron-usdt-testnet-weth-price', sourceDisputeDelayMs: 5_000, now: 1_000 },
      ),
      status: 'resting' as const,
    };
    const market = buildCrossJurisdictionMarketOffer(
      {
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
        createdHeight: 1,
        crossJurisdiction: route,
      },
      targetHub,
    );

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
    const testnetState = makeState(
      entity('same-token-catalog-testnet'),
      addr('12'),
      makeJurisdiction('Testnet', 31337, '11', '12'),
    );
    normalizeEntitySwapTradingPairs(testnetState);
    expect(testnetState.swapTradingPairs?.map(pair => `${pair.baseTokenId}/${pair.quoteTokenId}`)).toEqual([
      '2/1',
      '1/3',
      '2/3',
    ]);

    const tronState = makeState(
      entity('same-token-catalog-tron'),
      addr('13'),
      makeJurisdiction('Tron', 31338, '13', '14'),
    );
    normalizeEntitySwapTradingPairs(tronState);
    const tronPairs = tronState.swapTradingPairs?.map(pair => `${pair.baseTokenId}/${pair.quoteTokenId}`) ?? [];
    expect(tronPairs).toContain('4/1');
    expect(tronPairs).toContain('4/3');
    expect(tronPairs).toContain('5/1');
    expect(tronPairs).toContain('5/3');
  });

  test('cross-j rejects same-jurisdiction same-token route before orderbook admission', () => {
    const jurisdictionRef = `stack:31337:0x${'11'.repeat(20)}`;
    expect(() =>
      buildPreparedCrossJurisdictionRoute(
        {
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
        },
        {
          runtimeSeed: 'cross-same-chain-same-token-invalid',
          sourceDisputeDelayMs: 5_000,
          now: 1_000,
        },
      ),
    ).toThrow(/CROSS_J_REQUIRES_DISTINCT_STACKS/);
  });
});
